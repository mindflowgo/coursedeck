import Foundation

// MARK: - Evaluation models

public struct QuizPartEvaluation: Codable, Equatable, Sendable {
    public var part: String?
    public var label: String?
    public var isCorrect: Bool
    public var feedback: String?

    public init(part: String? = nil, label: String? = nil, isCorrect: Bool, feedback: String? = nil) {
        self.part = part
        self.label = label
        self.isCorrect = isCorrect
        self.feedback = feedback
    }
}

public struct QuizQuestionEvaluation: Codable, Equatable, Sendable {
    public var questionID: String
    public var number: String
    public var isCorrect: Bool
    /// Fractional credit in `0...1`. A three-of-four-part answer is `0.75`.
    public var score: Double
    public var feedback: String?
    public var parts: [QuizPartEvaluation]

    public init(
        questionID: String,
        number: String,
        isCorrect: Bool,
        score: Double,
        feedback: String? = nil,
        parts: [QuizPartEvaluation] = []
    ) {
        self.questionID = questionID
        self.number = number
        self.isCorrect = isCorrect
        self.score = score
        self.feedback = feedback
        self.parts = parts
    }
}

public struct QuizGradeResult: Equatable, Sendable {
    public var score: Double
    public var total: Int
    public var percentage: Int
    public var evaluations: [String: QuizQuestionEvaluation]
    public var usedAI: Bool
    public var aiError: String?

    public init(
        score: Double,
        total: Int,
        percentage: Int,
        evaluations: [String: QuizQuestionEvaluation],
        usedAI: Bool = false,
        aiError: String? = nil
    ) {
        self.score = score
        self.total = total
        self.percentage = percentage
        self.evaluations = evaluations
        self.usedAI = usedAI
        self.aiError = aiError
    }
}

public enum QuizGradingMode: Equatable, Sendable {
    /// Practice and course tests are not persisted; they can still be answered.
    case practice
    /// Interactive unit test: FIB and short answers go through the AI grader
    /// first, with deterministic fallbacks.
    case unitTest
    /// Pop quizzes are graded deterministically with a wall-clock timer.
    case popQuiz
}

// MARK: - AI protocol

public struct QuizAiGradingQuestion: Equatable, Sendable {
    public var number: String
    public var questionID: String
    public var type: QuizQuestionType
    public var prompt: String
    public var expectedAnswer: String
    public var explanation: String
    public var studentAnswer: String

    public init(
        number: String,
        questionID: String,
        type: QuizQuestionType,
        prompt: String,
        expectedAnswer: String,
        explanation: String,
        studentAnswer: String
    ) {
        self.number = number
        self.questionID = questionID
        self.type = type
        self.prompt = prompt
        self.expectedAnswer = expectedAnswer
        self.explanation = explanation
        self.studentAnswer = studentAnswer
    }
}

public struct QuizAiGradingRequest: Equatable, Sendable {
    public var courseId: String
    public var lessonId: String?
    public var title: String
    public var questions: [QuizAiGradingQuestion]

    public init(
        courseId: String,
        lessonId: String? = nil,
        title: String,
        questions: [QuizAiGradingQuestion]
    ) {
        self.courseId = courseId
        self.lessonId = lessonId
        self.title = title
        self.questions = questions
    }
}

public struct QuizAiQuestionEvaluation: Equatable, Sendable {
    public var number: String
    public var isCorrect: Bool
    public var score: Double
    public var feedback: String?
    public var parts: [QuizPartEvaluation]

    public init(
        number: String,
        isCorrect: Bool,
        score: Double,
        feedback: String? = nil,
        parts: [QuizPartEvaluation] = []
    ) {
        self.number = number
        self.isCorrect = isCorrect
        self.score = score
        self.feedback = feedback
        self.parts = parts
    }
}

public protocol QuizAiGrading: Sendable {
    func grade(_ request: QuizAiGradingRequest) async throws -> [QuizAiQuestionEvaluation]
}

public enum QuizGradingError: Error, LocalizedError, Equatable {
    case timeout
    case invalidAIResponse(String)
    case noActiveModel

    public var errorDescription: String? {
        switch self {
        case .timeout:
            return "The AI grader did not respond within 60 seconds."
        case let .invalidAIResponse(reason):
            return "The AI grader returned an unreadable response: \(reason)"
        case .noActiveModel:
            return "No AI model card is configured for unit-test grading."
        }
    }
}

// MARK: - Grader

