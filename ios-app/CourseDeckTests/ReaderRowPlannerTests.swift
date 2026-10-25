@testable import CourseDeck
import CourseDeckCore
import XCTest

final class ReaderRowPlannerTests: XCTestCase {
    private func sampleRows() throws -> (MarkdownDocument, [ReaderRow]) {
        let parsed = MarkdownPipeline.parse(
            ReaderSampleDocument.markdown,
            options: MarkdownPipelineOptions()
        )
        return (parsed, ReaderRowPlanner.plan(document: parsed))
    }

    func testSampleProducesEveryReaderRowKind() throws {
        let (_, rows) = try sampleRows()
        XCTAssertFalse(rows.isEmpty)
        XCTAssertTrue(rows.contains { if case .prose = $0.kind { return true }; return false })
        XCTAssertTrue(rows.contains { if case .table = $0.kind { return true }; return false })
        XCTAssertTrue(rows.contains { if case .taskList = $0.kind { return true }; return false })
        XCTAssertTrue(rows.contains { if case .details = $0.kind { return true }; return false })
        XCTAssertTrue(rows.contains { if case .userNote = $0.kind { return true }; return false })
        XCTAssertTrue(rows.contains { if case .code = $0.kind { return true }; return false })
        XCTAssertTrue(rows.contains { if case .image = $0.kind { return true }; return false })
        XCTAssertTrue(rows.contains { if case .mathBlock = $0.kind { return true }; return false })
    }

    func testConsecutiveProseBlocksShareOneSelectableRun() throws {
        let markdown = """
        # Heading

        First paragraph.

        Second paragraph.

        | A | B |
        |---|---|
        | 1 | 2 |
        """
        let parsed = MarkdownPipeline.parse(markdown)
        let rows = ReaderRowPlanner.plan(document: parsed)
        guard case let .prose(run)? = rows.first?.kind else {
            return XCTFail("Expected a prose run first")
        }
        XCTAssertEqual(run.segments.count, 3)
        XCTAssertEqual(run.blockIDs.count, 3)
        XCTAssertEqual(rows.filter { if case .prose = $0.kind { return true }; return false }.count, 1)
    }

    func testTaskListIsIsolatedAndReadOnlyModel() throws {
        let markdown = """
        - [x] Done
        - [ ] Not done
        """
        let parsed = MarkdownPipeline.parse(markdown)
        let rows = ReaderRowPlanner.plan(document: parsed)
        XCTAssertEqual(rows.count, 1)
        guard case let .taskList(list) = rows[0].kind else {
            return XCTFail("Expected task list row")
        }
        XCTAssertEqual(list.items.count, 2)
        XCTAssertEqual(list.items[0].checked, true)
        XCTAssertEqual(list.items[1].checked, false)
    }

    func testDetailsStartsCollapsedUnlessOpenAttribute() throws {
        let closed = MarkdownPipeline.parse("<details><summary>More</summary>Body</details>")
        let closedRows = ReaderRowPlanner.plan(document: closed)
        guard case let .details(closedDetails)? = closedRows.first?.kind else {
            return XCTFail("Expected details row")
        }
        XCTAssertFalse(closedDetails.isOpen)
        XCTAssertTrue(closedRows[0].expandedBlockIDs.isEmpty)

        let open = MarkdownPipeline.parse("<details open><summary>More</summary>Body</details>")
        let openRows = ReaderRowPlanner.plan(document: open)
        guard case let .details(openDetails)? = openRows.first?.kind else {
            return XCTFail("Expected details row")
        }
        XCTAssertTrue(openDetails.isOpen)
        XCTAssertEqual(openRows[0].expandedBlockIDs.count, 1)
    }

    func testUserNoteAnchorIsResolvedAndRowContainsNestedID() throws {
        let (document, rows) = try sampleRows()
        XCTAssertFalse(document.userNotes.isEmpty)
        let note = try XCTUnwrap(document.userNotes.first)
        XCTAssertNotNil(note.anchorBlockID)
        let noteRow = try XCTUnwrap(rows.first { if case .userNote = $0.kind { return true }; return false })
        XCTAssertTrue(noteRow.blockIDs.contains(noteRow.id))
    }

    func testTableRowsKeepSurplusColumnModel() throws {
        let markdown = """
        | A | B |
        |---|---|
        | 1 | 2 | 3 |
        """
        let parsed = MarkdownPipeline.parse(markdown)
        let rows = ReaderRowPlanner.plan(document: parsed)
        guard case let .table(table)? = rows.first?.kind else {
            return XCTFail("Expected table row")
        }
        XCTAssertEqual(table.columnCount, 3)
        XCTAssertEqual(table.rows[0].count, 3)
        XCTAssertEqual(table.rows[0][2].plainText, "3")
    }
}
