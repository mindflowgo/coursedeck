import Foundation

/// Allowlist/denylist rules shared by export, import, and the Documents audit
/// (PLAN §3.2). The lists are deliberately data, not scattered conditionals,
/// so a test can prove a denylisted file never reaches an export.
public enum BackupPathContext: Equatable, Sendable {
    case exporting
    case importing
}

public enum BackupPathDecision: Equatable, Sendable {
    case allow
    /// Credentials/logs/state: never exported, never imported, quarantined.
    case deny(reason: String)
    /// Structurally allowed but excluded by a non-secret rule (not allowlisted,
    /// `_backup/` without "include raw packages", `llm_config.json` on export).
    case skip(reason: String)
}

public enum BackupPolicy {
    /// Top-level directories that are part of a CourseDeck/desktop backup.
    public static let allowlistedRootDirectories: Set<String> = [
        "courses", "prompts", "lessonProgress", "attempts", "_conflicts",
    ]

    /// Non-secret root metadata files. `llm_config.json` is special-cased by
    /// the importer (keys → Keychain, sanitized JSON only) and never exported.
    public static let rootMetadataFiles: Set<String> = [
        "dataVersion.json", "settings.json", "llm_ios.json", "llm_config.json",
    ]

    /// Exact basenames that never cross the boundary in either direction.
    public static let denylistedNames: Set<String> = [
        ".google_credentials.json",
        ".arc_credentials.json",
        ".mcp-token",
        ".jobs.json",
        ".cleanup_queue.json",
        "backend.log",
        ".DS_Store",
    ]

    public static func isDenylistedName(_ name: String) -> Bool {
        let lower = name.lowercased()
        if denylistedNames.contains(lower) { return true }
        if lower.hasPrefix("llm_config.json.bak") { return true }
        return false
    }

    /// Applies deny rules first, then allow rules. `relativePath` must be a
    /// normalized, forward-slash path relative to the data root.
    public static func decide(
        relativePath: String,
        context: BackupPathContext,
        includeRawPackages: Bool
    ) -> BackupPathDecision {
        let components = relativePath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !components.isEmpty else { return .skip(reason: "empty path") }

        for component in components {
            if isDenylistedName(component) {
                return .deny(reason: "denylisted file \(component)")
            }
            if component.hasPrefix(".") {
                return .deny(reason: "hidden file \(component)")
            }
        }

        if components.contains("_backup") && !includeRawPackages {
            return .skip(reason: "raw packages excluded; enable \"include raw packages\"")
        }

        if components.count == 1 {
            let name = components[0]
            if name == "llm_config.json" {
                switch context {
                case .exporting:
                    return .skip(reason: "llm_config.json is never exported (keys stay on device)")
                case .importing:
                    return .allow
                }
            }
            if rootMetadataFiles.contains(name) {
                return .allow
            }
            return .skip(reason: "root file \(name) is not backup metadata")
        }

        if allowlistedRootDirectories.contains(components[0]) {
            return .allow
        }

        return .skip(reason: "\(components[0])/ is not in the backup allowlist")
    }

    /// Normalizes a ZIP entry path and rejects traversal. Returns nil for
    /// entries that must be ignored (empty or directory markers).
    public static func normalizedRelativePath(_ rawPath: String) -> String? {
        var path = rawPath.replacingOccurrences(of: "\\", with: "/")
        while path.hasPrefix("./") { path.removeFirst(2) }
        path = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !path.isEmpty else { return nil }
        if path.range(of: "^[A-Za-z]:", options: .regularExpression) != nil { return nil }
        let components = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !components.isEmpty else { return nil }
        for component in components {
            if component == "." || component == ".." || component.isEmpty {
                return nil
            }
        }
        return components.joined(separator: "/")
    }
}

public struct BackupLimits: Equatable, Sendable {
    public var maxEntries: Int
    public var maxEntryUncompressedBytes: UInt64
    public var maxTotalUncompressedBytes: UInt64
    public var maxCompressionRatio: Double
    public var maxRootMetadataBytes: UInt64

    public init(
        maxEntries: Int = 200_000,
        maxEntryUncompressedBytes: UInt64 = 2 * 1024 * 1024 * 1024,
        maxTotalUncompressedBytes: UInt64 = 8 * 1024 * 1024 * 1024,
        maxCompressionRatio: Double = 200,
        maxRootMetadataBytes: UInt64 = 10 * 1024 * 1024
    ) {
        self.maxEntries = maxEntries
        self.maxEntryUncompressedBytes = maxEntryUncompressedBytes
        self.maxTotalUncompressedBytes = maxTotalUncompressedBytes
        self.maxCompressionRatio = maxCompressionRatio
        self.maxRootMetadataBytes = maxRootMetadataBytes
    }
}

