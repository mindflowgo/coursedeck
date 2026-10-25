import Foundation

// MARK: - Models

public enum QuizQuestionType: String, Codable, Equatable, Sendable {
    case multipleChoice = "multiple-choice"
    case fillInTheBlank = "fill-in-the-blank"
    case shortAnswer = "short-answer"
}

public struct QuizOption: Codable, Equatable, Sendable, Identifiable {
    public var letter: String
    public var text: String

    public var id: String { letter }

    public init(letter: String, text: String) {
        self.letter = letter
        self.text = text
    }
}

public struct QuizQuestion: Codable, Equatable, Sendable, Identifiable {
    /// Stable parser identity. Numbers restart between sections (legacy
    /// fill-in-the-blank files restart at 01 after six multiple-choice
    /// questions), so the section must be part of the key.
    public var id: String
    /// Unique display number after duplicate renumbering (`07`, `08`, …).
    public var number: String
    /// Number as written in the source question section (`01` … `04`).
    public var originalNumber: String
    public var sectionIndex: Int
    public var sectionTitle: String?
    public var category: String?
    public var type: QuizQuestionType
    public var prompt: String
    public var options: [QuizOption]
    public var correctAnswer: String
    public var explanation: String?
    /// `Answer: **…**` written inside a fill-in question with no answer key.
    public var inlineAnswer: String?

    public var hasAnswer: Bool {
        !correctAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public init(
        id: String,
        number: String,
        originalNumber: String,
        sectionIndex: Int,
        sectionTitle: String? = nil,
        category: String? = nil,
        type: QuizQuestionType,
        prompt: String,
        options: [QuizOption] = [],
        correctAnswer: String = "",
        explanation: String? = nil,
        inlineAnswer: String? = nil
    ) {
        self.id = id
        self.number = number
        self.originalNumber = originalNumber
        self.sectionIndex = sectionIndex
        self.sectionTitle = sectionTitle
        self.category = category
        self.type = type
        self.prompt = prompt
        self.options = options
        self.correctAnswer = correctAnswer
        self.explanation = explanation
        self.inlineAnswer = inlineAnswer
    }
}

public enum QuizParseIssue: Equatable, Sendable {
    case noQuestions
    case missingAnswer(questionNumber: String, sectionIndex: Int)
    case unreadableFrontmatter(String)

    public var message: String {
        switch self {
        case .noQuestions:
            return "No quiz questions could be parsed from this document."
        case let .missingAnswer(number, _):
            return "Question \(number) has no answer in its answer section."
        case .unreadableFrontmatter(let reason):
            return "The quiz frontmatter is unreadable: \(reason)"
        }
    }
}

public struct ParsedQuiz: Equatable, Sendable {
    public var courseCode: String
    public var title: String
    public var questions: [QuizQuestion]
    public var issues: [QuizParseIssue]

    public init(
        courseCode: String = "",
        title: String = "Practice Quiz",
        questions: [QuizQuestion] = [],
        issues: [QuizParseIssue] = []
    ) {
        self.courseCode = courseCode
        self.title = title
        self.questions = questions
        self.issues = issues
    }

    public var hasQuestions: Bool { !questions.isEmpty }
    public var missingAnswers: [QuizQuestion] { questions.filter { !$0.hasAnswer } }

    public func question(id: String) -> QuizQuestion? {
        questions.first { $0.id == id }
    }
}

/// Parsed frontmatter fields needed by the unit-test runner.
public struct QuizDocumentMetadata: Equatable, Sendable {
    public var lastAttemptDate: String?
    public var score: Double?
    public var totalQuestions: Int?
    public var percentage: Int?

    public init(
        lastAttemptDate: String? = nil,
        score: Double? = nil,
        totalQuestions: Int? = nil,
        percentage: Int? = nil
    ) {
        self.lastAttemptDate = lastAttemptDate
        self.score = score
        self.totalQuestions = totalQuestions
        self.percentage = percentage
    }

