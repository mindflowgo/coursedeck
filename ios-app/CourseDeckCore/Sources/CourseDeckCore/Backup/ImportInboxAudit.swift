import Foundation

public struct InboxAuditReport: Equatable, Sendable {
    public var scannedFiles: Int
    public var quarantined: [String]
    public var migratedConfigs: [String]
    public var inboxArchives: [URL]
    /// True when the audit could not run (no Documents tree or lease timeout).
    public var wasSkipped: Bool
    /// Human-readable reason when `wasSkipped` is true.
    public var failure: String?

    public init(
        scannedFiles: Int = 0,
        quarantined: [String] = [],
        migratedConfigs: [String] = [],
        inboxArchives: [URL] = [],
        wasSkipped: Bool = false,
        failure: String? = nil
    ) {
        self.scannedFiles = scannedFiles
        self.quarantined = quarantined
        self.migratedConfigs = migratedConfigs
        self.inboxArchives = inboxArchives
        self.wasSkipped = wasSkipped
        self.failure = failure
    }
}

/// Audits the entire `Documents` tree on every foreground activation and
/// before any course load / backup export / import. Files-sharing exposes the
/// whole tree, not just `Import Inbox`, so a backup unzipped at the Documents
/// root must not bypass secret handling: denylisted files are quarantined and
/// `llm_config.json` keys are moved to the secret store in place.
public actor ImportInboxAudit {
    private let root: DataRoot
    private let keyMigrator: KeyMigrator
    private let store: AtomicFileStore
    private let quarantine: FileQuarantine
    private let maxConfigBytes: UInt64

    public init(
        root: DataRoot,
        keyMigrator: KeyMigrator,
        store: AtomicFileStore = AtomicFileStore(),
        maxConfigBytes: UInt64 = 10 * 1024 * 1024
    ) {
        self.root = root
        self.keyMigrator = keyMigrator
        self.store = store
        self.quarantine = FileQuarantine(rootURL: root.quarantineURL)
        self.maxConfigBytes = maxConfigBytes
    }

    @discardableResult
    public func auditDocumentsTree() -> InboxAuditReport {
        var report = InboxAuditReport()
        guard let documentsURL = root.documentsURL else {
            report.wasSkipped = true
            report.failure = "no Documents directory configured"
            return report
        }

        // Audit is a security cleanup, not a library write: run even when the
        // dataVersion fail-closed gate is active. Use a unique owner so two
        // concurrent audit/backup operations cannot re-enter as the same owner.
        let auditOwner = "ImportInboxAudit.\(UUID().uuidString)"
        do {
            try root.writeLease.acquire(owner: auditOwner, timeout: 60)
        } catch {
            report.wasSkipped = true
            report.failure = "timed out acquiring the write lease: \(error)"
            return report
        }
        defer { root.writeLease.release(owner: auditOwner) }

        guard let enumerator = FileManager.default.enumerator(
            at: documentsURL,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
            options: []
        ) else {
            report.wasSkipped = true
            report.failure = "could not enumerate the Documents tree"
            return report
        }

        let auditQuarantineRoot = root.quarantineURL.appendingPathComponent(
            "documents-audit-\(FileQuarantine.timestamp())",
            isDirectory: true
        )

        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            if values?.isSymbolicLink == true {
                enumerator.skipDescendants()
                continue
            }
            guard values?.isRegularFile == true else { continue }
            report.scannedFiles += 1

            let relative = BackupService.relativePath(of: url, under: documentsURL)
            let components = relative.split(separator: "/").map(String.init)
            let name = url.lastPathComponent

            let hidden = components.contains { $0.hasPrefix(".") }
            if hidden || BackupPolicy.isDenylistedName(name) {
                if let quarantined = try? quarantinePreservingPath(
                    url,
                    relativePath: relative,
                    quarantineRoot: auditQuarantineRoot,
                    reason: hidden ? "hidden file in Documents" : "denylisted file in Documents"
                ) {
                    report.quarantined.append(quarantined)
                }
                continue
            }

            if name == "llm_config.json" {
                if (values?.fileSize ?? 0) > Int(maxConfigBytes) {
                    if let quarantined = try? quarantinePreservingPath(
                        url,
                        relativePath: relative,
                        quarantineRoot: auditQuarantineRoot,
                        reason: "llm_config.json exceeds audit size limit"
                    ) {
                        report.quarantined.append(quarantined)
                    }
                    continue
                }
                do {
                    let data = try store.read(url)
                    let json = try JSONValue(parsing: data)
                    let llmStore = LlmStore.normalized(from: json)
                    let migrated = try keyMigrator.migrate(store: llmStore)
                    try store.writeJSON(migrated.store.sanitizedJSON, to: url)
                    report.migratedConfigs.append(relative)
                } catch {
                    if let quarantined = try? quarantinePreservingPath(
                        url,
                        relativePath: relative,
                        quarantineRoot: auditQuarantineRoot,
                        reason: "unmigratable llm_config.json: \(error)"
                    ) {
                        report.quarantined.append(quarantined)
                    }
                }
            }
        }

        report.inboxArchives = pendingInboxArchives()
        return report
    }

    /// ZIP/MHTML/HTML files sitting in `Documents/Import Inbox`.
    public func pendingInboxArchives() -> [URL] {
        guard let inbox = root.importInboxURL,
              let files = try? FileManager.default.contentsOfDirectory(
                at: inbox,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
              ) else { return [] }
        return files.filter { file in
            let ext = file.pathExtension.lowercased()
            return (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
                && ["zip", "mhtml", "mht", "html", "htm"].contains(ext)
        }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// Deletes a successfully imported archive. Only files inside the Import
    /// Inbox are eligible.
    public func removeImportedArchive(_ url: URL) throws {
        guard let inbox = root.importInboxURL else {
            throw BackupError.importFailed("no Import Inbox configured")
        }
        let inboxPath = inbox.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        guard path.hasPrefix(inboxPath + "/") else {
            throw BackupError.importFailed("refusing to delete a file outside the Import Inbox")
        }
        try FileManager.default.removeItem(at: url)
    }

    private func quarantinePreservingPath(
        _ url: URL,
        relativePath: String,
        quarantineRoot: URL,
        reason: String
    ) throws -> String {
        let fileManager = FileManager.default
        let destination = try PathValidator.safeJoin(
            base: quarantineRoot,
            components: [relativePath]
        )
        try fileManager.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if fileManager.fileExists(atPath: destination.path) {
            let unique = destination.deletingLastPathComponent()
                .appendingPathComponent("\(UUID().uuidString.prefix(8))-\(destination.lastPathComponent)")
            try fileManager.moveItem(at: url, to: unique)
            // Report the Documents-relative path, not the unique quarantine name.
            return relativePath
        }
        try fileManager.moveItem(at: url, to: destination)
        try? Data("reason: \(reason)\n".utf8).write(
            to: destination.deletingLastPathComponent().appendingPathComponent(
                "\(destination.lastPathComponent).QUARANTINE.txt"
            )
        )
        return relativePath
    }
}
