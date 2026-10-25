import XCTest
@testable import CourseDeckCore

final class CourseRepositoryTests: XCTestCase {
    func testManifestCRUDAndUnknownFieldPreservation() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse(title: "BAF3M")
        let repo = CourseRepository(root: workspace.dataRoot)

        let courses = try await repo.listCourses()
        XCTAssertEqual(courses.count, 1)
        XCTAssertEqual(courses[0].title, "BAF3M")

        let patched = try await repo.patchManifest(
            courseId: "baf3m",
            patch: .init(title: "Accounting", archived: true)
        )
        XCTAssertEqual(patched?.title, "Accounting")
        XCTAssertEqual(patched?.archived, true)

        let active = try await repo.listCourses(includeArchived: false)
        XCTAssertTrue(active.isEmpty)

        _ = try await repo.patchManifest(courseId: "baf3m", patch: .init(archived: false))
        let raw = try workspace.readJSON("courses/baf3m/meta.json")
        XCTAssertNil(raw["archived"])
        XCTAssertEqual(raw["title"]?.stringValue, "Accounting")
        XCTAssertEqual(
            raw.objectValue?.prefix(7).map(\.key),
            ["id", "title", "grade", "level", "description", "units", "updatedAt"]
        )
    }

    func testLessonBundleTabsAndCourseDocuments() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write("summary body", to: "courses/baf3m/01.01.summary.md")
        try workspace.write("custom body", to: "courses/baf3m/01.01.assignment.md")
        try workspace.write("course body", to: "courses/baf3m/course.summary.md")
        try workspace.write("unit body", to: "courses/baf3m/02.unit.test.md")
        let repo = CourseRepository(root: workspace.dataRoot)

        let bundle = try await repo.lessonBundle(courseId: "baf3m", lessonId: "01.01")
        XCTAssertEqual(bundle?.lesson, "# Lesson 01.01\n\nHello.")
        XCTAssertEqual(bundle?.tabs["summary"], "summary body")
        XCTAssertEqual(bundle?.tabs["assignment"], "custom body")

        try await repo.saveTab(courseId: "baf3m", lessonId: "01.01", tab: "cheatsheet", content: "new")
        let savedCheatsheet = try await repo.tabContent(courseId: "baf3m", lessonId: "01.01", tab: "cheatsheet")
        XCTAssertEqual(savedCheatsheet, "new")
        let deleted = try await repo.deleteTab(courseId: "baf3m", lessonId: "01.01", tab: "cheatsheet")
        XCTAssertTrue(deleted)
        let missingCheatsheet = try await repo.tabContent(courseId: "baf3m", lessonId: "01.01", tab: "cheatsheet")
        XCTAssertNil(missingCheatsheet)

        let courseSummary = try await repo.courseDocument(courseId: "baf3m", tab: "summary")
        let unitTest = try await repo.unitDocument(courseId: "baf3m", unit: 2, tab: "test")
        XCTAssertEqual(courseSummary, "course body")
        XCTAssertEqual(unitTest, "unit body")
        let flags = try await repo.discoverCourseDocs(courseId: "baf3m")
        XCTAssertTrue(flags.summary)
        XCTAssertFalse(flags.test)
        XCTAssertFalse(flags.cheatsheet)

        do {
            _ = try await repo.saveTab(courseId: "baf3m", lessonId: "../x", tab: "summary", content: "x")
            XCTFail("expected invalid lesson id")
        } catch {
            XCTAssertTrue(error is PathValidationError)
        }
    }

    func testCorruptManifestIsQuarantinedWithBackup() async throws {
        let workspace = try TestWorkspace()
        try workspace.write("{ bad json", to: "courses/baf3m/meta.json")
        let repo = CourseRepository(root: workspace.dataRoot)

        do {
            _ = try await repo.course(courseId: "baf3m")
            XCTFail("expected corrupt error")
        } catch let error as RepositoryError {
            guard case .corrupt = error else { return XCTFail("wrong error \(error)") }
        }
        XCTAssertTrue(workspace.exists("courses/baf3m/meta.json.bak"))
        XCTAssertFalse(workspace.exists("courses/baf3m/meta.json"))
        let quarantine = try FileManager.default.contentsOfDirectory(
            at: workspace.dataRoot.quarantineURL,
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(quarantine.count, 1)
    }

    func testWriteGateBlocksRepositoryMutations() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        workspace.dataRoot.writeGate.block(reason: "newer data version")
        let repo = CourseRepository(root: workspace.dataRoot)
        do {
            _ = try await repo.saveTab(courseId: "baf3m", lessonId: "01.01", tab: "summary", content: "x")
            XCTFail("expected blocked write")
        } catch let error as WriteBlockedError {
            XCTAssertTrue(error.reason.contains("newer"))
        }
    }

    func testCompareAndSaveRejectsConcurrentEditorWriteAndKeepsIt() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repo = CourseRepository(root: workspace.dataRoot)
        try workspace.write("ORIGINAL", to: "courses/baf3m/01.01.summary.md")
        let expected = SHA256.hex("ORIGINAL")
        // An editor writes after the read used to form the expected hash.
        try workspace.write("EDITOR WINS", to: "courses/baf3m/01.01.summary.md")

        do {
            _ = try await repo.compareAndSaveGeneratedDocument(
                courseId: "baf3m",
                scope: .lesson("01.01"),
                tab: "summary",
                content: "GENERATED",
                expectedExistingSHA256: expected
            )
            XCTFail("Expected concurrent modification")
        } catch let error as RepositoryError {
            XCTAssertEqual(error, .concurrentModification("01.01.summary.md"))
        }
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.summary.md"), "EDITOR WINS")
        XCTAssertFalse(workspace.exists("courses/baf3m/01.01.summary.md.bak"))
    }

    func testCompareAndSaveSnapshotsAndWritesUnderOneLease() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repo = CourseRepository(root: workspace.dataRoot)
        try workspace.write("ORIGINAL", to: "courses/baf3m/01.01.summary.md")

        let fileName = try await repo.compareAndSaveGeneratedDocument(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "summary",
            content: "GENERATED",
            expectedExistingSHA256: SHA256.hex("ORIGINAL")
        )
        XCTAssertEqual(fileName, "01.01.summary.md")
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.summary.md"), "GENERATED")
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.summary.md.bak"), "ORIGINAL")
    }

    func testSnapshotGeneratedDocumentKeepsOriginalForCorruptFrontmatter() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repo = CourseRepository(root: workspace.dataRoot)
        try workspace.write("---\nscore: [broken\n---\n\nBODY", to: "courses/baf3m/01.01.summary.md")

        let backup = try await repo.snapshotGeneratedDocument(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "summary"
        )
        XCTAssertNotNil(backup)
        XCTAssertEqual(
            try workspace.readString("courses/baf3m/01.01.summary.md.bak"),
            "---\nscore: [broken\n---\n\nBODY"
        )
    }

    func testCompareAndSaveHonorsHeldLeaseAndWriteGate() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repo = CourseRepository(root: workspace.dataRoot, leaseTimeout: 0.1)
        try workspace.dataRoot.writeLease.acquire(owner: "other", timeout: 0)
        defer { workspace.dataRoot.writeLease.release(owner: "other") }

        do {
            _ = try await repo.compareAndSaveGeneratedDocument(
                courseId: "baf3m",
                scope: .lesson("01.01"),
                tab: "summary",
                content: "GENERATED",
                expectedExistingSHA256: SHA256.hex("")
            )
            XCTFail("Expected lease timeout")
        } catch let error as WriteLeaseError {
            guard case .timedOut = error else { return XCTFail("wrong error \(error)") }
        }

        workspace.dataRoot.writeGate.block(reason: "newer data version")
        do {
            _ = try await repo.compareAndSaveGeneratedDocument(
                courseId: "baf3m",
                scope: .lesson("01.01"),
                tab: "summary",
                content: "GENERATED",
                expectedExistingSHA256: SHA256.hex("")
            )
            XCTFail("Expected write-blocked error")
        } catch let error as WriteBlockedError {
            XCTAssertTrue(error.reason.contains("newer"))
        }
    }
}

