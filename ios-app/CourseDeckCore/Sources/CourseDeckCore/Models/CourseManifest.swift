import Foundation

/// `meta.json` as written by the desktop `CourseIngest`. The typed fields below
/// are the ones the app understands; `extras` keeps every unknown key (and its
/// position) so a roundtrip never strips data written by a newer desktop build.
public struct CourseManifest: Equatable, Sendable {
    public var id: String
    public var title: String
    public var grade: String
    public var level: String
    public var description: String
    public var units: [CourseUnit]
    public var updatedAt: String
    public var archived: Bool?
    public var extras: [JSONMember]
    /// Original top-level key order (known and unknown). Encoding replays this
    /// order so an unknown key keeps its desktop position instead of being
    /// moved to the end.
    public var originalOrder: [String]

    /// `path` and `courseDocs` are injected by the desktop at read time and
    /// are deliberately not modelled: they are never persisted.
    public init(
        id: String,
        title: String,
        grade: String = "",
        level: String = "",
        description: String = "",
        units: [CourseUnit] = [],
        updatedAt: String = "",
        archived: Bool? = nil,
        extras: [JSONMember] = [],
        originalOrder: [String] = []
    ) {
        self.id = id
        self.title = title
        self.grade = grade
        self.level = level
        self.description = description
        self.units = units
        self.updatedAt = updatedAt
        self.archived = archived
        self.extras = extras
        self.originalOrder = originalOrder
    }

    public var allLessons: [CourseLesson] {
        units.flatMap(\.lessons)
    }

    public func unit(number: Int) -> CourseUnit? {
        units.first(where: { $0.number == number })
    }

    public func lesson(id: String) -> CourseLesson? {
        let clean = id.lowercased()
        return allLessons.first(where: { $0.id.lowercased() == clean })
    }

    // MARK: - JSON

    private static let knownKeys: Set<String> = [
        "id", "title", "grade", "level", "description", "units", "updatedAt", "archived",
    ]

    public init(json: JSONValue) throws {
        guard case let .object(members) = json else {
            throw ManifestError.notAnObject
        }
        var id = ""
        var title = ""
        var grade = ""
        var level = ""
        var description = ""
        var units: [CourseUnit] = []
        var updatedAt = ""
        var archived: Bool?
        var extras: [JSONMember] = []

        for member in members {
            switch member.key {
            case "id": id = member.value.stringValue ?? ""
            case "title": title = member.value.stringValue ?? ""
            case "grade": grade = member.value.stringValue ?? ""
            case "level": level = member.value.stringValue ?? ""
            case "description": description = member.value.stringValue ?? ""
            case "units": units = (member.value.arrayValue ?? []).compactMap { try? CourseUnit(json: $0) }
            case "updatedAt": updatedAt = member.value.stringValue ?? ""
            case "archived": archived = member.value.boolValue
            default:
                if !Self.knownKeys.contains(member.key) {
                    extras.append(member)
                }
            }
        }

        self.init(
            id: id,
            title: title,
            grade: grade,
            level: level,
            description: description,
            units: units,
            updatedAt: updatedAt,
            archived: archived,
            extras: extras,
            originalOrder: OrderedJSONKeyOrder.keys(in: members, excluding: [])
        )
    }

    /// Emits the desktop's field order for new manifests; loaded manifests
    /// replay their original key order so unknown fields keep their position.
    public var json: JSONValue {
        let known: [(String, JSONValue?)] = [
            ("id", .string(id)),
            ("title", .string(title)),
            ("grade", .string(grade)),
            ("level", .string(level)),
            ("description", .string(description)),
            ("units", .array(units.map(\.json))),
            ("updatedAt", .string(updatedAt)),
            ("archived", archived.map { .bool($0) }),
        ]
        return .object(OrderedJSONKeyOrder.members(
            known: known,
            extras: extras,
            originalOrder: originalOrder
        ))
    }

    public static func decode(_ data: Data) throws -> CourseManifest {
        try CourseManifest(json: JSONValue(parsing: data))
    }

    public func encoded(pretty: Bool = true) -> Data {
        json.serializedData(pretty: pretty)
    }
}

