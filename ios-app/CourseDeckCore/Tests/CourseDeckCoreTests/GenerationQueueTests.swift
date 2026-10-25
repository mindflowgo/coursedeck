import XCTest
@testable import CourseDeckCore

private enum QueueTestError: Error {
    case retryable
    case fatal
}

private actor ExecutionLog {
    private(set) var jobs: [GenerationJob] = []
    func record(_ job: GenerationJob) { jobs.append(job) }
    var count: Int { jobs.count }
    var all: [GenerationJob] { jobs }
}

private actor Flag {
    private(set) var value = false
    func set() { value = true }
}

final class GenerationQueueTests: XCTestCase {
    private func job(
        tab: String = "summary",
        lane: JobLane = .standard,
        lessonId: String = "01.01",
        maxAttempts: Int = 3
    ) -> GenerationJob {
        GenerationJob(
            id: GenerationJob.identifier(courseId: "baf3m", lessonId: lessonId, tab: tab),
            courseId: "baf3m",
            lessonId: lessonId,
            lessonTitle: "Lesson",
            tab: tab,
            customPrompt: "custom prompt \(tab)",
            customContent: "custom content \(tab)",
            contextAttachment: "lesson - lessons",
            preferences: .object([
                JSONMember(key: "force", value: .bool(true)),
                JSONMember(key: "unitNumber", value: .number("1")),
            ]),
            lane: lane,
            activeCardId: "card_deepseek",
            activeCardPolicy: "pinned",
            maxAttempts: maxAttempts
        )
    }

    private func waitUntil(
        timeout: TimeInterval = 5,
        _ condition: @escaping () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Condition timed out after \(timeout)s")
    }

    // MARK: - Processing

    func testDrainProcessesQueuedJobsDurably() async throws {
        let workspace = try TestWorkspace()
        let log = ExecutionLog()
        let queue = GenerationQueue(root: workspace.dataRoot) { job, _ in
            await log.record(job)
            return GenerationOutcome(content: "ok:\(job.tab)", tokensUsed: 7)
        }

        _ = try await queue.enqueue(job(tab: "summary"))
        _ = try await queue.enqueue(job(tab: "cheatsheet"))
        await queue.drain()

        let jobs = await queue.allJobs()
        XCTAssertEqual(jobs.count, 2)
        XCTAssertEqual(Set(jobs.map(\.status)), [.succeeded])
        XCTAssertEqual(jobs.map(\.attempts), [1, 1])
        XCTAssertEqual(jobs.compactMap(\.tokensUsed), [7, 7])
        let count = await log.count
        XCTAssertEqual(count, 2)

        let reloaded = JobStore(root: workspace.dataRoot)
        let durable = await reloaded.allJobs()
        XCTAssertEqual(durable.count, 2)
        XCTAssertEqual(Set(durable.map(\.status)), [.succeeded])
    }

    func testEnqueueDeduplicatesPendingIdentity() async throws {
        let workspace = try TestWorkspace()
        let queue = GenerationQueue(root: workspace.dataRoot) { _, _ in
            GenerationOutcome(content: "ok")
        }
        _ = try await queue.enqueue(job())
        _ = try await queue.enqueue(job())
        let jobs = await queue.allJobs()
        XCTAssertEqual(jobs.count, 1)
    }

    func testPriorityLaneOrdering() async throws {
        let workspace = try TestWorkspace()
        let log = ExecutionLog()
        let queue = GenerationQueue(root: workspace.dataRoot) { job, _ in
            await log.record(job)
            return GenerationOutcome(content: "ok")
        }
        _ = try await queue.enqueue(job(tab: "course_summary", lane: .courseDocs))
        _ = try await queue.enqueue(job(tab: "cheatsheet", lane: .standard))
        _ = try await queue.enqueue(job(tab: "popquiz", lane: .interactive))
        await queue.drain()

        let lanes = await log.all.map(\.lane)
        XCTAssertEqual(lanes, [.interactive, .standard, .courseDocs])
    }

    func testPauseStopsProcessingUntilResumed() async throws {
        let workspace = try TestWorkspace()
        let queue = GenerationQueue(root: workspace.dataRoot) { _, _ in
            GenerationOutcome(content: "ok")
        }
        _ = try await queue.enqueue(job())
        await queue.pause()
        let processedWhilePaused = await queue.processNext()
        XCTAssertFalse(processedWhilePaused)
        await queue.resume()
        let processed = await queue.processNext()
        XCTAssertTrue(processed)
    }

