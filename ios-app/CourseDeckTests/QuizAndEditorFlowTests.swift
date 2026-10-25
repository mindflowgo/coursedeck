import Foundation
import XCTest
@testable import CourseDeck
import CourseDeckCore

// MARK: - Editor fakes

@MainActor
private final class FakeEditorDataSource: MarkdownEditorDataProviding {
    enum SaveMode {
        case success
        case failure(Error)
        case conflict
    }

    var mode: SaveMode = .success
    var content: String
    var sha: String
    var saveCalls: [String] = []
    var bumpCount = 0
    let url: URL

    init(content: String, sha: String = "initial") {
        self.content = content
        self.sha = sha
        self.url = FileManager.default.temporaryDirectory
            .appendingPathComponent("editor-\(UUID().uuidString).md")
    }

    func documentURL(for target: ReaderTarget) throws -> URL { url }

    func markdownSnapshot(for target: ReaderTarget) async throws -> DocumentSnapshot {
        DocumentSnapshot(
            courseId: target.courseId,
            scope: .lesson("01.01"),
            tab: target.tab,
            fileName: "01.01.\(target.tab).md",
            content: content,
            sha256: sha,
            existed: true,
            modifiedAt: Date()
        )
    }

    func saveMarkdown(
        target: ReaderTarget,
        content: String,
        expectedSHA256: String,
        force: Bool
    ) async throws -> DocumentSnapshot {
        saveCalls.append(content)
        switch mode {
        case .success:
            self.content = content
            sha = "saved-\(saveCalls.count)"
        case let .failure(error):
            throw error
        case .conflict:
            throw RepositoryError.concurrentModification("01.01.summary.md")
        }
        return try await markdownSnapshot(for: target)
    }

    func bumpDataRevision() { bumpCount += 1 }
}

@MainActor
final class MarkdownEditorAppTests: XCTestCase {
    private func context(content: String = "old") -> MarkdownEditorContext {
        let target = ReaderTarget(courseId: "baf3m", scope: .lesson("01.01"), tab: "summary")
        let snapshot = DocumentSnapshot(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "summary",
            fileName: "01.01.summary.md",
            content: content,
            sha256: "initial",
            existed: true,
            modifiedAt: Date()
        )
        return MarkdownEditorContext(target: target, title: "Unit 1", snapshot: snapshot)
    }

    func testAutosaveSuccessUpdatesStateAndClearsDirty() async throws {
        let dataSource = FakeEditorDataSource(content: "old")
        let model = MarkdownEditorModel(
            context: context(),
            dataSource: dataSource,
            autosaveDelay: 0.01,
            registerFilePresenter: false
        )
        model.text = "new content"
        model.textDidChange()
        XCTAssertEqual(model.state, .editing)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(dataSource.saveCalls, ["new content"])
        XCTAssertEqual(model.state, .saved)
        XCTAssertFalse(model.isDirty)
        XCTAssertEqual(model.text, "new content")
    }

    func testAutosaveFailureKeepsBufferOpenAndRetryable() async throws {
        let dataSource = FakeEditorDataSource(content: "old")
        dataSource.mode = .failure(NSError(
            domain: "test",
            code: 28,
            userInfo: [NSLocalizedDescriptionKey: "The disk is full."]
        ))
        let model = MarkdownEditorModel(
            context: context(),
            dataSource: dataSource,
            autosaveDelay: 0.01,
            registerFilePresenter: false
        )
        model.text = "unsaved work"
        model.textDidChange()
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(model.text, "unsaved work")
        XCTAssertTrue(model.isDirty)
        XCTAssertNotNil(model.showingError)
        let canCloseAfterFailure = await model.prepareToClose()
        XCTAssertFalse(canCloseAfterFailure)
        XCTAssertTrue(model.showingDiscardConfirmation || model.showingError != nil)
        // The buffer survives a failed save and can be retried.
        dataSource.mode = .success
        await model.save(force: false)
        XCTAssertEqual(model.state, .saved)
        XCTAssertEqual(dataSource.content, "unsaved work")
    }

