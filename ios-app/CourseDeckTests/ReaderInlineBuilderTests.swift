@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

final class ReaderInlineBuilderTests: XCTestCase {
    func testInlineStylesLinksAndCode() async throws {
        let theme = ReaderTestSupport.theme()
        let builder = ReaderInlineBuilder(
            theme: theme,
            courseDirectoryURL: FileManager.default.temporaryDirectory
        )
        let inlines: [InlineNode] = [
            .text("Hello "),
            .strong([.text("bold")]),
            .text(" and "),
            .emphasis([.text("italic")]),
            .text(" with "),
            .code("let x = 1"),
            .text(" and "),
            .link(destination: "https://example.com", title: nil, children: [.text("a link")]),
            .text(" and superscript "),
            .superscript([.text("2")]),
            .lineBreak,
            .highlight([.text("marked")]),
        ]
        var context = ReaderInlineContext(theme: theme)
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 4
        context.paragraphStyle = style
        let result = await builder.build(inlines, context: context)

        XCTAssertEqual(result.attributed.string, "Hello bold and italic with let x = 1 and a link and superscript 2\nmarked")
        XCTAssertFalse(result.containsMathOrImage)

        let fullRange = NSRange(location: 0, length: result.attributed.length)
        var hasLink = false
        result.attributed.enumerateAttribute(.link, in: fullRange) { value, _, _ in
            if value != nil { hasLink = true }
        }
        XCTAssertTrue(hasLink)

        let boldRange = (result.attributed.string as NSString).range(of: "bold")
        let boldFont = result.attributed.attribute(.font, at: boldRange.location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(try XCTUnwrap(boldFont).fontDescriptor.symbolicTraits.contains(.traitBold))

        let codeRange = (result.attributed.string as NSString).range(of: "let x = 1")
        let codeFont = result.attributed.attribute(.font, at: codeRange.location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(try XCTUnwrap(codeFont).fontName.lowercased().contains("mono"))

        let supRange = (result.attributed.string as NSString).range(of: "2")
        let baseline = result.attributed.attribute(.baselineOffset, at: supRange.location, effectiveRange: nil) as? CGFloat
        XCTAssertGreaterThan(baseline ?? 0, 0)
    }

    func testMathFallbackKeepsTeXAndSpokenText() async throws {
        let theme = ReaderTestSupport.theme()
        let builder = ReaderInlineBuilder(
            theme: theme,
            courseDirectoryURL: FileManager.default.temporaryDirectory
        )
        let result = await builder.build(
            [.text("Equation "), .math(MathExpression(tex: "\\frac{1}{2}", display: false))],
            context: ReaderInlineContext(theme: theme)
        )
        XCTAssertTrue(result.containsMathOrImage)
        XCTAssertNotNil(result.spokenText)
        XCTAssertTrue(result.spokenText?.contains("\\frac{1}{2}") == true)
        var foundTeX = false
        result.attributed.enumerateAttribute(
            .readerTeX,
            in: NSRange(location: 0, length: result.attributed.length)
        ) { value, _, _ in
            if value as? String == "\\frac{1}{2}" { foundTeX = true }
        }
        XCTAssertTrue(foundTeX)
    }

    func testUnsafeRemoteImageStaysText() async throws {
        let theme = ReaderTestSupport.theme()
        let builder = ReaderInlineBuilder(
            theme: theme,
            courseDirectoryURL: FileManager.default.temporaryDirectory
        )
        let spec = ImageSpec(alt: "diagram")
        let result = await builder.build(
            [.image(spec, destination: "https://example.com/diagram.png", title: nil)],
            context: ReaderInlineContext(theme: theme)
        )
        XCTAssertTrue(result.attributed.string.contains("diagram"))
        XCTAssertNotNil(result.spokenText)
    }
}
