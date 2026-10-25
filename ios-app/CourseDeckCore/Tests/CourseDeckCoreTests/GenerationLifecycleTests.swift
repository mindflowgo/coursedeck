import XCTest
@testable import CourseDeckCore

private actor LifecycleConsent {
    private(set) var granted: Bool
    init(_ granted: Bool) { self.granted = granted }
    func set(_ value: Bool) { granted = value }
}

private actor ConsentGate {
    private(set) var entered = false
    private var continuation: CheckedContinuation<Bool, Never>?

    func wait() async -> Bool {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            self.entered = true
        }
    }

    func release(_ value: Bool) {
        continuation?.resume(returning: value)
        continuation = nil
    }
}

private actor WorkFlag {
    private(set) var value = false
    func set() { value = true }
}

final class GenerationLifecycleTests: XCTestCase {
    private func job() -> GenerationJob {
        GenerationJob(
            id: GenerationJob.identifier(courseId: "baf3m", lessonId: "01.01", tab: "summary"),
            courseId: "baf3m",
            lessonId: "01.01",
            lessonTitle: "Lesson",
            tab: "summary",
            activeCardId: "card_deepseek",
            activeCardPolicy: "pinned"
        )
    }

    private func makeQueue(_ workspace: TestWorkspace) -> GenerationQueue {
        GenerationQueue(root: workspace.dataRoot) { _, _ in
            GenerationOutcome(content: "ok")
        }
    }

    func testFirstSceneRecoversInterruptedJobsThenStartsWhenConsented() async throws {
        let workspace = try TestWorkspace()
        let store = JobStore(root: workspace.dataRoot)
        let queued = job()
        _ = try await store.enqueue(queued)
        _ = try await store.start(id: queued.id)

        let consent = LifecycleConsent(true)
        let queue = makeQueue(workspace)
        let coordinator = GenerationLifecycleCoordinator(
            queue: queue,
            consentProvider: { await consent.granted }
        )

        let started = await coordinator.sceneBecameActive(id: UUID())
        XCTAssertTrue(started)
        let recoveredOnce = await coordinator.hasRecovered
        let running = await coordinator.queueIsRunning()
        XCTAssertTrue(recoveredOnce)
        XCTAssertTrue(running)

        let recovered = await queue.job(id: queued.id)
        XCTAssertEqual(recovered?.status, .interrupted)
        XCTAssertEqual(recovered?.customPrompt, nil)

        await coordinator.sceneWillResignActive(id: UUID())
        // A different scene ID does not remove the active one.
        let stillRunning = await coordinator.queueIsRunning()
        XCTAssertTrue(stillRunning)
    }

    func testMultipleScenesKeepQueueRunningUntilLastResigns() async throws {
        let workspace = try TestWorkspace()
        let consent = LifecycleConsent(true)
        let queue = makeQueue(workspace)
        let coordinator = GenerationLifecycleCoordinator(
            queue: queue,
            consentProvider: { await consent.granted }
        )
        let first = UUID()
        let second = UUID()

        _ = await coordinator.sceneBecameActive(id: first)
        _ = await coordinator.sceneBecameActive(id: second)
        let count = await coordinator.activeSceneCount
        XCTAssertEqual(count, 2)
        let runningBoth = await coordinator.queueIsRunning()
        XCTAssertTrue(runningBoth)

        await coordinator.sceneWillResignActive(id: first)
        let runningOne = await coordinator.queueIsRunning()
        XCTAssertTrue(runningOne)

        await coordinator.sceneWillResignActive(id: second)
        let runningNone = await coordinator.queueIsRunning()
        XCTAssertFalse(runningNone)
    }

    func testQueueStaysStoppedUntilConsentIsAccepted() async throws {
        let workspace = try TestWorkspace()
        let consent = LifecycleConsent(false)
        let queue = makeQueue(workspace)
        let coordinator = GenerationLifecycleCoordinator(
            queue: queue,
            consentProvider: { await consent.granted }
        )
        let scene = UUID()

        let started = await coordinator.sceneBecameActive(id: scene)
        XCTAssertFalse(started)
        let notRunning = await coordinator.queueIsRunning()
        let recovered = await coordinator.hasRecovered
        XCTAssertFalse(notRunning)
        XCTAssertTrue(recovered)

        await consent.set(true)
        await coordinator.consentDidChange()
        let runningNow = await coordinator.queueIsRunning()
        XCTAssertTrue(runningNow)

        await consent.set(false)
        await coordinator.consentDidChange()
        let stopped = await coordinator.queueIsRunning()
        XCTAssertFalse(stopped)
    }

