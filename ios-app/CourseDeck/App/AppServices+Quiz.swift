import CourseDeckCore
import Foundation

// MARK: - Quiz editing, drafts, attempts, and grading actions.

struct QuizDocumentLoad: Equatable {
    var courseId: String
    var scope: ReaderScope
    var tab: String
    var title: String
    var fileName: String
    var markdown: String
}

struct UnitTestSubmission {
    var result: QuizGradeResult
    var persisted: Bool
    var persistenceError: String?
    var attempt: QuizAttempt?
    var attemptError: String?
}

@MainActor
extension AppServices {
    // MARK: Document loading

    func loadQuizDocument(
        courseId: String,
        scope: ReaderScope,
        tab: String,
        title: String
    ) async throws -> QuizDocumentLoad {
        let fileName: String
        let markdown: String?
        switch scope {
        case let .lesson(lessonId):
            fileName = try PathValidator.tabFileName(lessonId: lessonId, tab: tab)
            markdown = try await repository.tabContent(courseId: courseId, lessonId: lessonId, tab: tab)
        case let .unit(number):
            fileName = try PathValidator.unitDocFileName(unit: number, tab: tab)
            markdown = try await repository.unitDocument(courseId: courseId, unit: number, tab: tab)
        case .course:
            fileName = try PathValidator.courseDocFileName(tab: tab)
            markdown = try await repository.courseDocument(courseId: courseId, tab: tab)
        }
        guard let markdown else {
            throw ReaderDocumentError.notGenerated(title)
        }
        return QuizDocumentLoad(
            courseId: courseId,
            scope: scope,
            tab: tab,
            title: title,
            fileName: fileName,
            markdown: markdown
        )
    }

    func loadPopQuiz(
        courseId: String,
        lessonId: String,
        timestamp: String
    ) async throws -> QuizDocumentLoad {
        guard let markdown = try await repository.popQuizContent(
            courseId: courseId,
            lessonId: lessonId,
            timestamp: timestamp
        ) else {
            throw ReaderDocumentError.missingFile("pop quiz \(timestamp)")
        }
        return QuizDocumentLoad(
            courseId: courseId,
            scope: .lesson(lessonId),
            tab: "popquiz",
            title: "Pop Quiz",
            fileName: "\(lessonId).popquiz.\(timestamp).md",
            markdown: markdown
        )
    }

    func popQuizzes(courseId: String, lessonId: String) async -> [PopQuizReference] {
        (try? await repository.listPopQuizzes(courseId: courseId, lessonId: lessonId)) ?? []
    }

    // MARK: Editor snapshots

    func markdownSnapshot(for target: ReaderTarget) async throws -> DocumentSnapshot {
        try await repository.documentSnapshot(
            courseId: target.courseId,
            scope: generatedScope(for: target.scope),
            tab: target.tab
        )
    }

    @discardableResult
    func saveMarkdown(
        target: ReaderTarget,
        content: String,
        expectedSHA256: String,
        force: Bool = false
    ) async throws -> DocumentSnapshot {
        try await repository.compareAndSaveDocument(
            courseId: target.courseId,
            scope: generatedScope(for: target.scope),
            tab: target.tab,
            content: content,
            expectedSHA256: expectedSHA256,
            force: force
        )
    }

    func generatedScope(for scope: ReaderScope) -> GeneratedDocumentScope {
        switch scope {
        case let .lesson(lessonId): return .lesson(lessonId)
        case let .unit(number): return .unit(number)
        case .course: return .course
        }
    }

    func documentURL(for target: ReaderTarget) throws -> URL {
        let course = try dataRoot.courseURL(target.courseId)
        return try PathValidator.safeJoin(base: course, target.fileName())
    }

    // MARK: Custom tabs

    @discardableResult
    func createCustomTab(
        courseId: String,
        scope: ReaderScope,
        tab: String
    ) async throws -> DocumentSnapshot {
        try await repository.createCustomDocument(
            courseId: courseId,
            scope: generatedScope(for: scope),
            tab: tab
        )
    }

    @discardableResult
    func deleteCustomTab(
        courseId: String,
        scope: ReaderScope,
        tab: String
    ) async throws -> URL? {
        try await repository.deleteCustomDocument(
            courseId: courseId,
            scope: generatedScope(for: scope),
            tab: tab
        )
    }

    func trashedDocuments(courseId: String) async -> [TrashedDocument] {
        (try? await repository.listTrashedDocuments(courseId: courseId)) ?? []
    }

