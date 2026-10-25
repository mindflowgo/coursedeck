import Foundation

/// Versioned iOS settings. Defaults are applied on read; unknown fields are
/// preserved for forward compatibility. Desktop theme/resume preferences live
/// outside the desktop data directory and are deliberately not imported.
public struct Settings: Equatable, Sendable {
    public static let currentVersion = 1
    /// Bump when the AI disclosure text materially changes; the app requires
    /// the user to accept this version before any generation runs.
    public static let currentAIConsentVersion = 1

    public enum Theme: String, Equatable, Sendable {
        case system
        case light
        case dark
    }

    public var version: Int
    public var theme: Theme
    public var resumeLastPosition: Bool
    public var includeRawPackagesInBackup: Bool
    public var imageCompressionEnabled: Bool
    public var verboseLogging: Bool
    public var hasCompletedFirstRun: Bool
    /// 0 means the user has not accepted the current AI disclosure.
    public var aiConsentVersion: Int
    public var aiConsentAcceptedAt: String?
    /// Card ID selected in Settings; the authoritative card list/active ID
    /// stays in `llm_config.json`.
    public var activeCardId: String?
    public var extras: [JSONMember]

    public init(
        version: Int = Settings.currentVersion,
        theme: Theme = .system,
        resumeLastPosition: Bool = true,
        includeRawPackagesInBackup: Bool = false,
        imageCompressionEnabled: Bool = true,
        verboseLogging: Bool = false,
        hasCompletedFirstRun: Bool = false,
        aiConsentVersion: Int = 0,
        aiConsentAcceptedAt: String? = nil,
        activeCardId: String? = nil,
        extras: [JSONMember] = []
    ) {
        self.version = version
        self.theme = theme
        self.resumeLastPosition = resumeLastPosition
        self.includeRawPackagesInBackup = includeRawPackagesInBackup
        self.imageCompressionEnabled = imageCompressionEnabled
        self.verboseLogging = verboseLogging
        self.hasCompletedFirstRun = hasCompletedFirstRun
        self.aiConsentVersion = aiConsentVersion
        self.aiConsentAcceptedAt = aiConsentAcceptedAt
        self.activeCardId = activeCardId
        self.extras = extras
    }

    public var hasAIConsent: Bool {
        aiConsentVersion >= Self.currentAIConsentVersion
    }

    /// Records acceptance of the current disclosure version and timestamp.
    public mutating func acceptAIConsent(at date: Date = Date()) {
        aiConsentVersion = Self.currentAIConsentVersion
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        aiConsentAcceptedAt = formatter.string(from: date)
    }

    /// Revokes consent. The queue is stopped by the lifecycle coordinator; no
    /// generated content is deleted.
    public mutating func revokeAIConsent() {
        aiConsentVersion = 0
        aiConsentAcceptedAt = nil
    }

    private static let knownKeys: Set<String> = [
        "version", "theme", "resumeLastPosition", "includeRawPackagesInBackup",
        "imageCompressionEnabled", "verboseLogging", "hasCompletedFirstRun",
        "aiConsentVersion", "aiConsentAcceptedAt", "activeCardId",
    ]

    public init(json: JSONValue) {
        var version = Self.currentVersion
        var theme = Theme.system
        var resumeLastPosition = true
        var includeRaw = false
        var imageCompression = true
        var verboseLogging = false
        var firstRun = false
        var aiConsentVersion = 0
        var aiConsentAcceptedAt: String?
        var activeCardId: String?
        var extras: [JSONMember] = []

        for member in (json.objectValue ?? []) {
            switch member.key {
            case "version": version = member.value.intValue ?? Self.currentVersion
            case "theme": theme = Theme(rawValue: member.value.stringValue ?? "") ?? .system
            case "resumeLastPosition": resumeLastPosition = member.value.boolValue ?? true
            case "includeRawPackagesInBackup": includeRaw = member.value.boolValue ?? false
            case "imageCompressionEnabled": imageCompression = member.value.boolValue ?? true
            case "verboseLogging": verboseLogging = member.value.boolValue ?? false
            case "hasCompletedFirstRun": firstRun = member.value.boolValue ?? false
            case "aiConsentVersion": aiConsentVersion = member.value.intValue ?? 0
            case "aiConsentAcceptedAt": aiConsentAcceptedAt = member.value.stringValue
            case "activeCardId": activeCardId = member.value.stringValue
            default:
                if !Self.knownKeys.contains(member.key) { extras.append(member) }
            }
        }

        self.init(
            version: version,
            theme: theme,
            resumeLastPosition: resumeLastPosition,
            includeRawPackagesInBackup: includeRaw,
            imageCompressionEnabled: imageCompression,
            verboseLogging: verboseLogging,
            hasCompletedFirstRun: firstRun,
            aiConsentVersion: aiConsentVersion,
            aiConsentAcceptedAt: aiConsentAcceptedAt,
            activeCardId: activeCardId,
            extras: extras
        )
    }

    public var json: JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "version", value: .number(String(version))),
            JSONMember(key: "theme", value: .string(theme.rawValue)),
            JSONMember(key: "resumeLastPosition", value: .bool(resumeLastPosition)),
            JSONMember(key: "includeRawPackagesInBackup", value: .bool(includeRawPackagesInBackup)),
            JSONMember(key: "imageCompressionEnabled", value: .bool(imageCompressionEnabled)),
            JSONMember(key: "verboseLogging", value: .bool(verboseLogging)),
            JSONMember(key: "hasCompletedFirstRun", value: .bool(hasCompletedFirstRun)),
            JSONMember(key: "aiConsentVersion", value: .number(String(aiConsentVersion))),
        ]
        if let aiConsentAcceptedAt {
            members.append(JSONMember(key: "aiConsentAcceptedAt", value: .string(aiConsentAcceptedAt)))
        }
        if let activeCardId {
            members.append(JSONMember(key: "activeCardId", value: .string(activeCardId)))
        }
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }

    /// Applies forward migrations. Unknown fields and user values survive.
    public func migratedToCurrent() -> Settings {
        var copy = self
        if copy.version < Self.currentVersion {
            copy.version = Self.currentVersion
        }
        return copy
    }
}