    public static func read(from markdown: String) -> QuizDocumentMetadata {
        guard let document = try? FrontmatterDocument(parsing: markdown) else {
            return QuizDocumentMetadata()
        }
        return QuizDocumentMetadata(
            lastAttemptDate: document.value(forKey: "lastAttemptDate")?.stringValue,
            score: document.value(forKey: "score")?.doubleValue,
            totalQuestions: document.value(forKey: "totalQuestions")?.intValue,
            percentage: document.value(forKey: "percentage")?.intValue
        )
    }
}

// MARK: - Parser

/// Port of the desktop KICA `QuestionParser`, extended for the live corpus:
///
/// * Legacy `## Fill-in-the-Blank Questions` / `## Fill-in-the-Blank Answers`
///   sections may appear *after* `## Answers` (81 of 85 live lesson tests).
/// * Question and answer sections restart numbering. Answers are resolved with
///   the original number **inside the paired section**, never by display
///   number, before duplicate renumbering.
/// * A course test may contain multiple answer sections (for example
///   `## Answers & Detailed Solutions` followed by
///   `### … Short Answer … Suggested Answers`); each section is scoped
///   independently and never truncated at the next `##`/`###`.
/// * Inline `Answer: **…**` is used for fill-in questions with no options.
/// * Multiple-choice letters extend to A–Z.
public enum QuestionParser {
    public static func parse(_ markdown: String) -> ParsedQuiz {
        var issues: [QuizParseIssue] = []
        let document: FrontmatterDocument
        if let parsed = try? FrontmatterDocument(parsing: markdown) {
            document = parsed
        } else {
            issues.append(.unreadableFrontmatter("invalid YAML"))
            document = FrontmatterDocument(body: looseBody(markdown))
        }

        let lines = document.body.components(separatedBy: "\n")
        let scan = scanSections(lines)
        let title = scan.title.isEmpty ? "Practice Quiz" : scan.title
        let courseCode = scan.courseCode

        let questionSections = scan.sections.filter {
            if case .question = $0.kind { return true }
            return false
        }
        let answerSections = scan.sections.filter {
            if case .answers = $0.kind { return true }
            return false
        }

        var rawQuestions: [RawQuestion] = []
        for section in questionSections {
            guard case let .question(kind) = section.kind else { continue }
            rawQuestions.append(contentsOf: parseQuestions(in: section, kind: kind))
        }

        // Fallback for documents without any H2/H3 section boundary.
        if scan.sections.isEmpty {
            let fallback = RawSection(
                index: 0,
                title: "Questions",
                level: 2,
                kind: .question(.general),
                lines: lines
            )
            rawQuestions = parseQuestions(in: fallback, kind: .general)
        }

        let questionsBySection = Dictionary(grouping: rawQuestions, by: \.sectionIndex)
        let pairing = pairQuestionSections(
            questionSections: questionSections,
            answerSections: answerSections
        )
        let expectedNumbers = expectedNumbersByAnswerSection(
            questionSections: questionSections,
            answerSections: answerSections,
            questionsBySection: questionsBySection,
            pairing: pairing
        )
        let answersBySection = parseAnswerSections(
            answerSections,
            expectedNumbers: expectedNumbers
        )

        var usedNumbers = Set<String>()
        var questions: [QuizQuestion] = []
        for raw in rawQuestions {
            let type = classify(raw: raw)
            let answerEntry = answerEntry(
                for: raw,
                type: type,
                options: raw.options,
                questionSectionIndex: raw.sectionIndex,
                pairing: pairing,
                answerSections: answersBySection
            )
            let interpreted = answerEntry.map {
                interpret($0, kind: raw.kind, questionType: type, options: raw.options)
            }

            var correctAnswer = interpreted?.text ?? ""
            var explanation = interpreted?.explanation ?? ""
            if type == .multipleChoice {
                let inlineLetter = raw.inlineAnswer?.trimmingCharacters(in: .whitespacesAndNewlines)
                if correctAnswer.isEmpty, let checked = raw.checkedLetter {
                    correctAnswer = checked
                } else if correctAnswer.isEmpty, let inlineLetter, inlineLetter.count == 1 {
                    correctAnswer = inlineLetter.uppercased()
                } else if !correctAnswer.isEmpty, correctAnswer.count == 1 {
                    correctAnswer = correctAnswer.uppercased()
                }
                if explanation.isEmpty, let entry = answerEntry, entry.letter == nil {
                    // Text answer in an MC section: keep it as the fallback key.
                    explanation = entry.raw.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            } else if correctAnswer.isEmpty, let inline = raw.inlineAnswer {
                correctAnswer = cleanAnswerText(inline)
                if explanation.isEmpty { explanation = "" }
            }

            if correctAnswer.isEmpty {
                issues.append(.missingAnswer(
                    questionNumber: padded(raw.number),
                    sectionIndex: raw.sectionIndex
                ))
            }

            let paddedOriginal = padded(raw.number)
            let displayNumber: String
            if usedNumbers.insert(paddedOriginal).inserted {
                displayNumber = paddedOriginal
            } else {
                var candidate = questions.count + 1
                while usedNumbers.contains(padded(candidate)) { candidate += 1 }
                displayNumber = padded(candidate)
                usedNumbers.insert(displayNumber)
            }

            let id = "s\(raw.sectionIndex)q\(paddedOriginal)-\(raw.occurrence)"
            questions.append(
                QuizQuestion(
                    id: id,
                    number: displayNumber,
                    originalNumber: paddedOriginal,
                    sectionIndex: raw.sectionIndex,
                    sectionTitle: raw.sectionTitle,
                    category: raw.category,
                    type: type,
                    prompt: raw.prompt,
                    options: raw.options,
                    correctAnswer: correctAnswer,
                    explanation: explanation.isEmpty ? nil : explanation,
                    inlineAnswer: raw.inlineAnswer.map(cleanAnswerText)
                )
            )
        }

        if questions.isEmpty {
            issues.append(.noQuestions)
        }

        return ParsedQuiz(
            courseCode: courseCode,
            title: title,
            questions: questions,
            issues: issues
        )
    }

    /// Serializes back to the standardized KICA Markdown shape. Used by the
    /// round-trip tests and by the editor when a parser-normalized quiz is
    /// requested.
    public static func serialize(_ quiz: ParsedQuiz) -> String {
        var output: [String] = []
        if !quiz.courseCode.isEmpty {
            output.append("course: \(quiz.courseCode)")
            output.append("")
        }
        output.append("# \(quiz.title)")
        output.append("")
        output.append("## Questions")
        output.append("")
        for question in quiz.questions {
            let category: String
            if let existing = question.category, !existing.isEmpty {
                category = "[\(existing)] "
            } else {
                switch question.type {
                case .multipleChoice: category = ""
                case .fillInTheBlank: category = "[Fill-in-the-Blank] "
                case .shortAnswer: category = "[Short Answer] "
                }
            }
            output.append("\(question.number)) \(category)\(question.prompt)")
            if !question.options.isEmpty {
                output.append("<Multiple-Choice>")
                for option in question.options {
                    output.append("- [ ] \(option.text)")
                }
                output.append("</Multiple-Choice>")
            }
            output.append("")
            output.append("--")
            output.append("")
        }
        output.append("## Answers")
        for question in quiz.questions {
            switch question.type {
            case .multipleChoice:
                let explanation = question.explanation.map { " - (explanation) \($0)" } ?? ""
                output.append("\(question.number)) \(question.correctAnswer)\(explanation)")
            case .fillInTheBlank:
                let explanation = question.explanation.map { " - (explanation) \($0)" } ?? ""
                output.append("\(question.number)) \(question.correctAnswer)\(explanation)")
            case .shortAnswer:
                let explanation = question.explanation.map { " - (explanation) \($0)" } ?? ""
                output.append("\(question.number)) \(question.correctAnswer)\(explanation)")
            }
        }
        return output.joined(separator: "\n") + "\n"
    }

    // MARK: - Sections

    private enum QuestionKind: Equatable, Sendable {
        case general
        case fillInTheBlank
        case shortAnswer
    }

    private enum SectionKind: Equatable, Sendable {
        case question(QuestionKind)
        case answers(QuestionKind)
        case other
    }

    private struct RawSection {
        var index: Int
        var title: String
        var level: Int
        var kind: SectionKind
        var lines: [String]
    }

    private struct SectionScan {
        var title: String
        var courseCode: String
        var sections: [RawSection]
    }

    private static func scanSections(_ lines: [String]) -> SectionScan {
        var title = ""
        var courseCode = ""
        var sections: [RawSection] = []
        var currentTitle = ""
        var currentLevel = 0
        var currentLines: [String] = []
        var currentIndex = -1
        var sectionCounter = 0
        var inPrelude = true

        func flush() {
            guard currentIndex >= 0 else { return }
            sections.append(
                RawSection(
                    index: currentIndex,
                    title: currentTitle,
                    level: currentLevel,
                    kind: classify(title: currentTitle),
                    lines: currentLines
                )
            )
            currentLines = []
        }

        for line in lines {
            if let heading = headingComponents(line), heading.level <= 3 {
                if heading.level == 1 {
                    if title.isEmpty { title = heading.title }
                    if inPrelude {
                        // A top-level title is not a section boundary.
                        continue
                    }
                }
                if heading.level == 1 {
                    continue
                }
                if heading.level == 3,
                   currentIndex >= 0,
                   case .answers = classify(title: currentTitle),
                   isAnswerContinuation(heading.title) {
                    // An H3 such as `### Explanation` inside an answer section
                    // is part of the current answer body, not a new section.
                    currentLines.append(line)
                    continue
                }
                flush()
                inPrelude = false
                currentTitle = heading.title
                currentLevel = heading.level
                currentIndex = sectionCounter
                sectionCounter += 1
                currentLines = []
                continue
            }
            if inPrelude {
                if courseCode.isEmpty,
                   let match = firstCapture(
                    line,
                    pattern: "^\\s*\\**\\s*course\\s*\\**\\s*:\\s*(.*)$",
                    caseInsensitive: true
                   ) {
                    let value = match.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !value.isEmpty { courseCode = value }
                }
                if title.isEmpty, let heading = headingComponents(line), heading.level == 1 {
                    title = heading.title
                }
                continue
            }
            currentLines.append(line)
        }
        flush()
        return SectionScan(title: title, courseCode: courseCode, sections: sections)
    }

    private static func classify(title: String) -> SectionKind {
        let normalized = title
            .lowercased()
            .replacingOccurrences(of: "–", with: "-")
            .replacingOccurrences(of: "—", with: "-")
            .replacingOccurrences(of: "_", with: " ")
        // "Short Answer / Application Problems" is a *question* section even
        // though it contains the word "answer". Answer sections use plural
        // "answers" / "solutions" or start with the word.
        let isAnswer = normalized.contains("answers")
            || normalized.contains("answer key")
            || normalized.contains("solutions")
            || normalized.contains("solution")
            || normalized.contains("marking scheme")
            || normalized.hasPrefix("answer")
            || normalized.hasPrefix("solution")
        let isFill = normalized.contains("fill")
            || normalized.contains("blank")
            || normalized.contains("cloze")
        let isShort = normalized.contains("short answer")
            || normalized.contains("case problem")
            || normalized.contains("problem-solving")
            || normalized.contains("problem solving")
            || normalized.contains("application problem")
            || normalized.contains("written response")
            || normalized.contains("long answer")
            || normalized.contains("extended response")

        if isAnswer {
            if isFill { return .answers(.fillInTheBlank) }
            if isShort { return .answers(.shortAnswer) }
            return .answers(.general)
        }
        if isFill { return .question(.fillInTheBlank) }
        if isShort { return .question(.shortAnswer) }
        return .question(.general)
    }

    /// Pairs question sections to answer sections structurally before looking
    /// at entry shapes. Same-kind sections pair in document order, which keeps
    /// two sections that both restart at `01` from stealing each other's keys.
    /// A section with no same-kind answer falls back to the nearest generic
    /// answer section (shared answer keys).
    private static func isAnswerContinuation(_ title: String) -> Bool {
        let normalized = title
            .lowercased()
            .replacingOccurrences(of: "–", with: "-")
            .replacingOccurrences(of: "—", with: "-")
        if normalized.contains("fill")
            || normalized.contains("blank")
            || normalized.contains("suggested answers")
            || normalized.contains("answer key")
            || normalized.contains("short answer")
            || normalized.contains("case problem") {
            return false
        }
        return normalized.contains("explanation")
            || normalized.contains("rationale")
            || normalized.contains("rubric")
            || normalized.contains("marking")
            || normalized.contains("detailed solution")
            || normalized.contains("notes")
    }

    private static func pairQuestionSections(
        questionSections: [RawSection],
        answerSections: [RawSection]
    ) -> [Int: [Int]] {
        var pairing: [Int: [Int]] = [:]
        for kind in [QuestionKind.general, .fillInTheBlank, .shortAnswer] {
            let questions = questionSections.filter { $0.kind == .question(kind) }
            let answers = answerSections.filter { $0.kind == .answers(kind) }
            for (question, answer) in zip(questions, answers) {
                pairing[question.index, default: []].append(answer.index)
            }
        }
        let genericAnswers = answerSections.filter { $0.kind == .answers(.general) }
        for question in questionSections where pairing[question.index] == nil {
            let after = genericAnswers.filter { $0.index > question.index }
            if let chosen = after.first ?? genericAnswers.first {
                pairing[question.index] = [chosen.index]
            }
        }
        return pairing
    }

    private static func expectedNumbersByAnswerSection(
        questionSections: [RawSection],
        answerSections: [RawSection],
        questionsBySection: [Int: [RawQuestion]],
        pairing: [Int: [Int]]
    ) -> [Int: Set<String>] {
        var expected: [Int: Set<String>] = [:]
        for answer in answerSections {
            expected[answer.index] = []
        }
        for section in questionSections {
            guard let questions = questionsBySection[section.index], !questions.isEmpty else {
                continue
            }
            let allNumbers = Set(questions.map { normalizedNumber($0.number) })
            for index in pairing[section.index] ?? [] {
                expected[index, default: []].formUnion(allNumbers)
            }
            // A single mixed `## Questions` section can use several split
            // answer sections. Only a genuinely mixed section may claim later
            // kind-compatible sections; a single-kind section's later generic
            // section belongs to a later question section.
            let kinds = Set(questions.map { classify(raw: $0) })
            if kinds.count > 1 {
                for answer in answerSections where answer.index > section.index {
                    guard case let .answers(kind) = answer.kind else { continue }
                    let matching = questions.filter { question in
                        switch kind {
                        case .general:
                            return classify(raw: question) == .multipleChoice
                        case .fillInTheBlank:
                            return classify(raw: question) == .fillInTheBlank
                        case .shortAnswer:
                            return classify(raw: question) == .shortAnswer
                        }
                    }
                    if !matching.isEmpty {
                        expected[answer.index, default: []].formUnion(
                            matching.map { normalizedNumber($0.number) }
                        )
                    }
                }
            }
        }
        return expected
    }

    /// Content-aware lookup *after* structural pairing. The section pair is
    /// the primary rank; entry shape only disambiguates between candidate
    /// sections (e.g. a generic letter key vs a Suggested Answers rubric).
    private static func answerEntry(
        for raw: RawQuestion,
        type: QuizQuestionType,
        options: [QuizOption],
        questionSectionIndex: Int,
        pairing: [Int: [Int]],
        answerSections: [Int: AnswerSection]
    ) -> RawAnswer? {
        let number = normalizedNumber(raw.number)
        var indices = Set(pairing[questionSectionIndex] ?? [])
        let wantedKind = answerKind(for: type)
        for section in answerSections.values where section.index > questionSectionIndex {
            if section.kind == .general {
                indices.insert(section.index)
            } else if section.kind == wantedKind {
                indices.insert(section.index)
            }
        }

        let candidates = indices.compactMap { index -> (AnswerSection, RawAnswer)? in
            guard let section = answerSections[index],
                  let entry = section.byNumber[number],
                  entryMatches(entry, questionType: type, options: options) else {
                return nil
            }
            return (section, entry)
        }
        let paired = Set(pairing[questionSectionIndex] ?? [])
        let chosen = candidates.min { lhs, rhs in
            answerRank(
                lhs.0,
                for: raw,
                type: type,
                paired: paired.contains(lhs.0.index)
            ) < answerRank(
                rhs.0,
                for: raw,
                type: type,
                paired: paired.contains(rhs.0.index)
            )
        }
        return chosen?.1
    }

    private static func answerKind(for type: QuizQuestionType) -> QuestionKind {
        switch type {
        case .multipleChoice: return .general
        case .fillInTheBlank: return .fillInTheBlank
        case .shortAnswer: return .shortAnswer
        }
    }

    private static func entryMatches(
        _ entry: RawAnswer,
        questionType: QuizQuestionType,
        options: [QuizOption]
    ) -> Bool {
        let raw = entry.raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return false }
        switch questionType {
        case .multipleChoice:
            if entry.letter != nil { return true }
            return optionLetter(for: raw, options: options) != nil
        case .fillInTheBlank, .shortAnswer:
            // Text is valid even when it begins with a lowercase part label
            // such as `a)`. Only a single uppercase MC letter is rejected.
            return entry.letter == nil
        }
    }

