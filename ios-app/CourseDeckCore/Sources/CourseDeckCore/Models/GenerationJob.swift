import Foundation

public enum JobStatus: String, Equatable, Sendable, CaseIterable {
    case queued
    case running
    case succeeded
    case failed
    case cancelled
    /// The process died or the app was backgrounded mid-stream. Explicitly not
    /// a resumable state: the user chooses retry or discard.
    case interrupted

    public var isTerminal: Bool {
        switch self {
        case .succeeded, .failed, .cancelled: return true
        case .queued, .running, .interrupted: return false
        }
    }
}

public enum JobLane: String, Equatable, Sendable {
    case courseDocs = "course_docs"
    case standard
    case interactive
}

/// Durable generation journal record. Unlike the desktop `.jobs.json`, the iOS
/// record stores the complete task inputs so a relaunch can faithfully rebuild
/// the request (PLAN §4.9).
public struct GenerationJob: Equatable, Sendable {
    public var id: String
    public var courseId: String
    public var lessonId: String
    public var lessonTitle: String
    public var tab: String
    public var customPrompt: String?
    public var customContent: String?
    public var contextAttachment: String?
    /// Opaque user preferences (for example quiz options) kept verbatim.
    public var preferences: JSONValue?
    public var lane: JobLane
    public var activeCardId: String?
    public var activeCardPolicy: String?
    public var status: JobStatus
    public var attempts: Int
    public var maxAttempts: Int
    public var lastError: String?
    public var partialOutput: String?
    public var tokensUsed: Int?
    public var createdAt: String
    public var updatedAt: String
    public var startedAt: String?
    public var finishedAt: String?
    public var extras: [JSONMember]

    public init(
        id: String,
        courseId: String,
        lessonId: String,
        lessonTitle: String,
        tab: String,
        customPrompt: String? = nil,
        customContent: String? = nil,
        contextAttachment: String? = nil,
        preferences: JSONValue? = nil,
        lane: JobLane = .standard,
        activeCardId: String? = nil,
        activeCardPolicy: String? = nil,
        status: JobStatus = .queued,
        attempts: Int = 0,
        maxAttempts: Int = 3,
        lastError: String? = nil,
        partialOutput: String? = nil,
        tokensUsed: Int? = nil,
        createdAt: String = GenerationJob.timestamp(),
        updatedAt: String? = nil,
        startedAt: String? = nil,
        finishedAt: String? = nil,
        extras: [JSONMember] = []
    ) {
        self.id = id
        self.courseId = courseId
        self.lessonId = lessonId
        self.lessonTitle = lessonTitle
        self.tab = tab
        self.customPrompt = customPrompt
        self.customContent = customContent
        self.contextAttachment = contextAttachment
        self.preferences = preferences
        self.lane = lane
        self.activeCardId = activeCardId
        self.activeCardPolicy = activeCardPolicy
        self.status = status
        self.attempts = attempts
        self.maxAttempts = maxAttempts
        self.lastError = lastError
        self.partialOutput = partialOutput
        self.tokensUsed = tokensUsed
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.extras = extras
    }

    /// Desktop task identity, kept as the journal ID.
    public static func identifier(courseId: String, lessonId: String, tab: String) -> String {
        "\(courseId):\(lessonId):\(tab)"
    }

    private static let knownKeys: Set<String> = [
        "id", "courseId", "lessonId", "lessonTitle", "tab", "customPrompt",
        "customContent", "contextAttachment", "preferences", "lane", "activeCardId",
        "activeCardPolicy", "status", "attempts", "maxAttempts", "lastError",
        "partialOutput", "tokensUsed", "createdAt", "updatedAt", "startedAt", "finishedAt",
    ]

    public init?(json: JSONValue) {
        guard case let .object(members) = json else { return nil }
        var values: [String: JSONValue] = [:]
        var extras: [JSONMember] = []
        for member in members {
            if Self.knownKeys.contains(member.key) {
                values[member.key] = member.value
            } else {
                extras.append(member)
            }
        }
        guard let id = values["id"]?.stringValue,
              let courseId = values["courseId"]?.stringValue,
              let tab = values["tab"]?.stringValue else { return nil }

        // A missing or unrecognized status is never assumed runnable or
        // complete: it is exposed as interrupted for explicit retry/discard.
        let rawStatus = values["status"]?.stringValue
        let status = rawStatus.flatMap(JobStatus.init(rawValue:)) ?? .interrupted

        self.init(
            id: id,
            courseId: courseId,
            lessonId: values["lessonId"]?.stringValue ?? "",
            lessonTitle: values["lessonTitle"]?.stringValue ?? "",
            tab: tab,
            customPrompt: values["customPrompt"]?.stringValue,
            customContent: values["customContent"]?.stringValue,
            contextAttachment: values["contextAttachment"]?.stringValue,
            preferences: values["preferences"],
            lane: JobLane(rawValue: values["lane"]?.stringValue ?? "") ?? .standard,
            activeCardId: values["activeCardId"]?.stringValue,
            activeCardPolicy: values["activeCardPolicy"]?.stringValue,
            status: status,
            attempts: values["attempts"]?.intValue ?? 0,
            maxAttempts: values["maxAttempts"]?.intValue ?? 3,
            lastError: values["lastError"]?.stringValue,
            partialOutput: values["partialOutput"]?.stringValue,
            tokensUsed: values["tokensUsed"]?.intValue,
            createdAt: values["createdAt"]?.stringValue ?? Self.timestamp(),
            updatedAt: values["updatedAt"]?.stringValue,
            startedAt: values["startedAt"]?.stringValue,
            finishedAt: values["finishedAt"]?.stringValue,
            extras: extras
        )
    }

    public var json: JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "id", value: .string(id)),
            JSONMember(key: "courseId", value: .string(courseId)),
            JSONMember(key: "lessonId", value: .string(lessonId)),
            JSONMember(key: "lessonTitle", value: .string(lessonTitle)),
            JSONMember(key: "tab", value: .string(tab)),
        ]
        if let customPrompt { members.append(JSONMember(key: "customPrompt", value: .string(customPrompt))) }
        if let customContent { members.append(JSONMember(key: "customContent", value: .string(customContent))) }
        if let contextAttachment { members.append(JSONMember(key: "contextAttachment", value: .string(contextAttachment))) }
        if let preferences { members.append(JSONMember(key: "preferences", value: preferences)) }
        members.append(JSONMember(key: "lane", value: .string(lane.rawValue)))
        if let activeCardId { members.append(JSONMember(key: "activeCardId", value: .string(activeCardId))) }
        if let activeCardPolicy { members.append(JSONMember(key: "activeCardPolicy", value: .string(activeCardPolicy))) }
        members.append(JSONMember(key: "status", value: .string(status.rawValue)))
        members.append(JSONMember(key: "attempts", value: .number(String(attempts))))
        members.append(JSONMember(key: "maxAttempts", value: .number(String(maxAttempts))))
        if let lastError { members.append(JSONMember(key: "lastError", value: .string(lastError))) }
        if let partialOutput { members.append(JSONMember(key: "partialOutput", value: .string(partialOutput))) }
        if let tokensUsed { members.append(JSONMember(key: "tokensUsed", value: .number(String(tokensUsed)))) }
        members.append(JSONMember(key: "createdAt", value: .string(createdAt)))
        members.append(JSONMember(key: "updatedAt", value: .string(updatedAt)))
        if let startedAt { members.append(JSONMember(key: "startedAt", value: .string(startedAt))) }
        if let finishedAt { members.append(JSONMember(key: "finishedAt", value: .string(finishedAt))) }
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }

    public static func timestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
