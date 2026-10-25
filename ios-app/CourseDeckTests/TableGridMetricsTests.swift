@testable import CourseDeck
import CourseDeckCore
import XCTest

final class TableGridMetricsTests: XCTestCase {
    func testColumnsFitAvailableWidthWhenPossible() {
        let table = ReaderTestSupport.table(
            header: ["Account", "Debit", "Credit", "Balance"],
            rows: [
                ["Cash", "$1,500", "$0", "$1,500"],
                ["Inventory", "$2,000", "$1,500", "$500"],
            ],
            alignments: [.left, .right, .right, .right]
        )
        let theme = ReaderTestSupport.theme()
        let metrics = ReaderTestSupport.measure(table, width: 800, theme: theme)
        XCTAssertEqual(metrics.columnCount, 4)
        XCTAssertEqual(metrics.rowCount, 2)
        XCTAssertLessThanOrEqual(metrics.totalWidth, 801)
        XCTAssertFalse(metrics.hasHorizontalOverflow)
        XCTAssertEqual(metrics.bodyCells.count, 8)
        XCTAssertEqual(metrics.headerCells.count, 4)
        XCTAssertEqual(metrics.columnAlignments[1], .right)
    }

    func testWideTableScrollsHorizontally() {
        let table = ReaderTestSupport.table(
            header: ["A very long account description", "Debit", "Credit", "Balance", "Note"],
            rows: [
                ["A long description that cannot fit in a narrow phone width", "$1,500", "$0", "$1,500", "Opening"],
            ]
        )
        let theme = ReaderTestSupport.theme()
        let metrics = ReaderTestSupport.measure(table, width: 320, theme: theme)
        XCTAssertTrue(metrics.hasHorizontalOverflow)
        XCTAssertGreaterThan(metrics.totalWidth, 320)
        XCTAssertEqual(metrics.columnWidths.count, 5)
        XCTAssertTrue(metrics.columnWidths.allSatisfy { $0 >= TableGridMeasurer.minColumnWidth })
    }

    func testEmptyCellsOccupyTheirColumn() {
        let table = ReaderTestSupport.table(
            header: ["Name", "P.R.", "Credit"],
            rows: [["Widget", "", "$12"]]
        )
        let theme = ReaderTestSupport.theme()
        let metrics = ReaderTestSupport.measure(table, width: 600, theme: theme)
        XCTAssertEqual(metrics.bodyCells[1].plainText, "")
        XCTAssertGreaterThan(metrics.bodyCells[1].frame.width, 0)
        XCTAssertEqual(metrics.bodyCells[2].plainText, "$12")
    }

    func testColspanAndRowspanProduceCoveringFrames() {
        var table = ReaderTestSupport.table(
            header: ["Grouped header", "B", "C"],
            rows: [
                ["wide cell", "b1", "c1"],
                ["a2", "b2", "c2"],
            ]
        )
        table.header[0] = ReaderTestSupport.cell("Grouped header", span: 2, header: true)
        var secondRow = table.rows[0]
        secondRow[0] = ReaderTestSupport.cell("wide cell", rowSpan: 2)
        table.rows[0] = secondRow

        let theme = ReaderTestSupport.theme()
        let metrics = ReaderTestSupport.measure(table, width: 700, theme: theme)
        guard let header = metrics.headerCells.first else {
            return XCTFail("Expected a header cell")
        }
        XCTAssertEqual(header.colSpan, 2)
        XCTAssertGreaterThan(header.frame.width, metrics.columnWidths[0])
    }

    func testFiveHundredRowLedgerKeepsEveryCell() {
        let header = ["Date", "Description", "Debit", "Credit", "Balance"]
        var rows: [[String]] = []
        rows.reserveCapacity(500)
        for index in 0..<500 {
            rows.append(["2026-01-\(String(format: "%02d", (index % 28) + 1))", "Entry \(index)", "$\(index)", "$0", "$\(index)"])
        }
        let table = ReaderTestSupport.table(header: header, rows: rows)
        let theme = ReaderTestSupport.theme()
        let started = Date()
        let metrics = ReaderTestSupport.measure(table, width: 1_024, theme: theme)
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertEqual(metrics.rowCount, 500)
        XCTAssertEqual(metrics.bodyCells.count, 2_500)
        XCTAssertEqual(metrics.viewportHeight(maxHeight: 480), 480, accuracy: 0.5)
        XCTAssertGreaterThan(metrics.bodyHeight, 480)
        // A generous ceiling; this is a smoke test, not a benchmark gate.
        XCTAssertLessThan(elapsed, 5.0)
    }

    func testHeaderOnlyTable() {
        let table = ReaderTestSupport.table(header: ["A", "B"], rows: [])
        let metrics = ReaderTestSupport.measure(table, width: 500, theme: ReaderTestSupport.theme())
        XCTAssertEqual(metrics.rowCount, 0)
        XCTAssertEqual(metrics.bodyHeight, 0)
        XCTAssertEqual(metrics.headerCells.count, 2)
        XCTAssertEqual(metrics.viewportHeight(maxHeight: 480), metrics.headerHeight, accuracy: 0.5)
    }

    func testDynamicTypeIncreasesRowHeight() {
        let table = ReaderTestSupport.table(
            header: ["Item"],
            rows: [["A sentence that wraps across several lines at a large Dynamic Type size."]]
        )
        let normal = ReaderTestSupport.measure(table, width: 320, theme: ReaderTestSupport.theme(category: .large))
        let large = ReaderTestSupport.measure(
            table,
            width: 320,
            theme: ReaderTestSupport.theme(category: .accessibilityExtraExtraExtraLarge)
        )
        XCTAssertGreaterThan(large.rowHeights[0], normal.rowHeights[0])
    }
}
