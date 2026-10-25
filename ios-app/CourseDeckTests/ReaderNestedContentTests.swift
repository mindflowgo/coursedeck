@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

final class ReaderNestedContentTests: XCTestCase {
    private func preparedRow(markdown: String) async throws -> ReaderPreparedBlock {
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let rows = ReaderRowPlanner.plan(document: parsed)
        let row = try XCTUnwrap(rows.first)
        return await ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 800,
            document: document,
            allowRemoteImages: false
        ).prepare(row: row)
    }

    func testNestedListProseKeepsBoldFormatting() async throws {
        let markdown = """
        - Parent item
          - **Bold child**
        """
        let block = try await preparedRow(markdown: markdown)
        guard case let .prose(prose) = block else {
            return XCTFail("Expected prose list")
        }
        let string = prose.attributed.string as NSString
        let range = string.range(of: "Bold child")
        XCTAssertNotEqual(range.location, NSNotFound)
        let font = prose.attributed.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(try XCTUnwrap(font).fontDescriptor.symbolicTraits.contains(.traitBold))
    }

    func testTaskListWithRichNestedTableUsesContainerAndPreservesTable() async throws {
        let markdown = """
        - [x] Reconcile $x^2$
          | Account | Amount |
          |---|---:|
          | Cash | $1,500 |
        """
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let rows = ReaderRowPlanner.plan(document: parsed)
        let row = try XCTUnwrap(rows.first)
        guard case let .list(list) = row.kind else {
            return XCTFail("A task list with a nested table must route to the rich list container")
        }
        XCTAssertTrue(list.items.contains(where: { $0.checked != nil }))
        XCTAssertTrue(ReaderRowPlanner.hasRichNestedTaskContent(list))

        let block = await ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 800,
            document: document,
            allowRemoteImages: false
        ).prepare(row: row)
        guard case let .callout(container) = block else {
            return XCTFail("Expected list container")
        }
        XCTAssertTrue(container.children.contains { if case .table = $0.block { return true }; return false })
        guard case let .prose(itemProse)? = container.children.first?.block else {
            return XCTFail("Expected item prose")
        }
        XCTAssertTrue(itemProse.attributed.string.contains("☑"))
    }

    func testNestedTableInPlainListIsPreserved() async throws {
        let markdown = """
        - Parent
          | A | B |
          |---|---|
          | 1 | 2 |
        """
        let block = try await preparedRow(markdown: markdown)
        guard case let .callout(container) = block else {
            return XCTFail("Expected list container")
        }
        XCTAssertTrue(container.children.contains { if case .table = $0.block { return true }; return false })
    }

    func testTaskItemWithNestedParagraphMathImageAndListIsRich() async throws {
        let markdown = """
        - [x] Task parent
            Nested paragraph with $x^2$ and ![alt text](assets/img/missing.png).

            - nested item one
        """
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let rows = ReaderRowPlanner.plan(document: parsed)
        let row = try XCTUnwrap(rows.first)
        guard case let .list(list) = row.kind else {
            return XCTFail("Task item with nested blocks must route through the rich list container")
        }
        XCTAssertTrue(list.items.contains(where: { $0.checked != nil && !$0.blocks.isEmpty }))

        let block = await ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 800,
            document: document,
            allowRemoteImages: false
        ).prepare(row: row)
        guard case let .callout(container) = block else {
            return XCTFail("Expected list container")
        }

        var nestedProseText = ""
        var hasTeX = false
        var imageAltFound = false
        for child in container.children {
            guard case let .prose(prose) = child.block else { continue }
            nestedProseText += prose.attributed.string
            prose.attributed.enumerateAttribute(
                .readerTeX,
                in: NSRange(location: 0, length: prose.attributed.length)
            ) { value, _, _ in
                if value != nil { hasTeX = true }
            }
            if prose.attributed.string.contains("alt text") { imageAltFound = true }
        }
        XCTAssertTrue(nestedProseText.contains("Nested paragraph"))
        XCTAssertTrue(hasTeX, "nested inline math must survive")
        XCTAssertTrue(imageAltFound, "nested image alt text must survive")
        XCTAssertTrue(
            container.children.contains { child in
                if case let .callout(nested) = child.block { return nested.kind == .list }
                return false
            },
            "nested simple list must survive"
        )
    }
}
