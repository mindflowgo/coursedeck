import Foundation

// MARK: - Canonical attachments

public enum PromptContextScope: String, Equatable, Sendable {
    case lesson
    case unit
    case course
}

public enum PromptContextSource: String, Equatable, Sendable {
    case lessons
    case summaries
    case cheatsheets
}

/// The exact desktop token strings (PLAN §3.2). Unknown strings are rejected,
/// never mapped to a default.
public enum PromptContextAttachment: String, CaseIterable, Equatable, Sendable {
    case lessonLessons = "lesson - lessons"
    case lessonSummaries = "lesson - summaries"
    case lessonCheatsheets = "lesson - cheatsheets"
    case unitLessons = "unit - lessons"
    case unitSummaries = "unit - summaries"
    case unitCheatsheets = "unit - cheatsheets"
    case courseLessons = "course - lessons"
    case courseSummaries = "course - summaries"
    case courseCheatsheets = "course - cheatsheets"

    public var scope: PromptContextScope {
        switch self {
        case .lessonLessons, .lessonSummaries, .lessonCheatsheets: return .lesson
        case .unitLessons, .unitSummaries, .unitCheatsheets: return .unit
        case .courseLessons, .courseSummaries, .courseCheatsheets: return .course
        }
    }

    public var source: PromptContextSource {
        switch self {
        case .lessonLessons, .unitLessons, .courseLessons: return .lessons
        case .lessonSummaries, .unitSummaries, .courseSummaries: return .summaries
        case .lessonCheatsheets, .unitCheatsheets, .courseCheatsheets: return .cheatsheets
        }
    }

    public static func canonical(_ raw: String) -> PromptContextAttachment? {
        PromptContextAttachment(rawValue: raw)
    }

    public var scopeID: String {
        scope.rawValue
    }
}

// MARK: - Course documents

public enum CourseDocKind: String, CaseIterable, Equatable, Sendable {
    case summary
    case cheatsheet
    case test

    public var tab: String { rawValue }

    public var promptID: String { "course_\(rawValue)" }

    /// Course-doc selector mapping (PLAN §4.8). `course - lessons` is hidden
    /// and rejected for course documents in v1.
    public var attachment: PromptContextAttachment {
        switch self {
        case .summary, .test: return .courseSummaries
        case .cheatsheet: return .courseCheatsheets
        }
    }

    public var sourceChain: [PromptContextSource] {
        switch self {
        case .summary, .test: return [.summaries, .cheatsheets]
        case .cheatsheet: return [.cheatsheets, .summaries]
        }
    }

    public var budget: AggregationBudget {
        switch self {
        case .summary: return .courseSummary
        case .cheatsheet: return .courseCheatsheet
        case .test: return .courseTest
        }
    }

    public var includesQuestionCoverage: Bool { self == .test }
}

public struct AggregationBudget: Equatable, Sendable {
    public var perLessonCharacters: Int
    public var totalCharacters: Int

    public init(perLessonCharacters: Int, totalCharacters: Int) {
        self.perLessonCharacters = max(perLessonCharacters, 1)
        self.totalCharacters = max(totalCharacters, 1)
    }

    /// Unit tabs: 3,000 chars/lesson, 80,000 total (PLAN §4.8).
    public static let unit = AggregationBudget(perLessonCharacters: 3_000, totalCharacters: 80_000)
    public static let courseSummary = AggregationBudget(perLessonCharacters: 3_000, totalCharacters: 200_000)
    public static let courseCheatsheet = AggregationBudget(perLessonCharacters: 2_500, totalCharacters: 200_000)
    public static let courseTest = AggregationBudget(perLessonCharacters: 2_200, totalCharacters: 200_000)
}

// MARK: - Payload

public struct PromptContextPayload: Equatable, Sendable {
    public var content: String
    public var attachment: PromptContextAttachment
    public var lessonsIncluded: Int
    public var fallbackLessonIDs: [String]
    public var truncatedLessonIDs: [String]
    public var curatedCoveredLessons: Int
    public var totalLessons: Int

