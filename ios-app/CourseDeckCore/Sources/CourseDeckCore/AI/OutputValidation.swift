import Foundation

public enum GeneratedContentKind: Equatable, Sendable {
    case summary
    case cheatsheet
    case lessonTest
    case unitTest
    case courseTest
    case popQuiz
    case unitAssignments
    case custom(String)

    public var spec: OutputValidationSpec {
        switch self {
        case .summary:
            // Prose prompts accept tables and bullet lists; not every valid
            // response uses a Markdown heading.
            return OutputValidationSpec(minimumCharacters: 120, requiresHeading: false)
        case .cheatsheet:
            return OutputValidationSpec(minimumCharacters: 120, requiresHeading: false)
        case .unitAssignments:
            return OutputValidationSpec(minimumCharacters: 200, requiresHeading: false)
        case .lessonTest:
            return OutputValidationSpec(
                expected: PromptCatalog.expectedQuestionCounts["test"],
                requiresQuestionsSection: true,
                requiresAnswersSection: true,
                minimumCharacters: 200,
                requiresHeading: false
            )
        case .unitTest:
            return OutputValidationSpec(
                expected: PromptCatalog.expectedQuestionCounts["unit_test"],
                requiresQuestionsSection: true,
                requiresAnswersSection: true,
                minimumCharacters: 200,
                requiresHeading: false
            )
        case .courseTest:
            return OutputValidationSpec(
                expected: PromptCatalog.expectedQuestionCounts["course_test"],
                requiresQuestionsSection: true,
                requiresAnswersSection: true,
                minimumCharacters: 200,
                requiresHeading: false
            )
        case .popQuiz:
            return OutputValidationSpec(
                expected: PromptCatalog.expectedQuestionCounts["popquiz"],
                requiresQuestionsSection: true,
                requiresAnswersSection: true,
                minimumCharacters: 120,
                requiresHeading: false
            )
        case let .custom(tab):
            return OutputValidationSpec(minimumCharacters: 60, requiresHeading: false, label: tab)
        }
    }
}

public struct OutputValidationSpec: Equatable, Sendable {
    public var expected: PromptQuestionCounts?
    public var requiresQuestionsSection: Bool
    public var requiresAnswersSection: Bool
    public var minimumCharacters: Int
    public var requiresHeading: Bool
    public var label: String?

    public init(
        expected: PromptQuestionCounts? = nil,
        requiresQuestionsSection: Bool = false,
        requiresAnswersSection: Bool = false,
        minimumCharacters: Int = 60,
        requiresHeading: Bool = false,
        label: String? = nil
    ) {
        self.expected = expected
        self.requiresQuestionsSection = requiresQuestionsSection
        self.requiresAnswersSection = requiresAnswersSection
        self.minimumCharacters = minimumCharacters
        self.requiresHeading = requiresHeading
        self.label = label
    }
}