    func testConflictKeepsBufferAndDoesNotDismiss() async throws {
        let dataSource = FakeEditorDataSource(content: "old")
        dataSource.mode = .conflict
        let model = MarkdownEditorModel(
            context: context(),
            dataSource: dataSource,
            autosaveDelay: 0.01,
            registerFilePresenter: false
        )
        model.text = "mine"
        model.textDidChange()
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(model.text, "mine")
        XCTAssertTrue(model.showingConflict)
        XCTAssertEqual(model.state, .conflict)
        let canCloseDuringConflict = await model.prepareToClose()
        XCTAssertFalse(canCloseDuringConflict)
        XCTAssertEqual(model.text, "mine")
    }

    func testDiscardChangesRestoresSavedBuffer() async throws {
        let dataSource = FakeEditorDataSource(content: "old")
        let model = MarkdownEditorModel(
            context: context(),
            dataSource: dataSource,
            autosaveDelay: 10,
            registerFilePresenter: false
        )
        model.text = "temporary"
        model.textDidChange()
        model.discardChanges()
        XCTAssertEqual(model.text, "old")
        XCTAssertFalse(model.isDirty)
        XCTAssertEqual(model.state, .saved)
    }

    func testEditorRegistersAndStopsFilePresenter() async throws {
        let dataSource = FakeEditorDataSource(content: "old")
        let model = MarkdownEditorModel(
            context: context(),
            dataSource: dataSource,
            autosaveDelay: 10,
            registerFilePresenter: true
        )
        XCTAssertTrue(model.isPresentingFile)
        model.stopPresenting()
        XCTAssertFalse(model.isPresentingFile)
    }

    func testFindReplaceAllAndNext() async throws {
        let dataSource = FakeEditorDataSource(content: "old")
        let model = MarkdownEditorModel(
            context: context(),
            dataSource: dataSource,
            autosaveDelay: 10,
            registerFilePresenter: false
        )
        model.text = "Red red RED blue"
        let all = model.replaceAll(find: "red", replacement: "green", caseSensitive: false)
        XCTAssertEqual(all, 3)
        XCTAssertEqual(model.text, "green green green blue")
        XCTAssertTrue(model.isDirty)

        model.text = "one two one"
        XCTAssertTrue(model.replaceNext(find: "one", replacement: "three", caseSensitive: true))
        XCTAssertEqual(model.text, "three two one")
        XCTAssertFalse(model.replaceNext(find: "absent", replacement: "x", caseSensitive: true))
        XCTAssertEqual(model.text, "three two one")
    }

    func testFindReplaceCaseSensitivityAndNoMatch() {
        let result = MarkdownFindReplace.replaceAll(
            in: "Red red",
            find: "Red",
            replacement: "Blue",
            caseSensitive: true
        )
        XCTAssertEqual(result.text, "Blue red")
        XCTAssertEqual(result.count, 1)
        let none = MarkdownFindReplace.replaceAll(
            in: "Red",
            find: "green",
            replacement: "x",
            caseSensitive: false
        )
        XCTAssertEqual(none.count, 0)
        XCTAssertEqual(none.text, "Red")
    }
}

// MARK: - Quiz fake

@MainActor
private final class FakeQuizDataSource: QuizDataSource {
    var document: QuizDocumentLoad
    var drafts: [String: QuizDraft] = [:]
    var sessions: [String: PopQuizSession] = [:]
    var attempts: [QuizAttempt] = []
    var recordedAttempts: [QuizAttempt] = []
    var recordError: Error?
    var unitPersisted = true
    var unitPersistenceError: String?
    var savedSessions: [PopQuizSession] = []
    var saveSessionFails = false
    var deletedSessionKeys: [String] = []
    var generatedQuiz: PopQuizReference?

    init(document: QuizDocumentLoad) {
        self.document = document
    }