final class PromptRepositoryTests: XCTestCase {
    private func makePrompts(workspace: TestWorkspace) throws -> URL {
        let bundled = workspace.baseURL.appendingPathComponent("BundledPrompts", isDirectory: true)
        try FileManager.default.createDirectory(at: bundled, withIntermediateDirectories: true)
        try Data("# Summary Prompt\n\nBundled summary.".utf8).write(to: bundled.appendingPathComponent("summary.md"))
        try Data("# Course Cheatsheet\n\nBundled cheatsheet.".utf8).write(to: bundled.appendingPathComponent("course_cheatsheet.md"))
        return bundled
    }

    func testSeedsMissingPromptOnlyOnceAndMergesOverrides() async throws {
        let workspace = try TestWorkspace()
        let bundled = try makePrompts(workspace: workspace)
        let repo = PromptRepository(root: workspace.dataRoot, bundledDirectory: bundled)

        let seeded = try await repo.prompt(id: "summary")
        XCTAssertEqual(seeded?.title, "Summary Prompt")
        XCTAssertEqual(seeded?.content, "# Summary Prompt\n\nBundled summary.")
        XCTAssertTrue(workspace.exists("prompts/summary.md"))

        try await repo.save(id: "summary", content: "# My Summary\n\nEdited.")
        let overridden = try await repo.prompt(id: "summary")
        XCTAssertEqual(overridden?.title, "My Summary")
        XCTAssertEqual(overridden?.source, .active)

        let listed = try await repo.list()
        XCTAssertEqual(listed.first(where: { $0.id == "summary" })?.title, "My Summary")
        XCTAssertEqual(listed.first(where: { $0.id == "course_cheatsheet" })?.source, .bundled)
    }

