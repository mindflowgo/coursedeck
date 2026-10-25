import CourseDeckCore
import UIKit

extension NSAttributedString.Key {
    /// TeX source carried with an inline math attachment so it can be copied.
    static let readerTeX = NSAttributedString.Key("com.ilc.coursedeck.reader.tex")
    static let readerMathDisplay = NSAttributedString.Key("com.ilc.coursedeck.reader.math.display")
    static let readerImageDestination = NSAttributedString.Key("com.ilc.coursedeck.reader.image.destination")
    static let readerImageAlt = NSAttributedString.Key("com.ilc.coursedeck.reader.image.alt")
}

struct ReaderInlineContext {
    var font: UIFont
    var color: UIColor
    var paragraphStyle: NSParagraphStyle?
    var linkColor: UIColor
    var allowLinks: Bool = true
    var maxInlineImageHeight: CGFloat = 160
    var mathPointSize: CGFloat
    var isTableCell: Bool = false

    init(theme: ReaderTheme, font: UIFont? = nil, color: UIColor? = nil, mathPointSize: CGFloat? = nil) {
        self.font = font ?? theme.body
        self.color = color ?? theme.bodyColor
        self.paragraphStyle = nil
        self.linkColor = theme.linkColor
        self.mathPointSize = mathPointSize ?? theme.body.pointSize
    }
}

struct ReaderInlineResult {
    var attributed: NSAttributedString
    var containsMathOrImage: Bool
    var spokenText: String?
}

/// Builds attributed strings for prose, table cells, callout titles, and task
/// list labels. Images and math are resolved before measuring so a row's height
/// never changes after its first layout.
final class ReaderInlineBuilder {
    let theme: ReaderTheme
    let courseDirectoryURL: URL
    let imageLoader: ReaderImageLoader
    let mathRenderer: ReaderMathRenderer

    init(
        theme: ReaderTheme,
        courseDirectoryURL: URL,
        imageLoader: ReaderImageLoader = .shared,
        mathRenderer: ReaderMathRenderer = .shared
    ) {
        self.theme = theme
        self.courseDirectoryURL = courseDirectoryURL
        self.imageLoader = imageLoader
        self.mathRenderer = mathRenderer
    }

    func build(_ inlines: [InlineNode], context: ReaderInlineContext) async -> ReaderInlineResult {
        var containsMathOrImage = false
        let attributed = await buildNodes(
            inlines,
            context: context,
            containsMathOrImage: &containsMathOrImage
        )
        let spoken = containsMathOrImage ? spokenText(inlines) : nil
        return ReaderInlineResult(
            attributed: attributed,
            containsMathOrImage: containsMathOrImage,
            spokenText: spoken
        )
    }

    func plain(_ text: String, context: ReaderInlineContext) -> NSAttributedString {
        base(text, context: context)
    }

    // MARK: - Nodes

    private func buildNodes(
        _ nodes: [InlineNode],
        context: ReaderInlineContext,
        containsMathOrImage: inout Bool
    ) async -> NSAttributedString {
        let output = NSMutableAttributedString()
        for node in nodes {
            output.append(await buildNode(node, context: context, containsMathOrImage: &containsMathOrImage))
        }
        return output
    }