    func loadQuizDocument(
        courseId: String,
        scope: ReaderScope,
        tab: String,
        title: String
    ) async throws -> QuizDocumentLoad {
        document
    }

    func loadPopQuiz(courseId: String, lessonId: String, timestamp: String) async throws -> QuizDocumentLoad {
        document
    }

    func popQuizzes(courseId: String, lessonId: String) async -> [PopQuizReference] { [] }

    func loadDraft(key: String, contentHash: String) -> QuizDraft? {
        guard let draft = drafts[key], draft.contentHash == contentHash else { return nil }
        return draft
    }

    func saveDraft(key: String, contentHash: String, answers: [String: String]) {
        drafts[key] = QuizDraft(
            key: key,
            contentHash: contentHash,
            answers: answers,
            updatedAt: "now"
        )
    }

    func deleteDraft(key: String) { drafts.removeValue(forKey: key) }

    func loadPopQuizSession(key: String, contentHash: String) -> PopQuizSession? {
        guard let session = sessions[key], session.contentHash == contentHash else { return nil }
        return session
    }

    @discardableResult
    func savePopQuizSession(_ session: PopQuizSession) -> Bool {
        guard !saveSessionFails else { return false }
        sessions[session.key] = session
        savedSessions.append(session)
        return true
    }

    func deletePopQuizSession(key: String) {
        sessions.removeValue(forKey: key)
        deletedSessionKeys.append(key)
    }

    func draftKey(courseId: String, scope: ReaderScope, tab: String) -> String {
        "\(courseId):\(scope):\(tab)"
    }

    func popQuizDraftKey(courseId: String, lessonId: String, timestamp: String) -> String {
        "\(courseId):\(lessonId):popquiz:\(timestamp)"
    }

    func gradeUnitTest(
        courseId: String,
        unitNumber: Int,
        quiz: ParsedQuiz,
        answers: [String: String]
    ) async throws -> UnitTestSubmission {
        let result = await QuizGrader().grade(quiz: quiz, answers: answers, mode: .practice)
        return UnitTestSubmission(
            result: result,
            persisted: unitPersisted,
            persistenceError: unitPersistenceError,
            attempt: nil,
            attemptError: nil
        )
    }

    func gradeLocally(quiz: ParsedQuiz, answers: [String: String], mode: QuizGradingMode) async -> QuizGradeResult {
        await QuizGrader().grade(quiz: quiz, answers: answers, mode: mode)
    }

    func recordPopQuizAttempt(
        courseId: String,
        lessonId: String,
        timestamp: String,
        title: String,
        score: Double,
        total: Int,
        percentage: Int,
        answers: [String: String],
        durationSeconds: Int,
        timedOut: Bool,
        session: PopQuizSession
    ) throws -> QuizAttempt {
        if let recordError { throw recordError }
        let attempt = QuizAttempt(
            courseId: courseId,
            lessonId: lessonId,
            kind: .popQuiz,
            quizKey: timestamp,
            title: title,
            date: "now",
            score: score,
            total: total,
            percentage: percentage,
            durationSeconds: durationSeconds,
            timedOut: timedOut,
            answers: answers
        )
        attempts.append(attempt)
        recordedAttempts.append(attempt)
        // Mirrors AppServices: successful attempt write removes draft/session.
        deleteDraft(key: popQuizDraftKey(courseId: courseId, lessonId: lessonId, timestamp: timestamp))
        deletePopQuizSession(key: popQuizDraftKey(courseId: courseId, lessonId: lessonId, timestamp: timestamp))
        return attempt
    }

    func quizAttempts(courseId: String, lessonId: String?, kind: QuizAttemptKind?) -> [QuizAttempt] {
        attempts.filter { attempt in
            attempt.courseId == courseId
                && (lessonId == nil || attempt.lessonId == lessonId)
                && (kind == nil || attempt.kind == kind)
        }
    }