/// Deterministic multiple-choice scoring plus AI-assisted fill-in/short-answer
/// grading with partial credit and containment/heuristic fallbacks
/// (PLAN §4.9 / §4.10).
public struct QuizGrader: Sendable {
    public var aiGrader: (any QuizAiGrading)?
    public var aiTimeout: TimeInterval

    public init(aiGrader: (any QuizAiGrading)? = nil, aiTimeout: TimeInterval = 60) {
        self.aiGrader = aiGrader
        self.aiTimeout = aiTimeout
    }

    public func grade(
        quiz: ParsedQuiz,
        answers: [String: String],
        mode: QuizGradingMode
    ) async -> QuizGradeResult {
        var evaluations: [String: QuizQuestionEvaluation] = [:]
        var openQuestions: [QuizQuestion] = []

        for question in quiz.questions {
            let answer = trimmedAnswer(for: question, answers: answers)
            if question.type == .multipleChoice {
                let isCorrect = !answer.isEmpty
                    && !question.correctAnswer.isEmpty
                    && answer.uppercased() == question.correctAnswer.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
                evaluations[question.id] = QuizQuestionEvaluation(
                    questionID: question.id,
                    number: question.number,
                    isCorrect: isCorrect,
                    score: isCorrect ? 1 : 0,
                    feedback: isCorrect
                        ? (question.explanation ?? "Correct.")
                        : "Correct answer was \(question.correctAnswer)."
                )
            } else if answer.isEmpty {
                evaluations[question.id] = QuizQuestionEvaluation(
                    questionID: question.id,
                    number: question.number,
                    isCorrect: false,
                    score: 0,
                    feedback: "No response provided."
                )
            } else {
                openQuestions.append(question)
            }
        }

        var usedAI = false
        var aiError: String?
        if !openQuestions.isEmpty, mode != .popQuiz, let aiGrader {
            do {
                let request = QuizAiGradingRequest(
                    courseId: "",
                    lessonId: nil,
                    title: quiz.title,
                    questions: openQuestions.map { question in
                        QuizAiGradingQuestion(
                            number: question.number,
                            questionID: question.id,
                            type: question.type,
                            prompt: question.prompt,
                            expectedAnswer: question.correctAnswer,
                            explanation: question.explanation ?? question.correctAnswer,
                            studentAnswer: trimmedAnswer(for: question, answers: answers)
                        )
                    }
                )
                let response = try await withTimeout(seconds: aiTimeout) {
                    try await aiGrader.grade(request)
                }
                let requestedNumbers = Set(openQuestions.map { normalizeNumber($0.number) })
                var byNumber: [String: QuizAiQuestionEvaluation] = [:]
                for item in response {
                    let normalized = normalizeNumber(item.number)
                    if byNumber[normalized] == nil {
                        byNumber[normalized] = item
                    }
                }
                let missingNumbers = requestedNumbers.subtracting(byNumber.keys)
                if response.isEmpty {
                    aiError = "The AI grader returned no evaluations; fallback scoring was used."
                } else if !missingNumbers.isEmpty {
                    let list = missingNumbers.sorted().joined(separator: ", ")
                    aiError = "The AI grader omitted question(s) \(list); fallback scoring was used for those answers."
                }
                for question in openQuestions {
                    guard let ai = byNumber[normalizeNumber(question.number)] else { continue }
                    let evaluated = evaluation(for: question, ai: ai)
                    evaluations[question.id] = evaluated.evaluation
                    if let issue = evaluated.issue, aiError == nil {
                        aiError = issue
                    }
                    usedAI = true
                }
            } catch {
                aiError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }

        for question in openQuestions where evaluations[question.id] == nil {
            evaluations[question.id] = fallbackEvaluation(
                for: question,
                answer: trimmedAnswer(for: question, answers: answers)
            )
        }

        let total = quiz.questions.count
        var rawScore = 0.0
        for question in quiz.questions {
            rawScore += evaluations[question.id]?.score ?? 0
        }
        let score = (rawScore * 100).rounded() / 100
        let percentage = total > 0 ? Int(((score / Double(total)) * 100).rounded()) : 0
        return QuizGradeResult(
            score: score,
            total: total,
            percentage: percentage,
            evaluations: evaluations,
            usedAI: usedAI,
            aiError: aiError
        )
    }

    // MARK: - Fallbacks

    public static func normalizedContainment(student: String, correct: String) -> Bool {
        let cleanStudent = normalizeText(student)
        let cleanCorrect = normalizeText(correct)
        guard !cleanStudent.isEmpty, !cleanCorrect.isEmpty else { return false }
        return cleanStudent == cleanCorrect
            || cleanCorrect.contains(cleanStudent)
            || cleanStudent.contains(cleanCorrect)
    }

    private func fallbackEvaluation(
        for question: QuizQuestion,
        answer: String
    ) -> QuizQuestionEvaluation {
        switch question.type {
        case .multipleChoice:
            return QuizQuestionEvaluation(
                questionID: question.id,
                number: question.number,
                isCorrect: false,
                score: 0,
                feedback: "Correct answer was \(question.correctAnswer)."
            )
        case .fillInTheBlank:
            let isCorrect = Self.normalizedContainment(student: answer, correct: question.correctAnswer)
            return QuizQuestionEvaluation(
                questionID: question.id,
                number: question.number,
                isCorrect: isCorrect,
                score: isCorrect ? 1 : 0,
                feedback: isCorrect
                    ? (question.explanation ?? "Correct.")
                    : "Expected: \(question.correctAnswer)"
            )
        case .shortAnswer:
            let parts = Self.detectParts(in: question.prompt)
            if parts.count > 1 {
                let substantial = answer.count >= 30
                let evaluations = parts.map { part -> QuizPartEvaluation in
                    let hasPart = Self.answerMentions(part: part, in: answer)
                    return QuizPartEvaluation(
                        part: part,
                        label: "Part \(part)",
                        isCorrect: hasPart && substantial,
                        feedback: hasPart ? "Sub-part response detected." : "Missing sub-part response."
                    )
                }
                let correctCount = evaluations.filter(\.isCorrect).count
                let score = (Double(correctCount) / Double(evaluations.count) * 100).rounded() / 100
                return QuizQuestionEvaluation(
                    questionID: question.id,
                    number: question.number,
                    isCorrect: correctCount == evaluations.count,
                    score: score,
                    feedback: "Automated assessment: \(correctCount)/\(evaluations.count) parts identified. Review the rubric.",
                    parts: evaluations
                )
            }
            let substantial = answer.count >= 30
            return QuizQuestionEvaluation(
                questionID: question.id,
                number: question.number,
                isCorrect: false,
                score: substantial ? 0.5 : 0,
                feedback: substantial
                    ? "Automated evaluation: response noted. Review the expected rubric."
                    : "Response was too brief or incomplete."
            )
        }
    }

    public static func detectParts(in prompt: String) -> [String] {
        var parts: [String] = []
        func collect(_ pattern: String) {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
                return
            }
            let range = NSRange(prompt.startIndex..<prompt.endIndex, in: prompt)
            for match in regex.matches(in: prompt, range: range) {
                guard let captured = Range(match.range(at: 1), in: prompt) else { continue }
                let value = String(prompt[captured]).lowercased()
                if !parts.contains(value) { parts.append(value) }
            }
        }
        // Alphabetic sub-parts a)–z), including "(a)" and line-start forms.
        collect("(?:^|\\n|\\s|\\()([a-z])\\)")
        // Numbered sub-parts are used only when no alphabetic parts exist, so
        // a question's own numbering is not misread as a sub-part.
        if parts.isEmpty {
            collect("(?:^|\\n|\\s)(\\d{1,2})[\\).]")
        }
        return parts
    }