public struct CourseUnit: Equatable, Sendable {
    public var number: Int
    public var title: String
    public var lessons: [CourseLesson]
    public var extras: [JSONMember]
    public var originalOrder: [String]

    public init(
        number: Int,
        title: String,
        lessons: [CourseLesson] = [],
        extras: [JSONMember] = [],
        originalOrder: [String] = []
    ) {
        self.number = number
        self.title = title
        self.lessons = lessons
        self.extras = extras
        self.originalOrder = originalOrder
    }

    private static let knownKeys: Set<String> = ["number", "title", "lessons"]

    public init(json: JSONValue) throws {
        guard case let .object(members) = json else { throw ManifestError.notAnObject }
        var number = 0
        var title = ""
        var lessons: [CourseLesson] = []
        var extras: [JSONMember] = []
        for member in members {
            switch member.key {
            case "number": number = member.value.intValue ?? 0
            case "title": title = member.value.stringValue ?? ""
            case "lessons": lessons = (member.value.arrayValue ?? []).compactMap { try? CourseLesson(json: $0) }
            default:
                if !Self.knownKeys.contains(member.key) { extras.append(member) }
            }
        }
        self.init(
            number: number,
            title: title,
            lessons: lessons,
            extras: extras,
            originalOrder: OrderedJSONKeyOrder.keys(in: members, excluding: [])
        )
    }

    public var json: JSONValue {
        let known: [(String, JSONValue?)] = [
            ("number", .number(String(number))),
            ("title", .string(title)),
            ("lessons", .array(lessons.map(\.json))),
        ]
        return .object(OrderedJSONKeyOrder.members(
            known: known,
            extras: extras,
            originalOrder: originalOrder
        ))
    }
}

public enum CourseLessonType: Equatable, Sendable {
    case lesson
    case assignment
    /// Unknown values are preserved verbatim instead of being coerced.
    case other(String)

    public init(raw: String) {
        switch raw.lowercased() {
        case "lesson": self = .lesson
        case "assignment": self = .assignment
        default: self = .other(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .lesson: return "lesson"
        case .assignment: return "assignment"
        case let .other(value): return value
        }
    }
}

public struct CourseLesson: Equatable, Sendable {
    public var id: String
    public var code: String
    public var title: String
    public var unitNumber: Int
    public var lessonNumber: Int
    public var type: CourseLessonType
    public var hasFull: Bool
    public var hasSummary: Bool
    public var hasCheatsheet: Bool
    public var hasTest: Bool
    public var extras: [JSONMember]
    public var originalOrder: [String]

    public init(
        id: String,
        code: String = "",
        title: String = "",
        unitNumber: Int = 0,
        lessonNumber: Int = 0,
        type: CourseLessonType = .lesson,
        hasFull: Bool = false,
        hasSummary: Bool = false,
        hasCheatsheet: Bool = false,
        hasTest: Bool = false,
        extras: [JSONMember] = [],
        originalOrder: [String] = []
    ) {
        self.id = id
        self.code = code
        self.title = title
        self.unitNumber = unitNumber
        self.lessonNumber = lessonNumber
        self.type = type
        self.hasFull = hasFull
        self.hasSummary = hasSummary
        self.hasCheatsheet = hasCheatsheet
        self.hasTest = hasTest
        self.extras = extras
        self.originalOrder = originalOrder
    }

    private static let knownKeys: Set<String> = [
        "id", "code", "title", "unitNumber", "lessonNumber", "type",
        "hasFull", "hasSummary", "hasCheatsheet", "hasTest",
    ]