    func generatePopQuiz(courseId: String, lessonId: String, force: Bool) async throws -> PopQuizReference {
        generatedQuiz ?? PopQuizReference(
            lessonId: lessonId,
            timestamp: "2026-10-25_03-00-00",
            fileName: "\(lessonId).popquiz.2026-10-25_03-00-00.md",
            modifiedAt: Date()
        )
    }

    func bumpDataRevision() {}
}

@MainActor
final class QuizFlowAppTests: XCTestCase {
    private let markdown = """
    # Pop Quiz

    ## Questions
    01) [Knowledge] Two plus two?
    <Multiple-Choice>
    - [ ] 3
    - [x] 4

    --

    02) [Fill-in-the-Blank] The capital is ______.

    ## Answers
    01) B - (explanation) Four.
    02) Toronto - (explanation) The capital.
    """

    private func document() -> QuizDocumentLoad {
        QuizDocumentLoad(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "popquiz",
            title: "Lesson One",
            fileName: "01.01.popquiz.2026-10-25_03-00-00.md",
            markdown: markdown
        )
    }

    private func request() -> QuizRequest {
        .popQuiz(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "2026-10-25_03-00-00",
            lessonTitle: "Lesson One"
        )
    }

    func testExistingSessionShowsPrepAndResumeDoesNotResetDeadline() async {
        let dataSource = FakeQuizDataSource(document: document())
        let hash = QuizDraftStore.contentHash(markdown)
        let key = dataSource.popQuizDraftKey(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "2026-10-25_03-00-00"
        )
        let deadline = Date().addingTimeInterval(180)
        dataSource.sessions[key] = PopQuizSession(
            key: key,
            contentHash: hash,
            deadline: deadline,
            startedAt: Date().addingTimeInterval(-120),
            answers: ["s0q01-0": "B"]
        )
        let model = QuizModel(request: request(), dataSource: dataSource)
        await model.load()

        XCTAssertTrue(model.popQuizNeedsDecision)
        XCTAssertFalse(model.submitted)
        XCTAssertEqual(model.session?.deadline, deadline)
        XCTAssertEqual(model.answers["s0q01-0"], "B")
        XCTAssertTrue(dataSource.savedSessions.isEmpty, "loading must not create or reset a session")

        await model.resumePopQuiz()
        XCTAssertFalse(model.popQuizNeedsDecision)
        XCTAssertEqual(model.session?.deadline, deadline)
        XCTAssertEqual(model.answers["s0q01-0"], "B")
        XCTAssertGreaterThan(model.remainingSeconds, 0)
    }

    func testTryAgainCreatesNewDeadlineAndClearsAnswers() async {
        let dataSource = FakeQuizDataSource(document: document())
        let hash = QuizDraftStore.contentHash(markdown)
        let key = dataSource.popQuizDraftKey(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "2026-10-25_03-00-00"
        )
        let oldDeadline = Date().addingTimeInterval(100)
        dataSource.sessions[key] = PopQuizSession(
            key: key,
            contentHash: hash,
            deadline: oldDeadline,
            startedAt: Date(),
            answers: ["s0q01-0": "B"]
        )
        let model = QuizModel(request: request(), dataSource: dataSource)
        await model.load()
        XCTAssertEqual(model.answers["s0q01-0"], "B")

        model.startNewPopQuiz()
        XCTAssertFalse(model.popQuizNeedsDecision)
        XCTAssertTrue(model.answers.isEmpty)
        XCTAssertNotEqual(model.session?.deadline, oldDeadline)
        XCTAssertEqual(model.session?.answers, [:])
        XCTAssertEqual(dataSource.savedSessions.count, 1)
    }