    func testProtectedPromptsCannotBeDeletedAndDefaultsCanBeRestored() async throws {
        let workspace = try TestWorkspace()
        let bundled = try makePrompts(workspace: workspace)
        let repo = PromptRepository(root: workspace.dataRoot, bundledDirectory: bundled)

        try await repo.save(id: "summary", content: "# Edited")
        do {
            _ = try await repo.delete(id: "summary")
            XCTFail("expected protected prompt error")
        } catch let error as PromptRepositoryError {
            XCTAssertEqual(error, .protectedPrompt("summary"))
        }

        let restored = try await repo.restoreDefault(id: "summary")
        XCTAssertEqual(restored.content, "# Summary Prompt\n\nBundled summary.")
        XCTAssertEqual(try workspace.readString("prompts/summary.md"), "# Summary Prompt\n\nBundled summary.")

        try await repo.save(id: "custom_tab", content: "# Custom")
        let deleted = try await repo.delete(id: "custom_tab")
        XCTAssertTrue(deleted)
    }

    func testCreateRejectsProtectedAndCollisionAndRestoreKeepsBak() async throws {
        let workspace = try TestWorkspace()
        let bundled = try makePrompts(workspace: workspace)
        let repo = PromptRepository(root: workspace.dataRoot, bundledDirectory: bundled)

        let created = try await repo.create(
            id: "Exam_Review",
            content: "# Exam Review\n\nCustom prompt."
        )
        XCTAssertEqual(created.id, "exam_review")
        XCTAssertTrue(workspace.exists("prompts/exam_review.md"))

        do {
            _ = try await repo.create(id: "summary", content: "# Shadow")
            XCTFail("protected prompt was created")
        } catch let error as PromptRepositoryError {
            XCTAssertEqual(error, .protectedPrompt("summary"))
        }

        do {
            _ = try await repo.create(id: "exam_review", content: "# Duplicate")
            XCTFail("duplicate prompt was created")
        } catch let error as PromptRepositoryError {
            XCTAssertEqual(error, .alreadyExists("exam_review"))
        }

        try await repo.save(id: "summary", content: "# User summary\n\nEdited.")
        let restored = try await repo.restoreDefault(id: "summary")
        XCTAssertEqual(restored.content, "# Summary Prompt\n\nBundled summary.")
        XCTAssertEqual(
            try workspace.readString("prompts/summary.md.bak"),
            "# User summary\n\nEdited."
        )
    }

