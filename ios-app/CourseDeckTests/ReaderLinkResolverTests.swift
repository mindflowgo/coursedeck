@testable import CourseDeck
import CourseDeckCore
import XCTest

final class ReaderLinkResolverTests: XCTestCase {
    private func makeCourseDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("LinkResolver-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent("assets/alt", isDirectory: true),
            withIntermediateDirectories: true
        )
        try Data("<html></html>".utf8).write(
            to: directory.appendingPathComponent("assets/alt/guide.html")
        )
        return directory
    }

    func testParentRelativeAssetResolvesInsideCourse() throws {
        let directory = try makeCourseDirectory()
        let url = try XCTUnwrap(URL(string: "../assets/alt/guide.html"))
        guard case let .localFile(file) = ReaderLinkResolver.resolve(url, courseDirectoryURL: directory) else {
            return XCTFail("Expected a local file outcome")
        }
        XCTAssertEqual(file.lastPathComponent, "guide.html")
        XCTAssertTrue(file.path.contains("/assets/alt/"))
    }

    func testFragmentBecomesBlockJump() throws {
        let directory = try makeCourseDirectory()
        let url = try XCTUnwrap(URL(string: "#deep-anchor"))
        XCTAssertEqual(
            ReaderLinkResolver.resolve(url, courseDirectoryURL: directory),
            .fragment("deep-anchor")
        )
    }

    func testMissingPdfIsMissingNotAPDFViewer() throws {
        let directory = try makeCourseDirectory()
        let url = try XCTUnwrap(URL(string: "assets/alt/missing.pdf"))
        guard case let .missing(name) = ReaderLinkResolver.resolve(url, courseDirectoryURL: directory) else {
            return XCTFail("Expected a missing outcome")
        }
        XCTAssertTrue(name.contains("missing.pdf"))
    }

    func testUnsupportedAbsoluteSchemeIsReported() throws {
        let directory = try makeCourseDirectory()
        let url = try XCTUnwrap(URL(string: "coursedeck://lesson/01.01"))
        guard case .unsupported = ReaderLinkResolver.resolve(url, courseDirectoryURL: directory) else {
            return XCTFail("Expected an unsupported outcome")
        }
    }

    func testPipelineResolvesParentRelativeAssets() throws {
        let directory = try makeCourseDirectory()
        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent("assets/img", isDirectory: true),
            withIntermediateDirectories: true
        )
        try Data("png".utf8).write(to: directory.appendingPathComponent("assets/img/a.png"))
        let markdown = """
        ![alt](../assets/img/a.png)

        [guide](../assets/alt/guide.html)
        """
        let document = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(courseDirectoryURL: directory, courseID: "sample")
        )
        guard case let .image(image)? = document.blocks.first?.block else {
            return XCTFail("Expected image block")
        }
        XCTAssertTrue(image.destination.hasPrefix("file:"))
        XCTAssertTrue(image.destination.contains("/assets/img/a.png"))

        guard case let .paragraph(inlines) = document.blocks[1].block else {
            return XCTFail("Expected paragraph")
        }
        let link = inlines.compactMap { node -> String? in
            if case let .link(destination, _, _) = node { return destination }
            return nil
        }.first
        let destination = try XCTUnwrap(link)
        XCTAssertTrue(destination.hasPrefix("file:"))
        XCTAssertTrue(destination.contains("/assets/alt/guide.html"))
    }
}
