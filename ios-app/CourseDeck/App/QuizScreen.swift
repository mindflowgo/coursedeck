import CourseDeckCore
import SwiftUI

// MARK: - Request

enum QuizRequest: Equatable, Identifiable, Sendable {
    case lessonTest(courseId: String, lessonId: String, lessonTitle: String)
    case courseTest(courseId: String, courseTitle: String)
    case unitTest(courseId: String, unitNumber: Int, unitTitle: String)
    case popQuiz(courseId: String, lessonId: String, timestamp: String, lessonTitle: String)

    var id: String {
        switch self {
        case let .lessonTest(courseId, lessonId, _): return "\(courseId):\(lessonId):test"
        case let .courseTest(courseId, _): return "\(courseId):course:test"
        case let .unitTest(courseId, unit, _): return "\(courseId):unit-\(unit):test"
        case let .popQuiz(courseId, lessonId, timestamp, _):
            return "\(courseId):\(lessonId):popquiz:\(timestamp)"
        }
    }

    var mode: QuizGradingMode {
        switch self {
        case .unitTest: return .unitTest
        case .popQuiz: return .popQuiz
        case .lessonTest, .courseTest: return .practice
        }
    }

    var isUnitTest: Bool {
        if case .unitTest = self { return true }
        return false
    }

    var isPopQuiz: Bool {
        if case .popQuiz = self { return true }
        return false
    }

    var isCourseTest: Bool {
        if case .courseTest = self { return true }
        return false
    }

    var courseId: String {
        switch self {
        case let .lessonTest(courseId, _, _): return courseId
        case let .courseTest(courseId, _): return courseId
        case let .unitTest(courseId, _, _): return courseId
        case let .popQuiz(courseId, _, _, _): return courseId
        }
    }

    var lessonId: String? {
        switch self {
        case let .lessonTest(_, lessonId, _): return lessonId
        case let .popQuiz(_, lessonId, _, _): return lessonId
        default: return nil
        }
    }

    var heading: String {
        switch self {
        case let .lessonTest(_, _, lessonTitle): return lessonTitle
        case let .courseTest(_, courseTitle): return courseTitle
        case let .unitTest(_, unitNumber, unitTitle): return unitTitle.isEmpty ? "Unit \(unitNumber)" : unitTitle
        case let .popQuiz(_, _, _, lessonTitle): return lessonTitle
        }
    }

    var scopeLabel: String {
        switch self {
        case .lessonTest: return "Practice Test"
        case .courseTest: return "Course Practice Test"
        case .unitTest: return "Unit Practice Test"
        case .popQuiz: return "Pop Quiz"
        }
    }

    var generationRequest: GenerationRequest? {
        switch self {
        case let .lessonTest(courseId, lessonId, title):
            return .lesson(courseId: courseId, lessonId: lessonId, title: title, tab: "test")
        case let .courseTest(courseId, title):
            return .courseDoc(courseId: courseId, title: title, kind: .test)
        case let .unitTest(courseId, unitNumber, title):
            return .unit(courseId: courseId, unitNumber: unitNumber, title: title, tab: "test")
        case .popQuiz:
            return nil
        }
    }
}

// MARK: - Data seam

@MainActor
protocol QuizDataSource: AnyObject {
    func loadQuizDocument(
        courseId: String,
        scope: ReaderScope,
        tab: String,
        title: String
    ) async throws -> QuizDocumentLoad
    func loadPopQuiz(courseId: String, lessonId: String, timestamp: String) async throws -> QuizDocumentLoad
    func popQuizzes(courseId: String, lessonId: String) async -> [PopQuizReference]
    func loadDraft(key: String, contentHash: String) -> QuizDraft?
    func saveDraft(key: String, contentHash: String, answers: [String: String])
    func deleteDraft(key: String)
    func loadPopQuizSession(key: String, contentHash: String) -> PopQuizSession?
    @discardableResult
    func savePopQuizSession(_ session: PopQuizSession) -> Bool
    func deletePopQuizSession(key: String)
    func draftKey(courseId: String, scope: ReaderScope, tab: String) -> String
    func popQuizDraftKey(courseId: String, lessonId: String, timestamp: String) -> String
    func gradeUnitTest(
        courseId: String,
        unitNumber: Int,
        quiz: ParsedQuiz,
        answers: [String: String]
    ) async throws -> UnitTestSubmission
    func gradeLocally(quiz: ParsedQuiz, answers: [String: String], mode: QuizGradingMode) async -> QuizGradeResult
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
    ) throws -> QuizAttempt
    func quizAttempts(courseId: String, lessonId: String?, kind: QuizAttemptKind?) -> [QuizAttempt]
    func generatePopQuiz(courseId: String, lessonId: String, force: Bool) async throws -> PopQuizReference
    func bumpDataRevision()
}

