import Foundation

public struct DataVersionRecord: Equatable, Sendable {
    public var version: Int
    public var appVersion: String
    public var migratedAt: String
    public var extras: [JSONMember]

    public init(version: Int, appVersion: String, migratedAt: String, extras: [JSONMember] = []) {
        self.version = version
        self.appVersion = appVersion
        self.migratedAt = migratedAt
        self.extras = extras
    }

    public init(json: JSONValue) throws {
        guard case let .object(members) = json else {
            throw DataVersionError.notAnObject
        }
        var version: Int?
        var appVersion = ""
        var migratedAt = ""
        var extras: [JSONMember] = []
        let known: Set<String> = ["version", "appVersion", "migratedAt"]
        for member in members {
            switch member.key {
            case "version": version = member.value.intValue
            case "appVersion": appVersion = member.value.stringValue ?? ""
            case "migratedAt": migratedAt = member.value.stringValue ?? ""
            default:
                if !known.contains(member.key) { extras.append(member) }
            }
        }
        guard let version else { throw DataVersionError.missingVersion }
        self.init(version: version, appVersion: appVersion, migratedAt: migratedAt, extras: extras)
    }

    public var json: JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "version", value: .number(String(version))),
            JSONMember(key: "appVersion", value: .string(appVersion)),
            JSONMember(key: "migratedAt", value: .string(migratedAt)),
        ]
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }
}

public enum DataVersionStatus: Equatable, Sendable {
    /// No file yet: a fresh install (or legacy data) and safe to migrate.
    case missing
    case supported(DataVersionRecord)
    case corrupt(String)
    /// Written by a newer app build; fail closed and require an upgrade.
    case newer(record: DataVersionRecord, supportedVersion: Int)
    case migrationFailed(String)
}

public enum DataVersionError: Error, LocalizedError, Equatable {
    case notAnObject
    case missingVersion
    case snapshotFailed(String)

    public var errorDescription: String? {
        switch self {
        case .notAnObject: return "dataVersion.json is not a JSON object."
        case .missingVersion: return "dataVersion.json has no readable version."
        case let .snapshotFailed(reason): return "Pre-migration snapshot failed: \(reason)"
        }
    }
}

public protocol DataMigration: Sendable {
    var name: String { get }
    /// Migrations with `targetVersion` up to (and including) the app's current
    /// version run when the stored version is lower.
    var targetVersion: Int { get }
    func migrate(root: DataRoot, store: AtomicFileStore) throws
}

/// Versioned, idempotent data migrations. Version 1 introduced the iOS data
/// layout; version 2 normalizes the checkpoint anchor schema.
public final class DataVersionStore: @unchecked Sendable {
    public static let currentVersion = 2
    public static let fileName = "dataVersion.json"

    public let root: DataRoot
    private let store: AtomicFileStore
    private let appVersion: String
    private let migrations: [DataMigration]

    public init(
        root: DataRoot,
        appVersion: String = CourseDeckCore.version,
        store: AtomicFileStore = AtomicFileStore(),
        migrations: [DataMigration] = DataVersionStore.defaultMigrations
    ) {
        self.root = root
        self.store = store
        self.appVersion = appVersion
        self.migrations = migrations
    }

    public static var defaultMigrations: [DataMigration] {
        [
            AttemptsDirectoryMigration(),
            SettingsExtensionMigration(),
            JobJournalMigration(),
            AnchorSchemaMigration(),
        ]
    }