    static func answerMentions(part: String, in answer: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: part)
        return answer.range(
            of: "(?i)(^|[\\s(])" + escaped + "[\\).:]",
            options: .regularExpression
        ) != nil
    }

    // MARK: - Helpers

    private func evaluation(
        for question: QuizQuestion,
        ai: QuizAiQuestionEvaluation
    ) -> (evaluation: QuizQuestionEvaluation, issue: String?) {
        var score = ai.score
        var isCorrect = ai.isCorrect
        var parts = ai.parts
        var issue: String?
        let expectedParts = Self.detectParts(in: question.prompt)

        if !expectedParts.isEmpty {
            var provided: [String: QuizPartEvaluation] = [:]
            for part in ai.parts {
                guard let marker = Self.partMarker(part.part ?? part.label) else { continue }
                if provided[marker] == nil { provided[marker] = part }
            }
            let missing = expectedParts.filter { provided[$0] == nil }
            if !missing.isEmpty {
                issue = "The AI grader did not evaluate part(s) \(missing.joined(separator: ", ")); those parts were marked incorrect."
            }
            var complete: [QuizPartEvaluation] = expectedParts.map { marker in
                provided.removeValue(forKey: marker) ?? QuizPartEvaluation(
                    part: marker,
                    label: "Part \(marker)",
                    isCorrect: false,
                    feedback: "The AI grade did not evaluate this part."
                )
            }
            complete.append(contentsOf: provided.keys.sorted().compactMap { provided[$0] })
            parts = complete
            let correct = parts.filter(\.isCorrect).count
            score = (Double(correct) / Double(parts.count) * 100).rounded() / 100
            isCorrect = correct == parts.count
        } else if !parts.isEmpty {
            let correct = parts.filter(\.isCorrect).count
            score = (Double(correct) / Double(parts.count) * 100).rounded() / 100
            isCorrect = correct == parts.count
        } else {
            score = min(1, max(0, score))
            if score < 1 { isCorrect = false }
        }
        return (
            QuizQuestionEvaluation(
                questionID: question.id,
                number: question.number,
                isCorrect: isCorrect,
                score: score,
                feedback: ai.feedback,
                parts: parts
            ),
            issue
        )
    }

    static func partMarker(_ value: String?) -> String? {
        guard let value else { return nil }
        var text = value.lowercased()
        text = text.replacingOccurrences(of: "part", with: "")
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = text.first, first.isLetter || first.isNumber else { return nil }
        return String(first)
    }

    private func trimmedAnswer(for question: QuizQuestion, answers: [String: String]) -> String {
        (answers[question.id] ?? answers[question.number] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func normalizeNumber(_ value: String) -> String {
        String(format: "%02d", Int(value) ?? 0)
    }

    static func normalizeText(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9\\s]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func withTimeout<T: Sendable>(
        seconds: TimeInterval,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                let nanoseconds = UInt64(max(0, seconds) * 1_000_000_000)
                try await Task.sleep(nanoseconds: nanoseconds)
                throw QuizGradingError.timeout
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else {
                throw QuizGradingError.timeout
            }
            return result
        }
    }
}

