import XCTest
@testable import CourseDeckCore

final class PathValidationTests: XCTestCase {
    func testIdentifierRules() throws {
        XCTAssertEqual(try PathValidator.courseId("baf3m"), "baf3m")
        XCTAssertEqual(try PathValidator.lessonId("01.06_assign1"), "01.06_assign1")
        XCTAssertEqual(try PathValidator.promptId("course_summary"), "course_summary")
        XCTAssertEqual(try PathValidator.normalizedCourseId("BAF3M"), "baf3m")
        for invalid in [".", "..", "../x", "x/y", "", "-abc", "a b", String(repeating: "a", count: 65)] {
            XCTAssertThrowsError(try PathValidator.courseId(invalid), "expected \(invalid) to fail")
        }
    }

    func testTabRules() throws {
        XCTAssertEqual(try PathValidator.tab("summary"), "summary")
        XCTAssertThrowsError(try PathValidator.tab("Summary"))
        XCTAssertThrowsError(try PathValidator.tab("summary.md"))
        XCTAssertTrue(PathValidator.isReservedTab("popquiz"))
        XCTAssertEqual(PathValidator.slugifyTabName("  Practice Questions! "), "practice_questions")
    }

    func testDocFilenames() throws {
        XCTAssertEqual(try PathValidator.tabFileName(lessonId: "01.01", tab: "lesson"), "01.01.lesson.md")
        XCTAssertEqual(try PathValidator.courseDocFileName(tab: "summary"), "course.summary.md")
        XCTAssertEqual(try PathValidator.unitDocFileName(unit: 2, tab: "test"), "02.unit.test.md")

        let lesson = try XCTUnwrap(PathValidator.parseDocFileName("01.01.summary.md"))
        XCTAssertEqual(lesson.lessonId, "01.01")
        XCTAssertEqual(lesson.tab, "summary")
        let unit = try XCTUnwrap(PathValidator.parseDocFileName("02.unit.assignments.md"))
        XCTAssertTrue(unit.isUnitScope)
        XCTAssertEqual(unit.unitNumber, 2)
        XCTAssertEqual(unit.lessonId, "02.unit")
        let course = try XCTUnwrap(PathValidator.parseDocFileName("course.cheatsheet.md"))
        XCTAssertTrue(course.isCourseScope)
        XCTAssertNil(PathValidator.parseDocFileName("01.01.popquiz.20260101010101.md"))
        XCTAssertNotNil(PathValidator.parsePopQuizFileName("01.01.popquiz.20260101010101.md"))
    }

    func testSafeJoinRejectsTraversalAndSymlinkEscapes() throws {
        let workspace = try TestWorkspace()
        let base = workspace.rootURL.appendingPathComponent("courses", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

        XCTAssertNoThrow(try PathValidator.safeJoin(base: base, "baf3m", "meta.json"))
        XCTAssertThrowsError(try PathValidator.safeJoin(base: base, "..", "outside.json"))
        XCTAssertThrowsError(try PathValidator.safeJoin(base: base, "/etc/passwd"))
        XCTAssertThrowsError(try PathValidator.safeJoin(base: base, "a/../../outside.json"))

        let outside = workspace.baseURL.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let link = base.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        XCTAssertThrowsError(try PathValidator.safeJoin(base: base, "link", "escape.txt"))
    }
}

final class AtomicFileStoreTests: XCTestCase {
    func testAtomicWriteAndOverwriteLeavesNoTempFiles() throws {
        let workspace = try TestWorkspace()
        let store = AtomicFileStore()
        let url = workspace.url("courses/baf3m/meta.json")

        try store.write("first", to: url)
        XCTAssertEqual(try store.readString(url), "first")
        try store.write("second", to: url)
        XCTAssertEqual(try store.readString(url), "second")

        let files = try FileManager.default.contentsOfDirectory(
            at: url.deletingLastPathComponent(),
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(files.map(\.lastPathComponent), ["meta.json"])
    }

    func testReadStringRejectsNonUTF8() throws {
        let workspace = try TestWorkspace()
        let url = try workspace.write(Data([0xFF, 0xFE, 0x00]), to: "bad.bin")
        XCTAssertThrowsError(try AtomicFileStore().readString(url))
    }
}

final class DataVersionTests: XCTestCase {
    func testMissingVersionMigratesAndWritesRecord() throws {
        let workspace = try TestWorkspace()
        let store = DataVersionStore(root: workspace.dataRoot, appVersion: "1.2.3")

        XCTAssertEqual(store.read(), .missing)
        let status = store.loadAndMigrate()
        guard case let .supported(record) = status else {
            return XCTFail("expected supported, got \(status)")
        }
        XCTAssertEqual(record.version, DataVersionStore.currentVersion)
        XCTAssertEqual(record.appVersion, "1.2.3")
        XCTAssertFalse(record.migratedAt.isEmpty)
        XCTAssertTrue(workspace.exists("attempts"))
        XCTAssertTrue(workspace.exists("dataVersion.json"))
        XCTAssertTrue(workspace.dataRoot.writeGate.isWritable)

        let json = try workspace.readJSON("dataVersion.json")
        XCTAssertEqual(json["version"]?.intValue, DataVersionStore.currentVersion)
        XCTAssertEqual(record.version, DataVersionStore.currentVersion)
        XCTAssertEqual(json["appVersion"]?.stringValue, "1.2.3")
        XCTAssertNotNil(json["migratedAt"]?.stringValue)
    }

