import Foundation

public struct WriteBlockedError: Error, LocalizedError, Equatable, Sendable {
    public let reason: String

    public init(reason: String) {
        self.reason = reason
    }

    public var errorDescription: String? {
        "Writes are blocked: \(reason)"
    }
}

/// Process-wide write switch. `dataVersion.json` being newer or unreadable
/// puts the library into read-only mode (PLAN §3.2); every repository mutation
/// calls `assertWritable()` before touching disk.
public final class WriteGate: @unchecked Sendable {
    private let lock = NSLock()
    private var blockedReason: String?

    public init() {}

    public var reason: String? {
        lock.lock()
        defer { lock.unlock() }
        return blockedReason
    }

    public var isWritable: Bool {
        reason == nil
    }

    public func block(reason: String) {
        lock.lock()
        blockedReason = reason
        lock.unlock()
    }

    public func unblock() {
        lock.lock()
        blockedReason = nil
        lock.unlock()
    }

    public func assertWritable() throws {
        if let reason {
            throw WriteBlockedError(reason: reason)
        }
    }
}

/// The single owner of every data-root URL. The live root lives in
/// `Library/Application Support/CourseDeck`; `Documents` is only used for the
/// user-visible Import Inbox and Export folders, and the audit treats the
/// whole Documents tree as untrusted.
public final class DataRoot: @unchecked Sendable {
    public let rootURL: URL
    public let documentsURL: URL?
    public let writeGate: WriteGate
    public let writeLease: WriteLease

    /// Names that are internal bookkeeping and never part of backup snapshots.
    public static let internalRootNames: Set<String> = [
        ".staging", ".snapshots", ".quarantine",
        ".replace-in-progress.json", ".merge-in-progress.json",
    ]

    public init(
        rootURL: URL,
        documentsURL: URL? = nil,
        writeGate: WriteGate = WriteGate(),
        writeLease: WriteLease = WriteLease()
    ) {
        self.rootURL = rootURL.standardizedFileURL
        self.documentsURL = documentsURL?.standardizedFileURL
        self.writeGate = writeGate
        self.writeLease = writeLease
    }

    public var coursesURL: URL { rootURL.appendingPathComponent("courses", isDirectory: true) }
    public var promptsURL: URL { rootURL.appendingPathComponent("prompts", isDirectory: true) }
    public var attemptsURL: URL { rootURL.appendingPathComponent("attempts", isDirectory: true) }
    /// Private, non-backup quiz drafts and timer state (PLAN §4.10).
    public var draftsURL: URL { rootURL.appendingPathComponent("drafts", isDirectory: true) }
    /// Deleted custom tabs are recoverable here instead of being destroyed.
    /// `.trash/` is device-local recovery state: excluded from device backup
    /// and hidden from app export/import by `BackupPolicy` (hidden path
    /// component). It is never restored from a desktop/iOS backup.
    public var trashURL: URL { rootURL.appendingPathComponent(".trash", isDirectory: true) }
    public var quarantineURL: URL { rootURL.appendingPathComponent(".quarantine", isDirectory: true) }
    public var stagingURL: URL { rootURL.appendingPathComponent(".staging", isDirectory: true) }
    public var snapshotsURL: URL { rootURL.appendingPathComponent(".snapshots", isDirectory: true) }
    public var dataVersionURL: URL { rootURL.appendingPathComponent("dataVersion.json") }
    public var jobsURL: URL { rootURL.appendingPathComponent(".jobs.json") }
    public var settingsURL: URL { rootURL.appendingPathComponent("settings.json") }
    public var llmConfigURL: URL { rootURL.appendingPathComponent("llm_config.json") }
    public var llmIOSURL: URL { rootURL.appendingPathComponent("llm_ios.json") }
    public var promptProvenanceURL: URL { rootURL.appendingPathComponent("prompt-provenance.json") }

    public var importInboxURL: URL? {
        documentsURL?.appendingPathComponent("Import Inbox", isDirectory: true)
    }

    public var exportURL: URL? {
        documentsURL?.appendingPathComponent("Export", isDirectory: true)
    }

    public func courseURL(_ courseId: String) throws -> URL {
        let id = try PathValidator.normalizedCourseId(courseId)
        return try PathValidator.safeJoin(base: coursesURL, id)
    }

