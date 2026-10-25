import Foundation
import ZIPFoundation

public enum BackupRestoreMode: String, Equatable, Sendable {
    case merge
    case replaceAll = "replace_all"
}

public struct BackupImportOptions: Sendable {
    public var mode: BackupRestoreMode
    public var includeRawPackages: Bool
    /// Restrict a merge import to these course IDs (course-scoped import).
    public var courseIds: Set<String>?
    /// Replace-all keeps local-only `_backup/`, `llm_ios.json`, `attempts/`,
    /// `.jobs.json`, and unknown root files unless this is explicitly false.
    public var preserveLocalOnly: Bool
    public var limits: BackupLimits

    public init(
        mode: BackupRestoreMode = .merge,
        includeRawPackages: Bool = false,
        courseIds: Set<String>? = nil,
        preserveLocalOnly: Bool = true,
        limits: BackupLimits = BackupLimits()
    ) {
        self.mode = mode
        self.includeRawPackages = includeRawPackages
        self.courseIds = courseIds
        self.preserveLocalOnly = preserveLocalOnly
        self.limits = limits
    }
}

public struct BackupImportResult: Equatable, Sendable {
    public var mode: BackupRestoreMode
    public var filesImported: Int
    public var filesSkipped: Int
    public var stagedBytes: UInt64
    public var snapshotURL: URL?
    public var report: BackupReport

    public init(
        mode: BackupRestoreMode,
        filesImported: Int,
        filesSkipped: Int,
        stagedBytes: UInt64,
        snapshotURL: URL?,
        report: BackupReport
    ) {
        self.mode = mode
        self.filesImported = filesImported
        self.filesSkipped = filesSkipped
        self.stagedBytes = stagedBytes
        self.snapshotURL = snapshotURL
        self.report = report
    }
}

extension BackupService {
    static let mergeMarkerName = ".merge-in-progress.json"
    static let replaceMarkerName = ".replace-in-progress.json"

    /// Imports a desktop or iOS backup.
    ///
    /// The whole operation holds the data-root write lease. Everything is
    /// staged first, entries are secret-scanned while streaming (matching bytes
    /// never reach staging), the archive's dataVersion is validated in memory,
    /// and commit runs under a journal so a crash rolls back on next launch.
    public func importBackup(
        from archiveURL: URL,
        options: BackupImportOptions = BackupImportOptions(),
        progress: ((BackupProgress) throws -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil
    ) async throws -> BackupImportResult {
        var report = BackupReport()
        // Audit the whole Documents tree before reading the archive. This runs
        // under its own unique lease and works when the fail-closed gate is
        // active.
        report.inboxAudit = await ImportInboxAudit(
            root: root,
            keyMigrator: keyMigrator,
            store: store
        ).auditDocumentsTree()

        // Quiesce generation before taking the data lease. Every in-flight
        // stream is interrupted and workers wait for bookkeeping to finish.
        if let generationQueue {
            await generationQueue.beginMaintenance()
        }
        defer {
            if let generationQueue {
                Task { await generationQueue.endMaintenance() }
            }
        }

        let leaseOwner = newLeaseOwner(Self.importLeasePrefix)
        try root.acquireWriteLease(owner: leaseOwner, timeout: 60)
        defer { root.releaseWriteLease(owner: leaseOwner) }

        let archive: Archive
        do {
            archive = try Archive(url: archiveURL, accessMode: .read)
        } catch {
            throw BackupError.corruptArchive(String(describing: error))
        }

        // Bounded pre-pass: count/limits and the archive's dataVersion are
        // validated before a single file is written.
        let preflight = try preflightArchive(archive, limits: options.limits)
        try validateLocalConfigBeforeImport()
        let mode: BackupRestoreMode = options.courseIds != nil ? .merge : options.mode
        try preflightFreeSpace(
            mode: mode,
            stagedBytes: preflight.totalUncompressed,
            libraryBytes: UInt64(DataRoot.directorySize(root.rootURL))
        )

        let fileManager = FileManager.default
        try fileManager.createDirectory(at: root.stagingURL, withIntermediateDirectories: true)
        let stagingRoot = root.stagingURL.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: stagingRoot, withIntermediateDirectories: true)
        var keepStaging = false
        defer {
            if !keepStaging {
                try? fileManager.removeItem(at: stagingRoot)
            }
        }

        var stagedBytes: UInt64 = 0
        var totalBudget = options.limits.maxTotalUncompressedBytes
        var importedKeyReport: KeyMigrationReport?
        var stagedFileCount = 0

        for (index, entry) in archive.enumerated() {
            if isCancelled?() == true { throw BackupError.cancelled }
            try progress?(BackupProgress(
                phase: "Import",
                current: index + 1,
                total: preflight.entryCount,
                currentPath: entry.path
            ))
            guard entry.type != .directory else { continue }
            if Self.containsTraversal(entry.path) {
                throw BackupError.zipSlip(entry.path)
            }
            guard let rawPath = BackupPolicy.normalizedRelativePath(entry.path) else {
                report.skipped.append("\(entry.path) (invalid path)")
                continue
            }
            if let courseIds = options.courseIds {
                guard rawPath.hasPrefix("courses/") else {
                    report.skipped.append("\(rawPath) (course-scoped import)")
                    continue
                }
                let components = rawPath.split(separator: "/").map(String.init)
                guard components.count >= 2, courseIds.contains(components[1].lowercased()) else {
                    report.skipped.append("\(rawPath) (course not selected)")
                    continue
                }
            }

            switch BackupPolicy.decide(
                relativePath: rawPath,
                context: .importing,
                includeRawPackages: options.includeRawPackages
            ) {
            case let .deny(reason):
                report.denied.append("\(rawPath) (\(reason))")
                continue
            case let .skip(reason):
                report.skipped.append("\(rawPath) (\(reason))")
                continue
            case .allow:
                break
            }

            if rawPath == "dataVersion.json" {
                report.skipped.append("\(rawPath) (validated in memory; local version wins)")
                continue
            }

            if rawPath == "llm_config.json" {
                let data = try extractToData(
                    entry: entry,
                    archive: archive,
                    limit: options.limits.maxRootMetadataBytes
                )
                guard let json = try? JSONValue(parsing: data) else {
                    report.skipped.append("\(rawPath) (unreadable config)")
                    continue
                }
                let llmStore = LlmStore.normalized(from: json)
                let migrated = try keyMigrator.migrate(store: llmStore)
                importedKeyReport = migrated.report
                let sanitized = migrated.store.sanitizedJSON.serializedData()
                if let match = scanner.firstMatch(in: sanitized) {
                    throw BackupError.secretDetected(path: rawPath, pattern: match.pattern)
                }
                let destination = try PathValidator.safeJoin(base: stagingRoot, "llm_config.json")
                try self.store.write(sanitized, to: destination)
                stagedBytes += UInt64(sanitized.count)
                stagedFileCount += 1
                continue
            }

            if rawPath.hasPrefix("courses/") {
                let components = rawPath.split(separator: "/").map(String.init)
                guard components.count >= 2, (try? PathValidator.courseId(components[1])) != nil else {
                    report.skipped.append("\(rawPath) (invalid course id)")
                    continue
                }
            }
            if rawPath.hasPrefix("prompts/") {
                let components = rawPath.split(separator: "/").map(String.init)
                guard components.count == 2, components[1].hasSuffix(".md") else {
                    report.skipped.append("\(rawPath) (invalid prompt path)")
                    continue
                }
                let id = String(components[1].dropLast(3))
                guard (try? PathValidator.promptId(id)) != nil else {
                    report.skipped.append("\(rawPath) (invalid prompt id)")
                    continue
                }
            }

            let destination = try PathValidator.safeJoin(base: stagingRoot, components: [rawPath])
            try fileManager.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            switch try extractEntry(
                entry: entry,
                archive: archive,
                destination: destination,
                limits: options.limits,
                totalBudget: &totalBudget
            ) {
            case let .written(bytes):
                stagedBytes += bytes
                stagedFileCount += 1
                // A zip is compressed, so the streaming byte scan cannot see a
                // secret inside it. Scan the staged archive (recursively,
                // including nested zips) before commit; never commit it on a
                // match.
                if destination.pathExtension.lowercased() == "zip",
                   let match = try scanner.scanFile(at: destination) {
                    try? fileManager.removeItem(at: destination)
                    report.quarantined.append(
                        "\(rawPath) (nested archive secret detected: \(match.pattern))"
                    )
                    stagedBytes -= min(stagedBytes, bytes)
                    stagedFileCount = max(0, stagedFileCount - 1)
                }
            case let .secret(match):
                report.quarantined.append("\(rawPath) (secret detected: \(match.pattern))")
            }
        }

        if let configURL = try? PathValidator.safeJoin(base: stagingRoot, "llm_config.json"),
           let config = try? store.read(configURL),
           let match = scanner.firstMatch(in: config) {
            throw BackupError.secretDetected(path: "llm_config.json", pattern: match.pattern)
        }

        let filesImported: Int
        var snapshotURL: URL?
        do {
            switch mode {
            case .merge:
                filesImported = try commitMerge(
                    stagingRoot: stagingRoot,
                    progress: progress,
                    report: &report
                )
            case .replaceAll:
                let stagedCount = stagedFileCount
                snapshotURL = try commitReplaceAll(
                    stagingRoot: stagingRoot,
                    options: options,
                    stagedFileCount: stagedCount,
                    progress: progress,
                    report: &report
                )
                filesImported = stagedCount
            }
        } catch let error as BackupError {
            // A failed merge rollback keeps the staging/rollback tree and the
            // marker for a later recovery attempt.
            if case .mergeRollbackFailed = error {
                keepStaging = true
            }
            throw error
        }

        report.keyMigration = importedKeyReport

        // Stamp imported prompts so an app update never overwrites them as if
        // they were untouched bundled defaults (PLAN §4.8). Read the content
        // under the import lease, then release it before the provenance actor
        // takes its own write lease.
        var importedPromptRecords: [(id: String, content: String, bundled: String?)] = []
        if let promptProvenance {
            let importedPromptNames: [String]
            if mode == .replaceAll {
                let stagedPrompts = stagingRoot.appendingPathComponent("prompts", isDirectory: true)
                importedPromptNames = (try? fileManager.contentsOfDirectory(atPath: stagedPrompts.path))?
                    .filter { $0.lowercased().hasSuffix(".md") } ?? []
            } else {
                importedPromptNames = report.importedPrompts
            }
            for name in importedPromptNames {
                let id = (name as NSString).deletingPathExtension
                guard (try? PathValidator.promptId(id)) != nil,
                      let content = try? store.readString(root.promptsURL.appendingPathComponent(name)) else {
                    continue
                }
                let bundled = bundledPromptsDirectory.flatMap {
                    try? store.readString($0.appendingPathComponent(name))
                }
                importedPromptRecords.append((id, content, bundled))
            }
        }

        // The provenance store writes under its own lease; release the import
        // lease first. The deferred release below is then a no-op.
        root.releaseWriteLease(owner: leaseOwner)
        if let promptProvenance {
            for record in importedPromptRecords {
                try? await promptProvenance.recordImported(
                    id: record.id,
                    content: record.content,
                    bundledContent: record.bundled
                )
            }
        }

        return BackupImportResult(
            mode: mode,
            filesImported: filesImported,
            filesSkipped: report.skipped.count + report.denied.count,
            stagedBytes: stagedBytes,
            snapshotURL: snapshotURL,
            report: report
        )
    }