extension AppServices: QuizDataSource {}

// MARK: - Model

@MainActor
final class QuizModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case ready
        case corrupt(String)
        case failed(String)
    }

    @Published private(set) var loadState: LoadState = .loading
    @Published private(set) var quiz = ParsedQuiz()
    @Published private(set) var metadata = QuizDocumentMetadata()
    @Published private(set) var result: QuizGradeResult?
    @Published private(set) var attempts: [QuizAttempt] = []
    @Published private(set) var remainingSeconds: Int = PopQuizSession.defaultDuration
    @Published private(set) var submitted = false
    @Published private(set) var isSubmitting = false
    @Published private(set) var popQuizNeedsDecision = false
    @Published private(set) var unitTestScorePersisted = true
    @Published private(set) var unitTestPersistenceError: String?
    @Published var answers: [String: String] = [:]
    @Published var error: String?
    @Published var toast: String?
    @Published var historyError: String?

    private(set) var request: QuizRequest
    private(set) var document: QuizDocumentLoad?
    private(set) var session: PopQuizSession?
    private(set) var contentHash = ""
    private(set) var draftKey = ""
    private var draftTask: Task<Void, Never>?
    private let dataSource: any QuizDataSource

    init(
        request: QuizRequest,
        dataSource: any QuizDataSource = AppServices.shared
    ) {
        self.request = request
        self.dataSource = dataSource
    }

    var isPopQuiz: Bool { request.isPopQuiz }
    var isUnitTest: Bool { request.isUnitTest }
    var isPractice: Bool { !isPopQuiz && !isUnitTest }
    var canSubmit: Bool {
        !submitted && !isSubmitting && quiz.hasQuestions
    }
    var answeredCount: Int {
        answers.values.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count
    }
    var timerText: String {
        let minutes = remainingSeconds / 60
        let seconds = remainingSeconds % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }

    var unitTestScoreStatus: String? {
        guard isUnitTest, submitted else { return nil }
        if unitTestScorePersisted {
            return "Recorded to the unit test frontmatter."
        }
        let reason = unitTestPersistenceError ?? "the test file is read-only."
        return "Not saved: \(reason)"
    }

    func answer(for question: QuizQuestion) -> String {
        answers[question.id] ?? ""
    }

    func setAnswer(_ question: QuizQuestion, value: String) {
        answers[question.id] = value
        if isPopQuiz, var session {
            session.answers = answers
            self.session = session
        }
        scheduleDraftSave()
    }

    func load() async {
        loadState = .loading
        error = nil
        result = nil
        submitted = false
        popQuizNeedsDecision = false
        unitTestScorePersisted = true
        unitTestPersistenceError = nil
        historyError = nil
        answers = [:]
        session = nil
        do {
            let loaded = try await loadDocument()
            document = loaded
            let parsed = QuestionParser.parse(loaded.markdown)
            quiz = parsed
            metadata = QuizDocumentMetadata.read(from: loaded.markdown)
            contentHash = QuizDraftStore.contentHash(loaded.markdown)
            draftKey = draftKey(for: loaded)
            if !parsed.hasQuestions {
                let message = parsed.issues.map(\.message).joined(separator: " ")
                loadState = .corrupt(message.isEmpty ? "No questions could be parsed." : message)
                return
            }
            if !parsed.missingAnswers.isEmpty {
                toast = "\(parsed.missingAnswers.count) question(s) have no answer key in this document."
            }
            if let draft = dataSource.loadDraft(key: draftKey, contentHash: contentHash) {
                answers = draft.answers
            }
            if isPopQuiz {
                await loadPopQuizSession(loaded: loaded)
            }
            loadState = .ready
            if isPopQuiz {
                await tick()
            }
            await refreshAttempts()
        } catch {
            loadState = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    func reload() async {
        if isPopQuiz, let document {
            _ = document
        }
        await load()
    }

    func submit(timedOut: Bool = false) async {
        guard !submitted, !isSubmitting, quiz.hasQuestions else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        draftTask?.cancel()

        if isUnitTest {
            do {
                let submission = try await dataSource.gradeUnitTest(
                    courseId: request.courseId,
                    unitNumber: unitNumber,
                    quiz: quiz,
                    answers: answers
                )
                result = submission.result
                submitted = true
                unitTestScorePersisted = submission.persisted
                unitTestPersistenceError = submission.persistenceError
                metadata = QuizDocumentMetadata(
                    lastAttemptDate: submission.attempt?.date,
                    score: submission.result.score,
                    totalQuestions: submission.result.total,
                    percentage: submission.result.percentage
                )
                if !submission.persisted, let message = submission.persistenceError {
                    toast = "Score calculated but not saved: \(message)"
                }
                if let attemptError = submission.attemptError {
                    historyError = "Score saved, but attempt history could not be saved: \(attemptError)"
                }
                await refreshAttempts()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            return
        }

        let gradingMode: QuizGradingMode = isPopQuiz ? .popQuiz : .practice
        let grade = await dataSource.gradeLocally(quiz: quiz, answers: answers, mode: gradingMode)
        result = grade
        if isPopQuiz {
            guard let session else {
                submitted = true
                return
            }
            let duration = session.elapsedSeconds()
            var finalSession = session
            finalSession.answers = answers
            finalSession.score = grade.score
            finalSession.total = grade.total
            finalSession.durationSeconds = duration
            finalSession.timedOut = timedOut
            finalSession.submittedAt = Date()
            self.session = finalSession
            do {
                _ = try dataSource.recordPopQuizAttempt(
                    courseId: request.courseId,
                    lessonId: sessionLessonId,
                    timestamp: timestamp,
                    title: quiz.title,
                    score: grade.score,
                    total: grade.total,
                    percentage: grade.percentage,
                    answers: answers,
                    durationSeconds: duration,
                    timedOut: timedOut,
                    session: finalSession
                )
                self.session = nil
                historyError = nil
            } catch {
                historyError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        } else {
            dataSource.deleteDraft(key: draftKey)
        }
        submitted = true
        await refreshAttempts()
    }

    func tick() async {
        guard isPopQuiz, let session else { return }
        // Keep the prep-screen countdown live even while waiting for the
        // Resume/Start decision. Only Resume may submit an expired session.
        remainingSeconds = session.remainingSeconds()
        guard !submitted, !popQuizNeedsDecision else { return }
        if session.hasExpired() {
            await submit(timedOut: true)
        }
    }

    func persistNow() {
        draftTask?.cancel()
        saveDraftNow()
    }

    func retake() async {
        if isPopQuiz {
            startNewPopQuiz()
            return
        }
        answers = [:]
        result = nil
        submitted = false
        error = nil
        toast = nil
        historyError = nil
        unitTestScorePersisted = true
        unitTestPersistenceError = nil
        dataSource.deleteDraft(key: draftKey)
    }

    func refreshAttempts() async {
        switch request {
        case .popQuiz:
            guard let lessonId = request.lessonId else { return }
            attempts = dataSource.quizAttempts(
                courseId: request.courseId,
                lessonId: lessonId,
                kind: .popQuiz
            ).filter { $0.quizKey == timestamp }
        case .unitTest:
            let fileName = document?.fileName ?? ""
            attempts = dataSource.quizAttempts(
                courseId: request.courseId,
                lessonId: nil,
                kind: .unitTest
            ).filter { $0.quizKey == fileName }
        case .lessonTest, .courseTest:
            attempts = []
        }
    }

    func regeneratePopQuiz() async {
        guard case let .popQuiz(courseId, lessonId, _, lessonTitle) = request else { return }
        do {
            _ = try await dataSource.generatePopQuiz(courseId: courseId, lessonId: lessonId, force: true)
            let newest = (await dataSource.popQuizzes(courseId: courseId, lessonId: lessonId)).first
            guard let newest else {
                error = "The pop quiz was generated but could not be listed."
                return
            }
            request = .popQuiz(
                courseId: courseId,
                lessonId: lessonId,
                timestamp: newest.timestamp,
                lessonTitle: lessonTitle
            )
            await load()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: - Private

    private var unitNumber: Int {
        if case let .unitTest(_, unitNumber, _) = request { return unitNumber }
        return 0
    }

    private var timestamp: String {
        if case let .popQuiz(_, _, timestamp, _) = request { return timestamp }
        return ""
    }

    private var sessionLessonId: String {
        request.lessonId ?? ""
    }

    private func loadDocument() async throws -> QuizDocumentLoad {
        switch request {
        case let .lessonTest(courseId, lessonId, lessonTitle):
            return try await dataSource.loadQuizDocument(
                courseId: courseId,
                scope: .lesson(lessonId),
                tab: "test",
                title: lessonTitle
            )
        case let .courseTest(courseId, courseTitle):
            return try await dataSource.loadQuizDocument(
                courseId: courseId,
                scope: .course,
                tab: "test",
                title: courseTitle
            )
        case let .unitTest(courseId, unitNumber, unitTitle):
            return try await dataSource.loadQuizDocument(
                courseId: courseId,
                scope: .unit(unitNumber),
                tab: "test",
                title: unitTitle
            )
        case let .popQuiz(courseId, lessonId, timestamp, lessonTitle):
            var loaded = try await dataSource.loadPopQuiz(
                courseId: courseId,
                lessonId: lessonId,
                timestamp: timestamp
            )
            loaded.title = lessonTitle
            return loaded
        }
    }

    private func draftKey(for document: QuizDocumentLoad) -> String {
        if isPopQuiz {
            return dataSource.popQuizDraftKey(
                courseId: request.courseId,
                lessonId: sessionLessonId,
                timestamp: timestamp
            )
        }
        return dataSource.draftKey(
            courseId: document.courseId,
            scope: document.scope,
            tab: document.tab
        )
    }

    private func loadPopQuizSession(loaded: QuizDocumentLoad) async {
        let key = dataSource.popQuizDraftKey(
            courseId: request.courseId,
            lessonId: sessionLessonId,
            timestamp: timestamp
        )
        if let existing = dataSource.loadPopQuizSession(key: key, contentHash: contentHash) {
            session = existing
            answers = existing.answers
            remainingSeconds = existing.remainingSeconds()
            if existing.submittedAt != nil {
                historyError = "This attempt was graded but its history record could not be saved."
            }
        } else {
            // Draft-only state (for example a crash between writing the draft
            // and the session): keep the answers recoverable. Loading never
            // starts a timer or deletes the draft.
            session = nil
            if let draft = dataSource.loadDraft(key: draftKey, contentHash: contentHash) {
                answers = draft.answers
            } else {
                answers = [:]
            }
            remainingSeconds = PopQuizSession.defaultDuration
        }
        popQuizNeedsDecision = true
        _ = loaded
    }

    func startNewPopQuiz(preserveAnswers: Bool = false) {
        let key = dataSource.popQuizDraftKey(
            courseId: request.courseId,
            lessonId: sessionLessonId,
            timestamp: timestamp
        )
        let restoredAnswers = preserveAnswers ? answers : [:]
        answers = restoredAnswers
        result = nil
        submitted = false
        historyError = nil
        let newSession = PopQuizSession(
            key: key,
            contentHash: contentHash,
            deadline: Date().addingTimeInterval(TimeInterval(PopQuizSession.defaultDuration)),
            startedAt: Date(),
            answers: restoredAnswers
        )
        // Save the new session before removing the draft-only state so a
        // failure between writes cannot lose the recovered answers.
        guard dataSource.savePopQuizSession(newSession) else {
            error = "Could not start the pop-quiz timer. Your saved answers are still retained; try again."
            popQuizNeedsDecision = true
            return
        }
        dataSource.deleteDraft(key: draftKey)
        session = newSession
        remainingSeconds = newSession.remainingSeconds()
        popQuizNeedsDecision = false
    }

    func resumePopQuiz() async {
        guard let session else { return }
        answers = session.answers
        remainingSeconds = session.remainingSeconds()
        popQuizNeedsDecision = false
        if session.hasExpired() {
            await submit(timedOut: true)
        }
    }

    func retrySavingHistory() async {
        guard let session, session.submittedAt != nil else { return }
        do {
            let total = session.total ?? quiz.questions.count
            let score = session.score ?? 0
            _ = try dataSource.recordPopQuizAttempt(
                courseId: request.courseId,
                lessonId: sessionLessonId,
                timestamp: timestamp,
                title: quiz.title,
                score: score,
                total: total,
                percentage: total > 0 ? Int(((score / Double(total)) * 100).rounded()) : 0,
                answers: session.answers,
                durationSeconds: session.durationSeconds,
                timedOut: session.timedOut,
                session: session
            )
            self.session = nil
            historyError = nil
            toast = "Attempt history saved."
            await refreshAttempts()
        } catch {
            historyError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func scheduleDraftSave() {
        guard !submitted, !popQuizNeedsDecision else { return }
        draftTask?.cancel()
        draftTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            self?.saveDraftNow()
        }
    }

    private func saveDraftNow() {
        guard !submitted, !popQuizNeedsDecision, !contentHash.isEmpty else { return }
        dataSource.saveDraft(key: draftKey, contentHash: contentHash, answers: answers)
        if isPopQuiz, var session {
            session.answers = answers
            self.session = session
            dataSource.savePopQuizSession(session)
        }
    }
}

// MARK: - Screen

struct QuizScreen: View {
    @StateObject private var model: QuizModel
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var services: AppServices
    @State private var showingAttempts = false
    @State private var generationRequest: GenerationRequest?

    init(request: QuizRequest) {
        _model = StateObject(wrappedValue: QuizModel(request: request))
    }

    var body: some View {
        Group {
            switch model.loadState {
            case .loading:
                ProgressView("Loading quiz…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .corrupt:
                corruptView
            case let .failed(message):
                ContentUnavailableView {
                    Label("Quiz unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    if let request = model.request.generationRequest {
                        Button("Generate this test") {
                            generationRequest = request
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("quiz.generateMissing")
                    }
                    Button("Reload") {
                        Task { await model.reload() }
                    }
                    .buttonStyle(.bordered)
                }
            case .ready:
                if model.isPopQuiz, model.popQuizNeedsDecision, !model.submitted {
                    popQuizPrepView
                } else {
                    quizView
                }
            }
        }
        .navigationTitle(model.request.scopeLabel)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task(id: model.request.id) { await model.load() }
        .task(id: timerTaskID) {
            guard model.isPopQuiz, !model.submitted else { return }
            while !Task.isCancelled, !model.submitted {
                await model.tick()
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                model.persistNow()
            } else {
                Task { await model.tick() }
            }
        }
        .onDisappear { model.persistNow() }
        .sheet(isPresented: $showingAttempts) {
            QuizAttemptHistoryView(
                attempts: model.attempts,
                title: model.isPopQuiz ? "Pop Quiz Attempts" : "Unit Test Attempts"
            )
        }
        .sheet(item: $generationRequest) { request in
            GenerationSheet(request: request) { _ in
                model.toast = "Generation queued. Reload when it completes."
            }
            .environmentObject(services)
        }
        .alert("Quiz error", isPresented: errorBinding) {
            Button("OK", role: .cancel) { model.error = nil }
        } message: {
            Text(model.error ?? "")
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                Text(toast)
                    .font(.footnote)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.bottom, 18)
                    .task {
                        try? await Task.sleep(nanoseconds: 2_200_000_000)
                        model.toast = nil
                    }
            }
        }
        .accessibilityIdentifier("quiz.root")
    }

    private var timerTaskID: String {
        "\(model.request.id)-\(model.isPopQuiz)-\(model.submitted)-\(model.popQuizNeedsDecision)"
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { model.error != nil },
            set: { if !$0 { model.error = nil } }
        )
    }

    private var corruptView: some View {
        ContentUnavailableView {
            Label("This quiz could not be parsed", systemImage: "doc.questionmark")
        } description: {
            if case let .corrupt(message) = model.loadState {
                Text(message)
            }
        } actions: {
            if model.isPopQuiz {
                Button("Regenerate pop quiz") {
                    Task { await model.regeneratePopQuiz() }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("quiz.regenerate")
            }
            Button("Reload") {
                Task { await model.reload() }
            }
            .buttonStyle(.bordered)
        }
    }

    private var popQuizPrepView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(model.quiz.title)
                        .font(.title2.weight(.semibold))
                    Text("Timed pop quiz · \(model.quiz.questions.count) questions")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Label("5-minute timer", systemImage: "timer")
                        .font(.headline)
                    Text("The deadline is absolute and keeps counting while the app is in the background. Loading this saved quiz does not start or reset the timer.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))

                if let session = model.session {
                    if session.submittedAt != nil {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("Attempt history needs attention", systemImage: "exclamationmark.triangle")
                                .font(.headline)
                                .foregroundStyle(.orange)
                            Text("The quiz was graded and its final timer state kept, but the attempt record could not be saved.")
                                .font(.callout)
                            Button {
                                Task { await model.retrySavingHistory() }
                            } label: {
                                Label("Retry saving results", systemImage: "arrow.clockwise")
                            }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("quiz.pop.retryHistory")
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
                    } else {
                        Button {
                            Task { await model.resumePopQuiz() }
                        } label: {
                            Label("Resume (\(model.timerText))", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .accessibilityIdentifier("quiz.pop.resume")
                    }
                }

                if let historyError = model.historyError {
                    Text(historyError)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }

                if model.session == nil, !model.answers.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Saved answers recovered", systemImage: "arrow.counterclockwise.circle")
                            .font(.headline)
                        Text("A draft with \(model.answers.count) answer(s) survived without a timer state. Resume with those answers, or start fresh.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Button {
                            model.startNewPopQuiz(preserveAnswers: true)
                        } label: {
                            Label("Resume with saved answers (5:00)", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .accessibilityIdentifier("quiz.pop.resumeDraft")
                        Button("Start fresh", role: .destructive) {
                            model.startNewPopQuiz(preserveAnswers: false)
                        }
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("quiz.pop.startFresh")
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                } else {
                    Button {
                        model.startNewPopQuiz(preserveAnswers: false)
                    } label: {
                        Label(
                            model.session == nil ? "Start quiz (5:00)" : "Try Again",
                            systemImage: "arrow.counterclockwise"
                        )
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .accessibilityIdentifier("quiz.pop.start")
                    Text(model.session == nil
                         ? "Starting creates the first absolute 5-minute deadline."
                         : "Only Try Again creates a new 5-minute deadline.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(18)
            .frame(maxWidth: 700)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .accessibilityIdentifier("quiz.prep")
    }

    private var quizView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if model.isPopQuiz, !model.submitted {
                    timerBadge
                }
                if model.isUnitTest, !model.submitted, model.metadata.lastAttemptDate != nil {
                    previousAttemptBanner
                }
                if let result = model.result {
                    scoreBanner(result)
                }
                ForEach(model.quiz.questions) { question in
                    QuizQuestionCard(model: model, question: question)
                }
                footer
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .accessibilityIdentifier("quiz.list")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(model.quiz.title)
                .font(.title2.weight(.semibold))
            Text("\(model.request.scopeLabel) · \(model.quiz.questions.count) Questions")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if model.isPractice {
                Text("Practice results are not saved to the test file.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if model.isUnitTest {
                Text("Your score and attempt date are saved. Raw answers are never stored in the test file.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if model.request.isCourseTest,
                      model.quiz.questions.contains(where: { $0.type == .shortAnswer }) {
                Text("Short-answer responses use a heuristic review score; this is not an authoritative AI grade.")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else {
                Text("5-minute timer · answers restore after relaunch · attempts are stored on this device.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var timerBadge: some View {
        HStack(spacing: 10) {
            Image(systemName: "clock")
            Text(model.timerText)
                .font(.system(.title3, design: .monospaced).weight(.bold))
            Text("remaining")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .foregroundStyle(model.remainingSeconds <= 30 ? Color.red : Color.primary)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityIdentifier("quiz.timer")
    }

    private var previousAttemptBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "rosette")
                .font(.title2)
                .foregroundStyle(.indigo)
            VStack(alignment: .leading, spacing: 2) {
                Text("Last attempt \(model.metadata.lastAttemptDate ?? "")")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("Score \(scoreText(model.metadata.score ?? 0)) / \(model.metadata.totalQuestions ?? model.quiz.questions.count) (\(model.metadata.percentage ?? 0)%)")
                    .font(.subheadline.weight(.semibold))
            }
            Spacer()
            Text("Ready for a new attempt")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(Color.indigo.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
    }

    private func scoreBanner(_ result: QuizGradeResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(result.percentage >= 50 ? Color.green : Color.orange)
                Text("Score \(scoreText(result.score)) / \(result.total) (\(result.percentage)%)")
                    .font(.headline)
                if result.usedAI {
                    Text("AI-graded")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.blue.opacity(0.15), in: Capsule())
                }
                if model.isPopQuiz, let attempt = model.attempts.first {
                    Text(attempt.timedOut ? "Timer expired" : "Time \(durationText(attempt.durationSeconds))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let aiError = result.aiError {
                Text("AI grading was unavailable, so deterministic fallbacks were used. \(aiError)")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if model.isUnitTest, let status = model.unitTestScoreStatus {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(model.unitTestScorePersisted ? Color.secondary : Color.red)
            }
            if model.request.isCourseTest,
               model.quiz.questions.contains(where: { $0.type == .shortAnswer }) {
                Text("Short-answer responses in course practice tests use a heuristic review score. Treat it as formative feedback, not an authoritative grade.")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let historyError = model.historyError {
                Text(historyError)
                    .font(.caption)
                    .foregroundStyle(.orange)
                if model.isPopQuiz, model.session?.submittedAt != nil {
                    Button("Retry saving results") {
                        Task { await model.retrySavingHistory() }
                    }
                    .font(.caption.weight(.semibold))
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityIdentifier("quiz.score")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.submitted {
                Button {
                    Task { await model.retake() }
                } label: {
                    Label(model.isPopQuiz ? "Try Again" : "Retake Test", systemImage: "arrow.counterclockwise")
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("quiz.retake")
            } else {
                HStack {
                    Text("\(model.answeredCount) of \(model.quiz.questions.count) answered")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        Task { await model.submit(timedOut: false) }
                    } label: {
                        if model.isSubmitting {
                            ProgressView()
                        } else {
                            Text(model.isUnitTest ? "Submit Unit Test" : model.isPopQuiz ? "Submit Pop Quiz" : "Submit Practice Test")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canSubmit)
                    .accessibilityIdentifier("quiz.submit")
                }
            }
            if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .padding(.top, 4)
        .padding(.bottom, 30)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if model.isPopQuiz || model.isUnitTest {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingAttempts = true
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                }
                .accessibilityLabel("Attempt history")
                .accessibilityIdentifier("quiz.attempts")
            }
        }
    }

    private func scoreText(_ score: Double) -> String {
        score == score.rounded() ? String(Int(score)) : String(format: "%.1f", score)
    }

    private func durationText(_ seconds: Int) -> String {
        "\(seconds / 60)m \(seconds % 60)s"
    }
}

// MARK: - Question card

private struct QuizQuestionCard: View {
    @ObservedObject var model: QuizModel
    let question: QuizQuestion

    private var evaluation: QuizQuestionEvaluation? {
        model.result?.evaluations[question.id]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text("Q\(question.number)")
                            .font(.caption.monospaced().weight(.bold))
                            .foregroundStyle(.secondary)
                        if let category = question.category, !category.isEmpty {
                            Text(category)
                                .font(.caption2.weight(.medium))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .background(Color.secondary.opacity(0.12), in: Capsule())
                        }
                        if question.type == .fillInTheBlank {
                            Text("Fill-in-the-Blank")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.orange)
                        } else if question.type == .shortAnswer {
                            Text("Short Answer")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.indigo)
                        }
                    }
                    QuizMarkdownText(text: question.prompt)
                        .font(.body)
                }
                Spacer()
                if let evaluation {
                    resultBadge(evaluation)
                }
            }

            switch question.type {
            case .multipleChoice:
                optionList
            case .fillInTheBlank:
                fillInField
            case .shortAnswer:
                shortAnswerField
            }

            if let evaluation {
                feedback(evaluation)
            }
            if model.submitted, let explanation = question.explanation, !explanation.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Explanation")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    QuizMarkdownText(text: explanation)
                        .font(.callout)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityIdentifier("quiz.question.\(question.number)")
    }

    private var optionList: some View {
        VStack(spacing: 8) {
            ForEach(question.options) { option in
                Button {
                    model.setAnswer(question, value: option.letter)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Text(option.letter)
                            .font(.caption.monospaced().weight(.bold))
                            .frame(width: 24, height: 24)
                            .background(optionBackground(option), in: Circle())
                            .foregroundStyle(optionForeground(option))
                        QuizMarkdownText(text: option.text)
                            .font(.callout)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 0)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(optionRowBackground(option), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(optionBorder(option), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .disabled(model.submitted)
                .accessibilityLabel("Option \(option.letter): \(option.text)")
                .accessibilityValue(isSelected(option) ? "Selected" : "")
            }
        }
    }

    private var fillInField: some View {
        Group {
            if model.submitted {
                Text(model.answer(for: question).isEmpty ? "(No answer provided)" : model.answer(for: question))
                    .font(.callout)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
            } else {
                TextField("Type your answer here…", text: binding)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("quiz.fill.\(question.number)")
            }
        }
    }

    private var shortAnswerField: some View {
        Group {
            if model.submitted {
                Text(model.answer(for: question).isEmpty ? "(No response provided)" : model.answer(for: question))
                    .font(.callout)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
            } else {
                TextEditor(text: binding)
                    .font(.callout)
                    .frame(minHeight: 110)
                    .padding(6)
                    .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color.secondary.opacity(0.25), lineWidth: 1)
                    )
                    .accessibilityIdentifier("quiz.short.\(question.number)")
            }
        }
    }

    private var binding: Binding<String> {
        Binding(
            get: { model.answer(for: question) },
            set: { model.setAnswer(question, value: $0) }
        )
    }

    private func resultBadge(_ evaluation: QuizQuestionEvaluation) -> some View {
        Group {
            if evaluation.isCorrect {
                Label("Correct", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else if evaluation.score > 0 {
                Text("Partially correct (\(scoreText(evaluation.score)) / 1)")
                    .foregroundStyle(.orange)
            } else {
                Label("Incorrect", systemImage: "xmark.circle.fill")
                    .foregroundStyle(.red)
            }
        }
        .font(.caption.weight(.semibold))
    }

    private func feedback(_ evaluation: QuizQuestionEvaluation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if !evaluation.parts.isEmpty {
                let correct = evaluation.parts.filter(\.isCorrect).count
                Text("Part evaluation: \(correct) of \(evaluation.parts.count) correct")
                    .font(.caption.weight(.semibold))
                ForEach(Array(evaluation.parts.enumerated()), id: \.offset) { _, part in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: part.isCorrect ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(part.isCorrect ? Color.green : Color.red)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(part.label ?? part.part ?? "Part")
                                .font(.caption.weight(.semibold))
                            if let text = part.feedback, !text.isEmpty {
                                Text(text).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if let text = evaluation.feedback, !text.isEmpty {
                QuizMarkdownText(text: text)
                    .font(.callout)
            }
            if !evaluation.isCorrect {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Correct answer / rubric")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    QuizMarkdownText(text: question.correctAnswer)
                        .font(.callout)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            (evaluation.isCorrect ? Color.green : evaluation.score > 0 ? Color.orange : Color.red)
                .opacity(0.08),
            in: RoundedRectangle(cornerRadius: 10)
        )
    }

    private func isSelected(_ option: QuizOption) -> Bool {
        model.answer(for: question) == option.letter
    }

    private func optionBackground(_ option: QuizOption) -> Color {
        if model.submitted {
            if option.letter == question.correctAnswer { return .green }
            if isSelected(option) { return .red }
            return Color.secondary.opacity(0.15)
        }
        return isSelected(option) ? Color.accentColor : Color.secondary.opacity(0.15)
    }

    private func optionForeground(_ option: QuizOption) -> Color {
        if model.submitted {
            if option.letter == question.correctAnswer || isSelected(option) { return .white }
        }
        return isSelected(option) ? .white : .primary
    }

    private func optionRowBackground(_ option: QuizOption) -> Color {
        if model.submitted {
            if option.letter == question.correctAnswer { return .green.opacity(0.10) }
            if isSelected(option) { return .red.opacity(0.10) }
        }
        return isSelected(option) ? Color.accentColor.opacity(0.10) : .clear
    }

    private func optionBorder(_ option: QuizOption) -> Color {
        if model.submitted {
            if option.letter == question.correctAnswer { return .green }
            if isSelected(option) { return .red }
        }
        return isSelected(option) ? Color.accentColor : Color.secondary.opacity(0.22)
    }

    private func scoreText(_ score: Double) -> String {
        score == score.rounded() ? String(Int(score)) : String(format: "%.2g", score)
    }
}

// MARK: - Attempt history

struct QuizAttemptHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    let attempts: [QuizAttempt]
    let title: String

    var body: some View {
        NavigationStack {
            List {
                if attempts.isEmpty {
                    Text("No attempts recorded for this quiz.")
                        .foregroundStyle(.secondary)
                }
                ForEach(attempts) { attempt in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("\(scoreText(attempt.score)) / \(attempt.total) (\(attempt.percentage)%)")
                                .font(.headline)
                            if attempt.timedOut {
                                Text("Timed out")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.red)
                            }
                        }
                        Text(attempt.date)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Duration \(attempt.durationSeconds / 60)m \(attempt.durationSeconds % 60)s")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("quiz.attempt.\(attempt.id)")
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func scoreText(_ score: Double) -> String {
        score == score.rounded() ? String(Int(score)) : String(format: "%.1f", score)
    }
}

// MARK: - Inline Markdown

struct QuizMarkdownText: View {
    let text: String

    var body: some View {
        Text(attributed)
    }

    private var attributed: AttributedString {
        guard let parsed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        ) else {
            return AttributedString(text)
        }
        return parsed
    }
}