// MARK: - LLM-backed grader

/// Grades open-ended answers with the active OpenAI-compatible card. The
/// response is a JSON array; if it is invalid the deterministic fallbacks run
/// instead of failing the submission.
public struct LlmQuizAiGrader: QuizAiGrading {
    public var client: LlmClient
    public var resolvedCard: ResolvedLlmCard
    public var maxTokens: Int

    public init(
        client: LlmClient = LlmClient(),
        resolvedCard: ResolvedLlmCard,
        maxTokens: Int = 4_096
    ) {
        self.client = client
        self.resolvedCard = resolvedCard
        self.maxTokens = maxTokens
    }

    public func grade(_ request: QuizAiGradingRequest) async throws -> [QuizAiQuestionEvaluation] {
        let systemPrompt = Self.systemPrompt
        let userContent = Self.userPrompt(request)
        let completion = try await client.complete(
            LlmCompletionRequest(
                card: resolvedCard.card,
                extensions: resolvedCard.extensions,
                capabilities: resolvedCard.capabilities,
                apiKey: resolvedCard.apiKey,
                systemPrompt: systemPrompt,
                userContent: userContent,
                maxTokensOverride: maxTokens,
                timeoutPolicyOverride: LlmTimeoutPolicy(
                    connect: 30,
                    idle: 45,
                    absolute: 60
                )
            )
        )
        return try Self.parseResponse(completion.content)
    }

    static let systemPrompt = """
    You are a rigorous, objective Ontario Secondary School curriculum evaluator grading practice test questions.
    Grade each question strictly and objectively against the provided Expected Content / Rubric and Detailed Explanation.

    CRITICAL GRADING RULES:
    1. Fill-in-the-Blank Questions:
       - Check if the student's answer accurately captures the required term, concept, or acceptable curriculum synonym.
       - If correct: "isCorrect": true, "score": 1.
       - If incorrect, blank, or inadequate: "isCorrect": false, "score": 0.

    2. Short-Answer / Written Problems (Multi-Part or Multi-Item):
       - You MUST analyze the question prompt and rubric for all distinct sub-questions, parts, or items.
       - You MUST evaluate EACH sub-part individually in a "parts" array.
       - For each part, specify "part", "label", "isCorrect" and a concise "feedback".
       - The question's "score" MUST be the exact proportion of correct parts: (correct parts) / (total parts).
       - "isCorrect" is true ONLY if ALL parts are correct.

    3. Single-Part Short-Answer Questions:
       - Fully correct: "score": 1, "isCorrect": true
       - Partially correct: "score": 0.5, "isCorrect": false
       - Incorrect: "score": 0, "isCorrect": false

    4. Output Format:
    Respond ONLY with a valid JSON array:
    [
      {
        "number": "09",
        "isCorrect": true,
        "score": 1,
        "feedback": "Correctly identified the term."
      }
    ]
    """