    // MARK: - Preflight

    struct ArchivePreflight {
        var entryCount: Int
        var totalUncompressed: UInt64
        var dataVersionEntry: Entry?
    }

    private func preflightArchive(_ archive: Archive, limits: BackupLimits) throws -> ArchivePreflight {
        var count = 0
        var total: UInt64 = 0
        var dataVersionEntry: Entry?

        // Bounded loop: stop immediately at the limit instead of materializing
        // an unbounded entry array.
        for entry in archive {
            count += 1
            if count > limits.maxEntries {
                throw BackupError.zipBomb("more than \(limits.maxEntries) entries")
            }
            guard entry.type != .directory else { continue }
            guard entry.uncompressedSize <= limits.maxEntryUncompressedBytes else {
                throw BackupError.zipBomb("entry \(entry.path) exceeds the per-entry size limit")
            }
            let (sum, overflow) = total.addingReportingOverflow(entry.uncompressedSize)
            guard !overflow else {
                throw BackupError.zipBomb("declared decompressed size overflows")
            }
            total = sum
            guard total <= limits.maxTotalUncompressedBytes else {
                throw BackupError.zipBomb("decompressed size exceeds the total limit")
            }
            if entry.compressedSize > 0, entry.uncompressedSize > 1024 * 1024 {
                let ratio = Double(entry.uncompressedSize) / Double(entry.compressedSize)
                guard ratio <= limits.maxCompressionRatio else {
                    throw BackupError.zipBomb("entry \(entry.path) has a compression ratio of \(Int(ratio))x")
                }
            }
            if dataVersionEntry == nil,
               let path = BackupPolicy.normalizedRelativePath(entry.path),
               path == "dataVersion.json" {
                dataVersionEntry = entry
            }
        }

        guard count > 0 else {
            throw BackupError.corruptArchive("archive has no entries")
        }

        if let entry = dataVersionEntry {
            let data = try extractToData(
                entry: entry,
                archive: archive,
                limit: min(limits.maxRootMetadataBytes, 1024 * 1024)
            )
            do {
                let record = try DataVersionRecord(json: JSONValue(parsing: data))
                if record.version > DataVersionStore.currentVersion {
                    throw BackupError.dataVersionIncompatible(
                        "archive version \(record.version) is newer than supported version \(DataVersionStore.currentVersion)"
                    )
                }
                if record.version < 0 {
                    throw BackupError.dataVersionIncompatible("archive version \(record.version) is invalid")
                }
            } catch let error as BackupError {
                throw error
            } catch {
                throw BackupError.dataVersionIncompatible("unreadable dataVersion.json: \(error)")
            }
        }

        return ArchivePreflight(entryCount: count, totalUncompressed: total, dataVersionEntry: dataVersionEntry)
    }

    private func preflightFreeSpace(mode: BackupRestoreMode, stagedBytes: UInt64, libraryBytes: UInt64) throws {
        guard let available = Self.availableCapacity(at: root.rootURL) else { return }
        let required = Self.requiredSpace(
            mode: mode,
            libraryBytes: libraryBytes,
            stagedBytes: stagedBytes
        )
        guard available >= required else {
            throw BackupError.insufficientSpace(requiredBytes: required, availableBytes: available)
        }
    }

    /// Free space required before commit. Replace-all must hold the existing
    /// library, its full immutable snapshot, the staged archive and headroom;
    /// a large archive is therefore never under-counted by the 4× rule.
    public static func requiredSpace(
        mode: BackupRestoreMode,
        libraryBytes: UInt64,
        stagedBytes: UInt64,
        headroomBytes: UInt64 = 64 * 1024 * 1024
    ) -> Int64 {
        let (sum, sumOverflow) = libraryBytes.addingReportingOverflow(stagedBytes)
        let (withHeadroom, headroomOverflow) = sum.addingReportingOverflow(headroomBytes)
        let fullNeed: UInt64 = (sumOverflow || headroomOverflow) ? UInt64(Int64.max) : withHeadroom

        switch mode {
        case .merge:
            return Int64(min(fullNeed, UInt64(Int64.max)))
        case .replaceAll:
            let (quad, quadOverflow) = libraryBytes.multipliedReportingOverflow(by: 4)
            let conservative: UInt64 = quadOverflow ? UInt64(Int64.max) : quad
            return Int64(min(max(conservative, fullNeed), UInt64(Int64.max)))
        }
    }

    // MARK: - Entry extraction (streaming secret scan)

    enum EntryExtraction {
        case written(UInt64)
        case secret(SecretMatch)
    }

    private struct ImportScanStop: Error {
        var match: SecretMatch
    }

