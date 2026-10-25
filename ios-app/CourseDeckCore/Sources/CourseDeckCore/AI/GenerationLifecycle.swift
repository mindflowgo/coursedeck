import Foundation

public enum SceneActivityPhase: Equatable, Sendable {
    case active
    case inactive
    case background
}

/// App-level scene coordinator for the generation queue (PLAN §4.9).
///
/// Multiple SwiftUI scenes each report active/inactive/background. The queue
/// runs only while at least one scene is active, must recover interrupted tasks
/// exactly once, and must never start before the user accepts the AI
/// disclosure. Scene events are serialized through an epoch counter so an
/// activation that was in flight cannot start the queue after a resign.
public actor GenerationLifecycleCoordinator {
    public typealias ConsentProvider = @Sendable () async -> Bool

    private let queue: GenerationQueue
    private let consentProvider: ConsentProvider
    private let inactiveGrace: TimeInterval
    private var activeScenes: Set<UUID> = []
    private var recovered = false
    private var epoch = 0
    private var inactiveGraceTask: Task<Void, Never>?
    private var recoveryError: String?

    /// `inactiveGrace` postpones interruption after `.inactive`; a return to
    /// `.active` within this window keeps the current stream alive.
    public init(
        queue: GenerationQueue,
        consentProvider: @escaping ConsentProvider,
        inactiveGrace: TimeInterval = 1.5
    ) {
        self.queue = queue
        self.consentProvider = consentProvider
        self.inactiveGrace = max(inactiveGrace, 0)
    }

    public var activeSceneCount: Int { activeScenes.count }
    public var hasRecovered: Bool { recovered }
    public var lastError: String? { recoveryError }

    public func queueIsRunning() async -> Bool {
        await queue.isRunning
    }

    // MARK: - Scene transitions

    /// Handles the full phase, including the short inactive grace.
    public func scenePhaseChanged(id: UUID, phase: SceneActivityPhase) async {
        epoch += 1
        let token = epoch
        switch phase {
        case .active:
            inactiveGraceTask?.cancel()
            inactiveGraceTask = nil
            activeScenes.insert(id)
            guard activeScenes.count == 1 else { return }
            _ = await activate(token: token)

        case .inactive:
            activeScenes.remove(id)
            guard activeScenes.isEmpty else { return }
            scheduleInactiveGrace(token: token)

        case .background:
            inactiveGraceTask?.cancel()
            inactiveGraceTask = nil
            activeScenes.remove(id)
            guard activeScenes.isEmpty else { return }
            await queue.shutdown(interruptRunning: true)
        }
    }

    /// Compatibility wrapper used by tests and older call sites.
    @discardableResult
    public func sceneBecameActive(id: UUID) async -> Bool {
        epoch += 1
        let token = epoch
        inactiveGraceTask?.cancel()
        inactiveGraceTask = nil
        activeScenes.insert(id)
        guard activeScenes.count == 1 else { return false }
        return await activate(token: token)
    }

    /// Immediate interrupt (window destruction or explicit background).
    public func sceneWillResignActive(id: UUID) async {
        await scenePhaseChanged(id: id, phase: .background)
    }

    /// Called after the user accepts or revokes consent.
    public func consentDidChange() async {
        epoch += 1
        let token = epoch
        guard !activeScenes.isEmpty else {
            await queue.shutdown(interruptRunning: true)
            return
        }
        await recoverIfNeeded()
        guard recovered else { return }
        guard token == epoch, !activeScenes.isEmpty else { return }

        let granted = await consentProvider()
        guard token == epoch, !activeScenes.isEmpty else { return }

        if granted {
            await queue.start()
            // The scene set can change while awaiting the queue actor.
            if token != epoch || activeScenes.isEmpty {
                await queue.shutdown(interruptRunning: true)
            }
        } else {
            await queue.shutdown(interruptRunning: true)
        }
    }

    // MARK: - Private

    private func activate(token: Int) async -> Bool {
        await recoverIfNeeded()
        guard recovered else { return false }
        guard token == epoch, !activeScenes.isEmpty else { return false }

        let granted = await consentProvider()
        guard token == epoch, !activeScenes.isEmpty else { return false }
        guard granted else { return false }

        await queue.start()
        guard token == epoch, !activeScenes.isEmpty else {
            await queue.shutdown(interruptRunning: true)
            return false
        }
        // A grace-expiry shutdown may have raced the start call; recover by
        // starting once more if the scene is still active.
        if await queue.isRunning == false {
            await queue.start()
        }
        return true
    }

    private func scheduleInactiveGrace(token: Int) {
        inactiveGraceTask?.cancel()
        let grace = inactiveGrace
        inactiveGraceTask = Task { [weak self] in
            if grace > 0 {
                try? await Task.sleep(nanoseconds: UInt64(grace * 1_000_000_000))
            }
            guard !Task.isCancelled else { return }
            await self?.inactiveGraceExpired(token: token)
        }
    }

    private func inactiveGraceExpired(token: Int) async {
        guard token == epoch, activeScenes.isEmpty else { return }
        epoch += 1
        await queue.shutdown(interruptRunning: true)
    }

    private func recoverIfNeeded() async {
        guard !recovered else { return }
        do {
            _ = try await queue.recoverOnLaunch()
            recovered = true
            recoveryError = nil
        } catch {
            recovered = false
            recoveryError = "Generation recovery failed: \(error.localizedDescription)"
        }
    }
}