    public init(json: JSONValue) throws {
        guard case let .object(members) = json else { throw ManifestError.notAnObject }
        var id = ""
        var code = ""
        var title = ""
        var unitNumber = 0
        var lessonNumber = 0
        var type: CourseLessonType = .lesson
        var hasFull = false
        var hasSummary = false
        var hasCheatsheet = false
        var hasTest = false
        var extras: [JSONMember] = []
        for member in members {
            switch member.key {
            case "id": id = member.value.stringValue ?? ""
            case "code": code = member.value.stringValue ?? ""
            case "title": title = member.value.stringValue ?? ""
            case "unitNumber": unitNumber = member.value.intValue ?? 0
            case "lessonNumber": lessonNumber = member.value.intValue ?? 0
            case "type": type = CourseLessonType(raw: member.value.stringValue ?? "lesson")
            case "hasFull": hasFull = member.value.boolValue ?? false
            case "hasSummary": hasSummary = member.value.boolValue ?? false
            case "hasCheatsheet": hasCheatsheet = member.value.boolValue ?? false
            case "hasTest": hasTest = member.value.boolValue ?? false
            default:
                if !Self.knownKeys.contains(member.key) { extras.append(member) }
            }
        }
        self.init(
            id: id,
            code: code,
            title: title,
            unitNumber: unitNumber,
            lessonNumber: lessonNumber,
            type: type,
            hasFull: hasFull,
            hasSummary: hasSummary,
            hasCheatsheet: hasCheatsheet,
            hasTest: hasTest,
            extras: extras,
            originalOrder: OrderedJSONKeyOrder.keys(in: members, excluding: [])
        )
    }

    public var json: JSONValue {
        let known: [(String, JSONValue?)] = [
            ("id", .string(id)),
            ("code", .string(code)),
            ("title", .string(title)),
            ("unitNumber", .number(String(unitNumber))),
            ("lessonNumber", .number(String(lessonNumber))),
            ("type", .string(type.rawValue)),
            ("hasFull", .bool(hasFull)),
            ("hasSummary", .bool(hasSummary)),
            ("hasCheatsheet", .bool(hasCheatsheet)),
            ("hasTest", .bool(hasTest)),
        ]
        return .object(OrderedJSONKeyOrder.members(
            known: known,
            extras: extras,
            originalOrder: originalOrder
        ))
    }
}

public enum ManifestError: Error, LocalizedError, Equatable {
    case notAnObject
    case corrupt(String)

    public var errorDescription: String? {
        switch self {
        case .notAnObject: return "Course manifest is not a JSON object."
        case let .corrupt(reason): return "Course manifest is corrupt: \(reason)"
        }
    }
}

/// Course-level document presence flags (`course.<tab>.md`).
public struct CourseDocsFlags: Equatable, Sendable {
    public var summary: Bool
    public var cheatsheet: Bool
    public var test: Bool
    public var schedule: Bool
    public var custom: [String: Bool]

    public init(
        summary: Bool = false,
        cheatsheet: Bool = false,
        test: Bool = false,
        schedule: Bool = false,
        custom: [String: Bool] = [:]
    ) {
        self.summary = summary
        self.cheatsheet = cheatsheet
        self.test = test
        self.schedule = schedule
        self.custom = custom
    }
}

/// Helpers for replaying a loaded JSON object's key order while overlaying
/// current typed values. Unknown keys keep their original position instead of
/// being pushed to the end of the object.
enum OrderedJSONKeyOrder {
    static func keys(in members: [JSONMember], excluding: Set<String>) -> [String] {
        var seen = Set<String>()
        var keys: [String] = []
        for member in members where !excluding.contains(member.key) {
            if seen.insert(member.key).inserted {
                keys.append(member.key)
            }
        }
        return keys
    }

    static func members(
        known: [(String, JSONValue?)],
        extras: [JSONMember],
        originalOrder: [String]
    ) -> [JSONMember] {
        var knownMap: [String: JSONValue?] = [:]
        for pair in known { knownMap[pair.0] = pair.1 }
        var extraMap: [String: JSONValue] = [:]
        for extra in extras where extraMap[extra.key] == nil { extraMap[extra.key] = extra.value }

        var result: [JSONMember] = []
        var emitted = Set<String>()
        for key in originalOrder where !emitted.contains(key) {
            if let value = knownMap[key] ?? nil {
                result.append(JSONMember(key: key, value: value))
            } else if let extra = extraMap[key] {
                result.append(JSONMember(key: key, value: extra))
            }
            emitted.insert(key)
        }
        for pair in known where !emitted.contains(pair.0) {
            if let value = pair.1 {
                result.append(JSONMember(key: pair.0, value: value))
                emitted.insert(pair.0)
            }
        }
        for extra in extras where !emitted.contains(extra.key) {
            result.append(extra)
            emitted.insert(extra.key)
        }
        return result
    }
}
