@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

@MainActor
final class ReaderBackgroundTests: XCTestCase {
    private func preparedBlocksByKind() async throws -> [String: ReaderPreparedBlock] {
        let document = try ReaderTestSupport.sampleDocument()
        let parsed = MarkdownPipeline.parse(
            document.markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let rows = ReaderRowPlanner.plan(document: parsed)
        let preparer = ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 1_024,
            document: document,
            allowRemoteImages: false
        )
        var output: [String: ReaderPreparedBlock] = [:]
        for row in rows {
            let block = await preparer.prepare(row: row)
            switch block {
            case .callout: output["callout"] = block
            case .details: output["details"] = block
            case .userNote: output["usernote"] = block
            case .code: output["code"] = block
            case .fallback: output["fallback"] = block
            default: break
            }
        }
        return output
    }

    func testContainerBackgroundsSurviveConfigure() async throws {
        let blocks = try await preparedBlocksByKind()
        let theme = ReaderTestSupport.theme()
        let context = ReaderBlockContext(
            rowID: "row",
            documentID: "doc",
            theme: theme,
            tableScrollState: TableScrollStateStore(),
            outerScrollView: nil,
            delegate: nil,
            isNested: false
        )
        for (name, block) in blocks {
            let view = ReaderBlockViewFactory.make(prepared: block)
            view.frame = CGRect(x: 0, y: 0, width: 700, height: 220)
            view.configure(prepared: block, context: context)
            view.layoutIfNeeded()
            XCTAssertGreaterThan(
                view.backgroundColor?.cgColor.alpha ?? 0,
                0.01,
                "\(name) background was cleared by ReaderBlockView.configure"
            )
        }
        XCTAssertNotNil(blocks["callout"])
        XCTAssertNotNil(blocks["details"])
        XCTAssertNotNil(blocks["usernote"])
        XCTAssertNotNil(blocks["code"])
    }
}
