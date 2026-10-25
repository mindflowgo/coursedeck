@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

@MainActor
final class TableFullScreenStateTests: XCTestCase {
    private func preparedTable(width: CGFloat, rows: Int = 40) -> ReaderPreparedTable {
        let theme = ReaderTestSupport.theme()
        let header = ["Date", "Description", "Debit", "Credit", "Balance", "Note"]
        let body = (0..<rows).map { index in
            ["2026-01-01", "Entry \(index)", "$\(index)", "$0", "$\(index)", "Memo \(index)"]
        }
        let table = ReaderTestSupport.table(header: header, rows: body)
        let metrics = ReaderTestSupport.measure(table, width: width, theme: theme)
        return ReaderPreparedTable(
            table: table,
            metrics: metrics,
            headerAttributed: table.header.map { ReaderTestSupport.attributed($0.plainText, font: theme.tableHeader) },
            bodyAttributed: table.rows.map { row in
                row.map { ReaderTestSupport.attributed($0.plainText, font: theme.table) }
            },
            totalHeight: metrics.totalHeight
        )
    }

    func testStoredOffsetsSurviveReconfigureWithNewMetrics() {
        let theme = ReaderTestSupport.theme()
        let store = TableScrollStateStore()
        let grid = TableGridView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        let preparedA = preparedTable(width: 400)
        grid.configure(
            prepared: preparedA,
            theme: theme,
            documentID: "doc",
            tableID: "table",
            stateStore: store,
            outerScrollView: nil,
            isFullScreen: false
        )
        grid.layoutIfNeeded()
        store.setState(
            TableScrollStateStore.State(horizontal: 40, vertical: 60),
            documentID: "doc",
            tableID: "table"
        )
        grid.applyStoredState()
        grid.layoutIfNeeded()
        XCTAssertEqual(grid.currentScrollOffset().x, 40, accuracy: 1)
        XCTAssertEqual(grid.currentScrollOffset().y, 60, accuracy: 1)

        // Simulate the full-screen remeasure installing new metrics. Layout
        // must run before applyStoredState or restoreStateIfNeeded sees the
        // old/zero content size.
        let preparedB = preparedTable(width: 700)
        grid.configure(
            prepared: preparedB,
            theme: theme,
            documentID: "doc",
            tableID: "table",
            stateStore: store,
            outerScrollView: nil,
            isFullScreen: true
        )
        grid.layoutIfNeeded()
        grid.applyStoredState()
        grid.layoutIfNeeded()
        XCTAssertEqual(grid.currentScrollOffset().x, 40, accuracy: 1)
        XCTAssertEqual(grid.currentScrollOffset().y, 60, accuracy: 1)
    }
}