    func testExpiredSessionSubmitsTimedOutAfterResume() async {
        let dataSource = FakeQuizDataSource(document: document())
        let hash = QuizDraftStore.contentHash(markdown)
        let key = dataSource.popQuizDraftKey(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "2026-10-25_03-00-00"
        )
        dataSource.sessions[key] = PopQuizSession(
            key: key,
            contentHash: hash,
            deadline: Date().addingTimeInterval(-5),
            startedAt: Date().addingTimeInterval(-305),
            answers: ["s0q01-0": "B", "s0q02-1": "Toronto"]
        )
        let model = QuizModel(request: request(), dataSource: dataSource)
        await model.load()
        XCTAssertTrue(model.popQuizNeedsDecision)
        await model.tick()
        XCTAssertEqual(model.remainingSeconds, 0)
        XCTAssertFalse(model.submitted, "prep screen must not auto-submit")
        await model.resumePopQuiz()
        XCTAssertTrue(model.submitted)
        XCTAssertEqual(dataSource.recordedAttempts.count, 1)
        XCTAssertEqual(dataSource.recordedAttempts[0].timedOut, true)
    }

    func testPrepTickUpdatesRemainingAfterDeadlineWithoutSubmitting() async {
        let dataSource = FakeQuizDataSource(document: document())
        let hash = QuizDraftStore.contentHash(markdown)
        let key = dataSource.popQuizDraftKey(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "2026-10-25_03-00-00"
        )
        dataSource.sessions[key] = PopQuizSession(
            key: key,
            contentHash: hash,
            deadline: Date().addingTimeInterval(0.1),
            startedAt: Date(),
            answers: ["s0q01-0": "B"]
        )
        let model = QuizModel(request: request(), dataSource: dataSource)
        await model.load()
        XCTAssertTrue(model.popQuizNeedsDecision)
        try? await Task.sleep(nanoseconds: 250_000_000)
        await model.tick()
        XCTAssertEqual(model.remainingSeconds, 0)
        XCTAssertFalse(model.submitted)
        await model.resumePopQuiz()
        XCTAssertTrue(model.submitted)
        XCTAssertEqual(dataSource.recordedAttempts.first?.timedOut, true)
    }

    func testDraftOnlyStateIsRecoverableAndNotDeletedOnLoad() async {
        let dataSource = FakeQuizDataSource(document: document())
        let key = dataSource.popQuizDraftKey(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "2026-10-25_03-00-00"
        )
        let draftKey = key
        dataSource.drafts[draftKey] = QuizDraft(
            key: draftKey,
            contentHash: QuizDraftStore.contentHash(markdown),
            answers: ["s0q01-0": "B", "s0q02-1": "Toronto"],
            updatedAt: "now"
        )
        let model = QuizModel(request: request(), dataSource: dataSource)
        await model.load()
        XCTAssertTrue(model.popQuizNeedsDecision)
        XCTAssertNil(model.session)
        XCTAssertEqual(model.answers.count, 2)
        XCTAssertNotNil(dataSource.drafts[draftKey], "loading must not delete a draft-only state")

        model.startNewPopQuiz(preserveAnswers: true)
        XCTAssertEqual(model.session?.answers.count, 2)
        XCTAssertEqual(model.answers.count, 2)
        XCTAssertNil(dataSource.drafts[draftKey], "converted draft is consumed after the session is saved")
    }

    func testDraftOnlyStateSurvivesFailureBetweenDraftAndSessionWrites() async {
        let dataSource = FakeQuizDataSource(document: document())
        let key = dataSource.popQuizDraftKey(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "2026-10-25_03-00-00"
        )
        dataSource.drafts[key] = QuizDraft(
            key: key,
            contentHash: QuizDraftStore.contentHash(markdown),
            answers: ["s0q01-0": "B"],
            updatedAt: "now"
        )
        dataSource.saveSessionFails = true
        let model = QuizModel(request: request(), dataSource: dataSource)
        await model.load()
        XCTAssertEqual(model.answers["s0q01-0"], "B")

        model.startNewPopQuiz(preserveAnswers: true)
        XCTAssertTrue(model.popQuizNeedsDecision)
        XCTAssertNil(model.session)
        XCTAssertNotNil(model.error)
        XCTAssertNotNil(dataSource.drafts[key], "the draft must survive a failed session write")
    }

