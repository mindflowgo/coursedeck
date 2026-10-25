import Foundation
import XCTest
@testable import CourseDeckCore

final class QuizAttemptStoreTests: XCTestCase {
    func testAttemptRoundTripAndFilters() throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let store = QuizAttemptStore(root: workspace.dataRoot)
        let pop = QuizAttempt(
            courseId: "baf3m",
            lessonId: "01.01",
            kind: .popQuiz,
            quizKey: "2026-10-19_23-52-28",
            title: "Pop Quiz",
            date: "2026-10-19T23:52:28Z",
            score: 5,
            total: 6,
            percentage: 83,
            durationSeconds: 154,
            timedOut: false,
            answers: ["s0q01-0": "B"]
        )
        let unit = QuizAttempt(
            courseId: "baf3m",
            lessonId: "01.01",
            kind: .unitTest,
            quizKey: "01.unit.test.md",
            title: "Unit Test",
            date: "2026-10-20T00:00:00Z",
            score: 7.5,
            total: 12,
            percentage: 63,
            usedAI: true
        )
        try store.record(pop)
        try store.record(unit)

        let all = try store.attempts(courseId: "baf3m")
        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(all.first?.id, unit.id, "newest first")
        let popOnly = try store.attempts(courseId: "baf3m", lessonId: "01.01", kind: .popQuiz)
        XCTAssertEqual(popOnly.count, 1)
        XCTAssertEqual(popOnly[0].answers?["s0q01-0"], "B")
        XCTAssertEqual(try store.attempt(id: pop.id, courseId: "baf3m")?.score, 5)
    }

    func testDraftRestoresOnlyForMatchingContentHash() throws {
        let workspace = try TestWorkspace()
        let drafts = QuizDraftStore(root: workspace.dataRoot)
        let key = "baf3m:01.01:test"
        let hash = QuizDraftStore.contentHash("# Quiz\n\n01) Question")
        try drafts.save(
            QuizDraft(
                key: key,
                contentHash: hash,
                answers: ["q1": "A"],
                updatedAt: "2026-10-25T00:00:00Z"
            )
        )
        XCTAssertEqual(drafts.load(key: key, contentHash: hash)?.answers["q1"], "A")

        let changed = QuizDraftStore.contentHash("# Quiz\n\n01) Changed question")
        XCTAssertNil(drafts.load(key: key, contentHash: changed))
        // The stale draft is deleted, not left to resurrect later.
        XCTAssertNil(drafts.load(key: key, contentHash: hash))
    }

    func testDraftDeleteAfterSubmit() throws {
        let workspace = try TestWorkspace()
        let drafts = QuizDraftStore(root: workspace.dataRoot)
        let hash = QuizDraftStore.contentHash("quiz")
        try drafts.save(
            QuizDraft(
                key: "k",
                contentHash: hash,
                answers: ["q": "A"],
                updatedAt: "2026-10-25T00:00:00Z"
            )
        )
        try drafts.delete(key: "k")
        XCTAssertNil(drafts.load(key: "k", contentHash: hash))
    }

    func testPopQuizSessionUsesAbsoluteDeadline() throws {
        let workspace = try TestWorkspace()
        let drafts = QuizDraftStore(root: workspace.dataRoot)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let session = PopQuizSession(
            key: "baf3m:01.01:2026-10-19_23-52-28",
            contentHash: QuizDraftStore.contentHash("quiz"),
            deadline: now.addingTimeInterval(300),
            startedAt: now,
            answers: ["q1": "B"],
            durationSeconds: 300
        )
        XCTAssertEqual(session.remainingSeconds(now: now), 300)
        XCTAssertEqual(session.remainingSeconds(now: now.addingTimeInterval(120)), 180)
        XCTAssertEqual(session.elapsedSeconds(now: now.addingTimeInterval(120)), 120)
        XCTAssertFalse(session.hasExpired(now: now.addingTimeInterval(299)))
        XCTAssertTrue(session.hasExpired(now: now.addingTimeInterval(301)))

        try drafts.savePopQuizSession(session)
        let loaded = drafts.loadPopQuizSession(key: session.key, contentHash: session.contentHash)
        XCTAssertEqual(loaded?.deadline, session.deadline)
        XCTAssertEqual(loaded?.answers["q1"], "B")

        try drafts.deletePopQuizSession(key: session.key)
        XCTAssertNil(drafts.loadPopQuizSession(key: session.key, contentHash: session.contentHash))
    }

    func testLivePopQuizTimestampIsParsed() {
        let parsed = PathValidator.parsePopQuizFileName("01.01.popquiz.2026-10-19_23-52-28.md")
        XCTAssertEqual(parsed?.lessonId, "01.01")
        XCTAssertEqual(parsed?.timestamp, "2026-10-19_23-52-28")
        XCTAssertNotNil(PathValidator.parsePopQuizFileName("01.01.popquiz.20260101010101.md"))
        XCTAssertNil(PathValidator.parsePopQuizFileName("01.01.popquiz.md"))
    }

    func testAttemptWriteFailsWhenRootIsReadOnlyOrFull() throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let store = QuizAttemptStore(root: workspace.dataRoot)
        let attempt = QuizAttempt(
            courseId: "baf3m",
            lessonId: "01.01",
            kind: .popQuiz,
            quizKey: "2026-10-19_23-52-28",
            title: "Pop Quiz",
            date: "2026-10-19T23:52:28Z",
            score: 5,
            total: 6,
            percentage: 83
        )
        workspace.dataRoot.writeGate.block(reason: "read-only data root")
        XCTAssertThrowsError(try store.record(attempt)) { error in
            XCTAssertTrue(error is WriteBlockedError)
        }
        XCTAssertFalse(
            (try? FileManager.default.contentsOfDirectory(
                at: workspace.dataRoot.attemptsURL,
                includingPropertiesForKeys: nil
            ))?.contains(where: { $0.pathExtension == "json" }) == true
        )
        workspace.dataRoot.writeGate.unblock()
        XCTAssertNoThrow(try store.record(attempt))
        XCTAssertEqual(try store.attempts(courseId: "baf3m").count, 1)
    }

    func testAttemptRecorderPersistsFinalSessionBeforeDeletingAndKeepsItOnFailure() throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let drafts = QuizDraftStore(root: workspace.dataRoot)
        let attempts = QuizAttemptStore(root: workspace.dataRoot)
        let recorder = PopQuizAttemptRecorder(attempts: attempts, drafts: drafts)
        let key = "baf3m:01.01:popquiz:2026-10-19_23-52-28"
        let session = PopQuizSession(
            key: key,
            contentHash: "hash",
            deadline: Date().addingTimeInterval(100),
            startedAt: Date(),
            answers: ["q": "B"],
            durationSeconds: 42
        )
        try drafts.savePopQuizSession(session)
        let attempt = QuizAttempt(
            courseId: "baf3m",
            lessonId: "01.01",
            kind: .popQuiz,
            quizKey: "2026-10-19_23-52-28",
            title: "Quiz",
            date: "2026-10-19T23:52:28Z",
            score: 5,
            total: 6,
            percentage: 83,
            durationSeconds: 42,
            timedOut: false,
            answers: ["q": "B"]
        )
        try recorder.record(attempt: attempt, session: session, draftKey: key)
        XCTAssertEqual(try attempts.attempts(courseId: "baf3m").count, 1)
        XCTAssertNil(drafts.loadPopQuizSession(key: key, contentHash: "hash"))

        // A history write failure still leaves the completed final session.
        try drafts.savePopQuizSession(session)
        let failing = PopQuizAttemptRecorder(
            attempts: FailingAttemptRecording(),
            drafts: drafts
        )
        XCTAssertThrowsError(
            try failing.record(attempt: attempt, session: session, draftKey: key)
        )
        let retained = drafts.loadPopQuizSession(key: key, contentHash: "hash")
        XCTAssertNotNil(retained?.submittedAt)
        XCTAssertEqual(retained?.score, 5)
        XCTAssertEqual(retained?.durationSeconds, 42)
        XCTAssertEqual(retained?.timedOut, false)
        XCTAssertEqual(try attempts.attempts(courseId: "baf3m").count, 1)
    }

    func testDraftsAndAttemptsAreExcludedFromDeviceBackup() throws {
        let workspace = try TestWorkspace()
        XCTAssertTrue(workspace.dataRoot.isExcludedFromBackup(workspace.dataRoot.attemptsURL))
        XCTAssertTrue(workspace.dataRoot.isExcludedFromBackup(workspace.dataRoot.draftsURL))
        let attempt = QuizAttempt(
            courseId: "baf3m",
            kind: .practice,
            quizKey: "test",
            title: "Test",
            date: "2026-10-25T00:00:00Z",
            score: 1,
            total: 1,
            percentage: 100
        )
        try QuizAttemptStore(root: workspace.dataRoot).record(attempt)
        // Attempts are allowlisted for app export even though the OS backup flag is set.
        XCTAssertEqual(
            BackupPolicy.decide(relativePath: "attempts/file.json", context: .exporting, includeRawPackages: false),
            .allow
        )
        XCTAssertEqual(
            BackupPolicy.decide(relativePath: "drafts/quiz/file.json", context: .exporting, includeRawPackages: false),
            .skip(reason: "drafts/ is not in the backup allowlist")
        )
    }
}

private struct FailingAttemptRecording: QuizAttemptRecording {
    func record(_ attempt: QuizAttempt) throws -> URL {
        throw NSError(
            domain: "test",
            code: 28,
            userInfo: [NSLocalizedDescriptionKey: "No space left on device."]
        )
    }
}