    public init(
        content: String,
        attachment: PromptContextAttachment,
        lessonsIncluded: Int = 0,
        fallbackLessonIDs: [String] = [],
        truncatedLessonIDs: [String] = [],
        curatedCoveredLessons: Int = 0,
        totalLessons: Int = 0
    ) {
        self.content = content
        self.attachment = attachment
        self.lessonsIncluded = lessonsIncluded
        self.fallbackLessonIDs = fallbackLessonIDs
        self.truncatedLessonIDs = truncatedLessonIDs
        self.curatedCoveredLessons = curatedCoveredLessons
        self.totalLessons = totalLessons
    }

    public var characterCount: Int { content.count }
}

public enum PromptContextRequest: Equatable, Sendable {
    case lesson(courseId: String, lessonId: String, attachment: PromptContextAttachment?, customContent: String?)
    case unit(courseId: String, unitNumber: Int, attachment: PromptContextAttachment?)
    case courseDoc(courseId: String, kind: CourseDocKind)
}

public enum PromptContextError: Error, LocalizedError, Equatable {
    case courseNotFound(String)
    case lessonNotFound(String)
    case unitNotFound(Int)
    case unsupportedAttachment(String)
    case attachmentScopeMismatch(String)
    case unsupportedCourseDocAttachment(String)
    case payloadTooShort(actual: Int, minimum: Int)
    case insufficientCuratedCoverage(courseId: String, covered: Int, total: Int, minimum: Double)

    public var errorDescription: String? {
        switch self {
        case let .courseNotFound(id): return "Course \(id) was not found."
        case let .lessonNotFound(id): return "Lesson \(id) was not found."
        case let .unitNotFound(number): return "Unit \(number) was not found."
        case let .unsupportedAttachment(value): return "Unknown prompt context attachment: \(value)."
        case let .attachmentScopeMismatch(value): return "Prompt context \(value) does not match this document scope."
        case let .unsupportedCourseDocAttachment(value):
            return "\(value) cannot be used to generate course documents in this version."
        case let .payloadTooShort(actual, minimum):
            return "The selected content is too short to generate from (\(actual) characters; at least \(minimum) are required)."
        case let .insufficientCuratedCoverage(courseId, covered, total, minimum):
            return "Course \(courseId) has generated content for only \(covered) of \(total) lessons. Generate the lesson summaries or cheatsheets first (at least \(Int(minimum * 100))% coverage is required)."
        }
    }
}

// MARK: - Sanitizer

/// Prompt content is media-stripped and frontmatter-free (PLAN §4.8). Files
/// remain untouched; only the text sent to the model is transformed.
public enum PromptContentSanitizer {
    public static let minimumPayloadCharacters = 50
    public static let stubCharacterLimit = 250

    public static func stripFrontmatter(_ raw: String) -> String {
        if let document = try? FrontmatterDocument(parsing: raw), document.hadFrontmatter {
            return document.body
        }
        guard raw.hasPrefix("---") else { return raw }
        guard let regex = try? NSRegularExpression(
            pattern: #"^---[ \t]*\n[\s\S]*?\n---[ \t]*\n?"#
        ) else { return raw }
        let range = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        return regex.stringByReplacingMatches(in: raw, options: [], range: range, withTemplate: "")
    }

