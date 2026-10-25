@testable import CourseDeck
import CourseDeckCore
import XCTest

@MainActor
final class TableAccessibilityTests: XCTestCase {
    func testTableExposesDimensionsHeadersAndCoordinates() throws {
        let theme = ReaderTestSupport.theme()
        let table = ReaderTestSupport.table(
            header: ["Account", "Debit"],
            rows: [["Cash", "$1,500"], ["Inventory", "$2,000"]],
            alignments: [.left, .right]
        )
        let metrics = ReaderTestSupport.measure(table, width: 500, theme: theme)
        let prepared = ReaderPreparedTable(
            table: table,
            metrics: metrics,
            headerAttributed: table.header.map { ReaderTestSupport.attributed($0.plainText, font: theme.tableHeader) },
            bodyAttributed: table.rows.map { row in
                row.map { ReaderTestSupport.attributed($0.plainText, font: theme.table) }
            },
            totalHeight: metrics.totalHeight
        )

        let grid = TableGridView(frame: CGRect(x: 0, y: 0, width: 500, height: 300))
        grid.configure(
            prepared: prepared,
            theme: theme,
            documentID: "doc",
            tableID: "table",
            stateStore: TableScrollStateStore(),
            outerScrollView: nil,
            isFullScreen: false
        )
        grid.layoutIfNeeded()

        XCTAssertTrue(grid.accessibilityLabel?.contains("2 rows") == true)
        XCTAssertTrue(grid.accessibilityLabel?.contains("2 columns") == true)
        XCTAssertTrue(grid.accessibilityLabel?.contains("Account") == true)

        let elements = (grid.accessibilityElements ?? []).compactMap { $0 as? UIAccessibilityElement }
        XCTAssertGreaterThan(elements.count, 3)
        let summary = try XCTUnwrap(elements.first)
        XCTAssertTrue(summary.accessibilityLabel?.contains("Table") == true)
        XCTAssertTrue(summary.accessibilityLabel?.contains("2 rows") == true)
        XCTAssertTrue(summary.accessibilityValue?.contains("Three-finger swipe") == true)

        let headers = elements.filter { $0.accessibilityTraits.contains(.header) }
        XCTAssertEqual(headers.count, 3)
        XCTAssertTrue(headers[1].accessibilityLabel?.contains("Account") == true)

        let body = elements.filter { $0.accessibilityTraits.contains(.staticText) }
        XCTAssertFalse(body.isEmpty)
        XCTAssertTrue(body[0].accessibilityValue?.contains("Row 1 of 2") == true)
        XCTAssertTrue(body[0].accessibilityValue?.contains("Header: Account") == true)
    }

    func testTableAccessibilityScrollIsHandled() {
        let theme = ReaderTestSupport.theme()
        let rows = (0..<40).map { ["Row \($0)", "\($0)"] }
        let table = ReaderTestSupport.table(header: ["Name", "Value"], rows: rows)
        let metrics = ReaderTestSupport.measure(table, width: 400, theme: theme)
        let prepared = ReaderPreparedTable(
            table: table,
            metrics: metrics,
            headerAttributed: table.header.map { ReaderTestSupport.attributed($0.plainText, font: theme.tableHeader) },
            bodyAttributed: table.rows.map { row in
                row.map { ReaderTestSupport.attributed($0.plainText, font: theme.table) }
            },
            totalHeight: metrics.totalHeight
        )
        let grid = TableGridView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        grid.configure(
            prepared: prepared,
            theme: theme,
            documentID: "doc",
            tableID: "table",
            stateStore: TableScrollStateStore(),
            outerScrollView: nil,
            isFullScreen: false
        )
        grid.layoutIfNeeded()
        XCTAssertTrue(grid.accessibilityScroll(.down))
    }
}
