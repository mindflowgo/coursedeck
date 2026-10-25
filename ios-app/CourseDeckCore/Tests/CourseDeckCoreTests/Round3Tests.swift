import XCTest
import ZIPFoundation
@testable import CourseDeckCore

private final class Round3TaskBox: @unchecked Sendable {
    var task: Task<Void, Error>?
    var error: Error?
}

final class Round3Tests: XCTestCase {
    private func makeManifest(units: [(Int, [(String, String)])]) -> CourseManifest {
        CourseManifest(
            id: "baf3m",
            title: "Remote",
            units: units.map { number, lessons in
                CourseUnit(
                    number: number,
                    title: "Unit \(number)",
                    lessons: lessons.enumerated().map { index, pair in
                        CourseLesson(
                            id: pair.0,
                            title: pair.1,
                            unitNumber: number,
                            lessonNumber: index + 1,
                            type: .lesson,
                            hasFull: true
                        )
                    }
                )
            }
        )
    }

    private func makeDeflatedZip(entries: [(String, Data)], at url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let archive = try Archive(url: url, accessMode: .create)
        for entry in entries {
            let data = entry.1
            try archive.addEntry(
                with: entry.0,
                type: .file,
                uncompressedSize: Int64(data.count),
                compressionMethod: .deflate,
                provider: { position, size in
                    let start = Int(position)
                    let end = min(start + size, data.count)
                    guard start <= end else { return Data() }
                    return data.subdata(in: start..<end)
                }
            )
        }
    }

    // MARK: - Staged nested archive scan

    func testStagedZipWithNestedSecretIsQuarantined() async throws {
        let workspace = try TestWorkspace()
        let secret = Data("sk-abcdefghijklmnopqrstuvwxyz012345".utf8)

        let innerURL = workspace.baseURL.appendingPathComponent("inner.zip")
        try makeDeflatedZip(entries: [("inner/secret.md", secret)], at: innerURL)
        let innerData = try Data(contentsOf: innerURL)

        let outerURL = workspace.baseURL.appendingPathComponent("outer.zip")
        try makeDeflatedZip(
            entries: [
                ("direct/secret.md", secret),
                ("nested.zip", innerData),
            ],
            at: outerURL
        )
        let outerData = try Data(contentsOf: outerURL)

        let manifest = makeManifest(units: [(1, [("01.01", "One")])])
        let archiveURL = workspace.baseURL.appendingPathComponent("nested-secret-backup.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("courses/baf3m/meta.json", manifest.encoded()),
                ("courses/baf3m/01.01.lesson.md", Data("# lesson".utf8)),
                ("courses/baf3m/_backup/pkg.zip", outerData),
            ],
            at: archiveURL
        )

        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let result = try await service.importBackup(
            from: archiveURL,
            options: BackupImportOptions(includeRawPackages: true)
        )

