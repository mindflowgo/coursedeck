@testable import CourseDeck
import CourseDeckCore
import XCTest

final class CheckpointRoundTripTests: XCTestCase {
    func testIOSPositionCheckpointJSONIsReadableByDesktopSchema() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("CheckpointRoundTrip-\(UUID().uuidString)", isDirectory: true)
        let root = DataRoot(rootURL: rootURL)
        try root.prepare()
        let repository = CheckpointRepository(root: root)

        let recorded = try await repository.recordPosition(
            courseId: "baf3m",
            file: "01.01.lesson.md",
            verticalPosition: 1_234,
            anchorBlockID: "b-deadbeefdeadbeef",
            anchorFraction: 0.42,
            date: "2026-10-25T12:00:00.000Z"
        )

        let checkpointURL = try await repository.checkpointURL(courseId: "baf3m")
        let data = try Data(contentsOf: checkpointURL)
        let json = try JSONValue(parsing: data)
        let entries = try XCTUnwrap(json.arrayValue)
        let entry = try XCTUnwrap(entries.first?.objectValue)
        let fields = Dictionary(uniqueKeysWithValues: entry.map { ($0.key, $0.value) })

        XCTAssertEqual(fields["file"]?.stringValue, "01.01.lesson.md")
        XCTAssertEqual(fields["verticalPosition"]?.doubleValue, 1_234)
        XCTAssertEqual(fields["anchorBlockID"]?.stringValue, "b-deadbeefdeadbeef")
        XCTAssertEqual(fields["anchorFraction"]?.doubleValue, 0.42)
        XCTAssertEqual(fields["type"]?.stringValue, "position")

        // Desktop reads the same top-level array schema.
        let desktopRead = try CheckpointDocument(data: data)
        let decoded = try XCTUnwrap(desktopRead.checkpoints.first)
        XCTAssertEqual(decoded.id, recorded.id)
        XCTAssertEqual(decoded.verticalPosition, 1_234)
        XCTAssertEqual(decoded.anchorBlockID, "b-deadbeefdeadbeef")
        XCTAssertEqual(decoded.anchorFraction ?? 0, 0.42, accuracy: 0.0001)
    }

    func testCourseNavigationCheckpointFileRoundTripsWithoutWriting() throws {
        let target = try XCTUnwrap(ReaderTarget.from(file: "course.lesson.md", courseId: "baf3m"))
        XCTAssertEqual(target.scope, .course)
        XCTAssertEqual(target.tab, "lesson")
        XCTAssertEqual(try target.fileName(), "course.lesson.md")

        let document = ReaderDocument(
            courseId: "baf3m",
            courseTitle: "BAF3M",
            target: target,
            title: "Course navigation",
            file: "course.lesson.md",
            markdown: "# Navigation",
            courseDirectoryURL: FileManager.default.temporaryDirectory,
            supportsCheckpoints: false,
            isReadOnly: true
        )
        XCTAssertFalse(ReaderSavePolicy.canSave(document: document, isWritable: true))
        XCTAssertFalse(ReaderSavePolicy.canSave(document: document, isWritable: false))
    }

    func testReadOnlyGateBlocksPositionWrites() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("ReadOnlyCheckpoint-\(UUID().uuidString)", isDirectory: true)
        let gate = WriteGate()
        gate.block(reason: "test read-only")
        let root = DataRoot(rootURL: rootURL, writeGate: gate)
        try? root.prepare()
        let repository = CheckpointRepository(root: root)
        do {
            _ = try await repository.recordPosition(
                courseId: "baf3m",
                file: "01.01.lesson.md",
                verticalPosition: 10,
                anchorBlockID: "b-1",
                anchorFraction: 0
            )
            XCTFail("Expected blocked write")
        } catch {
            XCTAssertTrue(error is WriteBlockedError || error is RepositoryError)
        }
    }

    func testSavePolicyRequiresWritableRootAndCheckpointSupport() throws {
        let target = ReaderTarget(courseId: "baf3m", scope: .lesson("01.01"), tab: "lesson")
        let writable = ReaderDocument(
            courseId: "baf3m",
            courseTitle: "BAF3M",
            target: target,
            title: "Lesson",
            file: "01.01.lesson.md",
            markdown: "Body",
            courseDirectoryURL: FileManager.default.temporaryDirectory,
            supportsCheckpoints: true,
            isReadOnly: false
        )
        XCTAssertTrue(ReaderSavePolicy.canSave(document: writable, isWritable: true))
        XCTAssertFalse(ReaderSavePolicy.canSave(document: writable, isWritable: false))

        var readOnly = writable
        readOnly.isReadOnly = true
        XCTAssertFalse(ReaderSavePolicy.canSave(document: readOnly, isWritable: true))

        var noCheckpoints = writable
        noCheckpoints.supportsCheckpoints = false
        XCTAssertFalse(ReaderSavePolicy.canSave(document: noCheckpoints, isWritable: true))
        XCTAssertFalse(ReaderSavePolicy.canSave(document: nil, isWritable: true))
    }

    @MainActor
    func testCheckpointHubOpeningUsesDeepLinkOffset() {
        let checkpoint = Checkpoint(
            id: "cp_note_1",
            file: "01.01.lesson.md",
            verticalPosition: 500,
            type: .note,
            color: "yellow",
            noteText: "Important",
            date: "2026-10-25T12:00:00.000Z",
            anchorBlockID: "b-1",
            anchorFraction: 0.5
        )
        let model = ReaderModel(
            request: .target(ReaderTarget(courseId: "baf3m", scope: .lesson("01.01"), tab: "lesson")),
            startCheckpoint: checkpoint
        )
        XCTAssertEqual(model.initialOffsetAdjustment, -60)
        let normal = ReaderModel(
            request: .target(ReaderTarget(courseId: "baf3m", scope: .lesson("01.01"), tab: "lesson"))
        )
        XCTAssertEqual(normal.initialOffsetAdjustment, 0)
    }
}