    func testPromptDiffMarksAddedAndRemovedLines() {
        let diff = PromptDiff.compare(
            active: "# Mine\n\nKeep\nActive only",
            bundled: "# Bundled\n\nKeep\nBundled only"
        )
        XCTAssertEqual(diff.filter { $0.kind == .removed }.map(\.text), ["# Mine", "Active only"])
        XCTAssertEqual(diff.filter { $0.kind == .added }.map(\.text), ["# Bundled", "Bundled only"])
        XCTAssertEqual(diff.filter { $0.kind == .unchanged }.map(\.text), ["", "Keep"])
    }

    func testMissingRequiredPromptsAreReported() async throws {
        let workspace = try TestWorkspace()
        let bundled = try makePrompts(workspace: workspace)
        let repo = PromptRepository(root: workspace.dataRoot, bundledDirectory: bundled)
        let missing = await repo.missingRequiredPrompts()
        XCTAssertTrue(missing.contains("test"))
        XCTAssertFalse(missing.contains("summary"))

        // An existing but empty prompt is still a configuration error.
        try await repo.save(id: "summary", content: "   \n")
        let missingAfterEmpty = await repo.missingRequiredPrompts()
        XCTAssertTrue(missingAfterEmpty.contains("summary"))
    }
}

final class CheckpointRepositoryTests: XCTestCase {
    private func checkpointJSON(_ workspace: TestWorkspace) throws -> JSONValue {
        try workspace.readJSON("courses/baf3m/checkpoint.json")
    }

    func testNewCheckpointsWriteVerticalPositionAndAnchors() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repo = CheckpointRepository(root: workspace.dataRoot)

        let first = try await repo.recordPosition(
            courseId: "baf3m",
            file: "01.01.lesson.md",
            verticalPosition: 640.7,
            anchorBlockID: "h:lesson-0101:0",
            anchorFraction: 0.5
        )
        XCTAssertEqual(first.type, .position)
        XCTAssertEqual(first.verticalPosition, 640)
        XCTAssertEqual(first.anchorBlockID, "h:lesson-0101:0")
        XCTAssertEqual(first.anchorFraction, 0.5)

        var json = try checkpointJSON(workspace)
        XCTAssertEqual(json.arrayValue?.count, 1)
        XCTAssertEqual(json[0]?["verticalPosition"]?.doubleValue, 640)
        XCTAssertEqual(json[0]?["anchorBlockID"]?.stringValue, "h:lesson-0101:0")
        XCTAssertEqual(json[0]?["anchorFraction"]?.doubleValue, 0.5)

        let second = try await repo.recordPosition(
            courseId: "baf3m",
            file: "01.01.lesson.md",
            verticalPosition: 800,
            anchorBlockID: "h:lesson-0101:2",
            anchorFraction: 0.25
        )
        XCTAssertEqual(second.id, first.id)
        json = try checkpointJSON(workspace)
        XCTAssertEqual(json.arrayValue?.count, 1)
        XCTAssertEqual(json[0]?["verticalPosition"]?.doubleValue, 800)
        XCTAssertEqual(json[0]?["anchorBlockID"]?.stringValue, "h:lesson-0101:2")