    func testRecoveryFailureKeepsQueueStopped() async throws {
        let workspace = try TestWorkspace()
        let store = JobStore(root: workspace.dataRoot)
        _ = try await store.enqueue(job())
        _ = try await store.start(id: job().id)

        workspace.dataRoot.writeGate.block(reason: "newer data version")
        let consent = LifecycleConsent(true)
        let queue = makeQueue(workspace)
        let coordinator = GenerationLifecycleCoordinator(
            queue: queue,
            consentProvider: { await consent.granted }
        )
        let scene = UUID()

        let started = await coordinator.sceneBecameActive(id: scene)
        XCTAssertFalse(started)
        let recovered = await coordinator.hasRecovered
        let running = await coordinator.queueIsRunning()
        let error = await coordinator.lastError
        XCTAssertFalse(recovered)
        XCTAssertFalse(running)
        XCTAssertNotNil(error)

        // A later .active retries recovery and starts once it succeeds.
        workspace.dataRoot.writeGate.unblock()
        await coordinator.scenePhaseChanged(id: scene, phase: .active)
        let retried = await coordinator.hasRecovered
        let nowRunning = await coordinator.queueIsRunning()
        let clearedError = await coordinator.lastError
        XCTAssertTrue(retried)
        XCTAssertTrue(nowRunning)
        XCTAssertNil(clearedError)
        let stored = await queue.job(id: job().id)
        XCTAssertEqual(stored?.status, .interrupted)
    }

    func testResignDuringConsentWaitDoesNotStartQueue() async throws {
        let workspace = try TestWorkspace()
        let gate = ConsentGate()
        let queue = makeQueue(workspace)
        let coordinator = GenerationLifecycleCoordinator(
            queue: queue,
            consentProvider: { await gate.wait() }
        )
        let scene = UUID()

        let activation = Task { await coordinator.sceneBecameActive(id: scene) }
        let deadline = Date().addingTimeInterval(5)
        while (await gate.entered) == false, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let entered = await gate.entered
        XCTAssertTrue(entered)

        // The activation is suspended in the consent provider. A resign must
        // invalidate it so it cannot start the queue when consent returns.
        await coordinator.scenePhaseChanged(id: scene, phase: .background)
        await gate.release(true)
        let started = await activation.value
        XCTAssertFalse(started)
        let running = await coordinator.queueIsRunning()
        XCTAssertFalse(running)
    }

    func testInactiveThenActiveDoesNotCancelRunningExecutor() async throws {
        let workspace = try TestWorkspace()
        let consent = LifecycleConsent(true)
        let started = WorkFlag()
        let cancelled = WorkFlag()
        let queue = GenerationQueue(
            root: workspace.dataRoot,
            executor: { _, _ in
                await started.set()
                do {
                    try await Task.sleep(nanoseconds: 60_000_000_000)
                } catch {
                    await cancelled.set()
                    throw error
                }
                return GenerationOutcome(content: "never")
            },
            retryable: { _ in false }
        )
        let coordinator = GenerationLifecycleCoordinator(
            queue: queue,
            consentProvider: { await consent.granted },
            inactiveGrace: 0.5
        )
        let scene = UUID()

        await coordinator.scenePhaseChanged(id: scene, phase: .active)
        let queued = try await queue.enqueue(job())
        let deadline = Date().addingTimeInterval(5)
        while (await started.value) == false, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let didStart = await started.value
        XCTAssertTrue(didStart)

        await coordinator.scenePhaseChanged(id: scene, phase: .inactive)
        try await Task.sleep(nanoseconds: 100_000_000)
        await coordinator.scenePhaseChanged(id: scene, phase: .active)
        try await Task.sleep(nanoseconds: 200_000_000)

        let wasCancelled = await cancelled.value
        XCTAssertFalse(wasCancelled)
        let stored = await queue.job(id: queued.id)
        XCTAssertEqual(stored?.status, .running)
        let running = await coordinator.queueIsRunning()
        XCTAssertTrue(running)

        _ = try await queue.cancel(id: queued.id)
        await queue.shutdown(interruptRunning: true)
    }
}
