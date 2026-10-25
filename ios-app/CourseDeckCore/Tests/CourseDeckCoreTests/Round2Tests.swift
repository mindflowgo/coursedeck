import XCTest
import ZIPFoundation
@testable import CourseDeckCore

private struct InjectedFailure: Error {}

private final class TaskBox: @unchecked Sendable {
    var task: Task<Void, Error>?
    var error: Error?
}

final class Round2Tests: XCTestCase {
    private func writeCourseArchive(
        _ workspace: TestWorkspace,
        lessonBody: String = "REMOTE",
        summary: String? = "# Remote summary",
        extraEntries: [(String, Data)] = []
    ) async throws -> URL {
        try workspace.makeCourse(title: "Remote", lessonBody: lessonBody)
        if let summary {
            try workspace.write(summary, to: "courses/baf3m/01.01.summary.md")
        }
        let result = try await export(workspace, includeRaw: false)
        return result.archiveURL
    }

    private func export(
        _ workspace: TestWorkspace,
        includeRaw: Bool
    ) async throws -> BackupExportResult {
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        return try await service.exportBackup(
            options: BackupExportOptions(
                destinationDirectory: workspace.exportDirectory,
                includeRawPackages: includeRaw
            )
        )
    }

    // MARK: - Export lease and scan-vs-write race

    func testExportHoldsLeaseAndScansFinishedArchive() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write(#"{"theme":"dark"}"#, to: "settings.json")
        try workspace.write(#"{"version":1}"#, to: "llm_ios.json")

        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        var observedLease = false
        let result = try await service.exportBackup(
            options: BackupExportOptions(destinationDirectory: workspace.exportDirectory)
        ) { progress in
            observedLease = workspace.dataRoot.writeLease.isHeld
                && (workspace.dataRoot.writeLease.holder?.hasPrefix(BackupService.exportLeasePrefix) ?? false)
            // Mutate an ALREADY archived file. The finished-archive scan must
            // not be fooled because the archive already contains the old bytes.
            if progress.currentPath == "settings.json" {
                try workspace.write("token sk-abcdefghijklmnopqrstuvwxyz012345", to: "settings.json")
            }
        }
        XCTAssertTrue(observedLease)
        XCTAssertNil(try TestWorkspace.archiveContainsSecret(at: result.archiveURL))
        XCTAssertFalse(workspace.dataRoot.writeLease.isHeld)

        // Reset and mutate a file that has NOT been archived yet; the scan must
        // catch it in the archived bytes.
        try workspace.write(#"{"theme":"dark"}"#, to: "settings.json")
        do {
            _ = try await service.exportBackup(
                options: BackupExportOptions(destinationDirectory: workspace.exportDirectory)
            ) { progress in
                if progress.currentPath == "settings.json" {
                    try workspace.write("token sk-abcdefghijklmnopqrstuvwxyz012345", to: "llm_ios.json")
                }
            }
            XCTFail("expected secret detection")
        } catch let error as BackupError {
            guard case let .secretDetected(path, _) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertEqual(path, "llm_ios.json")
        }
    }

    // MARK: - Write lease / concurrent editor

    func testExportRemainsAvailableWhenFailClosedGateIsActive() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        workspace.dataRoot.writeGate.block(reason: "dataVersion is newer")
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let result = try await service.exportBackup(
            options: BackupExportOptions(destinationDirectory: workspace.exportDirectory)
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.archiveURL.path))
        XCTAssertFalse(workspace.dataRoot.writeLease.isHeld)
    }

    func testWriteLeaseBlocksRepositoryWritesUntilReleased() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repo = CourseRepository(root: workspace.dataRoot)