    @discardableResult
    func restoreTrashedDocument(id: String) async throws -> DocumentSnapshot {
        try await repository.restoreTrashedDocument(id: id)
    }

    // MARK: Drafts

    func draftKey(courseId: String, scope: ReaderScope, tab: String) -> String {
        switch scope {
        case let .lesson(lessonId): return "\(courseId):\(lessonId):\(tab)"
        case let .unit(number): return "\(courseId):unit-\(number):\(tab)"
        case .course: return "\(courseId):course:\(tab)"
        }
    }

    func popQuizDraftKey(courseId: String, lessonId: String, timestamp: String) -> String {
        "\(courseId):\(lessonId):popquiz:\(timestamp)"
    }

    func loadDraft(key: String, contentHash: String) -> QuizDraft? {
        drafts.load(key: key, contentHash: contentHash)
    }

    func saveDraft(key: String, contentHash: String, answers: [String: String]) {
        let draft = QuizDraft(
            key: key,
            contentHash: contentHash,
            answers: answers,
            updatedAt: Self.isoNow()
        )
        try? drafts.save(draft)
    }

    func deleteDraft(key: String) {
        try? drafts.delete(key: key)
    }

    // MARK: Pop-quiz timer

    func loadPopQuizSession(key: String, contentHash: String) -> PopQuizSession? {
        drafts.loadPopQuizSession(key: key, contentHash: contentHash)
    }

    @discardableResult
    func savePopQuizSession(_ session: PopQuizSession) -> Bool {
        do {
            try drafts.savePopQuizSession(session)
            return true
        } catch {
            return false
        }
    }

    func deletePopQuizSession(key: String) {
        try? drafts.deletePopQuizSession(key: key)
    }

    // MARK: Grading

    func gradeUnitTest(
        courseId: String,
        unitNumber: Int,
        quiz: ParsedQuiz,
        answers: [String: String]
    ) async throws -> UnitTestSubmission {
        let aiGrader = await activeQuizAiGrader()
        let grader = QuizGrader(aiGrader: aiGrader, aiTimeout: 60)
        let result = await grader.grade(quiz: quiz, answers: answers, mode: .unitTest)

        var persisted = false
        var persistenceError: String?
        var fileName = "\(PathValidator.formatUnitScopeId(unitNumber)).unit.test.md"
        do {
            let snapshot = try await repository.documentSnapshot(
                courseId: courseId,
                scope: .unit(unitNumber),
                tab: "test"
            )
            guard snapshot.existed else {
                throw RepositoryError.notFound("Unit test")
            }
            let updated = try UnitTestScoreWriter.applying(result: result, to: snapshot.content)
            let saved = try await repository.compareAndSaveDocument(
                courseId: courseId,
                scope: .unit(unitNumber),
                tab: "test",
                content: updated,
                expectedSHA256: snapshot.sha256
            )
            fileName = saved.fileName
            persisted = true
        } catch {
            persistenceError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }

        let attempt = QuizAttempt(
            courseId: courseId,
            lessonId: nil,
            kind: .unitTest,
            quizKey: fileName,
            title: quiz.title,
            date: Self.isoNow(),
            score: result.score,
            total: result.total,
            percentage: result.percentage,
            durationSeconds: 0,
            timedOut: false,
            answers: nil,
            usedAI: result.usedAI
        )
        var attemptError: String?
        do {
            try attempts.record(attempt)
            deleteDraft(key: draftKey(courseId: courseId, scope: .unit(unitNumber), tab: "test"))
        } catch {
            // Keep the draft so the answers are not silently lost when history
            // cannot be written (read-only root or a full disk).
            attemptError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        bumpDataRevision()
        return UnitTestSubmission(
            result: result,
            persisted: persisted,
            persistenceError: persistenceError,
            attempt: attempt,
            attemptError: attemptError
        )
    }

    func gradeLocally(quiz: ParsedQuiz, answers: [String: String], mode: QuizGradingMode) async -> QuizGradeResult {
        await QuizGrader().grade(quiz: quiz, answers: answers, mode: mode)
    }

    @discardableResult
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
        let key = popQuizDraftKey(courseId: courseId, lessonId: lessonId, timestamp: timestamp)
        let attempt = QuizAttempt(
            courseId: courseId,
            lessonId: lessonId,
            kind: .popQuiz,
            quizKey: timestamp,
            title: title,
            date: Self.isoNow(),
            score: score,
            total: total,
            percentage: percentage,
            durationSeconds: durationSeconds,
            timedOut: timedOut,
            answers: answers,
            usedAI: false
        )
        let recorder = PopQuizAttemptRecorder(attempts: attempts, drafts: drafts)
        try recorder.record(attempt: attempt, session: session, draftKey: key)
        bumpDataRevision()
        return attempt
    }