public struct BackupProgress: Equatable, Sendable {
    public var phase: String
    public var current: Int
    public var total: Int
    public var currentPath: String

    public init(phase: String, current: Int, total: Int, currentPath: String) {
        self.phase = phase
        self.current = current
        self.total = total
        self.currentPath = currentPath
    }
}

public enum BackupError: Error, LocalizedError, Equatable {
    case corruptArchive(String)
    case zipSlip(String)
    case zipBomb(String)
    case dataVersionIncompatible(String)
    case secretDetected(path: String, pattern: String)
    case scanBoundsExceeded(path: String, reason: String)
    case insufficientSpace(requiredBytes: Int64, availableBytes: Int64)
    case cancelled
    case exportFailed(String)
    case importFailed(String)
    case replaceRolledBack(String)
    case replaceRollbackFailed(String)
    case mergeRollbackFailed(String)
    case mergeRecoveryFailed(String)
    case replaceRecoveryFailed(String)
    case invalidMarkerPath(String)
    case writeBlocked(String)

    public var errorDescription: String? {
        switch self {
        case let .corruptArchive(reason): return "Backup archive is corrupt: \(reason)"
        case let .zipSlip(path): return "Backup entry escapes its destination: \(path)"
        case let .zipBomb(reason): return "Backup archive rejected (zip-bomb guard): \(reason)"
        case let .dataVersionIncompatible(reason):
            return "Backup data version is not compatible with this app: \(reason)"
        case let .secretDetected(path, pattern): return "Secret detected in \(path) (\(pattern)). Export aborted."
        case let .scanBoundsExceeded(path, reason): return "Could not scan \(path) within bounds: \(reason)"
        case let .insufficientSpace(required, available):
            return "Not enough free space: need \(required) bytes, have \(available)."
        case .cancelled: return "Backup operation was cancelled."
        case let .exportFailed(reason): return "Backup export failed: \(reason)"
        case let .importFailed(reason): return "Backup import failed: \(reason)"
        case let .replaceRolledBack(reason): return "Replace-all failed and was rolled back: \(reason)"
        case let .replaceRollbackFailed(reason): return "Replace-all failed and rollback also failed: \(reason)"
        case let .mergeRollbackFailed(reason): return "Merge failed and rollback also failed: \(reason)"
        case let .mergeRecoveryFailed(reason): return "Interrupted merge could not be recovered: \(reason)"
        case let .replaceRecoveryFailed(reason): return "Interrupted replace could not be recovered: \(reason)"
        case let .invalidMarkerPath(path): return "Backup marker/journal contains an unsafe path: \(path)"
        case let .writeBlocked(reason): return "Writes are blocked: \(reason)"
        }
    }
}

public struct PendingKeyReplacement: Equatable, Sendable, Identifiable {
    /// Local card that should receive the imported key if the user chooses
    /// "replace".
    public var cardId: String
    public var cardLabel: String
    public var endpoint: String
    /// Extra card kept (with its Keychain item) so the imported key is not
    /// destroyed before the user decides.
    public var importedCardId: String
    public var importedCardLabel: String

    public var id: String { "\(cardId)->\(importedCardId)" }

    public init(
        cardId: String,
        cardLabel: String,
        endpoint: String,
        importedCardId: String,
        importedCardLabel: String
    ) {
        self.cardId = cardId
        self.cardLabel = cardLabel
        self.endpoint = endpoint
        self.importedCardId = importedCardId
        self.importedCardLabel = importedCardLabel
    }
}

public struct BackupReport: Equatable, Sendable {
    public var filesWritten: Int = 0
    public var bytesWritten: UInt64 = 0
    public var skipped: [String] = []
    public var denied: [String] = []
    public var conflicts: [String] = []
    public var quarantined: [String] = []
    public var importedPrompts: [String] = []
    public var missingLessons: [String] = []
    public var keyMigration: KeyMigrationReport?
    /// Both the local and imported card have a key for the same endpoint. The
    /// local key was left in place; the imported card/key is kept until the
    /// user explicitly chooses to replace or discard.
    public var pendingKeyReplacements: [PendingKeyReplacement] = []
    /// Local cards that received an imported key because they had none.
    public var adoptedImportedKeyCardIDs: [String] = []
    /// Result of the Documents/Import Inbox audit run before export/import.
    public var inboxAudit: InboxAuditReport?
    public init() {}
}
