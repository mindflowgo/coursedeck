@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

@MainActor
final class ReaderImagePlaceholderTests: XCTestCase {
    private func preparedImages() async throws -> (local: ReaderPreparedImage, remote: ReaderPreparedImage) {
        let markdown = """
        ![Missing local](assets/img/missing.png)

        ![Remote image](https://example.com/remote.png)
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
        let preparer = ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 800,
            document: document,
            allowRemoteImages: false
        )
        var local: ReaderPreparedImage?
        var remote: ReaderPreparedImage?
        for row in rows {
            let block = await preparer.prepare(row: row)
            if case let .image(image) = block {
                if image.allowsRemoteLoad { remote = image } else { local = image }
            }
        }
        return (try XCTUnwrap(local), try XCTUnwrap(remote))
    }

    func testMissingLocalImageUses120ptPlaceholder() async throws {
        let (local, _) = try await preparedImages()
        XCTAssertNil(local.image)
        XCTAssertNotNil(local.failure)
        XCTAssertFalse(local.allowsRemoteLoad)
        XCTAssertEqual(local.displaySize.height, 120, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(local.height, 120)

        let view = ImageBlockView(frame: CGRect(x: 0, y: 0, width: 800, height: local.height))
        let context = ReaderBlockContext(
            rowID: "row",
            documentID: "doc",
            theme: ReaderTestSupport.theme(),
            tableScrollState: TableScrollStateStore(),
            outerScrollView: nil,
            delegate: nil,
            isNested: false
        )
        view.configure(prepared: .image(local), context: context)
        view.layoutIfNeeded()
        let frames = view.placeholderFramesForTesting
        XCTAssertEqual(frames.placeholder.height, 120, accuracy: 0.5)
        XCTAssertLessThanOrEqual(frames.label.maxY, frames.placeholder.maxY)
        XCTAssertEqual(frames.button, .zero)
    }

    func testBlockedRemoteImageUses190ptPlaceholderAndFitsButton() async throws {
        let (_, remote) = try await preparedImages()
        XCTAssertNil(remote.image)
        XCTAssertTrue(remote.allowsRemoteLoad)
        XCTAssertEqual(remote.displaySize.height, 190, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(remote.height, 190)

        let view = ImageBlockView(frame: CGRect(x: 0, y: 0, width: 800, height: remote.height))
        let context = ReaderBlockContext(
            rowID: "row",
            documentID: "doc",
            theme: ReaderTestSupport.theme(),
            tableScrollState: TableScrollStateStore(),
            outerScrollView: nil,
            delegate: nil,
            isNested: false
        )
        view.configure(prepared: .image(remote), context: context)
        view.layoutIfNeeded()
        let frames = view.placeholderFramesForTesting
        XCTAssertEqual(frames.placeholder.height, 190, accuracy: 0.5)
        XCTAssertGreaterThan(frames.button.height, 0)
        XCTAssertLessThanOrEqual(frames.button.maxY, frames.placeholder.maxY)
        XCTAssertLessThanOrEqual(frames.label.maxY, frames.button.minY)
    }
}
