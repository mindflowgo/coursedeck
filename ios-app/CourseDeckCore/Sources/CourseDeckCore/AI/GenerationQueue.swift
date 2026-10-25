import Foundation

public struct GenerationOutcome: Equatable, Sendable {
    public var content: String
    public var tokensUsed: Int?

    public init(content: String, tokensUsed: Int? = nil) {
        self.content = content
        self.tokensUsed = tokensUsed
    }
}

/// Execution services the queue hands to a worker. Partial text is persisted
/// for diagnostics; cancellation is cooperative and backed by real URLSession
/// task cancellation in the client.
public struct GenerationExecutionContext: Sendable {
    public let recordPartial: @Sendable (String) -> Void
    public let isCancelled: @Sendable () -> Bool

    public init(
        recordPartial: @escaping @Sendable (String) -> Void,
        isCancelled: @escaping @Sendable () -> Bool
    ) {
        self.recordPartial = recordPartial
        self.isCancelled = isCancelled
    }
}

/// Durable foreground queue (PLAN §4.9).
///
/// * One worker per priority lane (`interactive`, `standard`, `courseDocs`).
/// * Every task's complete inputs live in `.jobs.json` via `JobStore`.
/// * A killed process leaves `running` records; `recoverOnLaunch()` turns them
///   into `interrupted` and the UI offers an explicit retry or discard. There
///   is never an automatic resume.
public actor GenerationQueue {
    public typealias Executor = @Sendable (GenerationJob, GenerationExecutionContext) async throws -> GenerationOutcome

    private let jobStore: JobStore
    private let executor: Executor
    private let retryable: @Sendable (Error) -> Bool
    private let retryDelay: @Sendable (Int) async -> Void

    private var workerTasks: [JobLane: Task<Void, Never>] = [:]
    private var activeTasks: [String: Task<GenerationOutcome, Error>] = [:]
    private var partialBuffers: [String: String] = [:]
    private var persistedPartialCounts: [String: Int] = [:]
    private var interruptedJobs: Set<String> = []
    private var claimed: Set<String> = []
    private var paused = false

    public init(
        root: DataRoot,
        jobStore: JobStore? = nil,
        executor: @escaping Executor,
        retryable: @escaping @Sendable (Error) -> Bool = { error in
            (error as? LlmError)?.isRetryable ?? false
        },
        retryDelay: @escaping @Sendable (Int) async -> Void = { attempt in
            let nanoseconds = UInt64(max(attempt, 1)) * 200_000_000
            try? await Task.sleep(nanoseconds: nanoseconds)
        }
    ) {
        self.jobStore = jobStore ?? JobStore(root: root)
        self.executor = executor
        self.retryable = retryable
        self.retryDelay = retryDelay
    }

    // MARK: - Enqueue and inspection

    @discardableResult
    public func enqueue(_ job: GenerationJob) async throws -> GenerationJob {
        interruptedJobs.remove(job.id)
        return try await jobStore.enqueue(job)
    }

    public func allJobs() async -> [GenerationJob] {
        await jobStore.allJobs()
    }

    public func job(id: String) async -> GenerationJob? {
        await jobStore.job(id: id)
    }

    // MARK: - Workers

    /// Starts one worker per lane. Idempotent.
    public func start() {
        guard workerTasks.isEmpty else { return }
        for lane in [JobLane.interactive, .standard, .courseDocs] {
            let task: Task<Void, Never> = Task { [weak self] in
                guard let self else { return }
                await self.laneLoop(lane)
            }
            workerTasks[lane] = task
        }
    }

    public func pause() {
        paused = true
    }

    public func resume() {
        paused = false
    }

    public var isPaused: Bool { paused }
    public var isRunning: Bool { !workerTasks.isEmpty }

    /// Stops workers. With `interruptRunning`, in-flight jobs are cancelled and
    /// marked interrupted with their partial output (app background/suspend).
    /// Without it, in-flight jobs keep `running` and launch recovery will mark
    /// them interrupted, which is what a process kill produces.
    public func shutdown(interruptRunning: Bool) async {
        workerTasks.values.forEach { $0.cancel() }
        workerTasks.removeAll()
        if interruptRunning {
            await interruptAll(reason: "App went to the background.")
        } else {
            activeTasks.values.forEach { $0.cancel() }
        }
    }

    /// Stops picking work, interrupts any in-flight stream, and waits for the
    /// workers to finish their bookkeeping. Backup import calls this before it
    /// takes the data lease so no generation write can race the import.
    public func beginMaintenance() async {
        paused = true
        await interruptAll(reason: "Maintenance is in progress.")
        await waitForIdle()
    }

    /// Re-enables workers after maintenance. Queued jobs resume; interrupted
    /// jobs stay interrupted until the user retries them.
    public func endMaintenance() {
        paused = false
    }

    private func waitForIdle(timeout: TimeInterval = 30) async {
        let deadline = Date().addingTimeInterval(timeout)
        while (!activeTasks.isEmpty || !claimed.isEmpty) && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// Cancels every in-flight request and marks running jobs interrupted.
    /// Never marks a partial stream as completed.
    public func interruptAll(reason: String) async {
        let running = await jobStore.jobs(status: .running)
        for job in running {
            interruptedJobs.insert(job.id)
            let partial = partialBuffers[job.id].flatMap { $0.isEmpty ? nil : $0 }
            _ = try? await jobStore.finish(
                id: job.id,
                status: .interrupted,
                error: reason,
                partialOutput: partial
            )
        }
        activeTasks.values.forEach { $0.cancel() }
    }

    // MARK: - Per-job control

    @discardableResult
    public func cancel(id: String) async throws -> GenerationJob? {
        if let partial = partialBuffers[id], !partial.isEmpty {
            _ = try? await jobStore.update(id: id) { $0.partialOutput = partial }
        }
        activeTasks[id]?.cancel()
        let result = try await jobStore.cancel(id: id)
        interruptedJobs.remove(id)
        return result
    }

    @discardableResult
    public func retry(id: String) async throws -> GenerationJob? {
        interruptedJobs.remove(id)
        return try await jobStore.retry(id: id)
    }

    @discardableResult
    public func discard(id: String) async throws -> Bool {
        // A running stream must be cancelled before its journal record is
        // removed; otherwise the worker would keep writing to a deleted job.
        activeTasks[id]?.cancel()
        interruptedJobs.remove(id)
        return try await jobStore.discard(id: id)
    }

    /// Called once on foreground launch. Running jobs become interrupted; no
    /// job is resumed automatically.
    @discardableResult
    public func recoverOnLaunch() async throws -> Int {
        try await jobStore.recoverInterrupted()
    }

    // MARK: - Draining (tests and one-shot foreground work)

    /// Runs the next queued job on the calling task. Returns false when the
    /// queue is empty or paused.
    public func processNext(preferredLane: JobLane? = nil) async -> Bool {
        guard !paused else { return false }
        guard let job = await jobStore.nextQueued(preferredLane: preferredLane) else { return false }
        await run(job)
        return true
    }

    /// Processes queued work until the journal is empty. Intended for tests and
    /// for a foreground "run now" action; production uses `start()`.
    public func drain() async {
        while await processNext() {}
    }

    // MARK: - Worker loop

    private func laneLoop(_ lane: JobLane) async {
        while !Task.isCancelled {
            if paused {
                try? await Task.sleep(nanoseconds: 50_000_000)
                continue
            }
            guard let job = await jobStore.nextQueued(lane: lane) else {
                try? await Task.sleep(nanoseconds: 50_000_000)
                continue
            }
            await run(job)
        }
    }

    private func run(_ job: GenerationJob) async {
        guard !claimed.contains(job.id) else { return }
        claimed.insert(job.id)
        defer {
            claimed.remove(job.id)
            activeTasks[job.id] = nil
            partialBuffers[job.id] = nil
            persistedPartialCounts[job.id] = nil
        }

        guard let started = try? await jobStore.start(id: job.id, activeCardId: job.activeCardId) else {
            return
        }

        partialBuffers[job.id] = ""
        persistedPartialCounts[job.id] = 0
        let context = GenerationExecutionContext(
            recordPartial: { [weak self] text in
                Task { await self?.recordPartial(jobId: job.id, text: text) }
            },
            isCancelled: { Task.isCancelled }
        )

        let task = Task<GenerationOutcome, Error> { [executor = self.executor] in
            try await executor(started, context)
        }
        activeTasks[job.id] = task

        do {
            let outcome = try await task.value
            guard !interruptedJobs.contains(job.id) else { return }
            let current = await jobStore.job(id: job.id)
            guard current?.status == .running else { return }
            _ = try? await jobStore.finish(
                id: job.id,
                status: .succeeded,
                tokensUsed: outcome.tokensUsed
            )
        } catch {
            if interruptedJobs.contains(job.id) { return }
            if Task.isCancelled { return }

            let current = await jobStore.job(id: job.id)
            if current?.status == .cancelled { return }

            let message = Self.errorDescription(error)
            let attempts = current?.attempts ?? job.attempts + 1
            let maximum = current?.maxAttempts ?? job.maxAttempts
            if retryable(error), attempts < maximum {
                _ = try? await jobStore.requeue(id: job.id, error: message)
                await retryDelay(attempts)
            } else {
                _ = try? await jobStore.finish(id: job.id, status: .failed, error: message)
            }
        }
    }

    private func recordPartial(jobId: String, text: String) async {
        partialBuffers[jobId] = text
        let last = persistedPartialCounts[jobId] ?? 0
        guard text.count - last >= 2_048 else { return }
        persistedPartialCounts[jobId] = text.count
        _ = try? await jobStore.update(id: jobId) { $0.partialOutput = text }
    }

    private static func errorDescription(_ error: Error) -> String {
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        return String(describing: error)
    }
}