    private static func answerRank(
        _ section: AnswerSection,
        for raw: RawQuestion,
        type: QuizQuestionType,
        paired: Bool
    ) -> (Int, Int, Int, Int) {
        let kindRank: Int
        switch (type, section.kind) {
        case (.multipleChoice, .general):
            kindRank = 0
        case (.multipleChoice, _):
            kindRank = 2
        case (.fillInTheBlank, .fillInTheBlank):
            kindRank = 0
        case (.fillInTheBlank, .general):
            kindRank = 1
        case (.fillInTheBlank, _):
            kindRank = 2
        case (.shortAnswer, .shortAnswer):
            kindRank = 0
        case (.shortAnswer, .general):
            kindRank = 1
        case (.shortAnswer, _):
            kindRank = 2
        }
        return (paired ? 0 : 1, kindRank, abs(section.index - raw.sectionIndex), section.index)
    }

    /// Maps a text MC answer key to an option letter. Exact normalized matches
    /// win; a unique containment match is the fallback.
    static func optionLetter(for rawAnswer: String, options: [QuizOption]) -> String? {
        guard !options.isEmpty else { return nil }
        let answer = cleanAnswerText(rawAnswer)
        let normalizedAnswer = normalizedMatch(answer)
        guard !normalizedAnswer.isEmpty else { return nil }

        if let exact = options.first(where: { normalizedMatch($0.text) == normalizedAnswer }) {
            return exact.letter
        }
        let contained = options.filter { option in
            let optionText = normalizedMatch(option.text)
            guard !optionText.isEmpty else { return false }
            return optionText.contains(normalizedAnswer) || normalizedAnswer.contains(optionText)
        }
        return contained.count == 1 ? contained[0].letter : nil
    }

