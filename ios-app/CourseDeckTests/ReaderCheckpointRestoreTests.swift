@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

@MainActor
final class ReaderCheckpointRestoreTests: XCTestCase {
    private func deepDocument() throws -> (ReaderDocument, MarkdownDocument, String) {
        var markdown = "# Deep lesson\n\n"
        for index in 0..<8 {
            markdown += "Paragraph \(index). " + String(repeating: "Ledger prose. ", count: 40) + "\n\n"
        }
        markdown += "```text\nlet marker = true\n```\n\n"
        for index in 8..<16 {
            markdown += "Paragraph \(index). " + String(repeating: "Second prose. ", count: 40) + "\n\n"
        }
        markdown += "| A | B |\n|---|---|\n| 1 | 2 |\n\n"
        markdown += "TARGET-MARKER: this paragraph is the deep checkpoint anchor. "
        markdown += String(repeating: "Anchor prose. ", count: 60) + "\n\n"
        for index in 16..<24 {
            markdown += "Paragraph \(index). " + String(repeating: "Tail prose. ", count: 40) + "\n\n"
        }
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let target = try XCTUnwrap(
            parsed.blocks.first(where: { $0.plainText.contains("TARGET-MARKER") })?.id
        )
        return (document, parsed, target)
    }

    private var windows: [UIWindow] = []

