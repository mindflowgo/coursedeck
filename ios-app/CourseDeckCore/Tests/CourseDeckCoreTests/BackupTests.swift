import XCTest
@testable import CourseDeckCore

final class SecretScannerTests: XCTestCase {
    func testDetectsKeysTokensAndPrivateKeys() {
        let scanner = SecretScanner()
        XCTAssertEqual(
            scanner.firstMatch(in: "key = sk-abcdefghijklmnopqrstuvwxyz012345")?.pattern,
            "openai-api-key"
        )
        XCTAssertEqual(
            scanner.firstMatch(in: #"{"apiKey": "very-secret-value-123"}"#)?.pattern,
            "json-apiKey"
        )
        XCTAssertEqual(
            scanner.firstMatch(in: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")?.pattern,
            "bearer-token"
        )
        XCTAssertEqual(
            scanner.firstMatch(in: "-----BEGIN PRIVATE KEY-----\nabc")?.pattern,
            "private-key"
        )
        XCTAssertEqual(
            scanner.firstMatch(in: "AIzaSyA1234567890abcdefghijklmnopqrstuv")?.pattern,
            "google-api-key"
        )
    }

    func testDoesNotFlagLessonCurrencyOrMath() {
        let scanner = SecretScanner()
        XCTAssertNil(scanner.firstMatch(in: "| $1,500 | $2,000 |"))
        XCTAssertNil(scanner.firstMatch(in: "The value of $|x|$ is absolute."))
        XCTAssertNil(scanner.firstMatch(in: "sk-short"))
        XCTAssertNil(scanner.firstMatch(in: #"{"apiKey": ""}"#))
    }

    func testScansNestedArchiveWithinBounds() throws {
        let workspace = try TestWorkspace()
        let archiveURL = workspace.baseURL.appendingPathComponent("nested.zip")
        try TestWorkspace.makeZip(
            entries: [("inner/notes.md", Data("token sk-abcdefghijklmnopqrstuvwxyz012345".utf8))],
            at: archiveURL
        )
        XCTAssertEqual(try SecretScanner().scanFile(at: archiveURL)?.pattern, "openai-api-key")

        let tinyBudget = SecretScanner(limits: .init(maxNestedEntries: 1, maxNestedUncompressedBytes: 4))
        XCTAssertThrowsError(try tinyBudget.scanFile(at: archiveURL))
    }
}

final class BackupTests: XCTestCase {
    // MARK: - Fixtures

    @discardableResult
    private func seedLibrary(
        _ workspace: TestWorkspace,
        secretKey: String = "sk-test123456789012345678901234"
    ) throws -> InMemorySecretStore {
        try workspace.makeCourse(title: "BAF3M", lessonBody: "# Lesson 01.01\n\nLedger content.")
        try workspace.write("# Summary\n\nSummary body.", to: "courses/baf3m/01.01.summary.md")
        try workspace.write(
            """
            [
              {
                "id": "cp_pos_desktop",
                "file": "01.01.lesson.md",
                "verticalPosition": 321,
                "type": "position",
                "date": "2026-01-01T00:00:00.000Z"
              },
              {
                "id": "cp_note_one",
                "file": "01.01.summary.md",
                "verticalPosition": 40,
                "type": "note",
                "color": "blue",
                "noteText": "remember this",
                "date": "2026-01-02T00:00:00.000Z"
              }
            ]
            """,
            to: "courses/baf3m/checkpoint.json"
        )
        try workspace.write(Data([0x89, 0x50, 0x4E, 0x47]), to: "courses/baf3m/assets/img/diagram.png")
        try TestWorkspace.makeZip(
            entries: [("package/readme.md", Data("raw package".utf8))],
            at: workspace.url("courses/baf3m/_backup/source.zip")
        )
        try workspace.write("# Summary Prompt\n\nUser edited.", to: "prompts/summary.md")
        try workspace.write(#"{"lesson":"01.01","percent":0.5}"#, to: "lessonProgress/progress.json")
        try workspace.write(#"{"attemptId":"a1","score":3}"#, to: "attempts/a1.json")
        try workspace.write(#"{"theme":"dark","hasCompletedFirstRun":true}"#, to: "settings.json")
        try workspace.write(#"{"version":1,"cards":{}}"#, to: "llm_ios.json")
        try workspace.write(makeLlmConfigJSON(key: secretKey), to: "llm_config.json")
        try workspace.write(#"[{"id":"baf3m:01.01:summary","status":"queued"}]"#, to: ".jobs.json")
        try workspace.write("log line with no key", to: "backend.log")
        try workspace.write("mcp-secret-token", to: ".mcp-token")
        try workspace.write("junk", to: ".DS_Store")

        let keyStore = InMemorySecretStore()
        return keyStore
    }

    private func export(
        from workspace: TestWorkspace,
        includeRawPackages: Bool = false,
        keyStore: InMemorySecretStore? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws -> BackupExportResult {
        let service = BackupService(
            root: workspace.dataRoot,
            keyMigrator: KeyMigrator(secretStore: keyStore)
        )
        return try await service.exportBackup(
            options: BackupExportOptions(
                destinationDirectory: workspace.exportDirectory,
                includeRawPackages: includeRawPackages
            )
        )
    }

    // MARK: - Export

    func testExportAllowlistDenylistAndSecretScrub() async throws {
        let workspace = try TestWorkspace()
        let keyStore = try seedLibrary(workspace)
        let result = try await export(from: workspace, keyStore: keyStore)

        let paths = try TestWorkspace.archivePaths(at: result.archiveURL)
        XCTAssertTrue(paths.contains("courses/baf3m/meta.json"))
        XCTAssertTrue(paths.contains("courses/baf3m/01.01.lesson.md"))
        XCTAssertTrue(paths.contains("courses/baf3m/01.01.summary.md"))
        XCTAssertTrue(paths.contains("courses/baf3m/checkpoint.json"))
        XCTAssertTrue(paths.contains("courses/baf3m/assets/img/diagram.png"))
        XCTAssertTrue(paths.contains("prompts/summary.md"))
        XCTAssertTrue(paths.contains("lessonProgress/progress.json"))
        XCTAssertTrue(paths.contains("attempts/a1.json"))
        XCTAssertTrue(paths.contains("settings.json"))
        XCTAssertTrue(paths.contains("llm_ios.json"))

        XCTAssertFalse(paths.contains("llm_config.json"))
        XCTAssertFalse(paths.contains("courses/baf3m/_backup/source.zip"))
        XCTAssertFalse(paths.contains(".jobs.json"))
        XCTAssertFalse(paths.contains("backend.log"))
        XCTAssertFalse(paths.contains(".mcp-token"))
        XCTAssertFalse(paths.contains(".DS_Store"))

        // The exported archive must not contain any secret pattern.
        XCTAssertNil(try TestWorkspace.archiveContainsSecret(at: result.archiveURL))
        XCTAssertEqual(result.fileCount, paths.count)
    }

    func testIncludeRawPackagesAddsBackupDirectory() async throws {
        let workspace = try TestWorkspace()
        _ = try seedLibrary(workspace)
        let result = try await export(from: workspace, includeRawPackages: true)
        let paths = try TestWorkspace.archivePaths(at: result.archiveURL)
        XCTAssertTrue(paths.contains("courses/baf3m/_backup/source.zip"))
    }

    func testExportAbortsWhenCourseFileContainsASecret() async throws {
        let workspace = try TestWorkspace()
        _ = try seedLibrary(workspace)
        try workspace.write(
            "# Leaked\n\napi key sk-abcdefghijklmnopqrstuvwxyz012345",
            to: "courses/baf3m/01.01.cheatsheet.md"
        )
        do {
            _ = try await export(from: workspace)
            XCTFail("expected secret detection")
        } catch let error as BackupError {
            guard case let .secretDetected(path, _) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertEqual(path, "courses/baf3m/01.01.cheatsheet.md")
        }
        let exported = (try? FileManager.default.contentsOfDirectory(
            at: workspace.exportDirectory,
            includingPropertiesForKeys: nil
        )) ?? []
        XCTAssertTrue(exported.isEmpty)
    }

    func testIncludeRawScansNestedArchivesAndAborts() async throws {
        let workspace = try TestWorkspace()
        _ = try seedLibrary(workspace)
        try TestWorkspace.makeZip(
            entries: [("capture/notes.md", Data("sk-abcdefghijklmnopqrstuvwxyz012345".utf8))],
            at: workspace.url("courses/baf3m/_backup/leak.zip")
        )
        do {
            _ = try await export(from: workspace, includeRawPackages: true)
            XCTFail("expected nested secret detection")
        } catch let error as BackupError {
            guard case let .secretDetected(path, _) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertTrue(path.contains("_backup/leak.zip"))
        }
    }

    // MARK: - Import roundtrip

    func testMergeImportRoundtripRestoresFilesAndMigratesKeys() async throws {
        let source = try TestWorkspace()
        try seedLibrary(source)
        let exported = try await export(from: source)

        let target = try TestWorkspace()
        let keyStore = InMemorySecretStore()
        let importer = BackupService(
            root: target.dataRoot,
            keyMigrator: KeyMigrator(secretStore: keyStore)
        )
        let result = try await importer.importBackup(from: exported.archiveURL)

        XCTAssertEqual(result.mode, .merge)
        let sourceLesson = try source.readString("courses/baf3m/01.01.lesson.md")
        let targetLesson = try target.readString("courses/baf3m/01.01.lesson.md")
        XCTAssertEqual(targetLesson, sourceLesson)
        XCTAssertEqual(try target.readString("courses/baf3m/01.01.summary.md"), "# Summary\n\nSummary body.")
        XCTAssertEqual(try target.readString("prompts/summary.md"), "# Summary Prompt\n\nUser edited.")
        XCTAssertEqual(
            try target.readString("lessonProgress/progress.json"),
            try source.readString("lessonProgress/progress.json")
        )
        XCTAssertEqual(
            try target.readString("attempts/a1.json"),
            try source.readString("attempts/a1.json")
        )
        XCTAssertEqual(try target.readString("llm_ios.json"), #"{"version":1,"cards":{}}"#)
        XCTAssertEqual(
            try target.readString("settings.json"),
            try source.readString("settings.json")
        )
        XCTAssertFalse(target.exists(".jobs.json"))

        let checkpoints = try await CheckpointRepository(root: target.dataRoot).read(courseId: "baf3m")
        XCTAssertEqual(checkpoints.checkpoints.count, 2)
        XCTAssertEqual(checkpoints.checkpoints[0].verticalPosition, 321)
        XCTAssertEqual(checkpoints.checkpoints[1].noteText, "remember this")

        // An iOS export deliberately omits llm_config.json entirely, so a
        // roundtrip must not invent a config or write a key anywhere.
        XCTAssertFalse(target.exists("llm_config.json"))
        XCTAssertNil(result.report.keyMigration)
        XCTAssertTrue(try keyStore.allAccounts().isEmpty)
    }

    func testManifestMergeUnionsUnitsAndKeepsLocalContentWithConflicts() async throws {
        // Remote backup: local course gains unit 2 and has a differing lesson file.
        let source = try TestWorkspace()
        try source.makeCourse(title: "Remote", lessonBody: "REMOTE")
        let remoteManifest = CourseManifest(
            id: "baf3m",
            title: "Remote",
            units: [
                CourseUnit(number: 1, title: "Unit 1", lessons: [
                    CourseLesson(id: "01.01", title: "Lesson One", unitNumber: 1, lessonNumber: 1, hasFull: true),
                ]),
                CourseUnit(number: 2, title: "Unit 2", lessons: [
                    CourseLesson(id: "02.01", title: "Lesson Two", unitNumber: 2, lessonNumber: 1, hasSummary: true),
                ]),
            ],
            updatedAt: "2026-02-02T00:00:00.000Z"
        )
        try source.write(remoteManifest.encoded(), to: "courses/baf3m/meta.json")
        try source.write("# Remote summary", to: "courses/baf3m/02.01.summary.md")
        let exported = try await export(from: source)

        // Local library: local title and lesson content must win.
        let target = try TestWorkspace()
        try target.makeCourse(title: "Local Title", lessonBody: "LOCAL")
        let importer = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let result = try await importer.importBackup(from: exported.archiveURL)

        let manifest = try await CourseRepository(root: target.dataRoot).course(courseId: "baf3m")
        XCTAssertEqual(manifest?.title, "Local Title")
        XCTAssertEqual(manifest?.units.map(\.number), [1, 2])
        let newLesson = manifest?.units.first(where: { $0.number == 2 })?.lessons.first
        XCTAssertEqual(newLesson?.id, "02.01")
        XCTAssertFalse(newLesson?.hasFull ?? true)
        XCTAssertTrue(newLesson?.hasSummary ?? false)
        XCTAssertEqual(try target.readString("courses/baf3m/02.01.summary.md"), "# Remote summary")
        XCTAssertEqual(try target.readString("courses/baf3m/01.01.lesson.md"), "LOCAL")

        let conflicts = try FileManager.default.contentsOfDirectory(
            at: target.url("courses/baf3m/_conflicts"),
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(conflicts.count, 1)
        XCTAssertTrue(conflicts[0].lastPathComponent.hasPrefix("01.01.lesson."))
        XCTAssertTrue(result.report.conflicts.contains("courses/baf3m/01.01.lesson.md"))
    }

    func testManifestMergeNeverShrinksUnitsAndMarksMissingLessons() throws {
        let local = CourseManifest(
            id: "baf3m",
            title: "Local",
            units: [CourseUnit(number: 1, title: "Unit 1", lessons: [
                CourseLesson(id: "01.01", title: "One", unitNumber: 1, lessonNumber: 1, hasFull: true),
            ])]
        )
        let imported = CourseManifest(
            id: "baf3m",
            title: "Imported",
            units: [
                CourseUnit(number: 1, title: "Imported Unit", lessons: [
                    CourseLesson(id: "01.01", title: "One", unitNumber: 1, lessonNumber: 1, hasFull: true, hasSummary: true),
                    CourseLesson(id: "01.02", title: "Two", unitNumber: 1, lessonNumber: 2, hasFull: false),
                ]),
                CourseUnit(number: 2, title: "Unit 2", lessons: [
                    CourseLesson(id: "02.01", title: "Three", unitNumber: 2, lessonNumber: 1),
                ]),
            ]
        )
        let merged = ManifestMerger.merge(
            local: local,
            imported: imported,
            stagedContent: ["01.01": LessonContentPresence(hasSummary: true)]
        )
        XCTAssertEqual(merged.manifest.title, "Local")
        XCTAssertEqual(merged.manifest.units.map(\.number), [1, 2])
        XCTAssertEqual(merged.manifest.units[0].title, "Unit 1")
        XCTAssertEqual(merged.manifest.units[0].lessons.count, 2)
        // Local lesson present; imported summary file raises the local flag.
        XCTAssertTrue(merged.manifest.units[0].lessons[0].hasSummary)
        XCTAssertEqual(merged.manifest.units[0].lessons[1].id, "01.02")
        XCTAssertFalse(merged.manifest.units[0].lessons[1].hasFull)
        XCTAssertEqual(merged.manifest.units[1].lessons[0].id, "02.01")
        XCTAssertEqual(Set(merged.missingLessonIDs), ["01.02", "02.01"])

        // Imported manifest with no units never clears local navigation.
        let emptyImport = CourseManifest(id: "baf3m", title: "Empty", units: [])
        let preserved = ManifestMerger.merge(local: local, imported: emptyImport, stagedContent: [:])
        XCTAssertEqual(preserved.manifest.units.count, 1)
    }

    func testReplaceAllPreservesLocalOnlyStateAndSnapshots() async throws {
        let source = try TestWorkspace()
        try source.makeCourse(title: "Remote", lessonBody: "# Remote")
        let exported = try await export(from: source)

        let target = try TestWorkspace()
        try target.makeCourse(title: "Local", lessonBody: "# Local")
        try TestWorkspace.makeZip(entries: [("raw.md", Data("raw".utf8))], at: target.url("courses/baf3m/_backup/local.zip"))
        try target.write(#"[{"id":"local","status":"queued"}]"#, to: ".jobs.json")
        try target.write(#"{"attemptId":"local"}"#, to: "attempts/local.json")
        try target.write(#"{"version":1}"#, to: "llm_ios.json")
        try target.write("unknown local file", to: "orphan.txt")

        let importer = BackupService(root: target.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        let result = try await importer.importBackup(
            from: exported.archiveURL,
            options: BackupImportOptions(mode: .replaceAll)
        )

        XCTAssertNotNil(result.snapshotURL)
        XCTAssertEqual(try target.readString("courses/baf3m/01.01.lesson.md"), "# Remote")
        XCTAssertTrue(target.exists("courses/baf3m/_backup/local.zip"))
        XCTAssertTrue(target.exists(".jobs.json"))
        XCTAssertTrue(target.exists("attempts/local.json"))
        XCTAssertTrue(target.exists("llm_ios.json"))
        XCTAssertTrue(target.exists("orphan.txt"))
        XCTAssertNotNil(result.snapshotURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.snapshotURL!.path))
    }

    func testZipSlipAndAbsolutePathsAreRejected() async throws {
        let workspace = try TestWorkspace()
        let archiveURL = workspace.baseURL.appendingPathComponent("slip.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("courses/baf3m/meta.json", Data(#"{"id":"baf3m","title":"X","units":[]}"#.utf8)),
                ("../evil.md", Data("evil".utf8)),
            ],
            at: archiveURL
        )
        let importer = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        do {
            _ = try await importer.importBackup(from: archiveURL)
            XCTFail("expected zip-slip rejection")
        } catch let error as BackupError {
            guard case .zipSlip = error else { return XCTFail("wrong error \(error)") }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspace.baseURL.appendingPathComponent("evil.md").path))
    }

    func testDesktopBackupWithDenylistedFilesImportsTheRest() async throws {
        let workspace = try TestWorkspace()
        let archiveURL = workspace.baseURL.appendingPathComponent("desktop.zip")
        let manifest = CourseManifest(
            id: "baf3m",
            title: "Desktop",
            units: [CourseUnit(number: 1, title: "Unit 1", lessons: [
                CourseLesson(id: "01.01", title: "One", unitNumber: 1, lessonNumber: 1, hasFull: true),
            ])]
        )
        try TestWorkspace.makeZip(
            entries: [
                ("courses/baf3m/meta.json", manifest.encoded()),
                ("courses/baf3m/01.01.lesson.md", Data("# Desktop lesson".utf8)),
                ("llm_config.json", Data(makeLlmConfigJSON().utf8)),
                (".mcp-token", Data("token".utf8)),
                ("backend.log", Data("log sk-abcdefghijklmnopqrstuvwxyz012345".utf8)),
                (".google_credentials.json", Data("{}".utf8)),
            ],
            at: archiveURL
        )
        let keyStore = InMemorySecretStore()
        let importer = BackupService(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: keyStore))
        let result = try await importer.importBackup(from: archiveURL)

        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.lesson.md"), "# Desktop lesson")
        XCTAssertFalse(workspace.exists("backend.log"))
        XCTAssertFalse(workspace.exists(".mcp-token"))
        XCTAssertFalse(workspace.exists(".google_credentials.json"))
        XCTAssertTrue(result.report.denied.contains { $0.hasPrefix(".mcp-token") })
        XCTAssertTrue(result.report.denied.contains { $0.hasPrefix("backend.log") })
        XCTAssertFalse(try workspace.readString("llm_config.json").contains("sk-"))
        XCTAssertEqual(
            try keyStore.secret(for: KeyMigrator.account(
                cardId: "card_deepseek",
                baseURL: "https://api.deepseek.com"
            )),
            "sk-test123456789012345678901234"
        )
    }
}