    private static func normalizedMatch(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9\\s]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Questions

    private struct RawQuestion {
        var number: String
        var sectionIndex: Int
        var sectionTitle: String?
        var kind: QuestionKind
        var prompt: String
        var category: String?
        var options: [QuizOption]
        var checkedLetter: String?
        var inlineAnswer: String?
        var occurrence: Int
    }

    private static func parseQuestions(in section: RawSection, kind: QuestionKind) -> [RawQuestion] {
        var blocks: [(number: String, lines: [String])] = []
        var currentNumber: String?
        var currentLines: [String] = []
        var lastNumber: Int?
        var occurrence = 0

        func flush() {
            guard let number = currentNumber else { return }
            blocks.append((number, currentLines))
            currentNumber = nil
            currentLines = []
        }

        for line in section.lines {
            if let marker = questionMarker(line, kind: kind) {
                let intValue = Int(marker.number) ?? 0
                let accepts: Bool
                if currentNumber == nil {
                    accepts = true
                } else if kind == .general {
                    accepts = intValue == (lastNumber ?? intValue - 1) + 1
                } else {
                    accepts = intValue == (lastNumber ?? intValue - 1) + 1
                }
                if accepts {
                    flush()
                    currentNumber = marker.number
                    lastNumber = intValue
                    currentLines = marker.rest.isEmpty ? [] : [marker.rest]
                    occurrence = blocks.count
                    continue
                }
            }
            if currentNumber != nil {
                currentLines.append(line)
            }
        }
        flush()

        return blocks.enumerated().map { index, block in
            var parsed = parseQuestionBlock(
                number: block.number,
                lines: block.lines,
                section: section,
                kind: kind
            )
            parsed.occurrence = index
            return parsed
        }
    }