    private func extractEntry(
        entry: Entry,
        archive: Archive,
        destination: URL,
        limits: BackupLimits,
        totalBudget: inout UInt64
    ) throws -> EntryExtraction {
        guard entry.uncompressedSize <= limits.maxEntryUncompressedBytes else {
            throw BackupError.zipBomb("entry \(entry.path) exceeds the per-entry size limit")
        }
        let ext = (entry.path as NSString).pathExtension.lowercased()

        if ext == "mhtml" || ext == "mht" {
            // Decode/scan in memory; only clean bytes are written to staging,
            // so encoded secrets never touch even a temp file.
            let limit = min(scanner.limits.maxNestedUncompressedBytes, totalBudget)
            let data = try extractToData(entry: entry, archive: archive, limit: limit)
            if let match = try scanner.scanMHTML(data: data, path: entry.path) {
                return .secret(match)
            }
            totalBudget -= UInt64(data.count)
            try store.write(data, to: destination)
            return .written(UInt64(data.count))
        }

        let fileManager = FileManager.default
        try fileManager.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        _ = fileManager.createFile(atPath: destination.path, contents: nil)
        let handle = try FileHandle(forWritingTo: destination)

        var carry = Data()
        var written: UInt64 = 0
        do {
            _ = try archive.extract(entry, skipCRC32: false) { chunk in
                var combined = carry
                combined.append(chunk)
                if let match = scanner.firstMatch(in: combined) {
                    throw ImportScanStop(match: match)
                }
                written += UInt64(chunk.count)
                guard written <= limits.maxEntryUncompressedBytes else {
                    throw BackupError.zipBomb("entry \(entry.path) exceeds the per-entry size limit")
                }
                guard written <= totalBudget else {
                    throw BackupError.zipBomb("archive exceeds the total decompressed-size limit")
                }
                try handle.write(contentsOf: chunk)
                carry = Data(combined.suffix(16 * 1024))
            }
            try handle.synchronize()
            try handle.close()
        } catch let stop as ImportScanStop {
            try? handle.close()
            try? fileManager.removeItem(at: destination)
            return .secret(stop.match)
        } catch {
            try? handle.close()
            try? fileManager.removeItem(at: destination)
            throw error
        }
        totalBudget -= written
        return .written(written)
    }

    private func extractToData(entry: Entry, archive: Archive, limit: UInt64) throws -> Data {
        var data = Data()
        var total: UInt64 = 0
        _ = try archive.extract(entry, skipCRC32: false) { chunk in
            total += UInt64(chunk.count)
            guard total <= limit else {
                throw BackupError.zipBomb("entry \(entry.path) exceeds \(limit) bytes")
            }
            data.append(chunk)
        }
        return data
    }

    // MARK: - Merge commit

    private func commitMerge(
        stagingRoot: URL,
        progress: ((BackupProgress) throws -> Void)?,
        report: inout BackupReport
    ) throws -> Int {
        let journal = try MergeTransaction(root: root, stagingRoot: stagingRoot, store: store)
        do {
            let count = try commitMergeBody(
                stagingRoot: stagingRoot,
                journal: journal,
                progress: progress,
                report: &report
            )
            try journal.finishSuccess()
            return count
        } catch {
            do {
                try journal.rollback()
            } catch let rollbackError {
                throw BackupError.mergeRollbackFailed(
                    "\(error); rollback error: \(rollbackError); staging/rollback tree kept at \(stagingRoot.path)"
                )
            }
            throw error
        }
    }