    // MARK: - Cancellation

    func testCancellationMarksJobCancelledAndCancelsExecutor() async throws {
        let workspace = try TestWorkspace()
        let started = Flag()
        let queue = GenerationQueue(
            root: workspace.dataRoot,
            executor: { _, _ in
                await started.set()
                while !Task.isCancelled {
                    try await Task.sleep(nanoseconds: 20_000_000)
                }
                throw CancellationError()
            },
            retryable: { _ in false }
        )
        let queued = try await queue.enqueue(job())
        let pump = Task { await queue.processNext() }
        try await waitUntil { await started.value }

        let cancelled = try await queue.cancel(id: queued.id)
        XCTAssertEqual(cancelled?.status, .cancelled)
        await pump.value

        let stored = await queue.job(id: queued.id)
        XCTAssertEqual(stored?.status, .cancelled)
    }

    // MARK: - Retries

    func testRetryableFailureRequeuesUntilMaxAttempts() async throws {
        let workspace = try TestWorkspace()
        let queue = GenerationQueue(
            root: workspace.dataRoot,
            executor: { _, _ in throw QueueTestError.retryable },
            retryable: { _ in true },
            retryDelay: { _ in }
        )
        let queued = try await queue.enqueue(job(maxAttempts: 2))
        await queue.drain()

        let stored = await queue.job(id: queued.id)
        XCTAssertEqual(stored?.status, .failed)
        XCTAssertEqual(stored?.attempts, 2)
        XCTAssertNotNil(stored?.lastError)
    }

    func testFatalFailureFailsImmediately() async throws {
        let workspace = try TestWorkspace()
        let queue = GenerationQueue(
            root: workspace.dataRoot,
            executor: { _, _ in throw QueueTestError.fatal },
            retryable: { _ in false },
            retryDelay: { _ in }
        )
        let queued = try await queue.enqueue(job(maxAttempts: 3))
        await queue.drain()
        let stored = await queue.job(id: queued.id)
        XCTAssertEqual(stored?.status, .failed)
        XCTAssertEqual(stored?.attempts, 1)
    }

    // MARK: - Kill / relaunch

    func testKillRelaunchRecoversInterruptedTaskWithFullInputsAndExplicitRetry() async throws {
        let workspace = try TestWorkspace()
        let queued = job(tab: "test", lessonId: "04.unit")
        let store = JobStore(root: workspace.dataRoot)
        _ = try await store.enqueue(queued)
        _ = try await store.start(id: queued.id, activeCardId: "card_deepseek")
        _ = try await store.update(id: queued.id) { job in
            job.partialOutput = "half of the streamed answer"
        }

        // A process kill leaves .jobs.json with status=running. A fresh app
        // instance must expose it as interrupted, never resumed/completed.
        let log = ExecutionLog()
        let relaunched = GenerationQueue(
            root: workspace.dataRoot,
            jobStore: JobStore(root: workspace.dataRoot)
        ) { job, _ in
            await log.record(job)
            return GenerationOutcome(content: "regenerated", tokensUsed: 3)
        }
        let recovered = try await relaunched.recoverOnLaunch()
        XCTAssertEqual(recovered, 1)

        var stored = await relaunched.job(id: queued.id)
        XCTAssertEqual(stored?.status, .interrupted)
        XCTAssertEqual(stored?.customPrompt, "custom prompt test")
        XCTAssertEqual(stored?.customContent, "custom content test")
        XCTAssertEqual(stored?.contextAttachment, "lesson - lessons")
        XCTAssertEqual(stored?.activeCardId, "card_deepseek")
        XCTAssertEqual(stored?.partialOutput, "half of the streamed answer")
        XCTAssertEqual(stored?.preferences?["force"]?.boolValue, true)

        let retried = try await relaunched.retry(id: queued.id)
        XCTAssertEqual(retried?.status, .queued)
        await relaunched.drain()

        stored = await relaunched.job(id: queued.id)
        XCTAssertEqual(stored?.status, .succeeded)
        XCTAssertEqual(stored?.attempts, 2)
        XCTAssertEqual(stored?.customContent, "custom content test")
        let executed = await log.all
        XCTAssertEqual(executed.count, 1)
        XCTAssertEqual(executed.first?.customPrompt, "custom prompt test")
        XCTAssertEqual(executed.first?.contextAttachment, "lesson - lessons")
    }

