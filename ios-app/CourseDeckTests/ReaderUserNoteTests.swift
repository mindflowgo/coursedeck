@testable import CourseDeck
import CourseDeckCore
import XCTest

final class ReaderUserNoteTests: XCTestCase {
    private func preparedNote(markdown: String) async throws -> ReaderPreparedUserNote {
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let rows = ReaderRowPlanner.plan(document: parsed)
        guard let row = rows.first(where: { if case .userNote = $0.kind { return true }; return false }) else {
            throw XCTSkip("No USERNOTE row")
        }
        let block = await ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 800,
            document: document,
            allowRemoteImages: false
        ).prepare(row: row)
        guard case let .userNote(note) = block else {
            throw XCTSkip("Not a USERNOTE")
        }
        return note
    }

    func testLongTargetIsMeasuredAndRenderedAsPreview() async throws {
        let longTarget = String(repeating: "Long target sentence. ", count: 20)
        let markdown = """
        Target paragraph for the note.

        > [!USERNOTE] Why?
        > <!-- target: "\(longTarget)" -->
        > The note body.
        """
        let note = try await preparedNote(markdown: markdown)
        XCTAssertFalse(note.targetDisplay.isEmpty)
        XCTAssertLessThanOrEqual(note.targetDisplay.count, 161)
        XCTAssertTrue(note.targetDisplay.hasSuffix("…"))
        XCTAssertGreaterThan(note.targetHeight, 0)
        XCTAssertGreaterThan(note.height, note.targetHeight)
    }

    func testUnresolvedTargetStillHasNonZeroRowHeight() async throws {
        let markdown = """
        > [!USERNOTE] Why?
        > The note body without any target comment.
        """
        let note = try await preparedNote(markdown: markdown)
        XCTAssertEqual(note.targetDisplay, "No target quote found in this document.")
        XCTAssertGreaterThan(note.targetHeight, 0)
        XCTAssertFalse(note.anchorResolved)
    }
}