    private func commitMergeBody(
        stagingRoot: URL,
        journal: MergeTransaction,
        progress: ((BackupProgress) throws -> Void)?,
        report: inout BackupReport
    ) throws -> Int {
        let fileManager = FileManager.default
        var imported = 0

        let stagingCourses = stagingRoot.appendingPathComponent("courses", isDirectory: true)
        if fileManager.fileExists(atPath: stagingCourses.path) {
            let courseDirs = try fileManager.contentsOfDirectory(
                at: stagingCourses,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
            for courseDir in courseDirs
            where (try? courseDir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                guard (try? PathValidator.courseId(courseDir.lastPathComponent)) != nil else { continue }
                imported += try mergeCourse(
                    courseId: courseDir.lastPathComponent,
                    stagedCourse: courseDir,
                    journal: journal,
                    progress: progress,
                    report: &report
                )
            }
        }

        // Prompts: local wins; only missing prompts are imported.
        let stagingPrompts = stagingRoot.appendingPathComponent("prompts", isDirectory: true)
        if fileManager.fileExists(atPath: stagingPrompts.path) {
            for file in try fileManager.contentsOfDirectory(at: stagingPrompts, includingPropertiesForKeys: nil) {
                guard file.pathExtension.lowercased() == "md",
                      (try? PathValidator.promptId(file.deletingPathExtension().lastPathComponent)) != nil else { continue }
                let destination = root.promptsURL.appendingPathComponent(file.lastPathComponent)
                if !fileManager.fileExists(atPath: destination.path) {
                    try journaledCopy(from: file, to: destination, journal: journal)
                    report.importedPrompts.append(file.lastPathComponent)
                    imported += 1
                } else if try !filesEqual(file, destination) {
                    let conflict = try conflictDestination(
                        base: root.rootURL,
                        relativePath: "_conflicts/prompts/\(file.lastPathComponent)",
                        source: file
                    )
                    try journaledCopy(from: file, to: conflict, journal: journal)
                    report.conflicts.append("prompts/\(file.lastPathComponent)")
                }
            }
        }

        imported += try mergePassthroughDirectory(
            staging: stagingRoot.appendingPathComponent("lessonProgress", isDirectory: true),
            live: root.rootURL.appendingPathComponent("lessonProgress", isDirectory: true),
            conflictBase: root.rootURL,
            relativePrefix: "lessonProgress",
            localWinsAlways: false,
            journal: journal,
            report: &report
        )

        imported += try mergePassthroughDirectory(
            staging: stagingRoot.appendingPathComponent("attempts", isDirectory: true),
            live: root.attemptsURL,
            conflictBase: root.rootURL,
            relativePrefix: "attempts",
            localWinsAlways: true,
            journal: journal,
            report: &report
        )

        // Root conflict copies produced by earlier imports are part of the
        // backup now; import missing only (never recurse conflicts-of-conflicts).
        imported += try mergePassthroughDirectory(
            staging: stagingRoot.appendingPathComponent("_conflicts", isDirectory: true),
            live: root.rootURL.appendingPathComponent("_conflicts", isDirectory: true),
            conflictBase: root.rootURL,
            relativePrefix: "_conflicts",
            localWinsAlways: true,
            journal: journal,
            report: &report
        )

        let stagedConfig = stagingRoot.appendingPathComponent("llm_config.json")
        if fileManager.fileExists(atPath: stagedConfig.path) {
            let local = try readLocalLlmStore(at: root.llmConfigURL)
            let importedStore = try LlmStore.decode(store.read(stagedConfig))
            let base = LlmStoreMerger.merge(local: local, imported: importedStore)
            let reconciliation = LlmKeyReconciler.reconcile(
                imported: importedStore,
                merged: base,
                secretStore: keyMigrator.secretStore
            )
            report.pendingKeyReplacements.append(contentsOf: reconciliation.pendingReplacements)
            report.adoptedImportedKeyCardIDs.append(contentsOf: reconciliation.adoptedCardIDs)
            try journaledWrite(
                reconciliation.store.sanitizedJSON.serializedData(),
                to: root.llmConfigURL,
                journal: journal
            )
        }

        imported += try importRootMetadataIfMissing(
            name: "llm_ios.json",
            stagingRoot: stagingRoot,
            journal: journal,
            report: &report
        )
        imported += try importRootMetadataIfMissing(
            name: "settings.json",
            stagingRoot: stagingRoot,
            journal: journal,
            report: &report
        )

        return imported
    }

    private func mergeCourse(
        courseId: String,
        stagedCourse: URL,
        journal: any WriteJournal,
        progress: ((BackupProgress) throws -> Void)?,
        report: inout BackupReport
    ) throws -> Int {
        let fileManager = FileManager.default
        let localCourse = try root.courseURL(courseId)
        try fileManager.createDirectory(at: localCourse, withIntermediateDirectories: true)
        var imported = 0

        let stagedMetaURL = stagedCourse.appendingPathComponent("meta.json")
        if fileManager.fileExists(atPath: stagedMetaURL.path) {
            if let importedManifest = try? CourseManifest.decode(store.read(stagedMetaURL)) {
                if importedManifest.id.lowercased() != courseId.lowercased() {
                    report.skipped.append("courses/\(courseId)/meta.json (manifest id mismatch)")
                } else {
                    let localMetaURL = localCourse.appendingPathComponent("meta.json")
                    var localManifest: CourseManifest?
                    if fileManager.fileExists(atPath: localMetaURL.path) {
                        do {
                            localManifest = try CourseManifest.decode(store.read(localMetaURL))
                        } catch {
                            throw BackupError.importFailed(
                                "local courses/\(courseId)/meta.json is corrupt; repair it before importing"
                            )
                        }
                    }
                    let presence = try stagedContentPresence(courseDir: stagedCourse)
                    let merged = ManifestMerger.merge(
                        local: localManifest,
                        imported: importedManifest,
                        stagedContent: presence
                    )
                    try journaledWrite(merged.manifest.encoded(), to: localMetaURL, journal: journal)
                    report.missingLessons.append(contentsOf: merged.missingLessonIDs.map { "\(courseId):\($0)" })
                    if !merged.invalidLessons.isEmpty {
                        try writeConflictsJSON(
                            merged.invalidLessons.map(\.json),
                            courseId: courseId,
                            name: "manifest-invalid-\(Self.fileTimestamp()).json",
                            journal: journal
                        )
                        report.conflicts.append("courses/\(courseId)/meta.json (invalid lessons)")
                    }
                }
            } else {
                report.skipped.append("courses/\(courseId)/meta.json (unreadable manifest)")
            }
        }

        let stagedCheckpoints = stagedCourse.appendingPathComponent("checkpoint.json")
        if fileManager.fileExists(atPath: stagedCheckpoints.path) {
            let importedDocument: CheckpointDocument
            do {
                importedDocument = try CheckpointDocument(data: store.read(stagedCheckpoints))
            } catch {
                report.skipped.append("courses/\(courseId)/checkpoint.json (unreadable)")
                return imported
            }
            let localURL = localCourse.appendingPathComponent("checkpoint.json")
            var localDocument = CheckpointDocument()
            if fileManager.fileExists(atPath: localURL.path) {
                do {
                    localDocument = try CheckpointDocument(data: store.read(localURL))
                } catch {
                    throw BackupError.importFailed(
                        "local courses/\(courseId)/checkpoint.json is corrupt; repair it before importing"
                    )
                }
            }

            let availableFiles = try availableFileNames(local: localCourse, staged: stagedCourse)
            var validImported = CheckpointDocument()
            var invalidRaw: [JSONValue] = []
            for value in importedDocument.passthrough {
                // An object that carries a `file` key is a malformed checkpoint,
                // not forward-compatible passthrough data.
                if value["file"] != nil {
                    invalidRaw.append(value)
                } else {
                    validImported.passthrough.append(value)
                }
            }
            var invalid: [Checkpoint] = []
            for checkpoint in importedDocument.checkpoints {
                if Self.isValidCheckpoint(checkpoint, availableFiles: availableFiles) {
                    validImported.checkpoints.append(checkpoint)
                } else {
                    invalid.append(checkpoint)
                }
            }

            let merged = CheckpointMerger.merge(local: localDocument, imported: validImported)
            try journaledWrite(merged.document.encoded(), to: localURL, journal: journal)
            if !merged.noteConflicts.isEmpty {
                let conflictURL = try conflictDestination(
                    base: localCourse,
                    relativePath: "_conflicts/checkpoint-notes-\(Self.fileTimestamp()).json",
                    source: nil
                )
                try journaledWrite(
                    JSONValue.array(merged.noteConflicts.map(\.json)).serializedData(),
                    to: conflictURL,
                    journal: journal
                )
                report.conflicts.append("courses/\(courseId)/checkpoint.json (note conflicts)")
            }
            if !invalid.isEmpty {
                try writeConflictsJSON(
                    invalid.map(\.json),
                    courseId: courseId,
                    name: "checkpoint-invalid-\(Self.fileTimestamp()).json",
                    journal: journal
                )
                report.conflicts.append("courses/\(courseId)/checkpoint.json (invalid entries)")
            }
            if !invalidRaw.isEmpty {
                try writeConflictsJSON(
                    invalidRaw,
                    courseId: courseId,
                    name: "checkpoint-invalid-raw-\(Self.fileTimestamp()).json",
                    journal: journal
                )
                report.conflicts.append("courses/\(courseId)/checkpoint.json (invalid raw entries)")
            }
        }

        guard let enumerator = fileManager.enumerator(
            at: stagedCourse,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return imported }
        for case let file as URL in enumerator {
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let relative = Self.relativePath(of: file, under: stagedCourse)
            if relative == "meta.json" || relative == "checkpoint.json" { continue }
            let destination = try PathValidator.safeJoin(base: localCourse, components: [relative])
            if !fileManager.fileExists(atPath: destination.path) {
                try journaledCopy(from: file, to: destination, journal: journal)
                imported += 1
            } else if try !filesEqual(file, destination) {
                let conflict = try conflictDestination(
                    base: localCourse,
                    relativePath: "_conflicts/\(relative)",
                    source: file
                )
                try journaledCopy(from: file, to: conflict, journal: journal)
                report.conflicts.append("courses/\(courseId)/\(relative)")
            }
        }

        // Raw packages are large and must stay out of device backup.
        try? root.excludeRawPackagesFromBackup(courseId: courseId)
        try progress?(BackupProgress(
            phase: "Merge.commit",
            current: 0,
            total: 0,
            currentPath: "courses/\(courseId)"
        ))
        return imported
    }

    private func mergePassthroughDirectory(
        staging: URL,
        live: URL,
        conflictBase: URL,
        relativePrefix: String,
        localWinsAlways: Bool,
        journal: any WriteJournal,
        report: inout BackupReport
    ) throws -> Int {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: staging.path),
              let enumerator = fileManager.enumerator(
                at: staging,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
              ) else { return 0 }
        var imported = 0
        for case let file as URL in enumerator {
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let relative = Self.relativePath(of: file, under: staging)
            let destination = try PathValidator.safeJoin(base: live, components: [relative])
            if !fileManager.fileExists(atPath: destination.path) {
                try journaledCopy(from: file, to: destination, journal: journal)
                imported += 1
            } else if localWinsAlways {
                continue
            } else if try !filesEqual(file, destination) {
                let conflict = try conflictDestination(
                    base: conflictBase,
                    relativePath: "_conflicts/\(relativePrefix)/\(relative)",
                    source: file
                )
                try journaledCopy(from: file, to: conflict, journal: journal)
                report.conflicts.append("\(relativePrefix)/\(relative)")
            }
        }
        return imported
    }

    private func importRootMetadataIfMissing(
        name: String,
        stagingRoot: URL,
        journal: any WriteJournal,
        report: inout BackupReport
    ) throws -> Int {
        let fileManager = FileManager.default
        let staged = stagingRoot.appendingPathComponent(name)
        let live = root.rootURL.appendingPathComponent(name)
        guard fileManager.fileExists(atPath: staged.path) else { return 0 }
        if fileManager.fileExists(atPath: live.path) {
            report.skipped.append("\(name) (local wins)")
            return 0
        }
        try journaledCopy(from: staged, to: live, journal: journal)
        return 1
    }

    private func writeConflictsJSON(
        _ values: [JSONValue],
        courseId: String,
        name: String,
        journal: any WriteJournal
    ) throws {
        let localCourse = try root.courseURL(courseId)
        let conflictURL = try conflictDestination(
            base: localCourse,
            relativePath: "_conflicts/\(name)",
            source: nil
        )
        try journaledWrite(
            JSONValue.array(values).serializedData(),
            to: conflictURL,
            journal: journal
        )
    }

    private func stagedContentPresence(courseDir: URL) throws -> [String: LessonContentPresence] {
        let fileManager = FileManager.default
        var presence: [String: LessonContentPresence] = [:]
        guard let enumerator = fileManager.enumerator(
            at: courseDir,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return presence }
        for case let file as URL in enumerator {
            guard file.pathExtension.lowercased() == "md" else { continue }
            guard let parsed = PathValidator.parseDocFileName(file.lastPathComponent),
                  !parsed.isCourseScope,
                  !parsed.isUnitScope else { continue }
            var item = presence[parsed.lessonId] ?? LessonContentPresence()
            switch parsed.tab {
            case "lesson": item.hasFull = true
            case "summary": item.hasSummary = true
            case "cheatsheet": item.hasCheatsheet = true
            case "test": item.hasTest = true
            default: break
            }
            presence[parsed.lessonId] = item
        }
        return presence
    }