    public func read() -> DataVersionStatus {
        let url = root.dataVersionURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            return .missing
        }
        do {
            let data = try Data(contentsOf: url)
            let record = try DataVersionRecord(json: JSONValue(parsing: data))
            if record.version > Self.currentVersion {
                return .newer(record: record, supportedVersion: Self.currentVersion)
            }
            return .supported(record)
        } catch {
            // An unreadable version must never be treated as "old": that would
            // let the app overwrite data it does not understand.
            return .corrupt(String(describing: error))
        }
    }

    /// Reads the version, takes a snapshot when a migration is needed, runs
    /// pending migrations, and writes the new record. Blocks the root's write
    /// gate (and returns) when the stored data is newer or unreadable.
    @discardableResult
    public func loadAndMigrate() -> DataVersionStatus {
        let status = read()
        switch status {
        case let .corrupt(reason):
            root.writeGate.block(
                reason: "dataVersion.json is unreadable (\(reason)). Open read-only and export before upgrading."
            )
            return status
        case let .newer(record, supported):
            root.writeGate.block(
                reason: "Data version \(record.version) is newer than this app supports (\(supported)). " +
                    "Open read-only and export before upgrading."
            )
            return status
        case let .supported(record):
            if record.version == Self.currentVersion {
                return status
            }
            return migrate(from: record.version, existingExtras: record.extras)
        case .missing:
            return migrate(from: 0, existingExtras: [])
        case .migrationFailed:
            return status
        }
    }

    private func migrate(from storedVersion: Int, existingExtras: [JSONMember]) -> DataVersionStatus {
        do {
            let leaseOwner = "DataVersionStore.\(UUID().uuidString)"
            try root.acquireWriteLease(owner: leaseOwner)
            defer { root.releaseWriteLease(owner: leaseOwner) }
            try SnapshotCreator.createPreMigrationSnapshot(root: root, store: store)

            let pending = migrations
                .filter { $0.targetVersion > storedVersion && $0.targetVersion <= Self.currentVersion }
                .sorted { $0.targetVersion < $1.targetVersion }
            for migration in pending {
                try migration.migrate(root: root, store: store)
            }

            let record = DataVersionRecord(
                version: Self.currentVersion,
                appVersion: appVersion,
                migratedAt: Self.timestamp(),
                extras: existingExtras
            )
            try store.writeJSON(record.json, to: root.dataVersionURL)
            return .supported(record)
        } catch {
            let reason = "Data migration failed: \(error)"
            root.writeGate.block(reason: reason + ". Open read-only and export before upgrading.")
            return .migrationFailed(reason)
        }
    }

    static func timestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

/// Copies the small mutable recovery-relevant files before a migration. The
/// snapshot uses a per-file copy (not a directory move) so a failed copy leaves
/// the live library untouched.
public enum SnapshotCreator {
    @discardableResult
    public static func createPreMigrationSnapshot(
        root: DataRoot,
        store: AtomicFileStore = AtomicFileStore()
    ) throws -> URL {
        let fileManager = FileManager.default
        let folder = root.snapshotsURL.appendingPathComponent(
            "pre-migration-\(FileQuarantine.timestamp())",
            isDirectory: true
        )
        do {
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)

            var relativeFiles: [String] = [
                DataVersionStore.fileName,
                "settings.json",
                ".jobs.json",
                "llm_config.json",
                "llm_ios.json",
            ]

            let coursesURL = root.coursesURL
            if let courseDirs = try? fileManager.contentsOfDirectory(
                at: coursesURL,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) {
                for courseDir in courseDirs {
                    guard (try? courseDir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
                    relativeFiles.append("courses/\(courseDir.lastPathComponent)/meta.json")
                    relativeFiles.append("courses/\(courseDir.lastPathComponent)/checkpoint.json")
                }
            }

            for relative in relativeFiles {
                let source = root.rootURL.appendingPathComponent(relative)
                guard fileManager.fileExists(atPath: source.path) else { continue }
                let destination = folder.appendingPathComponent(relative)
                try fileManager.createDirectory(
                    at: destination.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try fileManager.copyItem(at: source, to: destination)
            }
            return folder
        } catch {
            try? fileManager.removeItem(at: folder)
            throw DataVersionError.snapshotFailed(String(describing: error))
        }
    }
}

// MARK: - Version 1 migrations

/// Ensures the local quiz attempt store exists. Idempotent.
public struct AttemptsDirectoryMigration: DataMigration {
    public let name = "attempts-directory"
    public let targetVersion = 1

    public init() {}

    public func migrate(root: DataRoot, store: AtomicFileStore) throws {
        try FileManager.default.createDirectory(at: root.attemptsURL, withIntermediateDirectories: true)
    }
}

/// Adds the version field and known extension defaults to `settings.json`
/// without dropping unknown fields or reordering them.
public struct SettingsExtensionMigration: DataMigration {
    public let name = "settings-extension-fields"
    public let targetVersion = 1

