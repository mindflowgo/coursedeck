import Foundation
import XCTest
@testable import CourseDeckCore

final class DocumentEditingTests: XCTestCase {
    func testEditorSnapshotAndCompareAndSwapConflict() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write("old summary", to: "courses/baf3m/01.01.summary.md")
        let repository = CourseRepository(root: workspace.dataRoot)

        let snapshot = try await repository.documentSnapshot(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "summary"
        )
        XCTAssertTrue(snapshot.existed)
        XCTAssertEqual(snapshot.content, "old summary")

        // A second writer changes the file after our snapshot.
        try workspace.write("external edit", to: "courses/baf3m/01.01.summary.md")
        do {
            _ = try await repository.compareAndSaveDocument(
                courseId: "baf3m",
                scope: .lesson("01.01"),
                tab: "summary",
                content: "my edit",
                expectedSHA256: snapshot.sha256
            )
            XCTFail("Expected a concurrent-modification error")
        } catch let error as RepositoryError {
            guard case .concurrentModification = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.summary.md"), "external edit")

        // The explicit overwrite path succeeds and snapshots the replaced file.
        let saved = try await repository.compareAndSaveDocument(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "summary",
            content: "my edit",
            expectedSHA256: snapshot.sha256,
            force: true
        )
        XCTAssertEqual(saved.content, "my edit")
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.summary.md"), "my edit")
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.summary.md.bak"), "external edit")
    }