    /// Checkpoints reference course-root documents only; nested assets or
    /// `_backup/` files with the same basename must not validate an entry.
    private func availableFileNames(local: URL, staged: URL) throws -> Set<String> {
        let fileManager = FileManager.default
        var names = Set<String>()
        for directory in [local, staged] {
            guard let files = try? fileManager.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for file in files
            where (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
                names.insert(file.lastPathComponent)
            }
        }
        return names
    }

    static func isValidCheckpoint(_ checkpoint: Checkpoint, availableFiles: Set<String>) -> Bool {
        guard !checkpoint.file.contains("/"),
              !checkpoint.file.contains("\\"),
              PathValidator.parseDocFileName(checkpoint.file) != nil else { return false }
        // `course.lesson` is the virtual navigation page and intentionally has
        // no file; preserve its existing checkpoint string.
        if checkpoint.file == "course.lesson.md" { return true }
        return availableFiles.contains(checkpoint.file)
    }

    /// The local card store is read explicitly before any write. A corrupt
    /// file is preserved as `.bak` and quarantined; the import aborts rather
    /// than silently replacing it.
    private func validateLocalConfigBeforeImport() throws {
        guard store.exists(root.llmConfigURL) else { return }
        do {
            _ = try LlmStore.decode(store.read(root.llmConfigURL))
        } catch {
            _ = try? quarantine.quarantineFile(
                root.llmConfigURL,
                reason: "unreadable llm_config.json before import: \(error)",
                store: store
            )
            throw BackupError.importFailed(
                "local llm_config.json is unreadable; a .bak was kept, the file was quarantined, and the import was aborted"
            )
        }
    }

    private func readLocalLlmStore(at url: URL) throws -> LlmStore? {
        guard store.exists(url) else { return nil }
        do {
            return try LlmStore.decode(store.read(url))
        } catch {
            _ = try? quarantine.quarantineFile(
                url,
                reason: "unreadable llm_config.json: \(error)",
                store: store
            )
            throw BackupError.importFailed(
                "local llm_config.json is unreadable; a .bak was kept and the import was aborted"
            )
        }
    }

    // MARK: - Replace-all commit

    private func commitReplaceAll(
        stagingRoot: URL,
        options: BackupImportOptions,
        stagedFileCount: Int,
        progress: ((BackupProgress) throws -> Void)?,
        report: inout BackupReport
    ) throws -> URL {
        let transaction = try ReplaceTransaction(
            root: root,
            stagingRoot: stagingRoot,
            store: store
        )
        do {
            try replaceBody(
                stagingRoot: stagingRoot,
                options: options,
                transaction: transaction,
                progress: progress,
                report: &report
            )
            transaction.finishSuccess()
            report.filesWritten = stagedFileCount
            return transaction.snapshot
        } catch {
            do {
                try transaction.rollback()
            } catch let rollbackError {
                throw BackupError.replaceRollbackFailed(
                    "\(error); rollback error: \(rollbackError); snapshot and marker kept at \(transaction.snapshot.path)"
                )
            }
            throw error
        }
    }

    private func replaceBody(
        stagingRoot: URL,
        options: BackupImportOptions,
        transaction: ReplaceTransaction,
        progress: ((BackupProgress) throws -> Void)?,
        report: inout BackupReport
    ) throws {
        let fileManager = FileManager.default

        // Replace directories file-by-file so rollback (and post-crash
        // recovery) never deletes a live file that was not recorded. Unknown
        // orphan files survive a preserve-local replace.
        for name in ["courses", "prompts"] {
            let staged = stagingRoot.appendingPathComponent(name)
            guard fileManager.fileExists(atPath: staged.path) else { continue }
            let live = root.rootURL.appendingPathComponent(name)
            try installDirectoryReplacing(
                staged: staged,
                live: live,
                scope: name,
                options: options,
                transaction: transaction,
                report: &report
            )
            try progress?(BackupProgress(
                phase: "Replace.install",
                current: 0,
                total: 0,
                currentPath: name
            ))
        }

        // lessonProgress and attempts are passthrough data: preserve-local
        // means local wins with missing imported; opt-out performs a replace.
        let passthroughDirectories: [(name: String, live: URL)] = [
            ("lessonProgress", root.rootURL.appendingPathComponent("lessonProgress", isDirectory: true)),
            ("attempts", root.attemptsURL),
        ]
        for item in passthroughDirectories {
            let staged = stagingRoot.appendingPathComponent(item.name)
            if options.preserveLocalOnly {
                try fileManager.createDirectory(at: item.live, withIntermediateDirectories: true)
                if fileManager.fileExists(atPath: staged.path) {
                    _ = try mergePassthroughDirectory(
                        staging: staged,
                        live: item.live,
                        conflictBase: root.rootURL,
                        relativePrefix: item.name,
                        localWinsAlways: true,
                        journal: transaction,
                        report: &report
                    )
                }
            } else if fileManager.fileExists(atPath: staged.path) {
                try installDirectoryReplacing(
                    staged: staged,
                    live: item.live,
                    scope: item.name,
                    options: options,
                    transaction: transaction,
                    report: &report
                )
            } else if fileManager.fileExists(atPath: item.live.path) {
                try transaction.record(relativePath: item.name)
                try fileManager.removeItem(at: item.live)
            }
        }

        // Local raw packages are local-only data: merge them when both the
        // archive and the device have material for the same course.
        if options.preserveLocalOnly {
            try mergeLocalRawPackages(transaction: transaction, report: &report)
        }

        // Root metadata.
        let stagedConfig = stagingRoot.appendingPathComponent("llm_config.json")
        if fileManager.fileExists(atPath: stagedConfig.path) {
            let local = try readLocalLlmStore(at: root.llmConfigURL)
            let importedStore = try LlmStore.decode(store.read(stagedConfig))
            let base = LlmStoreMerger.merge(local: local, imported: importedStore)
            let reconciliation = LlmKeyReconciler.reconcile(
                imported: importedStore,
                merged: base,
                secretStore: keyMigrator.secretStore
            )
            report.pendingKeyReplacements.append(contentsOf: reconciliation.pendingReplacements)
            report.adoptedImportedKeyCardIDs.append(contentsOf: reconciliation.adoptedCardIDs)
            try transaction.record(relativePath: "llm_config.json")
            try store.writeJSON(reconciliation.store.sanitizedJSON, to: root.llmConfigURL)
        } else if !options.preserveLocalOnly {
            try transaction.record(relativePath: "llm_config.json")
            try? fileManager.removeItem(at: root.llmConfigURL)
        }

        for name in ["llm_ios.json", "settings.json"] {
            let staged = stagingRoot.appendingPathComponent(name)
            let live = root.rootURL.appendingPathComponent(name)
            if options.preserveLocalOnly, fileManager.fileExists(atPath: live.path) {
                report.skipped.append("\(name) (local wins)")
                continue
            }
            if fileManager.fileExists(atPath: staged.path) {
                try transaction.record(relativePath: name)
                try? fileManager.removeItem(at: live)
                try copyFileAtomically(from: staged, to: live)
            } else if !options.preserveLocalOnly, fileManager.fileExists(atPath: live.path) {
                try transaction.record(relativePath: name)
                try fileManager.removeItem(at: live)
            }
        }

        if !options.preserveLocalOnly, fileManager.fileExists(atPath: root.jobsURL.path) {
            try transaction.record(relativePath: ".jobs.json")
            try fileManager.removeItem(at: root.jobsURL)
        }

        // Root conflict copies from the archive (local wins).
        if fileManager.fileExists(atPath: stagingRoot.appendingPathComponent("_conflicts").path) {
            _ = try mergePassthroughDirectory(
                staging: stagingRoot.appendingPathComponent("_conflicts", isDirectory: true),
                live: root.rootURL.appendingPathComponent("_conflicts", isDirectory: true),
                conflictBase: root.rootURL,
                relativePrefix: "_conflicts",
                localWinsAlways: true,
                journal: transaction,
                report: &report
            )
        }

        // Unknown root files are local-only; drop them only on explicit opt-out.
        if !options.preserveLocalOnly {
            let handled: Set<String> = [
                "courses", "prompts", "lessonProgress", "attempts", "_conflicts",
                "llm_config.json", "llm_ios.json", "settings.json", ".jobs.json",
                "dataVersion.json", ".replace-in-progress.json", ".merge-in-progress.json",
            ]
            let topLevel = try fileManager.contentsOfDirectory(
                at: root.rootURL,
                includingPropertiesForKeys: nil,
                options: []
            )
            for item in topLevel {
                let name = item.lastPathComponent
                if DataRoot.internalRootNames.contains(name) || handled.contains(name) { continue }
                try transaction.record(relativePath: name)
                try fileManager.removeItem(at: item)
            }
        }

        // Re-exclude raw packages for every live course.
        for courseId in try liveCourseIDs() {
            try? root.excludeRawPackagesFromBackup(courseId: courseId)
        }
    }

