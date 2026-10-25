import Foundation
import ZIPFoundation

public struct BackupExportOptions: Sendable {
    public var destinationDirectory: URL
    public var includeRawPackages: Bool
    public var verifyArchive: Bool
    /// Free space must cover the archive plus headroom (the archive is built
    /// as a temp file in the destination directory first).
    public var freeSpaceHeadroomBytes: Int64

    public init(
        destinationDirectory: URL,
        includeRawPackages: Bool = false,
        verifyArchive: Bool = true,
        freeSpaceHeadroomBytes: Int64 = 32 * 1024 * 1024
    ) {
        self.destinationDirectory = destinationDirectory
        self.includeRawPackages = includeRawPackages
        self.verifyArchive = verifyArchive
        self.freeSpaceHeadroomBytes = freeSpaceHeadroomBytes
    }
}

public struct BackupExportResult: Equatable, Sendable {
    public var archiveURL: URL
    public var fileCount: Int
    public var totalBytes: UInt64
    public var report: BackupReport

    public init(archiveURL: URL, fileCount: Int, totalBytes: UInt64, report: BackupReport) {
        self.archiveURL = archiveURL
        self.fileCount = fileCount
        self.totalBytes = totalBytes
        self.report = report
    }
}

/// Streamed ZIP export/import.
///
/// Export holds the data-root write lease for the entire operation (quiescing
/// editor saves and generation writes), writes to a temp archive inside the
/// destination directory, scans the *finished* archive's decompressed bytes
/// for secrets, verifies CRCs, and only then swaps it into place.
public actor BackupService {
    let root: DataRoot
    let store: AtomicFileStore
    let scanner: SecretScanner
    let keyMigrator: KeyMigrator
    let quarantine: FileQuarantine
    /// Optional so tests and non-prompt imports do not need provenance.
    let promptProvenance: PromptProvenanceStore?
    let bundledPromptsDirectory: URL?
    /// Quiesced for the duration of an import so generation cannot write
    /// while the archive is being merged.
    let generationQueue: GenerationQueue?

    static let exportLeasePrefix = "BackupService.export."
    static let importLeasePrefix = "BackupService.import."
    static let recoveryLeasePrefix = "BackupService.recovery."

    func newLeaseOwner(_ prefix: String) -> String {
        "\(prefix)\(UUID().uuidString)"
    }

    public init(
        root: DataRoot,
        store: AtomicFileStore = AtomicFileStore(),
        scanner: SecretScanner = SecretScanner(),
        keyMigrator: KeyMigrator = KeyMigrator(secretStore: nil),
        promptProvenance: PromptProvenanceStore? = nil,
        bundledPromptsDirectory: URL? = nil,
        generationQueue: GenerationQueue? = nil
    ) {
        self.root = root
        self.store = store
        self.scanner = scanner
        self.keyMigrator = keyMigrator
        self.quarantine = FileQuarantine(rootURL: root.quarantineURL)
        self.promptProvenance = promptProvenance
        self.bundledPromptsDirectory = bundledPromptsDirectory
        self.generationQueue = generationQueue
    }

    // MARK: - Export

    public func exportBackup(
        options: BackupExportOptions,
        progress: ((BackupProgress) throws -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil
    ) async throws -> BackupExportResult {
        var report = BackupReport()
        // Audit the whole Documents tree before touching the live root. The
        // audit runs under its own unique lease and also works when the
        // fail-closed gate is active.
        report.inboxAudit = await ImportInboxAudit(
            root: root,
            keyMigrator: keyMigrator,
            store: store
        ).auditDocumentsTree()

        // Export is the fail-closed escape hatch: it must work even when the
        // write gate is active because dataVersion is newer/corrupt. Acquire
        // the lease directly (not through the gate) to quiesce writers.
        let leaseOwner = newLeaseOwner(Self.exportLeasePrefix)
        try root.writeLease.acquire(owner: leaseOwner, timeout: 60)
        defer { root.writeLease.release(owner: leaseOwner) }

        let fileManager = FileManager.default

        let files = try collectExportFiles(
            includeRawPackages: options.includeRawPackages,
            report: &report
        )
        let totalBytes = files.reduce(UInt64(0)) { $0 + $1.size }

        try fileManager.createDirectory(at: options.destinationDirectory, withIntermediateDirectories: true)

        // Fail early rather than half-writing a 543 MB archive.
        if let available = Self.availableCapacity(at: options.destinationDirectory) {
            let required = Int64(totalBytes) + options.freeSpaceHeadroomBytes
            guard available >= required else {
                throw BackupError.insufficientSpace(requiredBytes: required, availableBytes: available)
            }
        }

        let filename = "coursedeck-backup-\(Self.fileTimestamp()).zip"
        let destination = options.destinationDirectory.appendingPathComponent(filename)
        let tempURL = options.destinationDirectory.appendingPathComponent(
            ".\(filename).\(UUID().uuidString).tmp"
        )
        try? fileManager.removeItem(at: tempURL)

        do {
            try writeArchive(files: files, to: tempURL, progress: progress, isCancelled: isCancelled)

            // Scan archived bytes, not source files: this is immune to a file
            // changing between collection and compression.
            if let found = try scanner.scanArchive(at: tempURL) {
                throw BackupError.secretDetected(path: found.path, pattern: found.match.pattern)
            }
            if options.verifyArchive {
                try verifyArchive(at: tempURL, expectedFileCount: files.count)
            }
            if fileManager.fileExists(atPath: destination.path) {
                _ = try fileManager.replaceItemAt(destination, withItemAt: tempURL)
            } else {
                try fileManager.moveItem(at: tempURL, to: destination)
            }
        } catch {
            try? fileManager.removeItem(at: tempURL)
            throw error
        }

        report.filesWritten = files.count
        report.bytesWritten = totalBytes
        return BackupExportResult(
            archiveURL: destination,
            fileCount: files.count,
            totalBytes: totalBytes,
            report: report
        )
    }

    // MARK: - Export collection

    struct ExportFile {
        var url: URL
        var relativePath: String
        var size: UInt64
    }

    private func collectExportFiles(
        includeRawPackages: Bool,
        report: inout BackupReport
    ) throws -> [ExportFile] {
        let fileManager = FileManager.default
        var files: [ExportFile] = []

        for name in ["dataVersion.json", "settings.json", "llm_ios.json"] {
            let url = root.rootURL.appendingPathComponent(name)
            guard fileManager.fileExists(atPath: url.path) else { continue }
            let decision = BackupPolicy.decide(
                relativePath: name,
                context: .exporting,
                includeRawPackages: includeRawPackages
            )
            switch decision {
            case .allow:
                files.append(try exportFile(url: url, relativePath: name))
            case let .deny(reason):
                report.denied.append("\(name) (\(reason))")
            case let .skip(reason):
                report.skipped.append("\(name) (\(reason))")
            }
        }

        for directoryName in ["courses", "prompts", "lessonProgress", "attempts", "_conflicts"] {
            let directory = root.rootURL.appendingPathComponent(directoryName, isDirectory: true)
            guard fileManager.fileExists(atPath: directory.path) else { continue }
            guard let enumerator = fileManager.enumerator(
                at: directory,
                includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            for case let url as URL in enumerator {
                let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
                if values?.isSymbolicLink == true {
                    enumerator.skipDescendants()
                    continue
                }
                guard values?.isRegularFile == true else { continue }
                let relativePath = Self.relativePath(of: url, under: root.rootURL)
                switch BackupPolicy.decide(
                    relativePath: relativePath,
                    context: .exporting,
                    includeRawPackages: includeRawPackages
                ) {
                case .allow:
                    files.append(try exportFile(url: url, relativePath: relativePath, knownSize: values?.fileSize))
                case let .deny(reason):
                    report.denied.append("\(relativePath) (\(reason))")
                case let .skip(reason):
                    report.skipped.append("\(relativePath) (\(reason))")
                }
            }
        }

        return files
    }

    private func exportFile(url: URL, relativePath: String, knownSize: Int? = nil) throws -> ExportFile {
        let size = UInt64(knownSize ?? 0)
        let actualSize = size == 0
            ? UInt64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            : size
        return ExportFile(url: url, relativePath: relativePath, size: actualSize)
    }

    private func writeArchive(
        files: [ExportFile],
        to url: URL,
        progress: ((BackupProgress) throws -> Void)?,
        isCancelled: (() -> Bool)?
    ) throws {
        let archive = try Archive(url: url, accessMode: .create)
        let compressedExtensions: Set<String> = [
            "zip", "gz", "png", "jpg", "jpeg", "webp", "pdf", "mp4", "mp3", "woff2", "woff",
        ]
        for (index, file) in files.enumerated() {
            if isCancelled?() == true {
                throw BackupError.cancelled
            }
            let method: CompressionMethod = compressedExtensions.contains(file.url.pathExtension.lowercased())
                ? .none
                : .deflate
            try archive.addEntry(
                with: file.relativePath,
                fileURL: file.url,
                compressionMethod: method
            )
            try progress?(BackupProgress(
                phase: "Export",
                current: index + 1,
                total: files.count,
                currentPath: file.relativePath
            ))
        }
    }

    private func verifyArchive(at url: URL, expectedFileCount: Int) throws {
        let archive: Archive
        do {
            archive = try Archive(url: url, accessMode: .read)
        } catch {
            throw BackupError.exportFailed("archive could not be reopened: \(error)")
        }
        var entries: [Entry] = []
        for entry in archive {
            entries.append(entry)
            if entries.count > expectedFileCount {
                break
            }
        }
        guard entries.count == expectedFileCount else {
            throw BackupError.exportFailed(
                "archive contains \(entries.count) entries, expected \(expectedFileCount)"
            )
        }
        for entry in entries {
            do {
                let checksum = try archive.extract(entry, skipCRC32: false) { _ in }
                guard checksum == entry.checksum else {
                    throw BackupError.exportFailed("CRC mismatch for \(entry.path)")
                }
            } catch let error as BackupError {
                throw error
            } catch {
                throw BackupError.exportFailed("CRC verification failed for \(entry.path): \(error)")
            }
        }
    }

    // MARK: - Recovery

    /// Called on launch. Rolls back a killed replace-all or merge, then deletes
    /// orphaned staging directories. No operation auto-resumes.
    @discardableResult
    public func recoverInterruptedOperations() throws -> (replace: Bool, merge: Bool) {
        // Recovery restores a known-good snapshot, so it is allowed even when
        // the fail-closed write gate is active (e.g. dataVersion is corrupt).
        let leaseOwner = newLeaseOwner(Self.recoveryLeasePrefix)
        try root.writeLease.acquire(owner: leaseOwner, timeout: 60)
        defer { root.writeLease.release(owner: leaseOwner) }

        let replace = try ReplaceTransaction.recover(root: root, store: store)
        let merge = try MergeTransaction.recover(root: root, store: store)

        let fileManager = FileManager.default
        if let stale = try? fileManager.contentsOfDirectory(
            at: root.stagingURL,
            includingPropertiesForKeys: nil,
            options: []
        ) {
            for item in stale {
                try? fileManager.removeItem(at: item)
            }
        }
        return (replace, merge)
    }

    @discardableResult
    public func recoverInterruptedReplace() throws -> Bool {
        let leaseOwner = newLeaseOwner(Self.recoveryLeasePrefix)
        try root.writeLease.acquire(owner: leaseOwner, timeout: 60)
        defer { root.writeLease.release(owner: leaseOwner) }
        return try ReplaceTransaction.recover(root: root, store: store)
    }

    // MARK: - Helpers

    static func relativePath(of url: URL, under base: URL) -> String {
        // Resolve symlinks on both sides: `/var` → `/private/var` on macOS and
        // on-device container paths must compare consistently.
        let basePath = base.standardizedFileURL.resolvingSymlinksInPath().path
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        if path.hasPrefix(basePath + "/") {
            return String(path.dropFirst(basePath.count + 1))
        }
        return url.lastPathComponent
    }

    static func availableCapacity(at url: URL) -> Int64? {
        let values = try? url.resourceValues(forKeys: [
            .volumeAvailableCapacityForImportantUsageKey,
            .volumeAvailableCapacityKey,
        ])
        let important = values?.volumeAvailableCapacityForImportantUsage ?? 0
        let basic = Int64(values?.volumeAvailableCapacity ?? 0)
        let capacity = important > 0 ? important : basic
        // macOS containers can report 0 even with free space; treat that as
        // unknown instead of refusing every export. A real ENOSPC still fails.
        return capacity > 0 ? capacity : nil
    }

    static func fileTimestamp(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return formatter.string(from: date)
    }
}
