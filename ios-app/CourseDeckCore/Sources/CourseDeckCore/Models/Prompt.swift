import Foundation

public enum PromptSource: String, Equatable, Sendable {
    /// Shipped inside the app bundle (`CourseDeck/Resources/Prompts`).
    case bundled
    /// Present in the live `<data root>/prompts` directory (seeded or edited).
    case active
}

public struct Prompt: Equatable, Sendable {
    public var id: String
    public var title: String
    public var filename: String
    public var content: String
    public var source: PromptSource

    public init(id: String, title: String, filename: String, content: String, source: PromptSource) {
        self.id = id
        self.title = title
        self.filename = filename
        self.content = content
        self.source = source
    }

    /// First top-level `#` heading, falling back to the ID, matching the
    /// desktop `PromptService`.
    public static func title(for content: String, fallback: String) -> String {
        if let title = firstHeading(in: content) {
            return title
        }
        return fallback
    }

    public static func firstHeading(in content: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: "^#\\s+(.*)$", options: [.anchorsMatchLines]) else {
            return nil
        }
        let range = NSRange(content.startIndex..<content.endIndex, in: content)
        guard let match = regex.firstMatch(in: content, options: [], range: range),
              match.numberOfRanges > 1,
              let titleRange = Range(match.range(at: 1), in: content) else { return nil }
        let title = content[titleRange].trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? nil : title
    }
}

public enum PromptCatalog {
    /// Required by the staged prompt manifest. A missing required prompt is a
    /// configuration error, not a silent fallback.
    public static let requiredIDs: [String] = [
        "cheatsheet", "course_cheatsheet", "course_schedule", "course_summary",
        "course_test", "popquiz", "summary", "test", "unit_assignments", "unit_test",
    ]

    /// Present in the desktop library but optional on iOS. They are protected
    /// from deletion when they exist.
    public static let optionalProtectedIDs: [String] = ["lesson", "test_kica"]

    /// Every built-in prompt the app refuses to delete (PLAN §4.8).
    public static let protectedIDs: Set<String> = Set([
        "course_summary", "course_cheatsheet", "course_schedule", "course_test",
        "summary", "cheatsheet", "test", "test_kica", "lesson", "popquiz",
        "unit_assignments", "unit_test",
    ])

    /// The counts each staged prompt asks for. Validation and the prompt
    /// manifest must enforce the same numbers (PLAN §4.8): a lesson test is
    /// 6 MC + 4 FIB, a generated course test is 12 MC + 4 multi-part, a unit
    /// test is 8 MC + 2 FIB + 2 short answer, and a pop quiz is 4 MC + 2 FIB.
    public static let expectedQuestionCounts: [String: PromptQuestionCounts] = [
        "test": PromptQuestionCounts(multipleChoice: 6, fillInTheBlank: 4, total: 10),
        "course_test": PromptQuestionCounts(multipleChoice: 12, multiPart: 4, total: 16),
        "unit_test": PromptQuestionCounts(multipleChoice: 8, fillInTheBlank: 2, shortAnswer: 2, total: 12),
        "popquiz": PromptQuestionCounts(multipleChoice: 4, fillInTheBlank: 2, total: 6),
    ]

    public static func isProtected(_ id: String) -> Bool {
        protectedIDs.contains(id.lowercased())
    }
}

public struct PromptQuestionCounts: Equatable, Sendable {
    public var multipleChoice: Int?
    public var fillInTheBlank: Int?
    public var shortAnswer: Int?
    public var multiPart: Int?
    public var total: Int?

    public init(
        multipleChoice: Int? = nil,
        fillInTheBlank: Int? = nil,
        shortAnswer: Int? = nil,
        multiPart: Int? = nil,
        total: Int? = nil
    ) {
        self.multipleChoice = multipleChoice
        self.fillInTheBlank = fillInTheBlank
        self.shortAnswer = shortAnswer
        self.multiPart = multiPart
        self.total = total
    }

    public init?(json: JSONValue) {
        guard json.objectValue != nil else { return nil }
        self.init(
            multipleChoice: json["multipleChoice"]?.intValue,
            fillInTheBlank: json["fillInTheBlank"]?.intValue,
            shortAnswer: json["shortAnswer"]?.intValue,
            multiPart: json["multiPart"]?.intValue,
            total: json["total"]?.intValue
        )
    }

    public var json: JSONValue {
        var members: [JSONMember] = []
        if let multipleChoice { members.append(JSONMember(key: "multipleChoice", value: .number(String(multipleChoice)))) }
        if let fillInTheBlank { members.append(JSONMember(key: "fillInTheBlank", value: .number(String(fillInTheBlank)))) }
        if let shortAnswer { members.append(JSONMember(key: "shortAnswer", value: .number(String(shortAnswer)))) }
        if let multiPart { members.append(JSONMember(key: "multiPart", value: .number(String(multiPart)))) }
        if let total { members.append(JSONMember(key: "total", value: .number(String(total)))) }
        return .object(members)
    }
}