    public init() {}

    public func migrate(root: DataRoot, store: AtomicFileStore) throws {
        let url = root.settingsURL
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        guard var json = try? store.readJSON(url), case var .object(members) = json else { return }
        if !members.contains(where: { $0.key == "version" }) {
            members.insert(JSONMember(key: "version", value: .number("1")), at: 0)
            json = .object(members)
            try store.writeJSON(json, to: url)
        }
    }
}

/// Rewrites the legacy desktop job journal into the iOS state names. Any job
/// that was `processing` when the app died becomes `interrupted` — never a
/// false `completed` or an automatic resume.
public struct JobJournalMigration: DataMigration {
    public let name = "job-journal-states"
    public let targetVersion = 1

    public init() {}

    public func migrate(root: DataRoot, store: AtomicFileStore) throws {
        let url = root.jobsURL
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        guard let json = try? store.readJSON(url), let jobs = json.arrayValue else { return }

        var changed = false
        let migrated: [JSONValue] = jobs.map { job in
            guard case var .object(members) = job else { return job }
            guard let statusIndex = members.firstIndex(where: { $0.key == "status" }) else {
                members.append(JSONMember(key: "status", value: .string("interrupted")))
                changed = true
                return .object(members)
            }
            let raw = members[statusIndex].value.stringValue?.lowercased() ?? ""
            let replacement: String?
            switch raw {
            case "pending": replacement = "queued"
            case "processing": replacement = "interrupted"
            case "completed": replacement = "succeeded"
            default:
                // Unknown or missing statuses are never treated as completed.
                replacement = JobStatus(rawValue: raw) == nil ? "interrupted" : nil
            }
            guard let replacement else { return job }
            members[statusIndex].value = .string(replacement)
            changed = true
            return .object(members)
        }

        if changed {
            try store.writeJSON(.array(migrated), to: url)
        }
    }
}

/// Version 2 checkpoint anchor schema.
///
/// New iOS checkpoints always carry `verticalPosition` plus
/// `anchorBlockID`/`anchorFraction`. Legacy desktop entries cannot be given a
/// synthetic anchor at migration time because a stable block ID requires the
/// parsed document layout; this migration therefore:
///   * keeps every legacy `verticalPosition` untouched,
///   * adds `anchorFraction: 0` only when an anchor ID already exists,
///   * drops empty/invalid anchor IDs and non-numeric fractions,
///   * leaves structurally invalid entries for the repository to surface as
///     passthrough rather than deleting them.
/// Re-running it is a no-op.
public struct AnchorSchemaMigration: DataMigration {
    public let name = "checkpoint-anchor-schema"
    public let targetVersion = 2

    public init() {}

    public func migrate(root: DataRoot, store: AtomicFileStore) throws {
        let fileManager = FileManager.default
        guard let courseDirs = try? fileManager.contentsOfDirectory(
            at: root.coursesURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        for courseDir in courseDirs
        where (try? courseDir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            let url = courseDir.appendingPathComponent("checkpoint.json")
            guard fileManager.fileExists(atPath: url.path),
                  let json = try? store.readJSON(url),
                  let entries = json.arrayValue else { continue }

            var changed = false
            let migrated: [JSONValue] = entries.map { entry in
                guard case var .object(members) = entry else { return entry }
                if let anchorIndex = members.firstIndex(where: { $0.key == "anchorBlockID" }) {
                    let anchorID = members[anchorIndex].value.stringValue?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if anchorID.isEmpty {
                        members.remove(at: anchorIndex)
                        members.removeAll { $0.key == "anchorFraction" }
                        changed = true
                    } else if let fractionIndex = members.firstIndex(where: { $0.key == "anchorFraction" }) {
                        if members[fractionIndex].value.doubleValue?.isFinite != true {
                            members[fractionIndex].value = .number("0")
                            changed = true
                        }
                    } else {
                        members.append(JSONMember(key: "anchorFraction", value: .number("0")))
                        changed = true
                    }
                }
                return .object(members)
            }

            if changed {
                try store.writeJSON(.array(migrated), to: url)
            }
        }
    }
}