    func testCorruptVersionFailsClosed() throws {
        let workspace = try TestWorkspace()
        try workspace.write("{ not json", to: "dataVersion.json")
        let status = DataVersionStore(root: workspace.dataRoot).loadAndMigrate()
        guard case .corrupt = status else {
            return XCTFail("expected corrupt, got \(status)")
        }
        XCTAssertFalse(workspace.dataRoot.writeGate.isWritable)
        XCTAssertThrowsError(try workspace.dataRoot.ensureWritable())
        // The unreadable file is never treated as old and overwritten.
        XCTAssertEqual(try workspace.readString("dataVersion.json"), "{ not json")
    }

    func testNewerVersionFailsClosed() throws {
        let workspace = try TestWorkspace()
        try workspace.write(#"{"version":99,"appVersion":"9.0","migratedAt":"x"}"#, to: "dataVersion.json")
        let status = DataVersionStore(root: workspace.dataRoot).loadAndMigrate()
        guard case let .newer(record, supported) = status else {
            return XCTFail("expected newer, got \(status)")
        }
        XCTAssertEqual(record.version, 99)
        XCTAssertEqual(supported, DataVersionStore.currentVersion)
        XCTAssertFalse(workspace.dataRoot.writeGate.isWritable)
    }

    func testMigrationSnapshotsAndPreservesUnknownSettingsFields() throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            #"{"theme":"dark","customField":{"nested":true}}"#,
            to: "settings.json"
        )
        try workspace.write(#"{"version":1,"activeId":null,"cards":[]}"#, to: "llm_ios.json")
        _ = try workspace.write(
            #"{"id":"card","file":"01.01.lesson.md","verticalPosition":10,"type":"position","date":"x"}"#,
            to: "courses/baf3m/checkpoint.json"
        )

        let status = DataVersionStore(root: workspace.dataRoot).loadAndMigrate()
        guard case .supported = status else { return XCTFail("expected supported") }

        let snapshots = try FileManager.default.contentsOfDirectory(
            at: workspace.dataRoot.snapshotsURL,
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(snapshots.count, 1)
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: snapshots[0].appendingPathComponent("settings.json").path
            )
        )

        let settings = try workspace.readJSON("settings.json")
        XCTAssertEqual(settings["version"]?.intValue, 1)
        XCTAssertEqual(settings["customField"]?["nested"]?.boolValue, true)
        XCTAssertEqual(settings["theme"]?.stringValue, "dark")
        XCTAssertEqual(workspace.dataRoot.writeGate.isWritable, true)
    }

    func testJobJournalMigrationNormalizesLegacyStates() throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            """
            [
              {"id":"baf3m:01.01:summary","courseId":"baf3m","tab":"summary","status":"processing"},
              {"id":"baf3m:01.01:test","courseId":"baf3m","tab":"test","status":"pending"},
              {"id":"baf3m:01.01:lesson","courseId":"baf3m","tab":"lesson","status":"completed"}
            ]
            """,
            to: ".jobs.json"
        )
        _ = DataVersionStore(root: workspace.dataRoot).loadAndMigrate()
        let jobs = try workspace.readJSON(".jobs.json").arrayValue ?? []
        XCTAssertEqual(jobs[0]["status"]?.stringValue, "interrupted")
        XCTAssertEqual(jobs[1]["status"]?.stringValue, "queued")
        XCTAssertEqual(jobs[2]["status"]?.stringValue, "succeeded")
    }
}

final class SettingsStoreTests: XCTestCase {
    func testDefaultsAndRoundtripWithUnknownFields() async throws {
        let workspace = try TestWorkspace()
        let store = SettingsStore(root: workspace.dataRoot)

        var defaults = await store.load()
        XCTAssertEqual(defaults.version, Settings.currentVersion)
        XCTAssertTrue(defaults.resumeLastPosition)

        defaults.theme = .dark
        defaults.extras = [JSONMember(key: "futureSetting", value: .string("kept"))]
        _ = try await store.save(defaults)

        let loaded = await store.load()
        XCTAssertEqual(loaded.theme, .dark)
        XCTAssertEqual(loaded.extras.first?.key, "futureSetting")
        XCTAssertEqual(try workspace.readJSON("settings.json")["futureSetting"]?.stringValue, "kept")
    }

