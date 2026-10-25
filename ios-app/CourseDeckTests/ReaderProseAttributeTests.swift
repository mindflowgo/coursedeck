@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

@MainActor
final class ReaderProseAttributeTests: XCTestCase {
    private func preparedProse(
        markdown: String,
        document: ReaderDocument,
        width: CGFloat = 800
    ) async throws -> ReaderPreparedProse {
        let parsed = MarkdownPipeline.parse(
            markdown,
            options: MarkdownPipelineOptions(
                courseDirectoryURL: document.courseDirectoryURL,
                courseID: document.courseId
            )
        )
        let rows = ReaderRowPlanner.plan(document: parsed)
        guard let row = rows.first(where: { if case .prose = $0.kind { return true }; return false }) else {
            throw XCTSkip("No prose row")
        }
        let block = await ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: width,
            document: document,
            allowRemoteImages: false
        ).prepare(row: row)
        guard case let .prose(prose) = block else {
            throw XCTSkip("Not prose")
        }
        return prose
    }

    func testInlineFontsAndLinkSurviveProseAssembly() async throws {
        let markdown = "A paragraph with **bold**, *italic*, `code`, and [a link](https://example.com)."
        let document = try ReaderTestSupport.document(markdown: markdown)
        let prose = try await preparedProse(markdown: markdown, document: document)
        let string = prose.attributed.string as NSString

        let boldRange = string.range(of: "bold")
        let boldFont = prose.attributed.attribute(.font, at: boldRange.location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(try XCTUnwrap(boldFont).fontDescriptor.symbolicTraits.contains(.traitBold))

        let italicRange = string.range(of: "italic")
        let italicFont = prose.attributed.attribute(.font, at: italicRange.location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(try XCTUnwrap(italicFont).fontDescriptor.symbolicTraits.contains(.traitItalic))

        let codeRange = string.range(of: "code")
        let codeFont = prose.attributed.attribute(.font, at: codeRange.location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(try XCTUnwrap(codeFont).fontName.lowercased().contains("mono"))

        let linkRange = string.range(of: "a link")
        let link = prose.attributed.attribute(.link, at: linkRange.location, effectiveRange: nil)
        XCTAssertNotNil(link)
    }

    func testSpokenTextCoversEverySegmentWhenMathAndImageArePresent() async throws {
        let markdown = """
        # Intro heading

        Before math $x^2$ and an image ![missing alt](assets/img/missing.png) and tail.
        """
        let document = try ReaderTestSupport.document(markdown: markdown)
        let prose = try await preparedProse(markdown: markdown, document: document)
        let spoken = try XCTUnwrap(prose.spokenText)
        XCTAssertTrue(spoken.contains("Intro heading"))
        XCTAssertTrue(spoken.contains("Before math"))
        XCTAssertTrue(spoken.contains("x^2") || spoken.contains("equation"))
        XCTAssertTrue(spoken.contains("missing alt"))
        XCTAssertTrue(spoken.contains("tail"))
    }

    func testProseAccessibilityLabelUsesSpokenTextForMixedRun() async throws {
        let markdown = "Start $x^2$ middle ![alt](assets/img/missing.png) end."
        let document = try ReaderTestSupport.document(markdown: markdown)
        let prose = try await preparedProse(markdown: markdown, document: document)
        let view = ProseBlockView(frame: CGRect(x: 0, y: 0, width: 800, height: prose.height))
        let context = ReaderBlockContext(
            rowID: "r",
            documentID: document.id,
            theme: ReaderTestSupport.theme(),
            tableScrollState: TableScrollStateStore(),
            outerScrollView: nil,
            delegate: nil,
            isNested: false
        )
        view.configure(prepared: .prose(prose), context: context)
        view.layoutIfNeeded()
        let label = try XCTUnwrap(view.accessibilityTextForTesting)
        XCTAssertTrue(label.contains("Start"))
        XCTAssertTrue(label.contains("middle"))
        XCTAssertTrue(label.contains("alt"))
        XCTAssertTrue(label.contains("end"))
        XCTAssertTrue(label.contains("equation") || label.contains("x^2"))
    }
}