    func testUnitPersistenceFailureBannerDoesNotClaimRecorded() async {
        let unitMarkdown = """
        # Unit Test

        ## Questions
        01) [Fill-in-the-Blank] First ______.
        02) [Fill-in-the-Blank] Second ______.

        ## Answers
        01) alpha
        02) beta
        """
        let dataSource = FakeQuizDataSource(document: QuizDocumentLoad(
            courseId: "baf3m",
            scope: .unit(1),
            tab: "test",
            title: "Unit 1",
            fileName: "01.unit.test.md",
            markdown: unitMarkdown
        ))
        dataSource.unitPersisted = false
        dataSource.unitPersistenceError = "01.unit.test.md is read-only."
        let model = QuizModel(
            request: .unitTest(courseId: "baf3m", unitNumber: 1, unitTitle: "Unit 1"),
            dataSource: dataSource
        )
        await model.load()
        model.setAnswer(model.quiz.questions[0], value: "alpha")
        await model.submit()
        XCTAssertEqual(model.unitTestScorePersisted, false)
        XCTAssertEqual(model.unitTestPersistenceError, "01.unit.test.md is read-only.")
        XCTAssertEqual(model.unitTestScoreStatus, "Not saved: 01.unit.test.md is read-only.")
    }

    func testAttemptPersistenceFailureKeepsFinalSessionAndShowsError() async {
        let dataSource = FakeQuizDataSource(document: document())
        dataSource.recordError = NSError(
            domain: "test",
            code: 28,
            userInfo: [NSLocalizedDescriptionKey: "No space left on device."]
        )
        let model = QuizModel(request: request(), dataSource: dataSource)
        await model.load()
        model.startNewPopQuiz()
        dataSource.deletedSessionKeys.removeAll()
        model.setAnswer(model.quiz.questions[0], value: "B")
        await model.submit(timedOut: false)

        XCTAssertTrue(model.submitted)
        XCTAssertNotNil(model.historyError)
        XCTAssertNotNil(model.session?.submittedAt)
        XCTAssertEqual(model.session?.score, 1)
        XCTAssertTrue(dataSource.deletedSessionKeys.isEmpty)
    }

    func testReloadDiscardsDraftWhenQuizMarkdownChanged() async {
        let dataSource = FakeQuizDataSource(document: QuizDocumentLoad(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "test",
            title: "Lesson One",
            fileName: "01.01.test.md",
            markdown: markdown
        ))
        let lessonRequest = QuizRequest.lessonTest(
            courseId: "baf3m",
            lessonId: "01.01",
            lessonTitle: "Lesson One"
        )
        let key = dataSource.draftKey(courseId: "baf3m", scope: .lesson("01.01"), tab: "test")
        dataSource.drafts[key] = QuizDraft(
            key: key,
            contentHash: QuizDraftStore.contentHash(markdown),
            answers: ["s0q01-0": "B"],
            updatedAt: "now"
        )
        let model = QuizModel(request: lessonRequest, dataSource: dataSource)
        await model.load()
        XCTAssertEqual(model.answers["s0q01-0"], "B")

        dataSource.document = QuizDocumentLoad(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "test",
            title: "Lesson One",
            fileName: "01.01.test.md",
            markdown: markdown + "\n\nNew question text."
        )
        await model.load()
        XCTAssertTrue(model.answers.isEmpty)
        XCTAssertEqual(model.answer(for: model.quiz.questions[0]), "")
        await model.submit()
        XCTAssertEqual(model.result?.evaluations[model.quiz.questions[0].id]?.score, 0)
    }

    func testLoadClearsAnswersAndSessionBeforeReloading() async {
        let dataSource = FakeQuizDataSource(document: document())
        let model = QuizModel(request: request(), dataSource: dataSource)
        await model.load()
        model.setAnswer(model.quiz.questions[0], value: "B")
        XCTAssertEqual(model.answers.count, 1)
        await model.load()
        XCTAssertTrue(model.answers.isEmpty)
    }