    static func userPrompt(_ request: QuizAiGradingRequest) -> String {
        let sections = request.questions.map { question in
            """
            Question \(question.number) (\(question.type.rawValue)):
            Question Prompt:
            \(question.prompt)

            Expected Content / Rubric:
            \(question.expectedAnswer)

            Detailed Explanation / Grading Criteria:
            \(question.explanation)

            Student Response:
            \(question.studentAnswer)
            """
        }
        return "Please evaluate these student responses against the Ontario curriculum expected content and rubrics:\n"
            + sections.joined(separator: "\n---\n")
    }

    public static func parseResponse(_ content: String) throws -> [QuizAiQuestionEvaluation] {
        var text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        text = text.replacingOccurrences(
            of: "^```(?:json)?\\s*",
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        text = text.replacingOccurrences(
            of: "```\\s*$",
            with: "",
            options: .regularExpression
        )
        guard let start = text.firstIndex(of: "["),
              let end = text.lastIndex(of: "]") else {
            throw QuizGradingError.invalidAIResponse("no JSON array found")
        }
        let json = String(text[start...end])
        guard let data = json.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw QuizGradingError.invalidAIResponse("malformed JSON")
        }

        var evaluations: [QuizAiQuestionEvaluation] = []
        for item in array {
            let rawNumber: String?
            if let string = item["number"] as? String {
                rawNumber = string
            } else if let number = item["number"] as? NSNumber {
                rawNumber = number.stringValue
            } else {
                rawNumber = nil
            }
            guard let rawNumber,
                  let intValue = Int(rawNumber.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                continue
            }
            var score = (item["score"] as? NSNumber)?.doubleValue
                ?? ((item["isCorrect"] as? Bool) == true ? 1 : 0)
            var isCorrect = (item["isCorrect"] as? Bool) ?? (score >= 1)
            var parts: [QuizPartEvaluation] = []
            if let rawParts = item["parts"] as? [[String: Any]], !rawParts.isEmpty {
                parts = rawParts.map { part in
                    QuizPartEvaluation(
                        part: (part["part"] as? String)
                            ?? (part["part"] as? NSNumber).map { "\($0)" },
                        label: part["label"] as? String,
                        isCorrect: (part["isCorrect"] as? Bool) ?? false,
                        feedback: part["feedback"] as? String
                    )
                }
                let correct = parts.filter(\.isCorrect).count
                score = (Double(correct) / Double(parts.count) * 100).rounded() / 100
                isCorrect = correct == parts.count
            } else {
                score = min(1, max(0, score))
                if score < 1 { isCorrect = false }
            }
            evaluations.append(
                QuizAiQuestionEvaluation(
                    number: String(format: "%02d", intValue),
                    isCorrect: isCorrect,
                    score: score,
                    feedback: item["feedback"] as? String,
                    parts: parts
                )
            )
        }
        return evaluations
    }
}

// MARK: - Score persistence

public enum UnitTestScoreWriter {
    /// Writes the score fields while preserving every other frontmatter key
    /// and removing any accidental raw-answer keys (PLAN §4.10).
    public static func applying(
        result: QuizGradeResult,
        to markdown: String,
        date: Date = Date()
    ) throws -> String {
        var document = try FrontmatterDocument(parsing: markdown)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        document.setValue(.scalar(formatter.string(from: date)), forKey: "lastAttemptDate")
        document.setValue(.scalar(trimmedNumber(result.score)), forKey: "score")
        document.setValue(.scalar(String(result.total)), forKey: "totalQuestions")
        document.setValue(.scalar(String(result.percentage)), forKey: "percentage")
        document.removeValue(forKey: "answers")
        document.removeValue(forKey: "userAnswers")
        document.removeValue(forKey: "studentAnswers")
        return try document.serialized()
    }

    public static func trimmedNumber(_ value: Double) -> String {
        if value == value.rounded() {
            return String(Int(value))
        }
        return String(format: "%.2f", value)
    }
}