        let after = try await repo.positionCheckpoint(courseId: "baf3m", file: "01.01.lesson.md")
        XCTAssertEqual(after?.verticalPosition, 800)
    }

    func testDesktopCheckpointFieldsAndUnknownKeysArePreserved() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write(
            """
            [
              {
                "id": "cp_pos_desktop",
                "file": "01.01.lesson.md",
                "verticalPosition": 123.5,
                "type": "position",
                "date": "2026-01-01T00:00:00.000Z",
                "desktopOnly": "keep"
              }
            ]
            """,
            to: "courses/baf3m/checkpoint.json"
        )
        let repo = CheckpointRepository(root: workspace.dataRoot)

        var document = try await repo.read(courseId: "baf3m")
        XCTAssertEqual(document.checkpoints.count, 1)
        XCTAssertEqual(document.checkpoints[0].verticalPosition, 123.5)
        XCTAssertEqual(document.checkpoints[0].extras.first?.key, "desktopOnly")

        _ = try await repo.addOrUpdateNote(
            courseId: "baf3m",
            file: "01.01.summary.md",
            verticalPosition: 10,
            anchorBlockID: "h:summary:0",
            anchorFraction: 0,
            color: "blue",
            noteText: "note"
        )
        document = try await repo.read(courseId: "baf3m")
        XCTAssertEqual(document.checkpoints.count, 2)
        XCTAssertEqual(document.checkpoints[0].file, "01.01.lesson.md")
        XCTAssertEqual(document.checkpoints[0].extras.first?.key, "desktopOnly")

        let raw = try checkpointJSON(workspace)
        XCTAssertEqual(raw[0]?["verticalPosition"]?.doubleValue, 123.5)
        XCTAssertEqual(raw[0]?["desktopOnly"]?.stringValue, "keep")
        XCTAssertEqual(raw[1]?["anchorBlockID"]?.stringValue, "h:summary:0")
    }

    func testNoteUpdatePreservesColorAndPassThroughEntries() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write(
            #"[{"unknownEntry": true}]"#,
            to: "courses/baf3m/checkpoint.json"
        )
        let repo = CheckpointRepository(root: workspace.dataRoot)

        let note = try await repo.addOrUpdateNote(
            courseId: "baf3m",
            file: "01.01.summary.md",
            verticalPosition: 5,
            anchorBlockID: "h:summary:0",
            anchorFraction: 0.1,
            color: "coral",
            noteText: "first"
        )
        let updated = try await repo.addOrUpdateNote(
            courseId: "baf3m",
            id: note.id,
            file: "01.01.summary.md",
            verticalPosition: 6,
            anchorBlockID: "h:summary:1",
            anchorFraction: 0.2,
            noteText: "second"
        )
        XCTAssertEqual(updated.id, note.id)
        XCTAssertEqual(updated.color, "coral")
        XCTAssertEqual(updated.noteText, "second")
        XCTAssertEqual(updated.anchorBlockID, "h:summary:1")

        let raw = try checkpointJSON(workspace)
        XCTAssertEqual(raw.arrayValue?.count, 2)
        XCTAssertEqual(raw[0]?["noteText"]?.stringValue, "second")
        XCTAssertEqual(raw[1]?["unknownEntry"]?.boolValue, true)

        let deleted = try await repo.delete(courseId: "baf3m", checkpointId: note.id)
        XCTAssertTrue(deleted)
        let after = try await repo.read(courseId: "baf3m")
        XCTAssertEqual(after.checkpoints.count, 0)
        XCTAssertEqual(after.passthrough.count, 1)
    }

    func testCorruptCheckpointFileIsQuarantinedNotOverwritten() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write("{ not an array", to: "courses/baf3m/checkpoint.json")
        let repo = CheckpointRepository(root: workspace.dataRoot)

        do {
            _ = try await repo.recordPosition(
                courseId: "baf3m",
                file: "01.01.lesson.md",
                verticalPosition: 10,
                anchorBlockID: "a",
                anchorFraction: 0
            )
            XCTFail("expected corrupt error")
        } catch let error as RepositoryError {
            guard case .corrupt = error else { return XCTFail("wrong error \(error)") }
        }
        XCTAssertTrue(workspace.exists("courses/baf3m/checkpoint.json.bak"))
        XCTAssertFalse(workspace.exists("courses/baf3m/checkpoint.json"))
    }
}