    func testCourseTestHeuristicIsLabelledNotAuthoritative() async {
        let courseMarkdown = """
        # Course Test

        ## Questions
        01) [Application] Explain your reasoning. a) one b) two

        ## Answers
        01) Rubric: two points.
        """
        let dataSource = FakeQuizDataSource(document: QuizDocumentLoad(
            courseId: "baf3m",
            scope: .course,
            tab: "test",
            title: "BAF3M",
            fileName: "course.test.md",
            markdown: courseMarkdown
        ))
        let model = QuizModel(
            request: .courseTest(courseId: "baf3m", courseTitle: "BAF3M"),
            dataSource: dataSource
        )
        await model.load()
        XCTAssertTrue(model.request.isCourseTest)
        XCTAssertTrue(model.quiz.questions.contains { $0.type == .shortAnswer })
        model.setAnswer(
            model.quiz.questions[0],
            value: "a) first reason with enough detail b) second reason with enough detail"
        )
        await model.submit()
        XCTAssertEqual(model.result?.usedAI, false)
        XCTAssertEqual(model.result?.evaluations[model.quiz.questions[0].id]?.parts.count, 2)
    }
}

// MARK: - Prompt diff (app-facing)

final class PromptDiffViewDataTests: XCTestCase {
    func testDiffIsDeterministic() {
        let diff = PromptDiff.compare(active: "# A", bundled: "# B")
        XCTAssertEqual(diff.map(\.kind), [.removed, .added])
        XCTAssertEqual(diff.map(\.text), ["# A", "# B"])
    }
}

// MARK: - Prompt manager integration

final class PromptManagerAppTests: XCTestCase {
    private func makeRepository() throws -> (DataRoot, PromptRepository, URL) {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("PromptManager-\(UUID().uuidString)", isDirectory: true)
        let rootURL = base.appendingPathComponent("Library/Application Support/CourseDeck", isDirectory: true)
        let bundled = base.appendingPathComponent("Bundled", isDirectory: true)
        try FileManager.default.createDirectory(at: bundled, withIntermediateDirectories: true)
        try Data("# Summary\n\nBundled summary.".utf8)
            .write(to: bundled.appendingPathComponent("summary.md"))
        let root = DataRoot(rootURL: rootURL)
        try root.prepare()
        return (root, PromptRepository(root: root, bundledDirectory: bundled), base)
    }

    func testCreateRestoreAndProtectedDelete() async throws {
        let (root, repository, base) = try makeRepository()
        defer { try? FileManager.default.removeItem(at: base) }

        let created = try await repository.create(
            id: "exam_review",
            content: "# Exam Review\n\nCustom."
        )
        XCTAssertEqual(created.id, "exam_review")
        let active = try await repository.prompt(id: "exam_review")
        XCTAssertEqual(active?.source, .active)

        do {
            _ = try await repository.delete(id: "summary")
            XCTFail("protected prompt deleted")
        } catch let error as PromptRepositoryError {
            XCTAssertEqual(error, .protectedPrompt("summary"))
        }

        try await repository.save(id: "summary", content: "# Mine\n\nEdited.")
        _ = try await repository.restoreDefault(id: "summary")
        let restored = try await repository.prompt(id: "summary")
        XCTAssertEqual(restored?.content, "# Summary\n\nBundled summary.")
        let bak = root.promptsURL.appendingPathComponent("summary.md.bak")
        XCTAssertEqual(
            try String(contentsOf: bak, encoding: .utf8),
            "# Mine\n\nEdited."
        )
    }

    func testDiffShowsActiveAndBundledLines() {
        let diff = PromptDiff.compare(active: "# Active\nsame", bundled: "# Bundled\nsame")
        XCTAssertEqual(diff.map(\.kind), [.removed, .added, .unchanged])
    }
}