    private func buildNode(
        _ node: InlineNode,
        context: ReaderInlineContext,
        containsMathOrImage: inout Bool
    ) async -> NSAttributedString {
        switch node {
        case let .text(value):
            return base(value, context: context)

        case let .emphasis(children):
            let inner = await buildNodes(children, context: context, containsMathOrImage: &containsMathOrImage)
            return applyingFontTrait(.traitItalic, to: inner)

        case let .strong(children):
            let inner = await buildNodes(children, context: context, containsMathOrImage: &containsMathOrImage)
            return applyingFontTrait(.traitBold, to: inner)

        case let .strikethrough(children):
            let inner = await buildNodes(children, context: context, containsMathOrImage: &containsMathOrImage)
            return applying(attributes: [
                .strikethroughStyle: NSUnderlineStyle.single.rawValue,
            ], to: inner)

        case let .code(value):
            let attributed = NSMutableAttributedString(string: value, attributes: [
                .font: theme.codeSmall,
                .foregroundColor: theme.bodyColor,
                .backgroundColor: theme.codeBackground,
                .paragraphStyle: context.paragraphStyle ?? NSParagraphStyle.default,
            ])
            return attributed

        case let .link(destination, _, children):
            let inner = NSMutableAttributedString(
                attributedString: await buildNodes(children, context: context, containsMathOrImage: &containsMathOrImage)
            )
            if context.allowLinks, let url = URL(string: destination), !destination.isEmpty {
                inner.addAttributes([
                    .link: url,
                    .foregroundColor: context.linkColor,
                    .underlineStyle: NSUnderlineStyle.single.rawValue,
                ], range: NSRange(location: 0, length: inner.length))
            }
            return inner

        case let .image(spec, destination, _):
            containsMathOrImage = true
            let maxHeight = ReaderImageSizing.isIcon(
                ImageModel(spec: spec, destination: destination)
            ) ? ReaderImageSizing.iconMaxHeight : context.maxInlineImageHeight
            let result = await imageLoader.load(
                destination: destination,
                courseDirectoryURL: courseDirectoryURL,
                maxPixelSize: max(maxHeight * theme.displayScale, 64),
                scale: theme.displayScale
            )
            if let image = result.loaded?.image {
                return attachmentString(
                    image: image,
                    maxHeight: maxHeight,
                    baselineOffset: 0,
                    context: context,
                    extraAttributes: [
                        .readerImageDestination: destination,
                        .readerImageAlt: spec.alt,
                    ]
                )
            }
            let alt = spec.alt.isEmpty ? (result.failure ?? "Image") : spec.alt
            return altText("[\(alt)]", context: context)

        case let .math(expression):
            containsMathOrImage = true
            let pointSize = context.mathPointSize
            if let image = await mathRenderer.image(
                tex: expression.tex,
                display: expression.display,
                pointSize: pointSize,
                color: theme.mathColor()
            ) {
                return attachmentString(
                    image: image,
                    maxHeight: 10_000,
                    baselineOffset: expression.display ? 0 : ReaderMathRenderer.inlineBaselineOffset(pointSize: pointSize),
                    context: context,
                    extraAttributes: [
                        .readerTeX: expression.tex,
                        .readerMathDisplay: expression.display,
                    ]
                )
            }
            // Unsupported TeX stays visible rather than disappearing.
            let fallback = NSMutableAttributedString(string: expression.tex, attributes: [
                .font: theme.codeSmall,
                .foregroundColor: theme.secondaryColor,
                .backgroundColor: theme.codeBackground,
            ])
            fallback.addAttribute(
                .readerTeX,
                value: expression.tex,
                range: NSRange(location: 0, length: fallback.length)
            )
            return fallback

        case .lineBreak:
            return base("\n", context: context)

        case let .superscript(children):
            let inner = NSMutableAttributedString(
                attributedString: await buildNodes(children, context: context, containsMathOrImage: &containsMathOrImage)
            )
            let size = max(context.font.pointSize * 0.72, 8)
            inner.addAttributes([
                .font: UIFont.systemFont(ofSize: size),
                .baselineOffset: size * 0.45,
            ], range: NSRange(location: 0, length: inner.length))
            return inner

        case let .subscripting(children):
            let inner = NSMutableAttributedString(
                attributedString: await buildNodes(children, context: context, containsMathOrImage: &containsMathOrImage)
            )
            let size = max(context.font.pointSize * 0.72, 8)
            inner.addAttributes([
                .font: UIFont.systemFont(ofSize: size),
                .baselineOffset: -(size * 0.3),
            ], range: NSRange(location: 0, length: inner.length))
            return inner

        case let .highlight(children):
            let inner = NSMutableAttributedString(
                attributedString: await buildNodes(children, context: context, containsMathOrImage: &containsMathOrImage)
            )
            inner.addAttribute(
                .backgroundColor,
                value: UIColor.systemYellow.withAlphaComponent(0.35),
                range: NSRange(location: 0, length: inner.length)
            )
            return inner

        case let .keyboard(children):
            let inner = NSMutableAttributedString(
                attributedString: await buildNodes(children, context: context, containsMathOrImage: &containsMathOrImage)
            )
            inner.addAttributes([
                .font: theme.codeSmall,
                .backgroundColor: theme.codeBackground,
                .underlineStyle: NSUnderlineStyle.single.rawValue,
            ], range: NSRange(location: 0, length: inner.length))
            return inner

        case let .span(children):
            return await buildNodes(children, context: context, containsMathOrImage: &containsMathOrImage)
        }
    }