    public func promptURL(_ promptId: String) throws -> URL {
        let id = try PathValidator.promptId(promptId)
        return try PathValidator.safeJoin(base: promptsURL, "\(id).md")
    }

    public func ensureWritable() throws {
        try writeGate.assertWritable()
    }

    /// Acquires the exclusive data write lease, checking the fail-closed gate
    /// first. Callers must release with the same owner in a `defer`.
    public func acquireWriteLease(owner: String, timeout: TimeInterval = 30) throws {
        try ensureWritable()
        try writeLease.acquire(owner: owner, timeout: timeout)
    }

    public func releaseWriteLease(owner: String) {
        writeLease.release(owner: owner)
    }

    public func withWriteLease<T>(owner: String, timeout: TimeInterval = 30, _ body: () throws -> T) throws -> T {
        try acquireWriteLease(owner: owner, timeout: timeout)
        defer { releaseWriteLease(owner: owner) }
        return try body()
    }

    /// Creates the root layout and marks non-portable state as excluded from
    /// device/iCloud backup. Call once during app startup (idempotent).
    public func prepare() throws {
        let fileManager = FileManager.default
        for directory in [rootURL, coursesURL, promptsURL, attemptsURL, draftsURL, trashURL, quarantineURL, stagingURL, snapshotsURL] {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        }

        // Raw imported packages and disposable local state are excluded from
        // device/iCloud backup but still included in app exports where the
        // plan says so.
        try? setExcludedFromBackup(attemptsURL)
        try? setExcludedFromBackup(draftsURL)
        try? setExcludedFromBackup(trashURL)
        try? setExcludedFromBackup(jobsURL)
        try? setExcludedFromBackup(stagingURL)
        try? setExcludedFromBackup(snapshotsURL)
        try? setExcludedFromBackup(quarantineURL)

        // Raw imported packages are large and are included in app exports
        // only with "include raw packages"; keep them out of device/iCloud
        // backup (PLAN §3.1).
        if let courseDirs = try? fileManager.contentsOfDirectory(
            at: coursesURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) {
            for courseDir in courseDirs
            where (try? courseDir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                let rawPackages = courseDir.appendingPathComponent("_backup", isDirectory: true)
                if fileManager.fileExists(atPath: rawPackages.path) {
                    try? setExcludedFromBackup(rawPackages)
                }
            }
        }

        if let documentsURL {
            try fileManager.createDirectory(at: documentsURL, withIntermediateDirectories: true)
            if let importInboxURL {
                try fileManager.createDirectory(at: importInboxURL, withIntermediateDirectories: true)
            }
            if let exportURL {
                try fileManager.createDirectory(at: exportURL, withIntermediateDirectories: true)
            }
        }
    }

    public func setExcludedFromBackup(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = url
        try mutableURL.setResourceValues(values)
    }

    public func isExcludedFromBackup(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup) ?? false
    }

    /// Marks an existing `_backup/` raw-package directory as excluded. Called
    /// after import/ingest; a missing directory is a no-op.
    public func excludeRawPackagesFromBackup(courseId: String) throws {
        let course = try courseURL(courseId)
        let backup = try PathValidator.safeJoin(base: course, "_backup")
        if FileManager.default.fileExists(atPath: backup.path) {
            try setExcludedFromBackup(backup)
        }
    }

    /// Free space available for important usage, the same measure iOS uses to
    /// decide whether an export can proceed. Returns nil when the volume does
    /// not report a usable value (macOS containers report 0).
    public func availableCapacity() -> Int64? {
        let values = try? rootURL.resourceValues(forKeys: [
            .volumeAvailableCapacityForImportantUsageKey,
            .volumeAvailableCapacityKey,
        ])
        let important = values?.volumeAvailableCapacityForImportantUsage ?? 0
        let basic = Int64(values?.volumeAvailableCapacity ?? 0)
        let capacity = important > 0 ? important : basic
        return capacity > 0 ? capacity : nil
    }

    /// Recursive size of a directory (0 when absent).
    public static func directorySize(_ url: URL) -> Int64 {
        let fileManager = FileManager.default
        guard let enumerator = fileManager.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }
        var total: Int64 = 0
        for case let fileURL as URL in enumerator {
            let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            if values?.isRegularFile == true {
                total += Int64(values?.fileSize ?? 0)
            }
        }
        return total
    }
}