        XCTAssertTrue(workspace.exists("courses/baf3m/01.01.lesson.md"))
        XCTAssertFalse(workspace.exists("courses/baf3m/_backup/pkg.zip"))
        XCTAssertTrue(
            result.report.quarantined.contains { $0.contains("_backup/pkg.zip") },
            "report: \(result.report.quarantined)"
        )
    }

    // MARK: - Lease ownership

    func testSecondBackupServiceBlocksUntilFirstReleasesLease() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let firstService = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let secondService = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let secondDestination = workspace.baseURL.appendingPathComponent("Export2", isDirectory: true)

        let semaphore = DispatchSemaphore(value: 0)
        let box = Round3TaskBox()
        var started = false

        let first = try await firstService.exportBackup(
            options: BackupExportOptions(destinationDirectory: workspace.exportDirectory)
        ) { progress in
            if progress.current == 1, !started {
                started = true
                box.task = Task {
                    do {
                        _ = try await secondService.exportBackup(
                            options: BackupExportOptions(destinationDirectory: secondDestination)
                        )
                    } catch {
                        box.error = error
                    }
                    semaphore.signal()
                }
                XCTAssertEqual(semaphore.wait(timeout: .now() + 0.2), .timedOut)
            }
        }

        XCTAssertEqual(semaphore.wait(timeout: .now() + 15), .success)
        try await box.task?.value
        XCTAssertNil(box.error)
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.archiveURL.path))
        let secondArchives = try FileManager.default.contentsOfDirectory(
            at: secondDestination,
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(secondArchives.count, 1)
        XCTAssertFalse(workspace.dataRoot.writeLease.isHeld)
    }

    // MARK: - Read-modify-write leases

    func testConcurrentImportAndPatchManifestPreservesImportedUnits() async throws {
        let manifest = makeManifest(units: [
            (1, [("01.01", "One")]),
            (2, [("02.01", "Two")]),
        ])
        let workspace = try TestWorkspace()
        let archiveURL = workspace.baseURL.appendingPathComponent("unit2.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("courses/baf3m/meta.json", manifest.encoded()),
                ("courses/baf3m/01.01.lesson.md", Data("# one".utf8)),
                ("courses/baf3m/02.01.summary.md", Data("# two summary".utf8)),
            ],
            at: archiveURL
        )
        try workspace.makeCourse(title: "Local", lessonBody: "LOCAL")

        let repository = CourseRepository(root: workspace.dataRoot)
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let semaphore = DispatchSemaphore(value: 0)
        let box = Round3TaskBox()
        var started = false

        _ = try await service.importBackup(from: archiveURL) { progress in
            if progress.phase == "Merge.commit", !started {
                started = true
                box.task = Task {
                    do {
                        _ = try await repository.patchManifest(
                            courseId: "baf3m",
                            patch: CourseRepository.ManifestPatch(title: "Patched")
                        )
                    } catch {
                        box.error = error
                    }
                    semaphore.signal()
                }
                XCTAssertEqual(semaphore.wait(timeout: .now() + 0.2), .timedOut)
            }
        }

        XCTAssertEqual(semaphore.wait(timeout: .now() + 15), .success)
        try await box.task?.value
        XCTAssertNil(box.error)

        let updated = try await repository.course(courseId: "baf3m")
        XCTAssertEqual(updated?.title, "Patched")
        XCTAssertEqual(updated?.units.map(\.number), [1, 2])
        XCTAssertNotNil(updated?.allLessons.first(where: { $0.id == "02.01" }))
        XCTAssertTrue(workspace.exists("courses/baf3m/02.01.summary.md"))
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.lesson.md"), "LOCAL")
    }

    // MARK: - Rollback failures and recovery

    func testMergeRecoveryFailsWhenRollbackDirectoryIsMissing() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            """
            {
              "state": "committing",
              "staging": ".staging/missing",
              "rollback": ".staging/missing/.rollback",
              "progress": {"committed": 0, "lastPath": ""},
              "startedAt": "2026-01-01T00:00:00.000Z"
            }
            """,
            to: ".merge-in-progress.json"
        )
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        do {
            _ = try await service.recoverInterruptedOperations()
            XCTFail("expected missing rollback failure")
        } catch let error as BackupError {
            guard case let .mergeRecoveryFailed(reason) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertTrue(reason.contains("rollback directory is missing"))
        }
        XCTAssertTrue(workspace.exists(".merge-in-progress.json"))
    }

    func testFailedMergeRollbackKeepsTreeAndMarker() async throws {
        let workspace = try TestWorkspace()
        // A file where rollback needs a directory forces copy/create failure.
        try workspace.write("blocking file", to: "blocked")
        try workspace.write(
            "ORIGINAL",
            to: ".staging/merge-bad/.rollback/existing/blocked/child.txt"
        )
        try workspace.write(
            """
            {
              "state": "committing",
              "staging": ".staging/merge-bad",
              "rollback": ".staging/merge-bad/.rollback",
              "progress": {"committed": 1, "lastPath": "blocked/child.txt"},
              "startedAt": "2026-01-01T00:00:00.000Z"
            }
            """,
            to: ".merge-in-progress.json"
        )

        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        do {
            _ = try await service.recoverInterruptedOperations()
            XCTFail("expected recovery failure")
        } catch let error as BackupError {
            guard case let .mergeRecoveryFailed(reason) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertTrue(reason.contains("rollback"))
            XCTAssertTrue(reason.contains(".staging/merge-bad/.rollback"))
        }
        XCTAssertTrue(workspace.exists(".merge-in-progress.json"))
        XCTAssertTrue(workspace.exists(".staging/merge-bad/.rollback/existing/blocked/child.txt"))
    }

    // MARK: - Audit under fail-closed gate

    func testAuditRunsWhenGateIsBlockedAndExportReportsIt() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        workspace.dataRoot.writeGate.block(reason: "newer data version")

        let tokenURL = workspace.documentsURL.appendingPathComponent(".mcp-token")
        try Data("token".utf8).write(to: tokenURL)
        let audit = ImportInboxAudit(
            root: workspace.dataRoot,
            keyMigrator: KeyMigrator(secretStore: InMemorySecretStore())
        )
        let auditReport = await audit.auditDocumentsTree()
        XCTAssertFalse(auditReport.wasSkipped)
        XCTAssertNil(auditReport.failure)
        XCTAssertTrue(auditReport.quarantined.contains(".mcp-token"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: tokenURL.path))

        try Data("token2".utf8).write(to: tokenURL)
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let result = try await service.exportBackup(
            options: BackupExportOptions(destinationDirectory: workspace.exportDirectory)
        )
        XCTAssertFalse(result.report.inboxAudit?.wasSkipped ?? true)
        XCTAssertTrue(
            result.report.inboxAudit?.quarantined.contains { $0.contains(".mcp-token") } ?? false,
            "audit report: \(String(describing: result.report.inboxAudit))"
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: tokenURL.path))
    }

    // MARK: - Free space calculation

    func testReplaceRequiredSpaceIncludesStagedBytes() {
        let library: UInt64 = 1_000_000
        let staged: UInt64 = 100_000_000
        let headroom: UInt64 = 1_000_000

        let replace = BackupService.requiredSpace(
            mode: .replaceAll,
            libraryBytes: library,
            stagedBytes: staged,
            headroomBytes: headroom
        )
        XCTAssertEqual(replace, Int64(library + staged + headroom))
        XCTAssertGreaterThan(replace, Int64(library * 4))

        let merge = BackupService.requiredSpace(
            mode: .merge,
            libraryBytes: library,
            stagedBytes: staged,
            headroomBytes: headroom
        )
        XCTAssertEqual(merge, Int64(library + staged + headroom))

        // A small archive still uses the conservative 4× library rule.
        let small = BackupService.requiredSpace(
            mode: .replaceAll,
            libraryBytes: 1_000_000_000,
            stagedBytes: 1_000_000,
            headroomBytes: 1_000_000
        )
        XCTAssertEqual(small, 4_000_000_000)
    }

    // MARK: - Marker/journal path validation

    func testTraversalReplaceMarkerSnapshotIsRejected() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            #"{"state":"installing","snapshot":"../evil","transaction":"transaction.log"}"#,
            to: ".replace-in-progress.json"
        )
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        do {
            _ = try await service.recoverInterruptedReplace()
            XCTFail("expected invalid marker path")
        } catch let error as BackupError {
            guard case let .invalidMarkerPath(path) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertEqual(path, "../evil")
        }
        XCTAssertTrue(workspace.exists(".replace-in-progress.json"))
    }

    func testTraversalTransactionLogIsRejected() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            #"{"path":"../evil.md","existedBefore":false}"#,
            to: ".snapshots/replace-trav/transaction.log"
        )
        try workspace.write(
            #"{"state":"installing","snapshot":"replace-trav","transaction":"transaction.log"}"#,
            to: ".replace-in-progress.json"
        )
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        do {
            _ = try await service.recoverInterruptedReplace()
            XCTFail("expected invalid transaction path")
        } catch let error as BackupError {
            guard case let .invalidMarkerPath(path) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertEqual(path, "../evil.md")
        }
        XCTAssertTrue(workspace.exists(".replace-in-progress.json"))
    }

    func testTraversalMergeMarkerRollbackIsRejected() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            """
            {
              "state": "committing",
              "staging": ".staging/trav",
              "rollback": "../evil",
              "progress": {"committed": 0, "lastPath": ""},
              "startedAt": "2026-01-01T00:00:00.000Z"
            }
            """,
            to: ".merge-in-progress.json"
        )
        let service = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        do {
            _ = try await service.recoverInterruptedOperations()
            XCTFail("expected invalid merge marker path")
        } catch let error as BackupError {
            guard case let .invalidMarkerPath(path) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertEqual(path, "../evil")
        }
        XCTAssertTrue(workspace.exists(".merge-in-progress.json"))
    }
}
