@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

final class ReaderPreparerTests: XCTestCase {
    func testSampleRowsAreFullyMeasured() async throws {
        let document = try ReaderTestSupport.sampleDocument()
        let parsed = MarkdownPipeline.parse(document.markdown, options: MarkdownPipelineOptions(
            courseDirectoryURL: document.courseDirectoryURL,
            courseID: document.courseId
        ))
        let rows = ReaderRowPlanner.plan(document: parsed)
        XCTAssertFalse(rows.isEmpty)

        let theme = ReaderTestSupport.theme()
        let preparer = ReaderPreparer(
            theme: theme,
            width: 1_024,
            document: document,
            allowRemoteImages: false
        )

        var sawProse = false
        var sawTable = false
        var sawTasks = false
        var sawDetails = false
        var sawImage = false
        for row in rows {
            let block = await preparer.prepare(row: row)
            XCTAssertGreaterThan(block.height, 0, "row \(row.id) has no height")
            switch block {
            case .prose:
                sawProse = true
            case .table:
                sawTable = true
            case .taskList:
                sawTasks = true
            case .details:
                sawDetails = true
            case .image:
                sawImage = true
            default:
                break
            }
        }
        XCTAssertTrue(sawProse)
        XCTAssertTrue(sawTable)
        XCTAssertTrue(sawTasks)
        XCTAssertTrue(sawDetails)
        XCTAssertTrue(sawImage)

        var firstProse: ReaderPreparedProse?
        for row in rows {
            guard case .prose = row.kind else { continue }
            let prepared = await preparer.prepare(row: row)
            if case let .prose(value) = prepared {
                firstProse = value
                break
            }
        }
        let proseBlock = try XCTUnwrap(firstProse)
        XCTAssertGreaterThan(proseBlock.attributed.length, 20)
        XCTAssertFalse(proseBlock.anchors.isEmpty)
    }

    func testExpandedDetailsIsTallerThanCollapsed() async throws {
        let document = try ReaderTestSupport.sampleDocument()
        let parsed = MarkdownPipeline.parse(document.markdown, options: MarkdownPipelineOptions(
            courseDirectoryURL: document.courseDirectoryURL,
            courseID: document.courseId
        ))
        let rows = ReaderRowPlanner.plan(document: parsed)
        guard let detailsRow = rows.first(where: { if case .details = $0.kind { return true }; return false }) else {
            return XCTFail("Expected a details row")
        }
        let theme = ReaderTestSupport.theme()
        let collapsed = await ReaderPreparer(
            theme: theme,
            width: 1_024,
            document: document,
            allowRemoteImages: false,
            expandedBlockIDs: []
        ).prepare(row: detailsRow)
        let expanded = await ReaderPreparer(
            theme: theme,
            width: 1_024,
            document: document,
            allowRemoteImages: false,
            expandedBlockIDs: [detailsRow.id]
        ).prepare(row: detailsRow)
        XCTAssertGreaterThan(expanded.height, collapsed.height)
    }

    func testTaskListIsReadOnlyAndKeepsCheckedState() async throws {
        let markdown = """
        - [x] Done
        - [ ] Not done
        """
        let document = ReaderDocument(
            courseId: "sample",
            courseTitle: "Sample",
            target: ReaderTarget(courseId: "sample", scope: .lesson("sample"), tab: "lesson"),
            title: "Sample",
            file: "sample.lesson.md",
            markdown: markdown,
            courseDirectoryURL: FileManager.default.temporaryDirectory,
            supportsCheckpoints: false,
            isReadOnly: true
        )
        let parsed = MarkdownPipeline.parse(markdown)
        let rows = ReaderRowPlanner.plan(document: parsed)
        let block = await ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 800,
            document: document,
            allowRemoteImages: false
        ).prepare(row: rows[0])
        guard case let .taskList(tasks) = block else {
            return XCTFail("Expected task list")
        }
        XCTAssertEqual(tasks.items.map(\.checked), [true, false])
        XCTAssertEqual(tasks.items.map(\.text), ["Done", "Not done"])
    }
}