    private static func parseQuestionBlock(
        number: String,
        lines: [String],
        section: RawSection,
        kind: QuestionKind
    ) -> RawQuestion {
        var options: [QuizOption] = []
        var checkedLetter: String?
        var promptLines: [String] = []
        var inlineAnswer: String?
        var category: String?

        for (index, rawLine) in lines.enumerated() {
            let line = rawLine
            if isSeparator(line) { continue }
            if let option = optionComponents(line, expectedLetter: letter(forIndex: options.count)) {
                if checkedLetter == nil,
                   captures(line, pattern: "^\\s*[-*+]\\s*\\[[xX]\\]") != nil {
                    checkedLetter = option.letter
                }
                options.append(option)
                continue
            }
            if let answer = inlineAnswerComponents(line) {
                if inlineAnswer == nil { inlineAnswer = answer }
                continue
            }
            var working = line
            if index == 0 {
                if let parsedCategory = leadingCategory(working) {
                    category = parsedCategory.category
                    working = parsedCategory.rest
                }
                working = stripLeadingBold(replacingTags(in: working))
                if working.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    continue
                }
            } else {
                let withoutTags = replacingTags(in: working)
                if withoutTags.isEmpty,
                   working.range(of: "<Multiple-Choice>", options: .caseInsensitive) != nil {
                    continue
                }
                working = withoutTags
            }
            promptLines.append(working)
        }