        try workspace.dataRoot.acquireWriteLease(owner: "test-holder")
        let semaphore = DispatchSemaphore(value: 0)
        let box = TaskBox()
        box.task = Task {
            do {
                _ = try await repo.saveTab(courseId: "baf3m", lessonId: "01.01", tab: "summary", content: "editor")
            } catch {
                box.error = error
            }
            semaphore.signal()
        }
        XCTAssertEqual(semaphore.wait(timeout: .now() + 0.2), .timedOut)
        workspace.dataRoot.releaseWriteLease(owner: "test-holder")
        XCTAssertEqual(semaphore.wait(timeout: .now() + 10), .success)
        try await box.task?.value
        XCTAssertNil(box.error)
        let content = try await repo.tabContent(courseId: "baf3m", lessonId: "01.01", tab: "summary")
        XCTAssertEqual(content, "editor")
    }

    func testConcurrentEditorIsBlockedForTheWholeMerge() async throws {
        let source = try TestWorkspace()
        let archiveURL = try await writeCourseArchive(source)

        let target = try TestWorkspace()
        try target.makeCourse(lessonBody: "LOCAL")
        let repo = CourseRepository(root: target.dataRoot)
        let service = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))

        let semaphore = DispatchSemaphore(value: 0)
        let box = TaskBox()
        var started = false

        _ = try await service.importBackup(from: archiveURL) { progress in
            if progress.phase == "Merge.commit", !started {
                started = true
                box.task = Task {
                    do {
                        _ = try await repo.saveTab(
                            courseId: "baf3m",
                            lessonId: "01.01",
                            tab: "cheatsheet",
                            content: "editor during import"
                        )
                    } catch {
                        box.error = error
                    }
                    semaphore.signal()
                }
                XCTAssertEqual(semaphore.wait(timeout: .now() + 0.2), .timedOut)
            }
        }

        XCTAssertEqual(semaphore.wait(timeout: .now() + 10), .success)
        try await box.task?.value
        XCTAssertNil(box.error)
        XCTAssertEqual(
            try target.readString("courses/baf3m/01.01.cheatsheet.md"),
            "editor during import"
        )
    }

    // MARK: - Merge journal / recovery

    func testMergeMarkerContainsStagingAndProgress() async throws {
        let source = try TestWorkspace()
        let archiveURL = try await writeCourseArchive(source)
        let target = try TestWorkspace()
        try target.makeCourse(lessonBody: "LOCAL")
        let service = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))

        var checked = false
        _ = try await service.importBackup(from: archiveURL) { progress in
            guard progress.phase == "Merge.commit", !checked else { return }
            checked = true
            let markerURL = target.url(".merge-in-progress.json")
            let marker = try JSONValue(parsing: Data(contentsOf: markerURL))
            XCTAssertEqual(marker["state"]?.stringValue, "committing")
            XCTAssertTrue(marker["staging"]?.stringValue?.hasPrefix(".staging/") == true)
            XCTAssertNotNil(marker["rollback"]?.stringValue)
            XCTAssertNotNil(marker["progress"]?["committed"]?.intValue)
        }
        XCTAssertTrue(checked)
        XCTAssertFalse(target.exists(".merge-in-progress.json"))
    }

    func testMergeFailureRollsBackImportedFiles() async throws {
        let source = try TestWorkspace()
        let archiveURL = try await writeCourseArchive(source)
        let target = try TestWorkspace()
        try target.makeCourse(title: "Local Title", lessonBody: "LOCAL")
        let service = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))

        do {
            _ = try await service.importBackup(from: archiveURL) { progress in
                if progress.phase == "Merge.commit" {
                    throw InjectedFailure()
                }
            }
            XCTFail("expected injected failure")
        } catch is InjectedFailure {}

        XCTAssertEqual(try target.readString("courses/baf3m/01.01.lesson.md"), "LOCAL")
        XCTAssertFalse(target.exists("courses/baf3m/01.01.summary.md"))
        let manifest = try await CourseRepository(root: target.dataRoot).course(courseId: "baf3m")
        XCTAssertEqual(manifest?.title, "Local Title")
        XCTAssertFalse(target.exists(".merge-in-progress.json"))
    }

    func testLaunchRecoveryRollsBackMergeUsingJournal() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse(lessonBody: "ORIGINAL")
        try workspace.write("new file", to: "courses/baf3m/created.md")

        try workspace.write("ORIGINAL", to: ".staging/merge-manual/.rollback/existing/courses/baf3m/01.01.lesson.md")
        try workspace.write("", to: ".staging/merge-manual/.rollback/created/courses/baf3m/new.md")
        try workspace.write("MERGED", to: "courses/baf3m/01.01.lesson.md")
        try workspace.write("brand new", to: "courses/baf3m/new.md")
        try workspace.write(
            """
            {
              "state": "committing",
              "staging": ".staging/merge-manual",
              "rollback": ".staging/merge-manual/.rollback",
              "progress": {"committed": 1, "lastPath": "courses/baf3m/meta.json"},
              "startedAt": "2026-01-01T00:00:00.000Z"
            }
            """,
            to: ".merge-in-progress.json"
        )

        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let recovered = try await service.recoverInterruptedOperations()

        XCTAssertTrue(recovered.merge)
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.lesson.md"), "ORIGINAL")
        XCTAssertFalse(workspace.exists("courses/baf3m/new.md"))
        XCTAssertFalse(workspace.exists(".merge-in-progress.json"))
        XCTAssertFalse(workspace.exists(".staging/merge-manual"))
    }

    // MARK: - Replace transaction / recovery

    func testReplaceFailureRollsBackAndPreservesLiveOnlyFiles() async throws {
        let source = try TestWorkspace()
        let archiveURL = try await writeCourseArchive(source, lessonBody: "REMOTE")

        let target = try TestWorkspace()
        try target.makeCourse(lessonBody: "LOCAL")
        try target.write("user data", to: "user-note.txt")
        let service = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))

        do {
            _ = try await service.importBackup(
                from: archiveURL,
                options: BackupImportOptions(mode: .replaceAll)
            ) { progress in
                if progress.phase == "Replace.install" {
                    throw InjectedFailure()
                }
            }
            XCTFail("expected injected failure")
        } catch is InjectedFailure {}

        XCTAssertEqual(try target.readString("courses/baf3m/01.01.lesson.md"), "LOCAL")
        XCTAssertEqual(try target.readString("user-note.txt"), "user data")
        XCTAssertFalse(target.exists(".replace-in-progress.json"))
        let snapshots = try FileManager.default.contentsOfDirectory(
            at: target.dataRoot.snapshotsURL,
            includingPropertiesForKeys: nil
        )
        XCTAssertFalse(snapshots.isEmpty)
    }

    func testReplaceMarkerIsWrittenAfterSnapshotIsComplete() async throws {
        let source = try TestWorkspace()
        let archiveURL = try await writeCourseArchive(source, lessonBody: "REMOTE")
        let target = try TestWorkspace()
        try target.makeCourse(lessonBody: "LOCAL")
        let service = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))

        var markerAtStaging = false
        var snapshotWasComplete = false
        _ = try await service.importBackup(
            from: archiveURL,
            options: BackupImportOptions(mode: .replaceAll)
        ) { progress in
            if progress.phase == "Import" {
                markerAtStaging = markerAtStaging || target.exists(".replace-in-progress.json")
            }
            if progress.phase == "Replace.install", !snapshotWasComplete {
                let marker = try JSONValue(parsing: Data(contentsOf: target.url(".replace-in-progress.json")))
                let snapshotName = try XCTUnwrap(marker["snapshot"]?.stringValue)
                let snapshotLesson = target.url(".snapshots/\(snapshotName)/courses/baf3m/01.01.lesson.md")
                XCTAssertEqual(try String(contentsOf: snapshotLesson, encoding: .utf8), "LOCAL")
                XCTAssertEqual(snapshotName.hasPrefix("replace-"), true)
                snapshotWasComplete = true
            }
        }
        XCTAssertFalse(markerAtStaging)
        XCTAssertTrue(snapshotWasComplete)
    }

    func testLaunchRecoveryRestoresReplaceSnapshotWithoutDeletingLiveOnlyFiles() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse(lessonBody: "ORIGINAL")
        try workspace.write("NEW", to: "courses/baf3m/01.01.lesson.md")
        try workspace.write("created by import", to: "courses/baf3m/created.md")
        try workspace.write("user data", to: "user-note.txt")
        try workspace.write(#"[{"id":"original","status":"queued"}]"#, to: ".jobs.json")
        try workspace.write(#"[{"id":"merged","status":"running"}]"#, to: ".jobs.json")

        // Immutable snapshot + transaction journal, as a killed install leaves it.
        try workspace.write("ORIGINAL", to: ".snapshots/replace-manual/courses/baf3m/01.01.lesson.md")
        try workspace.write(
            #"[{"id":"original","status":"queued"}]"#,
            to: ".snapshots/replace-manual/.jobs.json"
        )
        try workspace.write(
            """
            [
              {"path": "courses", "existedBefore": true},
              {"path": "courses/baf3m/created.md", "existedBefore": false},
              {"path": ".jobs.json", "existedBefore": true}
            ]
            """,
            to: ".snapshots/replace-manual/transaction.json"
        )
        try workspace.write(
            #"{"state":"installing","snapshot":"replace-manual","transaction":"transaction.json"}"#,
            to: ".replace-in-progress.json"
        )

        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let recovered = try await service.recoverInterruptedOperations()

        XCTAssertTrue(recovered.replace)
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.lesson.md"), "ORIGINAL")
        XCTAssertFalse(workspace.exists("courses/baf3m/created.md"))
        XCTAssertEqual(try workspace.readString("user-note.txt"), "user data")
        XCTAssertEqual(try workspace.readString(".jobs.json"), #"[{"id":"original","status":"queued"}]"#)
        XCTAssertFalse(workspace.exists(".replace-in-progress.json"))
    }

    // MARK: - Import staging and scanning

    func testInterruptedImportLeavesNoStagingAndStaleStagingIsCleaned() async throws {
        let source = try TestWorkspace()
        let archiveURL = try await writeCourseArchive(source)
        let target = try TestWorkspace()
        try target.makeCourse(lessonBody: "LOCAL")
        let service = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))

        do {
            _ = try await service.importBackup(from: archiveURL) { progress in
                if progress.phase == "Import", progress.current == 1 {
                    throw InjectedFailure()
                }
            }
            XCTFail("expected injected failure")
        } catch is InjectedFailure {}

        XCTAssertTrue(
            try FileManager.default.contentsOfDirectory(at: target.dataRoot.stagingURL, includingPropertiesForKeys: nil).isEmpty
        )
        XCTAssertEqual(try target.readString("courses/baf3m/01.01.lesson.md"), "LOCAL")

        try target.write("stale", to: ".staging/stale/file.txt")
        _ = try await service.recoverInterruptedOperations()
        XCTAssertFalse(target.exists(".staging/stale/file.txt"))
    }

    func testStreamingScanNeverStagesSecretBytes() async throws {
        let workspace = try TestWorkspace()
        let archiveURL = workspace.baseURL.appendingPathComponent("secret-course.zip")
        let manifest = CourseManifest(
            id: "baf3m",
            title: "T",
            units: [CourseUnit(number: 1, title: "U", lessons: [
                CourseLesson(id: "01.01", title: "One", unitNumber: 1, lessonNumber: 1, hasFull: true),
            ])]
        )
        try TestWorkspace.makeZip(
            entries: [
                ("courses/baf3m/meta.json", manifest.encoded()),
                ("courses/baf3m/01.01.lesson.md", Data("# lesson".utf8)),
                ("courses/baf3m/01.01.summary.md", Data("sk-abcdefghijklmnopqrstuvwxyz012345".utf8)),
            ],
            at: archiveURL
        )
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let result = try await service.importBackup(from: archiveURL)

        XCTAssertFalse(workspace.exists("courses/baf3m/01.01.summary.md"))
        XCTAssertTrue(result.report.quarantined.contains { $0.contains("01.01.summary.md") })
        XCTAssertTrue(
            try FileManager.default.contentsOfDirectory(at: workspace.dataRoot.stagingURL, includingPropertiesForKeys: nil).isEmpty
        )
    }

    func testEncodedMHTMLSecretsAreDetectedOnExportAndImport() async throws {
        let secretText = "api key sk-abcdefghijklmnopqrstuvwxyz012345"
        let base64 = Data(secretText.utf8).base64EncodedString()
        let mhtml = """
        MIME-Version: 1.0
        Content-Type: multipart/related; boundary="BOUND"

        --BOUND
        Content-Type: text/plain; charset=utf-8
        Content-Transfer-Encoding: base64

        \(base64)
        --BOUND
        Content-Type: text/plain
        Content-Transfer-Encoding: quoted-printable

        key=3Dsk-abcdefghijklmnopqrstuvwxyz012345
        --BOUND--
        """

        let source = try TestWorkspace()
        try source.makeCourse()
        try source.write(mhtml, to: "courses/baf3m/_backup/capture.mhtml")
        do {
            _ = try await export(source, includeRaw: true)
            XCTFail("expected encoded MHTML secret detection")
        } catch let error as BackupError {
            guard case let .secretDetected(path, _) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertTrue(path.contains("capture.mhtml"))
        }

        let manifest = CourseManifest(
            id: "baf3m",
            title: "T",
            units: [CourseUnit(number: 1, title: "U", lessons: [
                CourseLesson(id: "01.01", title: "One", unitNumber: 1, lessonNumber: 1, hasFull: true),
            ])]
        )
        let archiveURL = source.baseURL.appendingPathComponent("mhtml-course.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("courses/baf3m/meta.json", manifest.encoded()),
                ("courses/baf3m/01.01.lesson.md", Data("# lesson".utf8)),
                ("courses/baf3m/_backup/capture.mhtml", Data(mhtml.utf8)),
            ],
            at: archiveURL
        )
        let target = try TestWorkspace()
        let service = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let result = try await service.importBackup(
            from: archiveURL,
            options: BackupImportOptions(includeRawPackages: true)
        )
        XCTAssertFalse(target.exists("courses/baf3m/_backup/capture.mhtml"))
        XCTAssertTrue(result.report.quarantined.contains { $0.contains("capture.mhtml") })
    }

    // MARK: - Archive dataVersion preflight and bounded entries

    func testNewerOrCorruptArchiveDataVersionIsRejectedBeforeStaging() async throws {
        let manifest = CourseManifest(
            id: "baf3m",
            title: "T",
            units: [CourseUnit(number: 1, title: "U", lessons: [
                CourseLesson(id: "01.01", title: "One", unitNumber: 1, lessonNumber: 1, hasFull: true),
            ])]
        )
        let workspace = try TestWorkspace()
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))

        let newerURL = workspace.baseURL.appendingPathComponent("version-99.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("dataVersion.json", Data(#"{"version":99,"appVersion":"x","migratedAt":"x"}"#.utf8)),
                ("courses/baf3m/meta.json", manifest.encoded()),
            ],
            at: newerURL
        )
        do {
            _ = try await service.importBackup(from: newerURL)
            XCTFail("expected newer data version rejection")
        } catch let error as BackupError {
            guard case .dataVersionIncompatible = error else {
                return XCTFail("wrong error \(error)")
            }
        }
        XCTAssertFalse(workspace.exists("courses/baf3m"))

        // An older archive version is acceptable: the local migrator upgrades.
        let olderURL = workspace.baseURL.appendingPathComponent("version-1.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("dataVersion.json", Data(#"{"version":1,"appVersion":"x","migratedAt":"x"}"#.utf8)),
                ("courses/baf3m/meta.json", manifest.encoded()),
            ],
            at: olderURL
        )
        _ = try await service.importBackup(from: olderURL)
        XCTAssertTrue(workspace.exists("courses/baf3m/meta.json"))
        try FileManager.default.removeItem(at: workspace.url("courses/baf3m"))

        let corruptURL = workspace.baseURL.appendingPathComponent("version-corrupt.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("dataVersion.json", Data("{ bad".utf8)),
                ("courses/baf3m/meta.json", manifest.encoded()),
            ],
            at: corruptURL
        )
        do {
            _ = try await service.importBackup(from: corruptURL)
            XCTFail("expected corrupt data version rejection")
        } catch let error as BackupError {
            guard case .dataVersionIncompatible = error else {
                return XCTFail("wrong error \(error)")
            }
        }
        XCTAssertFalse(workspace.exists("courses/baf3m"))
        XCTAssertTrue(
            try FileManager.default.contentsOfDirectory(at: workspace.dataRoot.stagingURL, includingPropertiesForKeys: nil).isEmpty
        )
    }

    func testManyEntryArchiveIsRejectedBeforeMaterializing() async throws {
        let workspace = try TestWorkspace()
        let archiveURL = workspace.baseURL.appendingPathComponent("many.zip")
        var entries: [(String, Data)] = []
        for index in 0..<6 {
            entries.append(("courses/baf3m/file\(index).md", Data("x".utf8)))
        }
        try TestWorkspace.makeZip(entries: entries, at: archiveURL)
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        do {
            _ = try await service.importBackup(
                from: archiveURL,
                options: BackupImportOptions(limits: BackupLimits(maxEntries: 5))
            )
            XCTFail("expected entry-limit rejection")
        } catch let error as BackupError {
            guard case .zipBomb = error else { return XCTFail("wrong error \(error)") }
        }
        XCTAssertTrue(
            try FileManager.default.contentsOfDirectory(at: workspace.dataRoot.stagingURL, includingPropertiesForKeys: nil).isEmpty
        )

        // The nested scanner uses the same capped iterator.
        let nestedURL = workspace.baseURL.appendingPathComponent("nested-many.zip")
        try TestWorkspace.makeZip(
            entries: (0..<4).map { ("part\($0).md", Data("x".utf8)) },
            at: nestedURL
        )
        let scanner = SecretScanner(limits: .init(maxNestedEntries: 2, maxNestedUncompressedBytes: 1024))
        XCTAssertThrowsError(try scanner.scanFile(at: nestedURL))
    }

    // MARK: - Local config corruption

    func testCorruptLocalLlmConfigAbortsImportWithBackup() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write("{ bad config", to: "llm_config.json")

        let archiveURL = workspace.baseURL.appendingPathComponent("config.zip")
        let manifest = CourseManifest(
            id: "baf3m",
            title: "T",
            units: [CourseUnit(number: 1, title: "U", lessons: [
                CourseLesson(id: "01.01", title: "One", unitNumber: 1, lessonNumber: 1, hasFull: true),
            ])]
        )
        try TestWorkspace.makeZip(
            entries: [
                ("courses/baf3m/meta.json", manifest.encoded()),
                ("llm_config.json", Data(makeLlmConfigJSON().utf8)),
            ],
            at: archiveURL
        )

        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        do {
            _ = try await service.importBackup(from: archiveURL)
            XCTFail("expected corrupt local config abort")
        } catch let error as BackupError {
            guard case .importFailed = error else { return XCTFail("wrong error \(error)") }
        }
        XCTAssertTrue(workspace.exists("llm_config.json.bak"))
        XCTAssertFalse(workspace.exists("llm_config.json"))
        XCTAssertFalse(workspace.exists("courses/baf3m/02.01.summary.md"))
    }

    // MARK: - Conflicts, raw packages

    func testPromptConflictRoundtripThroughRootConflicts() async throws {
        let source = try TestWorkspace()
        try source.write("# Summary\n\nSOURCE", to: "prompts/summary.md")
        let exported = try await export(source, includeRaw: false)

        let target = try TestWorkspace()
        try target.write("# Summary\n\nTARGET", to: "prompts/summary.md")
        let service = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let imported = try await service.importBackup(from: exported.archiveURL)
        XCTAssertTrue(imported.report.conflicts.contains("prompts/summary.md"))

        let conflicts = try FileManager.default.contentsOfDirectory(
            at: target.url("_conflicts/prompts"),
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(conflicts.count, 1)
        let conflictName = conflicts[0].lastPathComponent
        XCTAssertTrue(conflictName.hasPrefix("summary."))
        XCTAssertEqual(try String(contentsOf: conflicts[0], encoding: .utf8), "# Summary\n\nSOURCE")

        // The conflict travels with the next export and lands on a fresh app.
        let targetExport = try await export(target, includeRaw: false)
        let paths = try TestWorkspace.archivePaths(at: targetExport.archiveURL)
        XCTAssertTrue(paths.contains { $0.hasPrefix("_conflicts/prompts/summary.") })

        let fresh = try TestWorkspace()
        let freshService = BackupService(root: fresh.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        _ = try await freshService.importBackup(from: targetExport.archiveURL)
        XCTAssertEqual(
            try fresh.readString("_conflicts/prompts/\(conflictName)"),
            "# Summary\n\nSOURCE"
        )
    }

    func testLocalRawPackagesMergeWithArchiveMaterialAndStayExcluded() async throws {
        let source = try TestWorkspace()
        try source.makeCourse()
        try TestWorkspace.makeZip(
            entries: [("remote.md", Data("remote".utf8))],
            at: source.url("courses/baf3m/_backup/remote.zip")
        )
        let exported = try await export(source, includeRaw: true)

        let target = try TestWorkspace()
        try target.makeCourse()
        try TestWorkspace.makeZip(
            entries: [("local.md", Data("local".utf8))],
            at: target.url("courses/baf3m/_backup/local.zip")
        )
        let service = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        _ = try await service.importBackup(
            from: exported.archiveURL,
            options: BackupImportOptions(includeRawPackages: true)
        )
        XCTAssertTrue(target.exists("courses/baf3m/_backup/local.zip"))
        XCTAssertTrue(target.exists("courses/baf3m/_backup/remote.zip"))

        let replaceTarget = try TestWorkspace()
        try replaceTarget.makeCourse()
        try TestWorkspace.makeZip(
            entries: [("local.md", Data("local".utf8))],
            at: replaceTarget.url("courses/baf3m/_backup/local.zip")
        )
        let replaceService = BackupService(root: replaceTarget.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        _ = try await replaceService.importBackup(
            from: exported.archiveURL,
            options: BackupImportOptions(mode: .replaceAll, includeRawPackages: true)
        )
        XCTAssertTrue(replaceTarget.exists("courses/baf3m/_backup/local.zip"))
        XCTAssertTrue(replaceTarget.exists("courses/baf3m/_backup/remote.zip"))
        XCTAssertTrue(replaceTarget.dataRoot.isExcludedFromBackup(replaceTarget.url("courses/baf3m/_backup")))
    }

    // MARK: - Validation, anchors, jobs

    func testInvalidCheckpointAndManifestEntriesGoToConflicts() async throws {
        let manifestJSON = """
        {
          "id": "baf3m",
          "title": "Remote",
          "units": [
            {
              "number": 1,
              "title": "Unit 1",
              "lessons": [
                {"id": "01.01", "title": "One", "unitNumber": 1, "lessonNumber": 1, "type": "lesson", "hasFull": true},
                {"id": "../evil", "title": "Bad", "unitNumber": 1, "lessonNumber": 2, "type": "lesson"}
              ]
            }
          ]
        }
        """
        let checkpointsJSON = """
        [
          {"id": "ok", "file": "01.01.lesson.md", "verticalPosition": 10, "type": "position", "date": "x"},
          {"id": "bad", "file": "../evil.md", "verticalPosition": 20, "type": "position", "date": "x"}
        ]
        """
        let workspace = try TestWorkspace()
        let archiveURL = workspace.baseURL.appendingPathComponent("invalid.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("courses/baf3m/meta.json", Data(manifestJSON.utf8)),
                ("courses/baf3m/01.01.lesson.md", Data("# lesson".utf8)),
                ("courses/baf3m/checkpoint.json", Data(checkpointsJSON.utf8)),
            ],
            at: archiveURL
        )
        try workspace.makeCourse()
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        _ = try await service.importBackup(from: archiveURL)

        let document = try await CheckpointRepository(root: workspace.dataRoot).read(courseId: "baf3m")
        XCTAssertEqual(document.checkpoints.count, 1)
        XCTAssertEqual(document.checkpoints[0].file, "01.01.lesson.md")
        XCTAssertTrue(document.passthrough.isEmpty)

        let manifest = try await CourseRepository(root: workspace.dataRoot).course(courseId: "baf3m")
        XCTAssertEqual(manifest?.allLessons.map(\.id), ["01.01"])

        let conflicts = try FileManager.default.contentsOfDirectory(
            at: workspace.url("courses/baf3m/_conflicts"),
            includingPropertiesForKeys: nil
        ).map(\.lastPathComponent)
        XCTAssertTrue(conflicts.contains { $0.hasPrefix("checkpoint-invalid-raw-") })
        XCTAssertTrue(conflicts.contains { $0.hasPrefix("manifest-invalid-") })

        // Re-validation on read: a local traversal-like entry is passthrough.
        try workspace.write(
            #"[{"id":"x","file":"../evil.md","verticalPosition":1,"type":"position","date":"x"}]"#,
            to: "courses/baf3m/checkpoint.json"
        )
        let revalidated = try await CheckpointRepository(root: workspace.dataRoot).read(courseId: "baf3m")
        XCTAssertTrue(revalidated.checkpoints.isEmpty)
        XCTAssertEqual(revalidated.passthrough.count, 1)
    }

    func testAnchorMigrationNormalizesAnchorFieldsAtVersionTwo() throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write(
            """
            [
              {"id":"a","file":"01.01.lesson.md","verticalPosition":12,"type":"position","date":"x","anchorBlockID":"h:a"},
              {"id":"b","file":"01.01.summary.md","verticalPosition":20,"type":"position","date":"x","anchorBlockID":"","anchorFraction":0.5}
            ]
            """,
            to: "courses/baf3m/checkpoint.json"
        )
        let status = DataVersionStore(root: workspace.dataRoot).loadAndMigrate()
        guard case let .supported(record) = status else { return XCTFail("expected supported") }
        XCTAssertEqual(record.version, 2)

        let entries = try XCTUnwrap(try workspace.readJSON("courses/baf3m/checkpoint.json").arrayValue)
        XCTAssertEqual(entries[0]["verticalPosition"]?.doubleValue, 12)
        XCTAssertEqual(entries[0]["anchorFraction"]?.doubleValue, 0)
        XCTAssertNil(entries[1]["anchorBlockID"])
        XCTAssertNil(entries[1]["anchorFraction"])
    }

    func testUnknownJobStatusBecomesInterruptedAndWriteGateBlocksRecovery() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            """
            [
              {"id":"baf3m:01.01:summary","courseId":"baf3m","tab":"summary","status":"exploded"},
              {"id":"baf3m:01.01:test","courseId":"baf3m","tab":"test"}
            ]
            """,
            to: ".jobs.json"
        )
        let store = JobStore(root: workspace.dataRoot)
        let jobs = await store.allJobs()
        XCTAssertEqual(jobs.map(\.status), [.interrupted, .interrupted])

        workspace.dataRoot.writeGate.block(reason: "newer data")
        do {
            _ = try await store.recoverInterrupted()
            XCTFail("expected blocked write")
        } catch let error as WriteBlockedError {
            XCTAssertTrue(error.reason.contains("newer"))
        }
        do {
            _ = try await store.pruneTerminal(olderThan: Date())
            XCTFail("expected blocked write")
        } catch let error as WriteBlockedError {
            XCTAssertTrue(error.reason.contains("newer"))
        }
    }
}