    private func makeController(
        document: ReaderDocument,
        position: ReaderPosition?,
        deepLinkOffset: CGFloat = 0
    ) -> ReaderViewController {
        let controller = ReaderViewController(
            document: document,
            initialPosition: position,
            tableScrollState: TableScrollStateStore(),
            deepLinkOffset: deepLinkOffset
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        windows.append(window)
        controller.beginAppearanceTransition(true, animated: false)
        controller.endAppearanceTransition()
        return controller
    }

    func testDeepAnchorRestoresFromMeasuredProseAnchor() async throws {
        let (document, _, target) = try deepDocument()
        let controller = makeController(
            document: document,
            position: ReaderPosition(
                verticalPosition: 0,
                anchorBlockID: target,
                anchorFraction: 0.5
            )
        )
        await controller.waitForInitialLoadForTesting()
        await controller.waitForRestoreForTesting()

        let position = controller.currentPositionForTesting()
        XCTAssertEqual(position.anchorBlockID, target)
        XCTAssertGreaterThan(controller.contentOffsetForTesting().y, 0)
    }

    func testDeepLinkOffsetShowsPrecedingContext() async throws {
        let (document, _, target) = try deepDocument()
        let normal = makeController(
            document: document,
            position: ReaderPosition(verticalPosition: 0, anchorBlockID: target, anchorFraction: 0.5)
        )
        await normal.waitForInitialLoadForTesting()
        await normal.waitForRestoreForTesting()

        let deepLinked = makeController(
            document: document,
            position: ReaderPosition(verticalPosition: 0, anchorBlockID: target, anchorFraction: 0.5),
            deepLinkOffset: -60
        )
        await deepLinked.waitForInitialLoadForTesting()
        await deepLinked.waitForRestoreForTesting()

        let delta = normal.contentOffsetForTesting().y - deepLinked.contentOffsetForTesting().y
        XCTAssertEqual(delta, 60, accuracy: 2, "deep link should show 60 pt of preceding context")
    }

    func testRotationPreservesAnchorAfterReLayout() async throws {
        let (document, _, target) = try deepDocument()
        let controller = makeController(
            document: document,
            position: ReaderPosition(verticalPosition: 0, anchorBlockID: target, anchorFraction: 0.25)
        )
        await controller.waitForInitialLoadForTesting()
        await controller.waitForRestoreForTesting()
        let before = controller.currentPositionForTesting()
        XCTAssertEqual(before.anchorBlockID, target)

        controller.view.frame = CGRect(x: 0, y: 0, width: 768, height: 1_024)
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        try? await Task.sleep(nanoseconds: 300_000_000)
        await controller.waitForRestoreForTesting()

        let after = controller.currentPositionForTesting()
        XCTAssertEqual(after.anchorBlockID, target)
    }

    func testUserNoteJumpPreparesAnchorRow() async throws {
        let document = try ReaderTestSupport.sampleDocument()
        let parsed = MarkdownPipeline.parse(
            document.markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let anchor = try XCTUnwrap(parsed.userNotes.first?.anchorBlockID)
        let controller = makeController(document: document, position: nil)
        await controller.waitForInitialLoadForTesting()
        await controller.scrollToBlock(anchor)
        await controller.waitForRestoreForTesting()

        let position = controller.currentPositionForTesting()
        XCTAssertNotNil(position.anchorBlockID)
        XCTAssertTrue(
            controller.visibleBlockIDsForTesting().contains(anchor),
            "USERNOTE anchor row must be visible after the jump"
        )
    }

    func testClosedDetailsAncestorsExpandAndChildIsVisible() async throws {
        let markdown = """
        # Lesson

        <details>
        <summary>Show worked answer</summary>

        TARGET-DETAIL paragraph with **bold** content.

        </details>
        """
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let target = try XCTUnwrap(
            parsed.allBlockNodes.first(where: {
                if case .paragraph = $0.block { return $0.plainText.contains("TARGET-DETAIL") }
                return false
            })?.id
        )
        let detailsID = try XCTUnwrap(
            parsed.allBlockNodes.first(where: {
                if case .details = $0.block { return $0.plainText.contains("TARGET-DETAIL") }
                return false
            })?.id
        )
        let controller = makeController(document: document, position: nil)
        await controller.waitForInitialLoadForTesting()
        await controller.scrollToBlock(target)
        await controller.waitForRestoreForTesting()

        XCTAssertTrue(controller.expandedDetailsForTesting().contains(detailsID))
        XCTAssertTrue(controller.isBlockVisibleForTesting(target))
    }

    func testClosedDetailsInsideCalloutExpandsTargetChild() async throws {
        let markdown = """
        > [!NOTE] Worked answer
        > <details>
        > <summary>Show</summary>
        >
        > CALLOUT-TARGET paragraph with **bold**.
        > </details>
        """
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let target = try XCTUnwrap(
            parsed.allBlockNodes.first(where: {
                if case .paragraph = $0.block { return $0.plainText.contains("CALLOUT-TARGET") }
                return false
            })?.id
        )
        let detailsID = try XCTUnwrap(
            parsed.allBlockNodes.first(where: {
                if case .details = $0.block { return $0.plainText.contains("CALLOUT-TARGET") }
                return false
            })?.id
        )
        let controller = makeController(document: document, position: nil)
        await controller.waitForInitialLoadForTesting()
        await controller.scrollToBlock(target)
        await controller.waitForRestoreForTesting()

        XCTAssertTrue(controller.expandedDetailsForTesting().contains(detailsID))
        XCTAssertTrue(controller.isBlockVisibleForTesting(target))
    }

    func testPixelOnlyCheckpointMeasuresRowsBeforeClamping() async throws {
        let (document, parsed, target) = try deepDocument()
        let rows = ReaderRowPlanner.plan(document: parsed)
        let preparer = ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 1_024,
            document: document,
            allowRemoteImages: false
        )
        var targetRowStart: CGFloat?
        var cumulative: CGFloat = 0
        var slices: [ReaderPositionCalculator.RowSlice] = []
        for row in rows {
            let block = await preparer.prepare(row: row)
            slices.append(.init(blockIDs: row.blockIDs, height: block.height))
            if row.blockIDs.contains(target), targetRowStart == nil {
                targetRowStart = cumulative
                break
            }
            cumulative += block.height
        }
        let rowStart = try XCTUnwrap(targetRowStart)
        let pixel = rowStart + 40
        let calculated = ReaderPositionCalculator.position(at: pixel, rows: slices)
        XCTAssertEqual(calculated.anchorBlockID, target)

        let controller = makeController(
            document: document,
            position: ReaderPosition(
                verticalPosition: Double(pixel),
                anchorBlockID: nil,
                anchorFraction: 0
            )
        )
        await controller.waitForInitialLoadForTesting()
        await controller.waitForRestoreForTesting()

        XCTAssertTrue(controller.isBlockVisibleForTesting(target))
    }

    func testExactSaveAfterDeepJumpWhileRowsAboveAreUnprepared() async throws {
        var markdown = "# Long lesson\n\n"
        for index in 0..<30 {
            markdown += "## Section \(index)\n\n"
            markdown += "Paragraph \(index). " + String(repeating: "Read carefully. ", count: 20) + "\n\n"
            markdown += "```text\nlet value\(index) = \(index)\n```\n\n"
        }
        let document = try ReaderTestSupport.document(markdown: markdown)
        let controller = makeController(document: document, position: nil)
        await controller.waitForInitialLoadForTesting()

        var received: ReaderPosition?
        let expectation = expectation(description: "background exact save")
        expectation.assertForOverFulfill = false
        controller.onPositionChange = { position in
            if received == nil { received = position }
            expectation.fulfill()
        }
        controller.setContentOffsetForTesting(2_400)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        await fulfillment(of: [expectation], timeout: 10)
        XCTAssertNotNil(received?.anchorBlockID)
    }

    func testDeepAnchorAfterFiveHundredRowTable() async throws {
        var markdown = "# Ledger lesson\n\n"
        markdown += "| Date | Description | Debit | Credit | Balance |\n"
        markdown += "|---|---|---:|---:|---:|\n"
        for index in 0..<500 {
            markdown += "| 2026-01-01 | Entry \(index) | $\(index) | $0 | $\(index) |\n"
        }
        markdown += "\nTARGET-AFTER-TABLE paragraph after a very large ledger.\n"
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let target = try XCTUnwrap(
            parsed.blocks.first(where: { $0.plainText.contains("TARGET-AFTER-TABLE") })?.id
        )
        let started = Date()
        let controller = makeController(
            document: document,
            position: ReaderPosition(verticalPosition: 0, anchorBlockID: target, anchorFraction: 0)
        )
        await controller.waitForInitialLoadForTesting()
        await controller.waitForRestoreForTesting()
        let elapsed = Date().timeIntervalSince(started)

        XCTAssertTrue(controller.isBlockVisibleForTesting(target))
        XCTAssertLessThan(elapsed, 8.0, "deep restore after a 500-row table took \(elapsed)s")
    }
}