        let prompt = promptLines
            .joined(separator: "\n")
            .replacingOccurrences(of: "\r", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return RawQuestion(
            number: number,
            sectionIndex: section.index,
            sectionTitle: section.title.isEmpty ? nil : section.title,
            kind: kind,
            prompt: prompt,
            category: category,
            options: options,
            checkedLetter: checkedLetter,
            inlineAnswer: inlineAnswer,
            occurrence: 0
        )
    }

    private static func classify(raw: RawQuestion) -> QuizQuestionType {
        if !raw.options.isEmpty { return .multipleChoice }
        if raw.kind == .fillInTheBlank { return .fillInTheBlank }
        let category = raw.category?.lowercased() ?? ""
        if category.contains("fill") || category.contains("blank") {
            return .fillInTheBlank
        }
        if raw.prompt.contains("___") || raw.prompt.contains("____") {
            return .fillInTheBlank
        }
        return .shortAnswer
    }

    private static func questionMarker(
        _ line: String,
        kind: QuestionKind
    ) -> (number: String, rest: String)? {
        let stripped = topLevelMarkerText(line) ?? ""
        guard !stripped.isEmpty else { return nil }
        let pattern: String
        switch kind {
        case .general:
            // Desktop heuristic: two-digit numbers (or zero-prefixed one-digit
            // numbers) may use `)`/`.`/`:`, while a single digit must use `)`
            // so numbered lists inside a prompt are not split.
            pattern = "^\\s*\\**\\s*((?:0\\d|\\d{2,})[\\).:]|\\d+\\))\\s*(.*)$"
        case .fillInTheBlank, .shortAnswer:
            pattern = "^\\s*\\**\\s*(\\d{1,3})[\\).:]\\s*(.*)$"
        }
        guard let captured = captures(stripped, pattern: pattern) else { return nil }
        let rawNumber = captured[0].trimmingCharacters(in: CharacterSet(charactersIn: ").:"))
        var rest = captured[1].trimmingCharacters(in: .whitespacesAndNewlines)
        rest = stripLeadingBold(rest)
        guard let intValue = Int(rawNumber), intValue > 0 else { return nil }
        return (String(intValue), rest)
    }