    /// Installs a staged directory file-by-file. Every path is journaled before
    /// it is written or removed, so rollback restores exactly what changed and
    /// leaves unrelated live files alone.
    private func installDirectoryReplacing(
        staged: URL,
        live: URL,
        scope: String,
        options: BackupImportOptions,
        transaction: ReplaceTransaction,
        report: inout BackupReport
    ) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: live, withIntermediateDirectories: true)

        let stagedFiles = try listFiles(in: staged)
        for file in stagedFiles {
            let relative = Self.relativePath(of: file, under: staged)
            let target = try PathValidator.safeJoin(base: live, components: [relative])
            try transaction.record(absoluteURL: target)
            try copyFileAtomically(from: file, to: target)
        }
        let stagedSet = Set(stagedFiles.map { Self.relativePath(of: $0, under: staged) })

        for liveFile in try listFiles(in: live) {
            let relative = Self.relativePath(of: liveFile, under: live)
            if stagedSet.contains(relative) { continue }
            if options.preserveLocalOnly {
                if scope == "courses", relative.contains("/_backup/") { continue }
                if !Self.isKnownLibraryFile(relative, scope: scope) { continue }
            }
            try transaction.record(absoluteURL: liveFile)
            try fileManager.removeItem(at: liveFile)
            report.skipped.append("\(scope)/\(relative) (removed by replace-all)")
        }
    }

    private func listFiles(in directory: URL) throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: []
        ) else { return [] }
        var files: [URL] = []
        for case let file as URL in enumerator {
            if (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
                files.append(file)
            }
        }
        return files
    }

    /// Known library documents are removed when a replace archive no longer
    /// contains them; unknown/orphan files are preserved unless the user
    /// explicitly opts out of local-only preservation.
    static func isKnownLibraryFile(_ relativePath: String, scope: String) -> Bool {
        let base = (relativePath as NSString).lastPathComponent
        switch scope {
        case "courses":
            if base == "meta.json" || base == "checkpoint.json" { return true }
            if relativePath.hasPrefix("assets/") || relativePath.contains("/assets/") { return true }
            if relativePath.hasPrefix("_backup/") || relativePath.contains("/_backup/") { return true }
            return PathValidator.parseDocFileName(base) != nil
                || PathValidator.parsePopQuizFileName(base) != nil
        case "prompts":
            guard relativePath.hasSuffix(".md") else { return false }
            return (try? PathValidator.promptId((base as NSString).deletingPathExtension)) != nil
        default:
            return true
        }
    }

    private func mergeLocalRawPackages(
        transaction: ReplaceTransaction,
        report: inout BackupReport
    ) throws {
        let fileManager = FileManager.default
        let snapshotCourses = transaction.snapshot.appendingPathComponent("courses", isDirectory: true)
        guard fileManager.fileExists(atPath: snapshotCourses.path) else { return }
        for courseDir in try fileManager.contentsOfDirectory(
            at: snapshotCourses,
            includingPropertiesForKeys: [.isDirectoryKey]
        ) where (try? courseDir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            let localBackup = courseDir.appendingPathComponent("_backup", isDirectory: true)
            guard fileManager.fileExists(atPath: localBackup.path) else { continue }
            let liveCourse = root.coursesURL.appendingPathComponent(courseDir.lastPathComponent, isDirectory: true)
            // A course absent from the archive is intentionally removed by
            // replace-all; there is nowhere to merge its raw packages into.
            guard fileManager.fileExists(atPath: liveCourse.path) else { continue }
            let liveBackup = liveCourse.appendingPathComponent("_backup", isDirectory: true)
            try fileManager.createDirectory(at: liveBackup, withIntermediateDirectories: true)

            guard let enumerator = fileManager.enumerator(
                at: localBackup,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for case let file as URL in enumerator {
                guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                let relative = Self.relativePath(of: file, under: localBackup)
                let destination = try PathValidator.safeJoin(base: liveBackup, components: [relative])
                if !fileManager.fileExists(atPath: destination.path) {
                    try transaction.record(absoluteURL: destination)
                    try copyFileAtomically(from: file, to: destination)
                } else if try !filesEqual(file, destination) {
                    // Archive material wins at the same path; keep the local
                    // copy under _conflicts with a hash.
                    let conflict = try conflictDestination(
                        base: liveCourse,
                        relativePath: "_conflicts/raw-backup/\(relative)",
                        source: file
                    )
                    try transaction.record(absoluteURL: conflict)
                    try copyFileAtomically(from: file, to: conflict)
                    report.conflicts.append("courses/\(courseDir.lastPathComponent)/_backup/\(relative)")
                }
            }
        }
    }

    private func liveCourseIDs() throws -> [String] {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: root.coursesURL.path),
              let dirs = try? fileManager.contentsOfDirectory(
                at: root.coursesURL,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
              ) else { return [] }
        return dirs.compactMap { dir in
            guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
                  (try? PathValidator.courseId(dir.lastPathComponent)) != nil else { return nil }
            return dir.lastPathComponent
        }
    }
}

// MARK: - Merge transaction

/// A write journal records the pre-mutation state of every live path it
/// touches. Both merge and replace-all use it; replace-all persists a
/// transaction file inside its immutable snapshot.
protocol WriteJournal: AnyObject {
    func record(_ url: URL) throws
    func didCommit(relative: String) throws
}

/// Journal for merge commits. Before a live file is touched, its original is
/// copied under `<staging>/.rollback/existing/<relative>`; files that did not
/// exist get an empty marker under `.rollback/created/<relative>`. A crash
/// therefore rolls back to the exact pre-merge state on next launch.
final class MergeTransaction {
    let root: DataRoot
    let stagingRoot: URL
    let rollbackRoot: URL
    let markerURL: URL
    private let store: AtomicFileStore
    private var recorded = Set<String>()
    private var committed = 0
    private var lastPath = ""

    init(root: DataRoot, stagingRoot: URL, store: AtomicFileStore) throws {
        self.root = root
        self.stagingRoot = stagingRoot
        self.store = store
        self.rollbackRoot = stagingRoot.appendingPathComponent(".rollback", isDirectory: true)
        self.markerURL = root.rootURL.appendingPathComponent(BackupService.mergeMarkerName)
        try FileManager.default.createDirectory(
            at: rollbackRoot.appendingPathComponent("existing", isDirectory: true),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: rollbackRoot.appendingPathComponent("created", isDirectory: true),
            withIntermediateDirectories: true
        )
        try writeMarker()
    }