    func testEditorCanCreateMissingDocumentThroughCompareAndSwap() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repository = CourseRepository(root: workspace.dataRoot)
        let snapshot = try await repository.documentSnapshot(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "vocab"
        )
        XCTAssertFalse(snapshot.existed)
        XCTAssertEqual(snapshot.content, "")
        _ = try await repository.compareAndSaveDocument(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "vocab",
            content: "# Vocab\n",
            expectedSHA256: snapshot.sha256
        )
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.vocab.md"), "# Vocab\n")
    }

    func testCustomTabCreateDeleteAndReservedRejection() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repository = CourseRepository(root: workspace.dataRoot)

        let created = try await repository.createCustomDocument(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "vocab_list"
        )
        XCTAssertEqual(created.tab, "vocab_list")
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.vocab_list.md"), "# Vocab List\n")

        do {
            _ = try await repository.createCustomDocument(
                courseId: "baf3m",
                scope: .lesson("01.01"),
                tab: "vocab_list"
            )
            XCTFail("Expected an already-exists error")
        } catch let error as RepositoryError {
            guard case .alreadyExists = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }

        for reserved in ["test", "popquiz", "summary", "lesson"] {
            do {
                _ = try await repository.createCustomDocument(
                    courseId: "baf3m",
                    scope: .lesson("01.01"),
                    tab: reserved
                )
                XCTFail("Reserved tab \(reserved) was created")
            } catch is PathValidationError {
                // expected
            }
        }

        let trash = try await repository.deleteCustomDocument(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "vocab_list"
        )
        XCTAssertNotNil(trash)
        XCTAssertFalse(workspace.exists("courses/baf3m/01.01.vocab_list.md"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: trash!.path))
        XCTAssertEqual(try String(contentsOf: trash!, encoding: .utf8), "# Vocab List\n")

        // Deleting through the custom API must never remove a reserved file.
        do {
            _ = try await repository.deleteCustomDocument(
                courseId: "baf3m",
                scope: .lesson("01.01"),
                tab: "lesson"
            )
            XCTFail("Reserved lesson tab was deletable")
        } catch is PathValidationError {
            // expected
        }
    }

    func testCourseAndUnitCustomTabs() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repository = CourseRepository(root: workspace.dataRoot)
        _ = try await repository.createCustomDocument(
            courseId: "baf3m",
            scope: .course,
            tab: "exam_review"
        )
        _ = try await repository.createCustomDocument(
            courseId: "baf3m",
            scope: .unit(1),
            tab: "graph_lab"
        )
        XCTAssertTrue(workspace.exists("courses/baf3m/course.exam_review.md"))
        XCTAssertTrue(workspace.exists("courses/baf3m/01.unit.graph_lab.md"))
        let unitTabs = try await repository.discoverUnitDocs(courseId: "baf3m", unitNumber: 1)
        XCTAssertEqual(unitTabs, ["graph_lab"])
        let docs = try await repository.discoverCourseDocs(courseId: "baf3m")
        XCTAssertEqual(docs.custom["exam_review"], true)
    }

    func testPopQuizDiscoveryWithLiveTimestampFormat() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write(
            "# Pop Quiz\n\n## Questions\n01) Q",
            to: "courses/baf3m/01.01.popquiz.2026-10-19_23-52-28.md"
        )
        try workspace.write(
            "# Other Quiz",
            to: "courses/baf3m/01.02.popquiz.2026-10-20_00-26-45.md"
        )
        let repository = CourseRepository(root: workspace.dataRoot)
        let quizzes = try await repository.listPopQuizzes(courseId: "baf3m", lessonId: "01.01")
        XCTAssertEqual(quizzes.count, 1)
        XCTAssertEqual(quizzes[0].timestamp, "2026-10-19_23-52-28")
        XCTAssertEqual(quizzes[0].fileName, "01.01.popquiz.2026-10-19_23-52-28.md")
        let content = try await repository.popQuizContent(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "2026-10-19_23-52-28"
        )
        XCTAssertTrue(content?.contains("Pop Quiz") == true)
        let traversal = try? await repository.popQuizContent(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "../../etc/passwd"
        )
        XCTAssertNil(traversal)
    }

    func testTwoPopQuizGenerationsInSameSecondAreDistinctAndLoadable() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repository = CourseRepository(root: workspace.dataRoot)
        let now = Date(timeIntervalSince1970: 1_700_000_000)

        let first = try await repository.saveNewPopQuiz(
            courseId: "baf3m",
            lessonId: "01.01",
            content: "# First Pop Quiz\n\n## Questions\n01) Q",
            now: now
        )
        let second = try await repository.saveNewPopQuiz(
            courseId: "baf3m",
            lessonId: "01.01",
            content: "# Second Pop Quiz\n\n## Questions\n01) Q",
            now: now
        )
        XCTAssertNotEqual(first.timestamp, second.timestamp)
        XCTAssertNotEqual(first.fileName, second.fileName)
        XCTAssertTrue(PathValidator.parsePopQuizFileName(first.fileName) != nil)
        XCTAssertTrue(PathValidator.parsePopQuizFileName(second.fileName) != nil)
        XCTAssertEqual(first.timestamp, PopQuizTimestamp.string(now))
        XCTAssertEqual(second.timestamp, PopQuizTimestamp.string(now.addingTimeInterval(1)))

        let firstContent = try await repository.popQuizContent(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: first.timestamp
        )
        let secondContent = try await repository.popQuizContent(
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: second.timestamp
        )
        XCTAssertTrue(firstContent?.contains("First Pop Quiz") == true)
        XCTAssertTrue(secondContent?.contains("Second Pop Quiz") == true)
        let listed = try await repository.listPopQuizzes(courseId: "baf3m", lessonId: "01.01")
        XCTAssertEqual(listed.count, 2)
    }

    func testDeleteAndRestoreCustomTabsForLessonUnitAndCourse() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        let repository = CourseRepository(root: workspace.dataRoot)
        let scopes: [(GeneratedDocumentScope, String, String)] = [
            (.lesson("01.01"), "lesson_tab", "courses/baf3m/01.01.lesson_tab.md"),
            (.unit(1), "unit_tab", "courses/baf3m/01.unit.unit_tab.md"),
            (.course, "course_tab", "courses/baf3m/course.course_tab.md"),
        ]
        for (scope, tab, path) in scopes {
            _ = try await repository.createCustomDocument(
                courseId: "baf3m",
                scope: scope,
                tab: tab,
                content: "# \(tab)\n"
            )
            XCTAssertTrue(workspace.exists(path))
            let trash = try await repository.deleteCustomDocument(
                courseId: "baf3m",
                scope: scope,
                tab: tab
            )
            XCTAssertNotNil(trash)
            XCTAssertFalse(workspace.exists(path))

            let trashed = try await repository.listTrashedDocuments(courseId: "baf3m")
            let entry = try XCTUnwrap(trashed.first { $0.tab == tab })
            XCTAssertEqual(entry.fileName, String(path.split(separator: "/").last ?? ""))

            let restored = try await repository.restoreTrashedDocument(id: entry.id)
            XCTAssertEqual(restored.tab, tab)
            XCTAssertTrue(workspace.exists(path))
            XCTAssertEqual(try workspace.readString(path), "# \(tab)\n")
            let remaining = try await repository.listTrashedDocuments(courseId: "baf3m")
            XCTAssertFalse(remaining.contains { $0.id == entry.id })
        }
    }

    func testTrashIsNotExportedOrRestoredFromBackups() {
        XCTAssertEqual(
            BackupPolicy.decide(
                relativePath: ".trash/20260101-000000-abcd/01.01.vocab.md",
                context: .exporting,
                includeRawPackages: false
            ),
            .deny(reason: "hidden file .trash")
        )
        XCTAssertEqual(
            BackupPolicy.decide(
                relativePath: ".trash/20260101-000000-abcd/01.01.vocab.md",
                context: .importing,
                includeRawPackages: false
            ),
            .deny(reason: "hidden file .trash")
        )
    }

    func testGeneratedDocumentCompareAndSaveStillDetectsEditorWrite() async throws {
        let workspace = try TestWorkspace()
        try workspace.makeCourse()
        try workspace.write("old summary", to: "courses/baf3m/01.01.summary.md")
        let repository = CourseRepository(root: workspace.dataRoot)
        let snapshot = try await repository.documentSnapshot(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "summary"
        )
        _ = try await repository.compareAndSaveDocument(
            courseId: "baf3m",
            scope: .lesson("01.01"),
            tab: "summary",
            content: "editor write",
            expectedSHA256: snapshot.sha256
        )
        do {
            _ = try await repository.compareAndSaveGeneratedDocument(
                courseId: "baf3m",
                scope: .lesson("01.01"),
                tab: "summary",
                content: "generation write",
                expectedExistingSHA256: snapshot.sha256
            )
            XCTFail("Generation overwrote the editor's newer file")
        } catch let error as RepositoryError {
            guard case .concurrentModification = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
        XCTAssertEqual(try workspace.readString("courses/baf3m/01.01.summary.md"), "editor write")
    }
}