    func testInterruptAllPersistsPartialOutputAndNeverMarksSucceeded() async throws {
        let workspace = try TestWorkspace()
        let started = Flag()
        let queue = GenerationQueue(
            root: workspace.dataRoot,
            executor: { _, context in
                context.recordPartial(String(repeating: "x", count: 3_000))
                await started.set()
                while !Task.isCancelled {
                    try await Task.sleep(nanoseconds: 20_000_000)
                }
                throw CancellationError()
            },
            retryable: { _ in false }
        )
        let queued = try await queue.enqueue(job())
        let pump = Task { await queue.processNext() }
        try await waitUntil { await started.value }
        try await waitUntil {
            let current = await queue.job(id: queued.id)
            return current?.partialOutput?.count == 3_000
        }

        await queue.interruptAll(reason: "App went to the background.")
        await pump.value

        let stored = await queue.job(id: queued.id)
        XCTAssertEqual(stored?.status, .interrupted)
        XCTAssertEqual(stored?.partialOutput?.count, 3_000)
        XCTAssertTrue(stored?.lastError?.contains("background") ?? false)
    }

    func testBeginMaintenanceInterruptsRunningAndPausesWorkers() async throws {
        let workspace = try TestWorkspace()
        let started = Flag()
        let cancelled = Flag()
        let queue = GenerationQueue(
            root: workspace.dataRoot,
            executor: { _, _ in
                await started.set()
                do {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                } catch {
                    await cancelled.set()
                    throw error
                }
                return GenerationOutcome(content: "never")
            },
            retryable: { _ in false }
        )
        await queue.start()
        let queued = try await queue.enqueue(job())
        try await waitUntil { await started.value }

        await queue.beginMaintenance()
        let paused = await queue.isPaused
        XCTAssertTrue(paused)
        let stored = await queue.job(id: queued.id)
        XCTAssertEqual(stored?.status, .interrupted)
        try await waitUntil { await cancelled.value }

        await queue.endMaintenance()
        let resumed = await queue.isPaused
        XCTAssertFalse(resumed)
        await queue.shutdown(interruptRunning: true)
    }

    func testDiscardRemovesJournalRecord() async throws {
        let workspace = try TestWorkspace()
        let queue = GenerationQueue(root: workspace.dataRoot) { _, _ in
            GenerationOutcome(content: "ok")
        }
        let queued = try await queue.enqueue(job())
        let removed = try await queue.discard(id: queued.id)
        XCTAssertTrue(removed)
        let jobs = await queue.allJobs()
        XCTAssertTrue(jobs.isEmpty)
    }

    func testDiscardCancelsAnActiveExecutor() async throws {
        let workspace = try TestWorkspace()
        let started = Flag()
        let cancelled = Flag()
        let queue = GenerationQueue(
            root: workspace.dataRoot,
            executor: { _, _ in
                await started.set()
                do {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                } catch {
                    await cancelled.set()
                    throw error
                }
                return GenerationOutcome(content: "never")
            },
            retryable: { _ in false }
        )
        let queued = try await queue.enqueue(job())
        let pump = Task { await queue.processNext() }
        try await waitUntil { await started.value }

        let removed = try await queue.discard(id: queued.id)
        XCTAssertTrue(removed)
        await pump.value
        try await waitUntil { await cancelled.value }
        let jobs = await queue.allJobs()
        XCTAssertTrue(jobs.isEmpty)
    }

    func testInterruptedJobIsReplaceableByANewEnqueue() async throws {
        let workspace = try TestWorkspace()
        let store = JobStore(root: workspace.dataRoot)
        let queued = job()
        _ = try await store.enqueue(queued)
        _ = try await store.start(id: queued.id)
        _ = try await store.recoverInterrupted()

        var replacement = queued
        replacement.status = .queued
        replacement.customContent = "new content for the retried request"
        _ = try await store.enqueue(replacement)

        let stored = await store.job(id: queued.id)
        XCTAssertEqual(stored?.status, .queued)
        XCTAssertEqual(stored?.customContent, "new content for the retried request")
    }
}