    func quizAttempts(
        courseId: String,
        lessonId: String? = nil,
        kind: QuizAttemptKind? = nil
    ) -> [QuizAttempt] {
        (try? attempts.attempts(courseId: courseId, lessonId: lessonId, kind: kind)) ?? []
    }

    func activeQuizAiGrader() async -> (any QuizAiGrading)? {
        guard settings.hasAIConsent else { return nil }
        guard let resolved = try? await llmProviders.resolvedCard(),
              resolved.isConfigured,
              resolved.capabilities.isSupported else {
            return nil
        }
        return LlmQuizAiGrader(resolvedCard: resolved)
    }

    // MARK: Pop-quiz generation

    /// Synchronous generate/cache/force pop quiz (PLAN §4.9). The timestamped
    /// file is written beside the lesson so it survives relaunch and export.
    func generatePopQuiz(
        courseId: String,
        lessonId: String,
        force: Bool = false
    ) async throws -> PopQuizReference {
        guard settings.hasAIConsent else { throw GenerationError.consentRequired }
        guard let resolved = try? await llmProviders.resolvedCard(), resolved.isConfigured else {
            throw GenerationError.missingActiveModel
        }
        guard let prompt = try await prompts.prompt(id: "popquiz") else {
            throw GenerationError.missingPrompt("popquiz")
        }
        guard let bundle = try await repository.lessonBundle(courseId: courseId, lessonId: lessonId),
              !bundle.lesson.isEmpty else {
            throw GenerationError.lessonNotFound(lessonId)
        }
        if !force {
            let existing = (try? await repository.listPopQuizzes(courseId: courseId, lessonId: lessonId)) ?? []
            if let newest = existing.first {
                return newest
            }
        }

        let lessonBody = (try? FrontmatterDocument(parsing: bundle.lesson))?.body ?? bundle.lesson
        let userContent = """
        Course: \(courseId)
        Lesson: \(lessonId)

        \(lessonBody)
        """
        let completion = try await LlmClient().complete(
            LlmCompletionRequest(
                card: resolved.card,
                extensions: resolved.extensions,
                capabilities: resolved.capabilities,
                apiKey: resolved.apiKey,
                systemPrompt: prompt.content,
                userContent: userContent,
                maxTokensOverride: 4_096,
                timeoutPolicyOverride: LlmTimeoutPolicy(connect: 30, idle: 60, absolute: 300)
            )
        )
        let validation = OutputValidator.validate(completion.content, kind: .popQuiz)
        guard validation.isValid else {
            throw GenerationError.invalidOutput(validation)
        }
        let quiz = QuestionParser.parse(validation.normalizedContent)
        guard quiz.hasQuestions else {
            throw GenerationError.invalidOutput(validation)
        }
        let reference = try await repository.saveNewPopQuiz(
            courseId: courseId,
            lessonId: lessonId,
            contentBuilder: { timestamp in
                Self.popQuizDocument(
                    content: validation.normalizedContent,
                    courseId: courseId,
                    lessonId: lessonId,
                    timestamp: timestamp
                )
            }
        )
        bumpDataRevision()
        return reference
    }

    // MARK: Helpers

    static func isoNow() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    static func popQuizTimestamp(_ date: Date = Date()) -> String {
        PopQuizTimestamp.string(date)
    }

    /// Adds the desktop pop-quiz provenance fields when the model did not
    /// return frontmatter. Existing frontmatter and every unknown key are
    /// preserved.
    static func popQuizDocument(
        content: String,
        courseId: String,
        lessonId: String,
        timestamp: String
    ) -> String {
        guard var document = try? FrontmatterDocument(parsing: content) else {
            return content
        }
        func setIfMissing(_ key: String, _ value: String) {
            if document.value(forKey: key) == nil {
                document.setValue(.scalar(value), forKey: key)
            }
        }
        setIfMissing("type", "popquiz")
        setIfMissing("course", courseId.uppercased())
        setIfMissing("lesson", lessonId)
        setIfMissing("timestamp", timestamp)
        setIfMissing("createdAt", ISO8601DateFormatter().string(from: Date()))
        return (try? document.serialized()) ?? content
    }
}