    // MARK: - Helpers

    private func base(_ text: String, context: ReaderInlineContext) -> NSAttributedString {
        var attributes: [NSAttributedString.Key: Any] = [
            .font: context.font,
            .foregroundColor: context.color,
        ]
        if let paragraphStyle = context.paragraphStyle {
            attributes[.paragraphStyle] = paragraphStyle
        }
        return NSAttributedString(string: text, attributes: attributes)
    }

    private func altText(_ text: String, context: ReaderInlineContext) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            .font: theme.caption,
            .foregroundColor: theme.secondaryColor,
        ])
    }

    private func applying(
        attributes: [NSAttributedString.Key: Any],
        to string: NSAttributedString
    ) -> NSAttributedString {
        let mutable = NSMutableAttributedString(attributedString: string)
        mutable.addAttributes(attributes, range: NSRange(location: 0, length: mutable.length))
        return mutable
    }

    private func applyingFontTrait(_ trait: UIFontDescriptor.SymbolicTraits, to string: NSAttributedString) -> NSAttributedString {
        let mutable = NSMutableAttributedString(attributedString: string)
        mutable.enumerateAttribute(.font, in: NSRange(location: 0, length: mutable.length)) { value, range, _ in
            guard let font = value as? UIFont else { return }
            guard let descriptor = font.fontDescriptor.withSymbolicTraits(
                font.fontDescriptor.symbolicTraits.union(trait)
            ) else { return }
            mutable.addAttribute(.font, value: UIFont(descriptor: descriptor, size: font.pointSize), range: range)
        }
        return mutable
    }

    private func attachmentString(
        image: UIImage,
        maxHeight: CGFloat,
        baselineOffset: CGFloat,
        context: ReaderInlineContext,
        extraAttributes: [NSAttributedString.Key: Any]
    ) -> NSAttributedString {
        let natural = image.size
        guard natural.width > 0, natural.height > 0 else {
            return NSAttributedString(string: "")
        }
        var scale: CGFloat = 1
        if maxHeight > 0, natural.height > maxHeight {
            scale = maxHeight / natural.height
        }
        let maxWidth = max(theme.body.pointSize * 14, 120)
        if natural.width * scale > maxWidth {
            scale = maxWidth / natural.width
        }
        let size = CGSize(width: natural.width * scale, height: natural.height * scale)
        let attachment = NSTextAttachment()
        attachment.image = image
        attachment.bounds = CGRect(x: 0, y: baselineOffset, width: size.width, height: size.height)
        attachment.lineLayoutPadding = 1
        let attributed = NSMutableAttributedString(attachment: attachment)
        var attributes = extraAttributes
        attributes[.font] = context.font
        attributed.addAttributes(attributes, range: NSRange(location: 0, length: attributed.length))
        return attributed
    }

    // MARK: - Spoken text

    func spokenText(_ inlines: [InlineNode]) -> String {
        inlines.map(spoken).joined()
    }

    private func spoken(_ node: InlineNode) -> String {
        switch node {
        case let .text(value): return value
        case let .emphasis(children),
             let .strong(children),
             let .strikethrough(children),
             let .superscript(children),
             let .subscripting(children),
             let .highlight(children),
             let .keyboard(children),
             let .span(children):
            return children.map(spoken).joined()
        case let .code(value): return value
        case let .link(_, _, children): return children.map(spoken).joined()
        case let .image(spec, _, _):
            return spec.alt.isEmpty ? "image" : "image: \(spec.alt)"
        case let .math(expression):
            return expression.display ? "equation: \(expression.tex)" : " \(expression.tex) "
        case .lineBreak: return " "
        }
    }
}