    private static func optionComponents(
        _ line: String,
        expectedLetter: String
    ) -> QuizOption? {
        guard let captured = captures(
            line,
            pattern: "^\\s*[-*+]\\s*\\[([ xX])\\]\\s*(.*)$"
        ) else { return nil }
        var text = stripOuterBold(captured[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        let escaped = NSRegularExpression.escapedPattern(for: expectedLetter)
        if let stripped = firstCapture(
            text,
            pattern: "^" + escaped + "[\\).:]\\s*(.*)$",
            caseInsensitive: true
        ) {
            text = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if text.isEmpty { text = " " }
        return QuizOption(letter: expectedLetter, text: text)
    }

    private static func inlineAnswerComponents(_ line: String) -> String? {
        guard let captured = captures(
            line,
            pattern: "^\\s*(?:[-*]\\s*)?\\**\\s*(?:Correct\\s+)?Answer\\s*\\**\\s*:\\s*\\**\\s*(.+?)\\s*\\**\\s*$",
            caseInsensitive: true
        ) else { return nil }
        let value = stripOuterBold(captured[0]).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    // MARK: - Answers

    private struct RawAnswer {
        var number: String
        var raw: String
        var letter: String?
    }

    private struct AnswerSection {
        var index: Int
        var kind: QuestionKind
        var byNumber: [String: RawAnswer]
        var ordered: [RawAnswer]
    }

    private struct InterpretedAnswer {
        var letter: String?
        var text: String
        var explanation: String
    }

    private static func parseAnswerSections(
        _ sections: [RawSection],
        expectedNumbers: [Int: Set<String>]
    ) -> [Int: AnswerSection] {
        var result: [Int: AnswerSection] = [:]
        for section in sections {
            guard case let .answers(kind) = section.kind else { continue }
            let expected = expectedNumbers[section.index] ?? []
            var entries: [RawAnswer] = []
            var current: RawAnswer?
            var lastNumber: Int?

            func flush() {
                if let current {
                    entries.append(interpretAnswerNumbers(current, kind: kind))
                }
                current = nil
            }

            for line in section.lines {
                if isSeparator(line) {
                    continue
                }
                if let marker = answerMarker(line) {
                    let normalized = normalizedNumber(marker.number)
                    let intValue = Int(marker.number) ?? 0
                    let currentNumber = current.map { normalizedNumber($0.number) }
                    let isFirst = current == nil
                    let isDifferentExpected = expected.contains(normalized) && normalized != currentNumber
                    let fallbackNext = expected.isEmpty && intValue > (lastNumber ?? 0)
                    if isFirst || isDifferentExpected || fallbackNext {
                        flush()
                        current = RawAnswer(
                            number: marker.number,
                            raw: marker.rest,
                            letter: nil
                        )
                        lastNumber = intValue
                        continue
                    }
                }
                if current != nil {
                    current?.raw.append("\n")
                    current?.raw.append(line)
                }
            }
            flush()

            var byNumber: [String: RawAnswer] = [:]
            for entry in entries {
                byNumber[normalizedNumber(entry.number)] = entry
            }
            result[section.index] = AnswerSection(
                index: section.index,
                kind: kind,
                byNumber: byNumber,
                ordered: entries
            )
        }
        return result
    }

    private static func answerMarker(_ line: String) -> (number: String, rest: String)? {
        let stripped = topLevelMarkerText(line) ?? ""
        guard !stripped.isEmpty else { return nil }
        guard let captured = captures(
            stripped,
            pattern: "^\\s*\\**\\s*(\\d{1,3})[\\).:]\\s*\\**\\s*(.*)$"
        ) else { return nil }
        var rest = captured[1].trimmingCharacters(in: .whitespacesAndNewlines)
        guard let intValue = Int(captured[0]), intValue > 0 else { return nil }
        rest = stripLeadingBold(rest)
        return (String(intValue), rest)
    }

    private static func interpretAnswerNumbers(
        _ entry: RawAnswer,
        kind: QuestionKind
    ) -> RawAnswer {
        var copy = entry
        copy.number = normalizedNumber(entry.number)
        if kind == .general {
            copy.letter = leadingLetter(entry.raw)
        }
        return copy
    }

    private static func interpret(
        _ answer: RawAnswer,
        kind: QuestionKind,
        questionType: QuizQuestionType,
        options: [QuizOption]
    ) -> InterpretedAnswer {
        let raw = answer.raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let letter = answer.letter

        switch questionType {
        case .multipleChoice:
            if let letter {
                let explanation = stripExplanationPrefix(
                    splitAnswer(raw)?.right ?? ""
                )
                return InterpretedAnswer(letter: letter, text: letter, explanation: explanation)
            }
            let split = splitAnswer(raw)
            let text = cleanAnswerText(split?.left ?? raw)
            let mapped = optionLetter(for: text, options: options)
            let explanation = stripExplanationPrefix(split?.right ?? raw)
            return InterpretedAnswer(
                letter: mapped,
                text: mapped ?? text,
                explanation: explanation
            )

        case .fillInTheBlank:
            let split = splitAnswer(raw)
            let text = cleanAnswerText(split?.left ?? firstLine(raw))
            let explanation = stripExplanationPrefix(split?.right ?? "")
            return InterpretedAnswer(
                letter: nil,
                text: text,
                explanation: explanation.isEmpty ? "" : explanation
            )

        case .shortAnswer:
            if kind == .shortAnswer || kind == .general {
                let first = firstLine(raw)
                if let split = splitAnswer(first) {
                    let left = cleanAnswerText(split.left)
                    if !left.isEmpty {
                        return InterpretedAnswer(
                            letter: nil,
                            text: left,
                            explanation: stripExplanationPrefix(split.right).isEmpty
                                ? raw
                                : stripExplanationPrefix(split.right)
                        )
                    }
                }
                let bold = boldPhrases(first).joined(separator: ", ")
                let text = bold.isEmpty ? cleanAnswerText(first) : bold
                return InterpretedAnswer(
                    letter: nil,
                    text: text.isEmpty ? cleanAnswerText(raw) : text,
                    explanation: raw
                )
            }
            let split = splitAnswer(raw)
            return InterpretedAnswer(
                letter: nil,
                text: cleanAnswerText(split?.left ?? firstLine(raw)),
                explanation: stripExplanationPrefix(split?.right ?? raw)
            )
        }
    }

    // MARK: - Text helpers

    private static func headingComponents(_ line: String) -> (level: Int, title: String)? {
        guard let captured = captures(
            line,
            pattern: "^\\s{0,3}(#{1,6})\\s+(.+?)\\s*#*\\s*$"
        ) else { return nil }
        return (captured[0].count, captured[1].trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func stripBullet(_ line: String) -> (text: String, hadBullet: Bool) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
            return (String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces), true)
        }
        return (trimmed, false)
    }

    /// Question and answer markers are top-level list entries. A leading
    /// indentation means the line is a nested numbered list inside a prompt or
    /// answer body, not a new question/answer entry.
    private static func topLevelMarkerText(_ line: String) -> String? {
        guard let first = line.first, first != " ", first != "\t" else { return nil }
        return stripBullet(line).text
    }

    private static func stripTrailingBold(_ value: String) -> String {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("**") {
            text.removeLast(2)
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }

    private static func stripLeadingBold(_ value: String) -> String {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasPrefix("**") {
            text.removeFirst(2)
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }

    private static func stripOuterBold(_ value: String) -> String {
        stripLeadingBold(stripTrailingBold(value))
    }

    private static func leadingCategory(_ value: String) -> (category: String, rest: String)? {
        guard let captured = captures(
            value,
            pattern: "^\\s*\\**\\s*\\[([^\\]]+)\\]\\s*\\**\\s*(.*)$"
        ) else { return nil }
        return (captured[0].trimmingCharacters(in: .whitespaces), captured[1])
    }

    private static func replacingTags(in value: String) -> String {
        value
            .replacingOccurrences(
                of: "</?Multiple-Choice>",
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.range(of: "^-{2,}$", options: .regularExpression) != nil
            || trimmed == "***"
            || trimmed == "___"
    }

    private static func leadingLetter(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let captured = captures(
            trimmed,
            pattern: "^\\s*\\**\\s*(?:Option\\s*)?(?:Correct\\s+Answer\\s*:?\\s*)?(?:Answer\\s*:?\\s*)?\\**\\s*([A-Z])\\**\\s*(?:[-–—:.]|\\))\\s*[\\s\\S]*$"
        ) {
            return captured[0]
        }
        if let captured = captures(trimmed, pattern: "^\\s*\\**\\s*([A-Z])\\**\\s*$") {
            return captured[0]
        }
        return nil
    }

    private static func splitAnswer(_ raw: String) -> (left: String, right: String)? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(
            of: "\\s+[–—]\\s+|\\s+-\\s+",
            options: .regularExpression
        ) else { return nil }
        let left = String(trimmed[..<range.lowerBound])
        let right = String(trimmed[range.upperBound...])
        guard !left.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return (left, right)
    }

    private static func cleanAnswerText(_ value: String) -> String {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        text = text.replacingOccurrences(of: "**", with: "")
        text = text.replacingOccurrences(of: "__", with: "")
        text = text.replacingOccurrences(of: "*", with: "")
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: "[]()"))
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix(".") { text.removeLast() }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func stripExplanationPrefix(_ value: String) -> String {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["(explanation)", "explanation:", "explanation", "(rationale)", "rationale:", "rationale", "(rubric)", "rubric:"] {
            if text.lowercased().hasPrefix(prefix) {
                text = String(text.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                break
            }
        }
        while text.hasPrefix(":") || text.hasPrefix("—") || text.hasPrefix("–") || text.hasPrefix("-") {
            text.removeFirst()
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }

    private static func firstLine(_ value: String) -> String {
        value
            .components(separatedBy: .newlines)
            .first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
            ?? ""
    }

    private static func boldPhrases(_ value: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: "\\*\\*([^*]+)\\*\\*") else { return [] }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.matches(in: value, range: range).compactMap { match in
            guard let captured = Range(match.range(at: 1), in: value) else { return nil }
            return String(value[captured]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    private static func letter(forIndex index: Int) -> String {
        let scalar = UnicodeScalar(65 + index) ?? UnicodeScalar(65)!
        return String(Character(scalar))
    }

    private static func normalizedNumber(_ value: String) -> String {
        padded(Int(value) ?? 0)
    }

    private static func padded(_ value: Int) -> String {
        String(format: "%02d", value)
    }

    private static func padded(_ value: String) -> String {
        padded(Int(value) ?? 0)
    }

    private static func looseBody(_ markdown: String) -> String {
        guard let range = markdown.range(
            of: "^---\\s*\\n[\\s\\S]*?\\n---\\s*\\n*",
            options: .regularExpression
        ) else {
            return markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return String(markdown[range.upperBound...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Regex

    private static func captures(
        _ value: String,
        pattern: String,
        caseInsensitive: Bool = false
    ) -> [String]? {
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return nil
        }
        let searchRange = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, options: [], range: searchRange) else {
            return nil
        }
        var groups: [String] = []
        for index in 1..<match.numberOfRanges {
            if let range = Range(match.range(at: index), in: value) {
                groups.append(String(value[range]))
            } else {
                groups.append("")
            }
        }
        return groups
    }

    private static func firstCapture(
        _ value: String,
        pattern: String,
        caseInsensitive: Bool = false
    ) -> String? {
        captures(value, pattern: pattern, caseInsensitive: caseInsensitive)?.first
    }
}