    func record(_ url: URL) throws {
        let relative = BackupService.relativePath(of: url, under: root.rootURL)
        guard !relative.isEmpty, !relative.hasPrefix("..") else { return }
        guard recorded.insert(relative).inserted else { return }
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: url.path) {
            let saved = rollbackRoot.appendingPathComponent("existing", isDirectory: true)
                .appendingPathComponent(relative)
            try fileManager.createDirectory(
                at: saved.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? fileManager.removeItem(at: saved)
            try copyFileAtomically(from: url, to: saved)
        } else {
            let marker = rollbackRoot.appendingPathComponent("created", isDirectory: true)
                .appendingPathComponent(relative)
            try fileManager.createDirectory(
                at: marker.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try Data().write(to: marker)
        }
    }

    func didCommit(relative: String) throws {
        committed += 1
        lastPath = relative
        if committed == 1 || committed % 20 == 0 {
            try writeMarker()
        }
    }

    func finishSuccess() throws {
        try? FileManager.default.removeItem(at: markerURL)
    }

    func rollback() throws {
        try Self.performRollback(root: root, rollbackRoot: rollbackRoot)
        try? FileManager.default.removeItem(at: markerURL)
    }

    private func writeMarker() throws {
        let json = JSONValue.object([
            JSONMember(key: "state", value: .string("committing")),
            JSONMember(key: "staging", value: .string(BackupService.relativePath(of: stagingRoot, under: root.rootURL))),
            JSONMember(key: "rollback", value: .string(BackupService.relativePath(of: rollbackRoot, under: root.rootURL))),
            JSONMember(key: "progress", value: .object([
                JSONMember(key: "committed", value: .number(String(committed))),
                JSONMember(key: "lastPath", value: .string(lastPath)),
            ])),
            JSONMember(key: "startedAt", value: .string(GenerationJob.timestamp())),
        ])
        try store.writeJSON(json, to: markerURL)
    }

    static func performRollback(root: DataRoot, rollbackRoot: URL) throws {
        let fileManager = FileManager.default
        let createdRoot = rollbackRoot.appendingPathComponent("created", isDirectory: true)
        let existingRoot = rollbackRoot.appendingPathComponent("existing", isDirectory: true)

        if let enumerator = fileManager.enumerator(
            at: createdRoot,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: []
        ) {
            for case let file as URL in enumerator {
                guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                let relative = BackupService.relativePath(of: file, under: createdRoot)
                let live = try BackupService.validatedRelativePath(relative, base: root.rootURL)
                try? fileManager.removeItem(at: live)
            }
        }

        if let enumerator = fileManager.enumerator(
            at: existingRoot,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: []
        ) {
            for case let file as URL in enumerator {
                guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                let relative = BackupService.relativePath(of: file, under: existingRoot)
                let source = try BackupService.validatedRelativePath(relative, base: existingRoot)
                let live = try BackupService.validatedRelativePath(relative, base: root.rootURL)
                try? fileManager.removeItem(at: live)
                try copyFileAtomically(from: source, to: live)
            }
        }
    }

    @discardableResult
    static func recover(root: DataRoot, store: AtomicFileStore) throws -> Bool {
        let markerURL = root.rootURL.appendingPathComponent(BackupService.mergeMarkerName)
        guard let json = try? store.readJSON(markerURL) else { return false }
        guard json["state"]?.stringValue == "committing" else {
            try? FileManager.default.removeItem(at: markerURL)
            return false
        }
        guard let rollbackRel = json["rollback"]?.stringValue,
              !rollbackRel.isEmpty else {
            throw BackupError.mergeRecoveryFailed(
                "marker \(markerURL.path) has no rollback path; marker retained"
            )
        }
        guard let stagingRel = json["staging"]?.stringValue,
              !stagingRel.isEmpty else {
            throw BackupError.mergeRecoveryFailed(
                "marker \(markerURL.path) has no staging path; marker retained"
            )
        }
        let rollbackRoot = try BackupService.validatedRelativePath(rollbackRel, base: root.rootURL)
        let stagingRoot = try BackupService.validatedRelativePath(stagingRel, base: root.rootURL)
        var isDirectory: ObjCBool = false
        let rollbackExists = FileManager.default.fileExists(
            atPath: rollbackRoot.path,
            isDirectory: &isDirectory
        )
        guard rollbackExists, isDirectory.boolValue else {
            throw BackupError.mergeRecoveryFailed(
                "rollback directory is missing at \(rollbackRoot.path); marker retained"
            )
        }
        // If rollback throws, keep the marker so the next launch retries.
        do {
            try performRollback(root: root, rollbackRoot: rollbackRoot)
        } catch let error as BackupError {
            if case .invalidMarkerPath = error { throw error }
            throw BackupError.mergeRecoveryFailed(
                "rollback failed: \(error); tree kept at \(rollbackRoot.path); marker retained"
            )
        } catch {
            throw BackupError.mergeRecoveryFailed(
                "rollback failed: \(error); tree kept at \(rollbackRoot.path); marker retained"
            )
        }
        try? FileManager.default.removeItem(at: stagingRoot)
        try? FileManager.default.removeItem(at: markerURL)
        return true
    }
}

// MARK: - Replace transaction

/// Immutable-snapshot replace-all transaction.
///
/// The snapshot is a full copy taken before the marker is written. Each live
/// path the transaction will touch is recorded first; rollback restores only
/// those recorded paths, so files created by the user after the snapshot are
/// never deleted.
final class ReplaceTransaction {
    let root: DataRoot
    let snapshot: URL
    let stagingRoot: URL
    let markerURL: URL
    let journalURL: URL
    private let store: AtomicFileStore
    private var entries: [EntryRecord] = []

    struct EntryRecord: Equatable, Sendable {
        var path: String
        var existedBefore: Bool
    }

    init(root: DataRoot, stagingRoot: URL, store: AtomicFileStore) throws {
        self.root = root
        self.stagingRoot = stagingRoot
        self.store = store
        self.snapshot = root.snapshotsURL.appendingPathComponent(
            "replace-\(BackupService.fileTimestamp())-\(UUID().uuidString.prefix(6))",
            isDirectory: true
        )
        self.markerURL = root.rootURL.appendingPathComponent(BackupService.replaceMarkerName)
        self.journalURL = snapshot.appendingPathComponent("transaction.log")

        let fileManager = FileManager.default
        try fileManager.createDirectory(at: snapshot, withIntermediateDirectories: true)

        // Full copy of the live tree (including hidden files). The live root
        // is untouched until the snapshot is complete; a failed copy removes
        // the partial snapshot and leaves no marker behind.
        do {
            let topLevel = try fileManager.contentsOfDirectory(
                at: root.rootURL,
                includingPropertiesForKeys: nil,
                options: []
            )
            for item in topLevel where !DataRoot.internalRootNames.contains(item.lastPathComponent) {
                try fileManager.copyItem(
                    at: item,
                    to: snapshot.appendingPathComponent(item.lastPathComponent)
                )
            }
        } catch {
            try? fileManager.removeItem(at: snapshot)
            throw error
        }

        if !fileManager.fileExists(atPath: journalURL.path) {
            fileManager.createFile(atPath: journalURL.path, contents: Data())
        }
        // Marker is written only after the snapshot is complete.
        try writeMarker()
    }

    /// Journal `name` (or a deeper relative path) before mutating it. Entries
    /// are appended and fsynced one line at a time so a kill can lose at most
    /// the record currently being written.
    func record(relativePath: String) throws {
        let clean = relativePath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !clean.isEmpty else { return }
        if entries.contains(where: { $0.path == clean }) { return }
        let live = root.rootURL.appendingPathComponent(clean)
        let entry = EntryRecord(
            path: clean,
            existedBefore: FileManager.default.fileExists(atPath: live.path)
        )
        let line = JSONValue.object([
            JSONMember(key: "path", value: .string(entry.path)),
            JSONMember(key: "existedBefore", value: .bool(entry.existedBefore)),
        ]).serialized(pretty: false) + "\n"

        let handle = try FileHandle(forWritingTo: journalURL)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(line.utf8))
        try handle.synchronize()
        entries.append(entry)
    }

    func record(absoluteURL: URL) throws {
        try record(relativePath: BackupService.relativePath(of: absoluteURL, under: root.rootURL))
    }

    func finishSuccess() {
        try? FileManager.default.removeItem(at: markerURL)
    }

    func rollback() throws {
        try Self.performRollback(root: root, snapshot: snapshot, entries: entries)
        try? FileManager.default.removeItem(at: markerURL)
    }

    private func writeMarker() throws {
        let json = JSONValue.object([
            JSONMember(key: "state", value: .string("installing")),
            JSONMember(key: "snapshot", value: .string(snapshot.lastPathComponent)),
            JSONMember(key: "transaction", value: .string("transaction.log")),
            JSONMember(key: "startedAt", value: .string(GenerationJob.timestamp())),
        ])
        try store.writeJSON(json, to: markerURL)
    }