public struct OutputValidationIssue: Equatable, Sendable {
    public var code: String
    public var message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct OutputValidationResult: Equatable, Sendable {
    public var isValid: Bool
    public var issues: [OutputValidationIssue]
    /// The input with at most one outer Markdown code fence removed.
    public var normalizedContent: String
    public var questionCount: Int
    public var multipleChoiceCount: Int
    public var fillInTheBlankCount: Int
    public var shortAnswerCount: Int
    public var answerCount: Int
    public var optionCounts: [Int]

    public init(
        isValid: Bool,
        issues: [OutputValidationIssue],
        normalizedContent: String,
        questionCount: Int = 0,
        multipleChoiceCount: Int = 0,
        fillInTheBlankCount: Int = 0,
        shortAnswerCount: Int = 0,
        answerCount: Int = 0,
        optionCounts: [Int] = []
    ) {
        self.isValid = isValid
        self.issues = issues
        self.normalizedContent = normalizedContent
        self.questionCount = questionCount
        self.multipleChoiceCount = multipleChoiceCount
        self.fillInTheBlankCount = fillInTheBlankCount
        self.shortAnswerCount = shortAnswerCount
        self.answerCount = answerCount
        self.optionCounts = optionCounts
    }

    public var summary: String {
        issues.map(\.message).joined(separator: " ")
    }
}

public enum OuterFenceAnalysis: Equatable, Sendable {
    case none
    case stripped(String)
    case invalid(code: String, message: String)
}

/// Validates model output before anything is written (PLAN §4.7). A truncated
/// or structurally incomplete response is never saved over a good file.
public enum OutputValidator {
    /// Removes exactly one genuine outer code fence. The opening fence must be
    /// the first non-empty line, its matching close must be the last non-empty
    /// line, and no other fence line may appear between them.
    public static func analyzeOuterFence(_ raw: String) -> OuterFenceAnalysis {
        let lines = raw.components(separatedBy: "\n")
        let nonEmpty = lines.indices.filter {
            !lines[$0].trimmingCharacters(in: .whitespaces).isEmpty
        }
        guard let first = nonEmpty.first else { return .none }
        let opening = lines[first].trimmingCharacters(in: .whitespaces)
        guard opening.hasPrefix("```") else { return .none }
        guard isFenceLine(opening) else {
            return .invalid(code: "openingFence", message: "The opening code fence is malformed.")
        }
        let language = String(opening.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        if !language.isEmpty,
           language.range(of: #"^[A-Za-z0-9_+.-]+$"#, options: .regularExpression) == nil {
            return .invalid(
                code: "openingFence",
                message: "The opening code fence has unexpected text after the backticks."
            )
        }

        let fenceIndices = nonEmpty.filter { index in
            index > first && isFenceLine(lines[index].trimmingCharacters(in: .whitespaces))
        }
        guard let close = fenceIndices.last else {
            return .invalid(code: "unclosedFence", message: "The response has an unclosed code fence.")
        }
        guard fenceIndices.count == 1 else {
            return .invalid(
                code: "multipleFences",
                message: "The response contains multiple Markdown code fences; only one outer wrapper is allowed."
            )
        }
        guard nonEmpty.last == close else {
            return .invalid(
                code: "trailingText",
                message: "Text appears after the closing code fence."
            )
        }

        let body = lines[(first + 1)..<close]
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return .stripped(body + "\n")
    }

    /// Convenience wrapper for callers that only need the body. Invalid fences
    /// are returned unchanged; `validate` rejects them with an explicit issue.
    public static func stripOuterFence(_ raw: String) -> String {
        if case let .stripped(content) = analyzeOuterFence(raw) {
            return content
        }
        return raw
    }

    private static func isFenceLine(_ trimmed: String) -> Bool {
        guard trimmed.hasPrefix("```") else { return false }
        return !trimmed.dropFirst(3).contains("`")
    }

    public static func validate(
        _ raw: String,
        kind: GeneratedContentKind,
        expected overrideCounts: PromptQuestionCounts? = nil
    ) -> OutputValidationResult {
        let fence = analyzeOuterFence(raw)
        if case let .invalid(code, message) = fence {
            return OutputValidationResult(
                isValid: false,
                issues: [OutputValidationIssue(code: code, message: message)],
                normalizedContent: raw
            )
        }
        let normalized: String
        if case let .stripped(content) = fence {
            normalized = content
        } else {
            normalized = raw
        }
        let spec = kind.spec
        let expected = overrideCounts ?? spec.expected
        var issues: [OutputValidationIssue] = []

        var body = normalized
        if let document = try? FrontmatterDocument(parsing: normalized) {
            body = document.body
        }

        let trimmedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedBody.isEmpty {
            issues.append(OutputValidationIssue(code: "empty", message: "The generated document is empty."))
            return OutputValidationResult(isValid: false, issues: issues, normalizedContent: normalized)
        }

        if trimmedBody.count < spec.minimumCharacters {
            issues.append(OutputValidationIssue(
                code: "tooShort",
                message: "The generated document is too short (\(trimmedBody.count) characters; expected at least \(spec.minimumCharacters))."
            ))
        }

        if spec.requiresHeading, !hasHeading(trimmedBody) {
            issues.append(OutputValidationIssue(
                code: "missingHeading",
                message: "The generated document has no Markdown heading."
            ))
        }

        if containsPlaceholders(trimmedBody) {
            issues.append(OutputValidationIssue(
                code: "placeholder",
                message: "The model returned the prompt schema placeholder text instead of content."
            ))
        }

        guard spec.requiresQuestionsSection || spec.requiresAnswersSection else {
            return OutputValidationResult(
                isValid: issues.isEmpty,
                issues: issues,
                normalizedContent: normalized
            )
        }

        let answersRange = firstRange(
            in: body,
            // Accept "Answer", "Answers", "Answer Key" at the start of a
            // heading, plus headings such as "Suggested Answers", while never
            // mistaking a "Short Answer" section for the answer key.
            pattern: #"(?m)^#{2,6}[ \t]+(?:Answer(?:s|[ \t]+Key)?\b[^\n]*|.*\bAnswers\b[^\n]*)$"#,
            options: [.caseInsensitive]
        )
        let questionsStart = firstRange(
            in: body,
            pattern: #"(?m)^#{2,6}[ \t]+[^\n]*Questions[^\n]*$"#,
            options: [.caseInsensitive]
        )

        if spec.requiresQuestionsSection, questionsStart == nil {
            issues.append(OutputValidationIssue(
                code: "missingQuestionsSection",
                message: "The generated test has no Questions section."
            ))
        }
        if spec.requiresAnswersSection, answersRange == nil {
            issues.append(OutputValidationIssue(
                code: "missingAnswersSection",
                message: "The generated test has no Answers section."
            ))
        }

        let questionRegion: String
        if let questionsStart {
            let start = questionsStart.upperBound
            let end = answersRange.map { min($0.lowerBound, body.endIndex) } ?? body.endIndex
            questionRegion = start < end ? String(body[start..<end]) : ""
        } else {
            let end = answersRange?.lowerBound ?? body.endIndex
            questionRegion = String(body[body.startIndex..<end])
        }
        let answerRegion = answersRange.map { String(body[$0.upperBound..<body.endIndex]) } ?? ""

        let numberedQuestions = numberedLines(in: questionRegion)
        let mcCount = occurrences(of: "<Multiple-Choice>", in: questionRegion, options: [.caseInsensitive])
        let fibCount = occurrences(of: "[Fill-in-the-Blank]", in: questionRegion, options: [.caseInsensitive])
        let shortAnswerCount = max(numberedQuestions - mcCount - fibCount, 0)
        let answerCount = numberedLines(in: answerRegion)
        let optionCounts = optionCounts(in: questionRegion)

        if let expected {
            if let total = expected.total, numberedQuestions != total {
                issues.append(OutputValidationIssue(
                    code: "questionCount",
                    message: "Expected \(total) questions but found \(numberedQuestions)."
                ))
            }
            if let mc = expected.multipleChoice, mcCount != mc {
                issues.append(OutputValidationIssue(
                    code: "multipleChoiceCount",
                    message: "Expected \(mc) multiple-choice questions but found \(mcCount)."
                ))
            }
            if let fib = expected.fillInTheBlank, fibCount != fib {
                issues.append(OutputValidationIssue(
                    code: "fillInTheBlankCount",
                    message: "Expected \(fib) fill-in-the-blank questions but found \(fibCount)."
                ))
            }
            let expectedOpen = (expected.shortAnswer ?? 0) + (expected.multiPart ?? 0)
            if expected.shortAnswer != nil || expected.multiPart != nil {
                if shortAnswerCount != expectedOpen {
                    issues.append(OutputValidationIssue(
                        code: "openEndedCount",
                        message: "Expected \(expectedOpen) short-answer/multi-part questions but found \(shortAnswerCount)."
                    ))
                }
            }
            if let total = expected.total, answerCount < total {
                issues.append(OutputValidationIssue(
                    code: "answerCoverage",
                    message: "The answer key covers \(answerCount) of \(total) questions."
                ))
            }
        }

        if spec.requiresAnswersSection, answerCount == 0 {
            issues.append(OutputValidationIssue(
                code: "emptyAnswerKey",
                message: "The answer key contains no numbered answers."
            ))
        }

        if mcCount > 0, optionCounts.isEmpty || optionCounts.contains(where: { $0 < 2 }) {
            issues.append(OutputValidationIssue(
                code: "optionCount",
                message: "Every multiple-choice question must have at least two options."
            ))
        }

        return OutputValidationResult(
            isValid: issues.isEmpty,
            issues: issues,
            normalizedContent: normalized,
            questionCount: numberedQuestions,
            multipleChoiceCount: mcCount,
            fillInTheBlankCount: fibCount,
            shortAnswerCount: shortAnswerCount,
            answerCount: answerCount,
            optionCounts: optionCounts
        )
    }

    // MARK: Helpers

    private static func hasHeading(_ body: String) -> Bool {
        firstRange(in: body, pattern: #"(?m)^#{1,6}[ \t]+\S"#, options: []) != nil
    }

    private static func containsPlaceholders(_ body: String) -> Bool {
        let markers = [
            "<Question prompt>", "<Question prompt", "<COURSE_ID>", "<LESSON_NUM>",
            "<Option A>", "<Target Word or Phrase>", "<Multi-unit problem prompt>",
            "<Expected Criteria / Rubric>",
        ]
        return markers.contains { body.contains($0) }
    }

    private static func numberedLines(in region: String) -> Int {
        guard let regex = try? NSRegularExpression(
            pattern: #"(?m)^[ \t]*\d{1,2}[\).][ \t]+\S"#,
            options: []
        ) else { return 0 }
        let range = NSRange(region.startIndex..<region.endIndex, in: region)
        return regex.numberOfMatches(in: region, options: [], range: range)
    }

    private static func occurrences(
        of needle: String,
        in text: String,
        options: String.CompareOptions
    ) -> Int {
        guard !needle.isEmpty else { return 0 }
        var count = 0
        var searchRange = text.startIndex..<text.endIndex
        while let found = text.range(of: needle, options: options, range: searchRange) {
            count += 1
            searchRange = found.upperBound..<text.endIndex
        }
        return count
    }

    private static func optionCounts(in questionRegion: String) -> [Int] {
        let lines = questionRegion.components(separatedBy: "\n")
        var counts: [Int] = []
        var index = 0
        while index < lines.count {
            if lines[index].range(of: "<Multiple-Choice>", options: [.caseInsensitive]) != nil {
                var count = 0
                var cursor = index + 1
                while cursor < lines.count {
                    let line = lines[cursor]
                    if line.range(of: #"^\s*--\s*$"#, options: [.regularExpression]) != nil { break }
                    if line.range(of: #"^\s*\d{1,2}[\).]\s+"#, options: [.regularExpression]) != nil { break }
                    if line.range(of: #"^\s*[-*]\s*\[[ xX]\]\s*\S"#, options: [.regularExpression]) != nil {
                        count += 1
                    }
                    cursor += 1
                }
                counts.append(count)
                index = cursor
            } else {
                index += 1
            }
        }
        return counts
    }

    private static func firstRange(
        in text: String,
        pattern: String,
        options: NSRegularExpression.Options
    ) -> Range<String.Index>? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range) else { return nil }
        return Range(match.range, in: text)
    }
}