    func testAIConsentVersionAndDateRoundtrip() async throws {
        let workspace = try TestWorkspace()
        let store = SettingsStore(root: workspace.dataRoot)
        var settings = await store.load()
        XCTAssertFalse(settings.hasAIConsent)
        XCTAssertEqual(settings.aiConsentVersion, 0)

        settings.acceptAIConsent(at: Date(timeIntervalSince1970: 1_700_000_000))
        let saved = try await store.save(settings)
        XCTAssertTrue(saved.hasAIConsent)
        XCTAssertEqual(saved.aiConsentVersion, Settings.currentAIConsentVersion)
        XCTAssertNotNil(saved.aiConsentAcceptedAt)

        let reloaded = await store.load()
        XCTAssertTrue(reloaded.hasAIConsent)
        XCTAssertEqual(reloaded.aiConsentVersion, Settings.currentAIConsentVersion)
        XCTAssertEqual(reloaded.aiConsentAcceptedAt, saved.aiConsentAcceptedAt)
    }

    func testOlderSettingsWithoutConsentFieldsDefaultToNotAccepted() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            #"{"version":1,"theme":"dark","hasCompletedFirstRun":true}"#,
            to: "settings.json"
        )
        let reloaded = await SettingsStore(root: workspace.dataRoot).load()
        XCTAssertFalse(reloaded.hasAIConsent)
        XCTAssertNil(reloaded.aiConsentAcceptedAt)
        XCTAssertEqual(reloaded.theme, .dark)
    }

    func testRevokeAIConsentClearsVersionAndDate() async throws {
        let workspace = try TestWorkspace()
        let store = SettingsStore(root: workspace.dataRoot)
        var settings = await store.load()
        settings.acceptAIConsent()
        _ = try await store.save(settings)

        var revoked = await store.load()
        XCTAssertTrue(revoked.hasAIConsent)
        revoked.revokeAIConsent()
        _ = try await store.save(revoked)
        let reloaded = await store.load()
        XCTAssertFalse(reloaded.hasAIConsent)
        XCTAssertNil(reloaded.aiConsentAcceptedAt)
    }

    func testCorruptSettingsQuarantinedWithBackup() async throws {
        let workspace = try TestWorkspace()
        try workspace.write("{ bad", to: "settings.json")
        let store = SettingsStore(root: workspace.dataRoot)
        let settings = await store.load()
        XCTAssertEqual(settings, Settings())
        XCTAssertTrue(workspace.exists("settings.json.bak"))
        XCTAssertFalse(workspace.exists("settings.json"))
        let quarantine = try FileManager.default.contentsOfDirectory(
            at: workspace.dataRoot.quarantineURL,
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(quarantine.count, 1)
    }
}

final class JobStoreTests: XCTestCase {
    private func job(tab: String, course: String = "baf3m", status: JobStatus = .queued, lane: JobLane = .standard) -> GenerationJob {
        GenerationJob(
            id: GenerationJob.identifier(courseId: course, lessonId: "01.01", tab: tab),
            courseId: course,
            lessonId: "01.01",
            lessonTitle: "Lesson",
            tab: tab,
            customPrompt: "prompt \(tab)",
            customContent: "content \(tab)",
            contextAttachment: "lesson - lessons",
            lane: lane,
            activeCardId: "card_deepseek",
            status: status
        )
    }

    func testJournalStoresFullInputsAndRecoversInterrupted() async throws {
        let workspace = try TestWorkspace()
        let store = JobStore(root: workspace.dataRoot)

        _ = try await store.enqueue(job(tab: "summary"))
        _ = try await store.enqueue(job(tab: "summary")) // dedupe queued
        let queuedCount = await store.allJobs().count
        XCTAssertEqual(queuedCount, 1)

        let started = try await store.start(id: "baf3m:01.01:summary")
        XCTAssertEqual(started?.status, .running)
        XCTAssertEqual(started?.attempts, 1)

        // Simulate a relaunch: running becomes interrupted, never resumed.
        let recovered = try await store.recoverInterrupted()
        XCTAssertEqual(recovered, 1)
        let interrupted = await store.job(id: "baf3m:01.01:summary")
        XCTAssertEqual(interrupted?.status, .interrupted)
        XCTAssertEqual(interrupted?.customPrompt, "prompt summary")
        XCTAssertEqual(interrupted?.customContent, "content summary")
        XCTAssertEqual(interrupted?.contextAttachment, "lesson - lessons")
        XCTAssertEqual(interrupted?.activeCardId, "card_deepseek")

        // Retry is explicit and preserves inputs.
        let retried = try await store.retry(id: "baf3m:01.01:summary")
        XCTAssertEqual(retried?.status, .queued)

        // Journal survives a brand-new store instance (durable file).
        let reloaded = JobStore(root: workspace.dataRoot)
        let jobs = await reloaded.allJobs()
        XCTAssertEqual(jobs.count, 1)
        XCTAssertEqual(jobs[0].status, .queued)
    }

    func testLaneOrderingPrefersInteractive() async throws {
        let workspace = try TestWorkspace()
        let store = JobStore(root: workspace.dataRoot)
        _ = try await store.enqueue(job(tab: "summary", lane: .courseDocs))
        _ = try await store.enqueue(job(tab: "cheatsheet", lane: .standard))
        _ = try await store.enqueue(job(tab: "popquiz", lane: .interactive))
        let nextLane = await store.nextQueued()?.lane
        XCTAssertEqual(nextLane, .interactive)
    }
}