    public static func sanitize(_ raw: String) -> String {
        var text = stripFrontmatter(raw)
        text = text.replacingOccurrences(of: "\u{FEFF}", with: "")
        text = text.replacingOccurrences(of: "\r\n", with: "\n")
        text = text.replacingOccurrences(of: "\r", with: "\n")

        // Images and media embeds add no useful model context. Links are kept.
        text = replace(text, pattern: #"!\[[^\]]*\]\([^)]*\)"#, with: "")
        text = replace(text, pattern: #"<(img|source)\b[^>]*>"#, with: "")
        text = replace(text, pattern: #"<(video|audio|iframe)\b[\s\S]*?</\1\s*>"#, with: "")
        text = replace(text, pattern: #"<script\b[\s\S]*?</script\s*>"#, with: "")
        text = replace(text, pattern: #"<style\b[\s\S]*?</style\s*>"#, with: "")
        text = replace(text, pattern: #"\n{3,}"#, with: "\n\n")
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Missing, near-empty, or placeholder output counts as not generated.
    public static func isStub(_ raw: String?) -> Bool {
        guard let raw else { return true }
        let body = sanitize(raw)
        guard !body.isEmpty else { return true }
        if body.count <= stubCharacterLimit { return true }
        return body.range(of: "not yet generated", options: [.caseInsensitive]) != nil
    }

    public static func truncate(_ text: String, to limit: Int) -> String {
        guard limit > 0, text.count > limit else { return text }
        let marker = "\n\n[… truncated …]"
        if limit <= marker.count { return String(text.prefix(limit)) }
        return String(text.prefix(limit - marker.count)) + marker
    }

    private static func replace(_ text: String, pattern: String, with template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return text
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: template)
    }
}

// MARK: - Service

/// Builds the user message for lesson/unit/course-doc generation. Exposes the
/// two distinct desktop behaviors without conflating them:
///
/// * `getPromptContext` — the exact attachment token, budgeted on iOS.
/// * `buildAggregatedPayload` — the course-doc matrix with per-lesson budgets
///   and curated fallbacks (PLAN §4.8).
public actor PromptContextService {
    private let repository: CourseRepository
    public var minimumCuratedCoverage: Double

    public init(repository: CourseRepository, minimumCuratedCoverage: Double = 0.5) {
        self.repository = repository
        self.minimumCuratedCoverage = min(max(minimumCuratedCoverage, 0), 1)
    }

    // MARK: Public requests

    public func payload(for request: PromptContextRequest) async throws -> PromptContextPayload {
        switch request {
        case let .lesson(courseId, lessonId, attachment, customContent):
            if let customContent, !customContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return try makeCustomPayload(
                    customContent,
                    attachment: attachment ?? .lessonLessons
                )
            }
            return try await lessonPayload(
                courseId: courseId,
                lessonId: lessonId,
                attachment: attachment ?? .lessonLessons
            )
        case let .unit(courseId, unitNumber, attachment):
            return try await unitPayload(
                courseId: courseId,
                unitNumber: unitNumber,
                attachment: attachment ?? .unitLessons
            )
        case let .courseDoc(courseId, kind):
            return try await buildAggregatedPayload(courseId: courseId, kind: kind)
        }
    }

    /// Port of the desktop `getPromptContext`, with the iOS unit/course budgets
    /// applied. Tokens are matched exactly.
    public func getPromptContext(
        courseId: String,
        lessonId: String,
        attachment rawAttachment: String
    ) async throws -> PromptContextPayload {
        guard let attachment = PromptContextAttachment.canonical(rawAttachment) else {
            throw PromptContextError.unsupportedAttachment(rawAttachment)
        }
        switch attachment.scope {
        case .lesson:
            return try await lessonPayload(courseId: courseId, lessonId: lessonId, attachment: attachment)
        case .unit:
            guard let unit = PathValidator.parseUnitNumber(lessonId) else {
                throw PromptContextError.unitNotFound(0)
            }
            return try await unitPayload(courseId: courseId, unitNumber: unit, attachment: attachment)
        case .course:
            return try await courseContextPayload(courseId: courseId, attachment: attachment)
        }
    }

    /// The budgeted course-doc matrix. This is the only preview/generation
    /// source for course documents; do not call `getPromptContext` instead.
    public func buildAggregatedPayload(
        courseId: String,
        kind: CourseDocKind
    ) async throws -> PromptContextPayload {
        let manifest = try await loadManifest(courseId)
        let lessons = manifest.allLessons
        guard !lessons.isEmpty else {
            throw PromptContextError.insufficientCuratedCoverage(
                courseId: courseId,
                covered: 0,
                total: 0,
                minimum: minimumCuratedCoverage
            )
        }

        let aggregate = await aggregate(
            courseId: courseId,
            lessons: lessons,
            sourceChain: kind.sourceChain,
            budget: kind.budget,
            includeQuestionCoverage: kind.includesQuestionCoverage
        )

        let total = lessons.count
        let coverage = Double(aggregate.coveredLessons) / Double(max(total, 1))
        guard coverage >= minimumCuratedCoverage, aggregate.coveredLessons > 0 else {
            throw PromptContextError.insufficientCuratedCoverage(
                courseId: courseId,
                covered: aggregate.coveredLessons,
                total: total,
                minimum: minimumCuratedCoverage
            )
        }

        let payload = PromptContextPayload(
            content: aggregate.content,
            attachment: kind.attachment,
            lessonsIncluded: aggregate.lessonsIncluded,
            fallbackLessonIDs: aggregate.fallbackLessonIDs,
            truncatedLessonIDs: aggregate.truncatedLessonIDs,
            curatedCoveredLessons: aggregate.coveredLessons,
            totalLessons: total
        )
        try assertMinimum(payload)
        return payload
    }

    // MARK: Lesson / unit

    public func lessonPayload(
        courseId: String,
        lessonId: String,
        attachment: PromptContextAttachment
    ) async throws -> PromptContextPayload {
        guard attachment.scope == .lesson else {
            throw PromptContextError.attachmentScopeMismatch(attachment.rawValue)
        }
        let manifest = try await loadManifest(courseId)
        guard manifest.lesson(id: lessonId) != nil else {
            throw PromptContextError.lessonNotFound(lessonId)
        }

        let content: String?
        switch attachment.source {
        case .lessons:
            content = try await repository.tabContent(courseId: courseId, lessonId: lessonId, tab: "lesson")
        case .summaries:
            content = try await repository.tabContent(courseId: courseId, lessonId: lessonId, tab: "summary")
        case .cheatsheets:
            content = try await repository.tabContent(courseId: courseId, lessonId: lessonId, tab: "cheatsheet")
        }

        let sanitized = PromptContentSanitizer.sanitize(content ?? "")
        let payload = PromptContextPayload(
            content: sanitized,
            attachment: attachment,
            lessonsIncluded: sanitized.isEmpty ? 0 : 1,
            totalLessons: 1
        )
        try assertMinimum(payload)
        return payload
    }

    public func unitPayload(
        courseId: String,
        unitNumber: Int,
        attachment: PromptContextAttachment
    ) async throws -> PromptContextPayload {
        guard attachment.scope == .unit else {
            throw PromptContextError.attachmentScopeMismatch(attachment.rawValue)
        }
        let manifest = try await loadManifest(courseId)
        guard let unit = manifest.unit(number: unitNumber) else {
            throw PromptContextError.unitNotFound(unitNumber)
        }

        let chain: [PromptContextSource]
        switch attachment.source {
        case .lessons:
            chain = [.lessons]
        case .summaries:
            chain = [.summaries, .lessons]
        case .cheatsheets:
            chain = [.cheatsheets, .summaries, .lessons]
        }

        let aggregate = await aggregate(
            courseId: courseId,
            lessons: unit.lessons,
            sourceChain: chain,
            budget: .unit,
            includeQuestionCoverage: false
        )
        let payload = PromptContextPayload(
            content: aggregate.content,
            attachment: attachment,
            lessonsIncluded: aggregate.lessonsIncluded,
            fallbackLessonIDs: aggregate.fallbackLessonIDs,
            truncatedLessonIDs: aggregate.truncatedLessonIDs,
            curatedCoveredLessons: aggregate.coveredLessons,
            totalLessons: unit.lessons.count
        )
        try assertMinimum(payload)
        return payload
    }

    private func courseContextPayload(
        courseId: String,
        attachment: PromptContextAttachment
    ) async throws -> PromptContextPayload {
        guard attachment.scope == .course else {
            throw PromptContextError.attachmentScopeMismatch(attachment.rawValue)
        }
        let manifest = try await loadManifest(courseId)
        let chain: [PromptContextSource]
        switch attachment.source {
        case .lessons: chain = [.lessons]
        case .summaries: chain = [.summaries, .cheatsheets]
        case .cheatsheets: chain = [.cheatsheets, .summaries]
        }
        let aggregate = await aggregate(
            courseId: courseId,
            lessons: manifest.allLessons,
            sourceChain: chain,
            budget: .unit,
            includeQuestionCoverage: false
        )
        let payload = PromptContextPayload(
            content: aggregate.content,
            attachment: attachment,
            lessonsIncluded: aggregate.lessonsIncluded,
            fallbackLessonIDs: aggregate.fallbackLessonIDs,
            truncatedLessonIDs: aggregate.truncatedLessonIDs,
            curatedCoveredLessons: aggregate.coveredLessons,
            totalLessons: manifest.allLessons.count
        )
        try assertMinimum(payload)
        return payload
    }

    private func makeCustomPayload(
        _ raw: String,
        attachment: PromptContextAttachment
    ) throws -> PromptContextPayload {
        let sanitized = PromptContentSanitizer.sanitize(raw)
        let payload = PromptContextPayload(
            content: sanitized,
            attachment: attachment,
            lessonsIncluded: sanitized.isEmpty ? 0 : 1
        )
        try assertMinimum(payload)
        return payload
    }

    // MARK: Aggregation

    private struct AggregateResult {
        var content: String
        var lessonsIncluded: Int
        var fallbackLessonIDs: [String]
        var truncatedLessonIDs: [String]
        var coveredLessons: Int
    }

    private func aggregate(
        courseId: String,
        lessons: [CourseLesson],
        sourceChain: [PromptContextSource],
        budget: AggregationBudget,
        includeQuestionCoverage: Bool
    ) async -> AggregateResult {
        var sections: [String] = []
        var used = 0
        var included = 0
        var fallbacks: [String] = []
        var truncated: [String] = []
        var covered = 0
        var exhausted = false

        for lesson in lessons {
            if exhausted { break }
            var chosen: String?
            var fallbackUsed = false
            for (index, source) in sourceChain.enumerated() {
                guard let raw = await sourceContent(
                    courseId: courseId,
                    lessonId: lesson.id,
                    source: source
                ) else { continue }
                if source == .lessons {
                    // Raw lesson bodies are valid at any length; a 200-char
                    // lesson is still real content. Only empty bodies skip.
                    let sanitized = PromptContentSanitizer.sanitize(raw)
                    guard !sanitized.isEmpty else { continue }
                    chosen = sanitized
                } else {
                    // Summary/cheatsheet stubs are placeholders and must not be
                    // sent as if they were curated content.
                    guard !PromptContentSanitizer.isStub(raw) else { continue }
                    chosen = PromptContentSanitizer.sanitize(raw)
                }
                fallbackUsed = index > 0
                break
            }
            guard let body = chosen, !body.isEmpty else { continue }

            covered += 1
            if fallbackUsed { fallbacks.append(lesson.id) }

            var section = Self.heading(for: lesson) + "\n\n" + PromptContentSanitizer.truncate(
                body,
                to: budget.perLessonCharacters
            )
            if body.count > budget.perLessonCharacters {
                truncated.append(lesson.id)
            }

            if includeQuestionCoverage,
               let test = try? await repository.tabContent(courseId: courseId, lessonId: lesson.id, tab: "test"),
               !PromptContentSanitizer.isStub(test) {
                let coverage = Self.questionCoverage(from: test)
                if !coverage.isEmpty {
                    section += "\n\n### Existing question coverage\n\n" + coverage
                }
            }

            let separator = sections.isEmpty ? 0 : 2
            let remaining = budget.totalCharacters - used - separator
            if remaining <= 0 {
                exhausted = true
                break
            }
            if section.count > remaining {
                section = PromptContentSanitizer.truncate(section, to: remaining)
                if !truncated.contains(lesson.id) { truncated.append(lesson.id) }
                exhausted = true
            }
            sections.append(section)
            used += section.count + separator
            included += 1
        }

        return AggregateResult(
            content: sections.joined(separator: "\n\n"),
            lessonsIncluded: included,
            fallbackLessonIDs: fallbacks,
            truncatedLessonIDs: truncated,
            coveredLessons: covered
        )
    }

    private func sourceContent(
        courseId: String,
        lessonId: String,
        source: PromptContextSource
    ) async -> String? {
        switch source {
        case .lessons:
            return try? await repository.tabContent(courseId: courseId, lessonId: lessonId, tab: "lesson")
        case .summaries:
            return try? await repository.tabContent(courseId: courseId, lessonId: lessonId, tab: "summary")
        case .cheatsheets:
            return try? await repository.tabContent(courseId: courseId, lessonId: lessonId, tab: "cheatsheet")
        }
    }

    private func loadManifest(_ courseId: String) async throws -> CourseManifest {
        guard let manifest = try await repository.course(courseId: courseId) else {
            throw PromptContextError.courseNotFound(courseId)
        }
        return manifest
    }

    private func assertMinimum(_ payload: PromptContextPayload) throws {
        let count = payload.content.trimmingCharacters(in: .whitespacesAndNewlines).count
        guard count >= PromptContentSanitizer.minimumPayloadCharacters else {
            throw PromptContextError.payloadTooShort(
                actual: count,
                minimum: PromptContentSanitizer.minimumPayloadCharacters
            )
        }
    }

    private static func heading(for lesson: CourseLesson) -> String {
        let code = lesson.code.isEmpty ? lesson.id : lesson.code
        let title = lesson.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? "## \(code)" : "## \(code) — \(title)"
    }

    /// Extracts at most 10 questions, each capped at 8 lines. If no numbered
    /// questions can be found, falls back to the first 1,500 characters of the
    /// questions region.
    static func questionCoverage(
        from raw: String,
        maxQuestions: Int = 10,
        maxLinesPerQuestion: Int = 8,
        fallbackCharacters: Int = 1_500
    ) -> String {
        let body = PromptContentSanitizer.sanitize(raw)
        let lines = body.components(separatedBy: "\n")
        var region: [String] = []
        var inQuestions = false
        for line in lines {
            if line.range(of: #"^\s*#{1,6}\s+Questions"#, options: [.regularExpression, .caseInsensitive]) != nil {
                inQuestions = true
                continue
            }
            if inQuestions,
               line.range(of: #"^\s*#{1,6}\s+.*Answers"#, options: [.regularExpression, .caseInsensitive]) != nil {
                break
            }
            if inQuestions {
                region.append(line)
            }
        }
        if region.isEmpty { region = lines }

        var blocks: [[String]] = []
        var current: [String] = []
        for line in region {
            let isQuestion = line.range(
                of: #"^\s*\d{1,2}[\).]\s+"#,
                options: [.regularExpression]
            ) != nil
            if isQuestion {
                if !current.isEmpty { blocks.append(current) }
                current = [line]
            } else if !current.isEmpty {
                current.append(line)
            }
        }
        if !current.isEmpty { blocks.append(current) }

        guard !blocks.isEmpty else {
            return String(body.prefix(fallbackCharacters))
        }

        let selected = blocks.prefix(maxQuestions).map { block in
            block.prefix(maxLinesPerQuestion).joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let joined = selected.filter { !$0.isEmpty }.joined(separator: "\n\n")
        return String(joined.prefix(fallbackCharacters))
    }
}