    static func performRollback(root: DataRoot, snapshot: URL, entries: [EntryRecord]) throws {
        let fileManager = FileManager.default
        for entry in entries.reversed() {
            let live = try BackupService.validatedRelativePath(entry.path, base: root.rootURL)
            if entry.existedBefore {
                let saved = try BackupService.validatedRelativePath(entry.path, base: snapshot)
                // Never delete a live item that is absent from the snapshot.
                guard fileManager.fileExists(atPath: saved.path) else { continue }
                if fileManager.fileExists(atPath: live.path) {
                    try fileManager.removeItem(at: live)
                }
                try fileManager.createDirectory(
                    at: live.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try fileManager.copyItem(at: saved, to: live)
            } else if fileManager.fileExists(atPath: live.path) {
                try fileManager.removeItem(at: live)
            }
        }
    }

    private static func performRecoveryRollback(
        root: DataRoot,
        snapshot: URL,
        entries: [EntryRecord]
    ) throws {
        do {
            try performRollback(root: root, snapshot: snapshot, entries: entries)
        } catch let error as BackupError {
            if case .invalidMarkerPath = error { throw error }
            throw BackupError.replaceRecoveryFailed(
                "rollback failed: \(error); snapshot kept at \(snapshot.path); marker retained"
            )
        } catch {
            throw BackupError.replaceRecoveryFailed(
                "rollback failed: \(error); snapshot kept at \(snapshot.path); marker retained"
            )
        }
    }

    @discardableResult
    static func recover(root: DataRoot, store: AtomicFileStore) throws -> Bool {
        let markerURL = root.rootURL.appendingPathComponent(BackupService.replaceMarkerName)
        guard let json = try? store.readJSON(markerURL),
              let snapshotName = json["snapshot"]?.stringValue else { return false }

        guard json["state"]?.stringValue == "installing" else {
            try? FileManager.default.removeItem(at: markerURL)
            return false
        }
        let snapshot = try BackupService.validatedRelativePath(snapshotName, base: root.snapshotsURL)
        var isDirectory: ObjCBool = false
        let snapshotExists = FileManager.default.fileExists(
            atPath: snapshot.path,
            isDirectory: &isDirectory
        )
        guard snapshotExists, isDirectory.boolValue else {
            throw BackupError.replaceRecoveryFailed(
                "snapshot is missing at \(snapshot.path); marker retained"
            )
        }

        let logURL = snapshot.appendingPathComponent("transaction.log")
        let legacyURL = snapshot.appendingPathComponent("transaction.json")

        if let logText = try? String(contentsOf: logURL, encoding: .utf8) {
            let entries = logText
                .split(separator: "\n", omittingEmptySubsequences: true)
                .compactMap { line -> EntryRecord? in
                    guard let value = try? JSONValue(parsing: String(line)),
                          let path = value["path"]?.stringValue,
                          let existed = value["existedBefore"]?.boolValue else { return nil }
                    return EntryRecord(path: path, existedBefore: existed)
                }
            try performRecoveryRollback(root: root, snapshot: snapshot, entries: entries)
        } else if let journalData = try? store.read(legacyURL),
                  let values = try? JSONValue(parsing: journalData).arrayValue {
            let entries = values.compactMap { value -> EntryRecord? in
                guard let path = value["path"]?.stringValue,
                      let existed = value["existedBefore"]?.boolValue else { return nil }
                return EntryRecord(path: path, existedBefore: existed)
            }
            try performRecoveryRollback(root: root, snapshot: snapshot, entries: entries)
        } else {
            // Conservative fallback: restore every snapshot item, but never
            // delete live items that are absent from the snapshot.
            let fileManager = FileManager.default
            for item in try fileManager.contentsOfDirectory(
                at: snapshot,
                includingPropertiesForKeys: nil,
                options: []
            ) where item.lastPathComponent != "transaction.log" && item.lastPathComponent != "transaction.json" {
                let live = try BackupService.validatedRelativePath(item.lastPathComponent, base: root.rootURL)
                if fileManager.fileExists(atPath: live.path) {
                    try fileManager.removeItem(at: live)
                }
                try fileManager.copyItem(at: item, to: live)
            }
        }
        try? FileManager.default.removeItem(at: markerURL)
        return true
    }
}

extension MergeTransaction: WriteJournal {}

extension ReplaceTransaction: WriteJournal {
    func record(_ url: URL) throws {
        try record(absoluteURL: url)
    }

    func didCommit(relative: String) throws {
        // Replace-all journals every file before it is touched; no separate
        // commit counter is needed.
    }
}

// MARK: - File helpers

private func copyFileAtomically(from source: URL, to destination: URL) throws {
    let fileManager = FileManager.default
    let directory = destination.deletingLastPathComponent()
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    let temp = directory.appendingPathComponent(
        ".\(destination.lastPathComponent).\(UUID().uuidString).tmp"
    )
    do {
        try fileManager.copyItem(at: source, to: temp)
        if fileManager.fileExists(atPath: destination.path) {
            _ = try fileManager.replaceItemAt(destination, withItemAt: temp)
        } else {
            try fileManager.moveItem(at: temp, to: destination)
        }
    } catch {
        try? fileManager.removeItem(at: temp)
        throw error
    }
}

extension BackupService {
    static func validatedRelativePath(_ raw: String, base: URL) throws -> URL {
        let clean = raw.replacingOccurrences(of: "\\", with: "/")
        guard !clean.isEmpty,
              !clean.hasPrefix("/"),
              clean.range(of: "^[A-Za-z]:", options: .regularExpression) == nil,
              !containsTraversal(clean) else {
            throw BackupError.invalidMarkerPath(raw)
        }
        do {
            return try PathValidator.safeJoin(base: base, components: [clean])
        } catch {
            throw BackupError.invalidMarkerPath(raw)
        }
    }

    func atomicCopy(from source: URL, to destination: URL) throws {
        try copyFileAtomically(from: source, to: destination)
    }

    func journaledCopy(from source: URL, to destination: URL, journal: any WriteJournal) throws {
        try journal.record(destination)
        try atomicCopy(from: source, to: destination)
        try journal.didCommit(relative: Self.relativePath(of: destination, under: root.rootURL))
    }

    func journaledWrite(_ data: Data, to destination: URL, journal: any WriteJournal) throws {
        try journal.record(destination)
        try store.write(data, to: destination)
        try journal.didCommit(relative: Self.relativePath(of: destination, under: root.rootURL))
    }

    func filesEqual(_ lhs: URL, _ rhs: URL) throws -> Bool {
        let lhsSize = (try? lhs.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
        let rhsSize = (try? rhs.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -2
        guard lhsSize == rhsSize else { return false }
        if lhsSize <= 4 * 1024 * 1024 {
            return try Data(contentsOf: lhs) == Data(contentsOf: rhs)
        }
        let lhsHandle = try FileHandle(forReadingFrom: lhs)
        let rhsHandle = try FileHandle(forReadingFrom: rhs)
        defer {
            try? lhsHandle.close()
            try? rhsHandle.close()
        }
        while true {
            let lhsChunk = try lhsHandle.read(upToCount: 1024 * 1024) ?? Data()
            let rhsChunk = try rhsHandle.read(upToCount: 1024 * 1024) ?? Data()
            if lhsChunk != rhsChunk { return false }
            if lhsChunk.isEmpty { return true }
        }
    }

    /// `_conflicts/<relative>` with an 8-character content hash before the
    /// extension. Local files stay untouched; the imported variant is kept.
    func conflictDestination(base: URL, relativePath: String, source: URL?) throws -> URL {
        let components = relativePath.split(separator: "/").map(String.init)
        guard let filename = components.last else {
            throw BackupError.importFailed("empty conflict path")
        }
        let directory = components.dropLast()
        let hash = source.map { Self.fileHash8($0) } ?? "import"
        let nsFilename = filename as NSString
        let ext = nsFilename.pathExtension
        let stem = nsFilename.deletingPathExtension
        let hashedName = ext.isEmpty ? "\(stem).\(hash)" : "\(stem).\(hash).\(ext)"
        let url = try PathValidator.safeJoin(
            base: base,
            components: directory + [hashedName]
        )
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        return url
    }

    static func containsTraversal(_ rawPath: String) -> Bool {
        let path = rawPath.replacingOccurrences(of: "\\", with: "/")
        if path.hasPrefix("/") { return true }
        if path.range(of: "^[A-Za-z]:", options: .regularExpression) != nil { return true }
        return path
            .split(separator: "/", omittingEmptySubsequences: false)
            .contains { $0 == ".." }
    }

    static func fileHash8(_ url: URL) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "unknown" }
        defer { try? handle.close() }
        while let chunk = try? handle.read(upToCount: 256 * 1024), !chunk.isEmpty {
            for byte in chunk {
                hash ^= UInt64(byte)
                hash = hash &* 0x100000001b3
            }
        }
        return String(hash, radix: 16).prefix(8).description
    }
}
