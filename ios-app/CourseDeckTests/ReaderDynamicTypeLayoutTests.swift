@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

@MainActor
final class ReaderDynamicTypeLayoutTests: XCTestCase {
    func testControllerProseAndTableDoNotClipAtAccessibilityXXXL() async throws {
        let longParagraph = String(repeating: "Long prose content for Dynamic Type layout. ", count: 80)
        let markdown = """
        # Accessibility layout

        \(longParagraph)

        | Account | Debit | Credit | Balance |
        |---|---:|---:|---:|
        | Cash | $1,500 | $0 | $1,500 |
        """
        let document = try ReaderTestSupport.document(markdown: markdown)

        let controller = ReaderViewController(
            document: document,
            initialPosition: nil,
            tableScrollState: TableScrollStateStore()
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        controller.beginAppearanceTransition(true, animated: false)
        controller.endAppearanceTransition()
        window.layoutIfNeeded()
        await controller.waitForInitialLoadForTesting()
        await controller.waitForRestoreForTesting()

        XCTAssertEqual(
            controller.themeForTesting().contentSizeCategory,
            .accessibilityExtraExtraExtraLarge
        )
        XCTAssertTrue(controller.visibleProseFitsForTesting())

        let theme = ReaderTestSupport.theme(category: .accessibilityExtraExtraExtraLarge)
        let table = ReaderTestSupport.table(
            header: ["Account", "Debit", "Credit", "Balance"],
            rows: [["Cash", "$1,500", "$0", "$1,500"]],
            alignments: [.left, .right, .right, .right]
        )
        let metrics = ReaderTestSupport.measure(table, width: 700, theme: theme)
        for cell in metrics.bodyCells {
            let needed = cell.attributed.boundingRect(
                with: CGSize(width: cell.textFrame.width, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                context: nil
            ).height
            XCTAssertLessThanOrEqual(
                needed,
                cell.textFrame.height + 1,
                "table cell text is clipped at Accessibility XXXL"
            )
        }
    }
}
