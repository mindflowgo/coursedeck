import CourseDeckCore
import Foundation
import UIKit

/// Turns rows into fully measured blocks off the main thread. Every image and
/// math expression in a row is resolved before measuring, so the table view
/// never asks a `UITextView` to self-size.
final class ReaderPreparer {
    let theme: ReaderTheme
    let width: CGFloat
    let document: ReaderDocument
    let inline: ReaderInlineBuilder
    let allowRemoteImages: Bool
    let expandedBlockIDs: Set<String>

    private let contentWidth: CGFloat

    init(
        theme: ReaderTheme,
        width: CGFloat,
        document: ReaderDocument,
        allowRemoteImages: Bool,
        expandedBlockIDs: Set<String> = [],
        contentWidth: CGFloat? = nil
    ) {
        self.theme = theme
        self.width = width
        self.document = document
        self.allowRemoteImages = allowRemoteImages
        self.expandedBlockIDs = expandedBlockIDs
        let builder = ReaderInlineBuilder(
            theme: theme,
            courseDirectoryURL: document.courseDirectoryURL
        )
        self.inline = builder
        self.contentWidth = max(contentWidth ?? (width - theme.horizontalInset * 2), 40)
    }

    /// A copy whose blocks are measured for a narrower container (callout,
    /// details, quote, or USERNOTE). Without this, nested prose would be
    /// measured at the page width and clipped by the card's insets.
    private func childPreparer(inset: CGFloat) -> ReaderPreparer {
        ReaderPreparer(
            theme: theme,
            width: max(width - inset, 80),
            document: document,
            allowRemoteImages: allowRemoteImages,
            expandedBlockIDs: expandedBlockIDs,
            contentWidth: max(contentWidth - inset, 40)
        )
    }

    func prepare(row: ReaderRow) async -> ReaderPreparedBlock {
        switch row.kind {
        case let .prose(run):
            return await prepareProse(run)
        case let .taskList(list):
            return await prepareTaskList(list)
        case let .table(table):
            return await prepareTable(table)
        case let .image(image):
            return await prepareImage(image)
        case let .mathBlock(expression):
            return await prepareMath(expression)
        case let .code(code):
            return prepareCode(code)
        case let .callout(callout):
            return await prepareCallout(callout)
        case let .details(details):
            let blockID = row.blockIDs.first ?? row.id
            return await prepareDetails(
                details,
                blockID: blockID,
                expanded: row.expandedBlockIDs.contains(blockID)
                    || expandedBlockIDs.contains(blockID)
            )
        case let .userNote(note):
            return await prepareUserNote(note)
        case let .quote(children):
            return await prepareContainer(
                kind: .quote,
                label: "Quote",
                title: nil,
                children: children
            )
        case let .list(list):
            if list.items.contains(where: { $0.checked != nil }),
               !ReaderRowPlanner.hasRichNestedTaskContent(list) {
                return await prepareTaskList(list)
            }
            return await prepareListContainer(list, blockID: row.id)
        case .separator:
            return .separator(ReaderPreparedSeparator(height: 25))
        case let .fallback(fallback):
            return prepareFallback(fallback)
        }
    }

    // MARK: - Prose

    func prepareProse(_ run: ProseRun) async -> ReaderPreparedBlock {
        let output = NSMutableAttributedString()
        var ranges: [(id: String, range: NSRange)] = []
        var containsAttachment = false
        var spokenParts: [String] = []

        for (index, segment) in run.segments.enumerated() {
            let segmentID = index < run.segmentIDs.count
                ? run.segmentIDs[index]
                : (run.blockIDs.first ?? "")
            let start = output.length

            switch segment {
            case let .heading(level, inlines, quote):
                let font = headingFont(level)
                let paragraphStyle = makeParagraphStyle(quote: quote)
                paragraphStyle.paragraphSpacing = 6
                paragraphStyle.paragraphSpacingBefore = level <= 2 ? 14 : 10
                let effectiveFont = quote ? font.withItalicIfPossible() : font
                var context = ReaderInlineContext(
                    theme: theme,
                    font: effectiveFont,
                    color: quote ? theme.secondaryColor : theme.bodyColor,
                    mathPointSize: theme.body.pointSize
                )
                context.paragraphStyle = paragraphStyle
                let result = await inline.build(inlines, context: context)
                appendProseSegment(
                    result,
                    to: output,
                    paragraphStyle: paragraphStyle,
                    newlineFont: effectiveFont,
                    newlineColor: quote ? theme.secondaryColor : theme.bodyColor
                )
                if result.containsMathOrImage { containsAttachment = true }
                spokenParts.append(result.spokenText ?? result.attributed.string)

            case let .paragraph(inlines, quote):
                let paragraphStyle = makeParagraphStyle(quote: quote)
                let effectiveFont = quote ? theme.body.withItalicIfPossible() : theme.body
                var context = ReaderInlineContext(
                    theme: theme,
                    font: effectiveFont,
                    color: quote ? theme.secondaryColor : theme.bodyColor
                )
                context.paragraphStyle = paragraphStyle
                let result = await inline.build(inlines, context: context)
                appendProseSegment(
                    result,
                    to: output,
                    paragraphStyle: paragraphStyle,
                    newlineFont: effectiveFont,
                    newlineColor: quote ? theme.secondaryColor : theme.bodyColor
                )
                if result.containsMathOrImage { containsAttachment = true }
                spokenParts.append(result.spokenText ?? result.attributed.string)

            case let .list(list, quote):
                let listBlock = await prepareProseList(list, quote: quote)
                output.append(listBlock.attributed)
                if listBlock.containsAttachment { containsAttachment = true }
                spokenParts.append(listBlock.spokenText)
            }

            if !segmentID.isEmpty,
               !ranges.contains(where: { $0.id == segmentID }) {
                ranges.append((
                    segmentID,
                    NSRange(location: start, length: max(output.length - start, 0))
                ))
            }
        }

        let measurement = ProseTextMeasurer.measure(
            attributed: output,
            width: contentWidth,
            blockRanges: ranges
        )
        let height = ceil(measurement.height + theme.proseInsets.top + theme.proseInsets.bottom)
        return .prose(
            ReaderPreparedProse(
                attributed: output,
                height: max(height, 1),
                anchors: measurement.anchors,
                spokenText: containsAttachment ? spokenParts.joined(separator: " ") : nil
            )
        )
    }

    private func appendProseSegment(
        _ result: ReaderInlineResult,
        to output: NSMutableAttributedString,
        paragraphStyle: NSMutableParagraphStyle,
        newlineFont: UIFont,
        newlineColor: UIColor
    ) {
        // Never overwrite inline fonts/colors: the inline builder already
        // applied the base font/color plus bold/italic/code/link styling.
        let mutable = NSMutableAttributedString(attributedString: result.attributed)
        mutable.addAttribute(
            .paragraphStyle,
            value: paragraphStyle,
            range: NSRange(location: 0, length: mutable.length)
        )
        output.append(mutable)
        output.append(NSAttributedString(string: "\n", attributes: [
            .font: newlineFont,
            .paragraphStyle: paragraphStyle,
            .foregroundColor: newlineColor,
        ]))
    }

    private struct PreparedListProse {
        var attributed: NSAttributedString
        var spokenText: String
        var containsAttachment: Bool
    }

    private func prepareProseList(_ list: ListModel, quote: Bool, level: Int = 0) async -> PreparedListProse {
        let output = NSMutableAttributedString()
        var containsAttachment = false
        var spoken: [String] = []

        for (index, item) in list.items.enumerated() {
            let style = makeParagraphStyle(quote: quote)
            style.firstLineHeadIndent = CGFloat(level) * 22 + (quote ? 12 : 0)
            style.headIndent = style.firstLineHeadIndent + 22
            style.tabStops = [
                NSTextTab(textAlignment: .left, location: style.headIndent, options: [:]),
            ]
            style.defaultTabInterval = 22
            let marker = list.ordered ? "\(list.start + index). " : "• "
            let effectiveFont = quote ? theme.body.withItalicIfPossible() : theme.body
            let effectiveColor = quote ? theme.secondaryColor : theme.bodyColor
            let markerAttributes: [NSAttributedString.Key: Any] = [
                .font: effectiveFont,
                .foregroundColor: effectiveColor,
                .paragraphStyle: style,
            ]
            output.append(NSAttributedString(string: marker, attributes: markerAttributes))

            var context = ReaderInlineContext(theme: theme, font: effectiveFont, color: effectiveColor)
            context.paragraphStyle = style
            let itemResult = await inline.build(item.inlines, context: context)
            output.append(itemResult.attributed)
            output.append(NSAttributedString(string: "\n", attributes: [
                .font: effectiveFont,
                .paragraphStyle: style,
                .foregroundColor: effectiveColor,
            ]))
            if itemResult.containsMathOrImage { containsAttachment = true }
            spoken.append(marker + (itemResult.spokenText ?? item.inlines.plainText))

            for nested in item.blocks {
                await appendNestedListProse(
                    nested,
                    quote: quote,
                    level: level + 1,
                    output: output,
                    spoken: &spoken,
                    containsAttachment: &containsAttachment
                )
            }
        }

        return PreparedListProse(
            attributed: output,
            spokenText: spoken.joined(separator: " "),
            containsAttachment: containsAttachment
        )
    }

    /// Nested prose is rebuilt through the inline builder so bold/italic/code/
    /// links/math/images survive instead of being flattened to `plainText`.
    /// Rich blocks never reach this path: `ReaderRowPlanner.canRenderAsProse`
    /// returns false for a list containing them, which routes the list through
    /// `prepareListContainer` and `prepareNode`.
    private func appendNestedListProse(
        _ node: MarkdownBlockNode,
        quote: Bool,
        level: Int,
        output: NSMutableAttributedString,
        spoken: inout [String],
        containsAttachment: inout Bool
    ) async {
        switch node.block {
        case let .list(nestedList):
            let nestedPrepared = await prepareProseList(nestedList, quote: quote, level: level)
            output.append(nestedPrepared.attributed)
            spoken.append(nestedPrepared.spokenText)
            if nestedPrepared.containsAttachment { containsAttachment = true }

        case let .paragraph(inlines):
            await appendNestedInline(
                inlines,
                quote: quote,
                level: level,
                font: quote ? theme.body.withItalicIfPossible() : theme.body,
                output: output,
                spoken: &spoken,
                containsAttachment: &containsAttachment
            )

        case let .heading(level: headingLevel, inlines):
            await appendNestedInline(
                inlines,
                quote: quote,
                level: level,
                font: headingFont(headingLevel),
                output: output,
                spoken: &spoken,
                containsAttachment: &containsAttachment
            )

        case let .blockquote(children):
            for child in children {
                await appendNestedListProse(
                    child,
                    quote: true,
                    level: level,
                    output: output,
                    spoken: &spoken,
                    containsAttachment: &containsAttachment
                )
            }

        default:
            let text = node.plainText
            if !text.isEmpty {
                let style = makeParagraphStyle(quote: quote)
                style.firstLineHeadIndent = CGFloat(level) * 22 + (quote ? 12 : 0)
                style.headIndent = style.firstLineHeadIndent
                output.append(NSAttributedString(string: text + "\n", attributes: [
                    .font: quote ? theme.body.withItalicIfPossible() : theme.body,
                    .foregroundColor: quote ? theme.secondaryColor : theme.bodyColor,
                    .paragraphStyle: style,
                ]))
                spoken.append(text)
            }
        }
    }

    private func appendNestedInline(
        _ inlines: [InlineNode],
        quote: Bool,
        level: Int,
        font: UIFont,
        output: NSMutableAttributedString,
        spoken: inout [String],
        containsAttachment: inout Bool
    ) async {
        let style = makeParagraphStyle(quote: quote)
        style.firstLineHeadIndent = CGFloat(level) * 22 + (quote ? 12 : 0)
        style.headIndent = style.firstLineHeadIndent
        var context = ReaderInlineContext(
            theme: theme,
            font: font,
            color: quote ? theme.secondaryColor : theme.bodyColor
        )
        context.paragraphStyle = style
        let result = await inline.build(inlines, context: context)
        output.append(result.attributed)
        output.append(NSAttributedString(string: "\n", attributes: [
            .font: font,
            .foregroundColor: quote ? theme.secondaryColor : theme.bodyColor,
            .paragraphStyle: style,
        ]))
        if result.containsMathOrImage { containsAttachment = true }
        spoken.append(result.spokenText ?? result.attributed.string)
    }

    private func headingFont(_ level: Int) -> UIFont {
        switch level {
        case 1: return theme.heading1
        case 2: return theme.heading2
        case 3: return theme.heading3
        case 4: return theme.heading4
        case 5: return theme.heading5
        default: return theme.heading6
        }
    }

    private func makeParagraphStyle(quote: Bool) -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = quote ? 3 : 4
        style.paragraphSpacing = quote ? 6 : 9
        style.headIndent = quote ? 18 : 0
        style.firstLineHeadIndent = quote ? 18 : 0
        return style
    }

    // MARK: - Task list

    private func prepareTaskList(_ list: ListModel) async -> ReaderPreparedBlock {
        var items: [ReaderPreparedTaskItem] = []
        var total: CGFloat = 28
        for item in list.items {
            let checked = item.checked ?? false
            var text = item.inlines.plainText
            let nested = item.blocks.map(\.plainText).joined(separator: "\n")
            if !nested.isEmpty {
                text += text.isEmpty ? nested : "\n" + nested
            }
            let style = NSMutableParagraphStyle()
            style.lineSpacing = 3
            style.paragraphSpacing = 0
            var context = ReaderInlineContext(theme: theme, font: theme.body)
            context.paragraphStyle = style
            let built = await inline.build(item.inlines, context: context)
            let attributed = NSMutableAttributedString(attributedString: built.attributed)
            if !nested.isEmpty {
                attributed.append(NSAttributedString(string: "\n" + nested, attributes: [
                    .font: theme.caption,
                    .foregroundColor: theme.secondaryColor,
                    .paragraphStyle: style,
                ]))
            }
            let textWidth = contentWidth - 34
            let height = max(
                28,
                ceil(attributed.boundingRect(
                    with: CGSize(width: max(textWidth, 40), height: .greatestFiniteMagnitude),
                    options: [.usesLineFragmentOrigin, .usesFontLeading],
                    context: nil
                ).height) + 6
            )
            items.append(
                ReaderPreparedTaskItem(
                    checked: checked,
                    text: text,
                    attributed: attributed,
                    height: height
                )
            )
            total += height
        }
        return .taskList(ReaderPreparedTaskList(items: items, height: total + 12))
    }

    // MARK: - Code

    private func prepareCode(_ code: CodeBlockModel) -> ReaderPreparedBlock {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 2
        style.paragraphSpacing = 0
        let attributed = NSAttributedString(string: code.code, attributes: [
            .font: theme.code,
            .foregroundColor: theme.bodyColor,
            .paragraphStyle: style,
        ])
        let lineHeight = ceil(theme.code.lineHeight)
        let measured = attributed.boundingRect(
            with: CGSize(width: 4_000, height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        let lineCount = max(code.code.components(separatedBy: "\n").count, 1)
        let textHeight = max(ceil(measured.height), CGFloat(lineCount) * lineHeight)
        let viewportHeight = min(textHeight + 20, 340)
        return .code(
            ReaderPreparedCode(
                attributed: attributed,
                language: code.language,
                plainText: code.code,
                textHeight: textHeight,
                viewportHeight: viewportHeight,
                height: 36 + viewportHeight + 6
            )
        )
    }

    // MARK: - Image

    private func prepareImage(_ model: ImageModel) async -> ReaderPreparedBlock {
        let isIcon = ReaderImageSizing.isIcon(model)
        let maxPixel = isIcon
            ? ReaderImageSizing.iconMaxHeight * theme.displayScale * 2
            : max(contentWidth, 200) * theme.displayScale
        let result = await ReaderImageLoader.shared.load(
            destination: model.destination,
            courseDirectoryURL: document.courseDirectoryURL,
            maxPixelSize: maxPixel,
            scale: theme.displayScale,
            allowsRemote: allowRemoteImages
        )
        let captionHeight: CGFloat
        if let caption = model.caption, !caption.isEmpty {
            captionHeight = ceil((caption as NSString).boundingRect(
                with: CGSize(width: contentWidth, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: theme.caption],
                context: nil
            ).height)
        } else {
            captionHeight = 0
        }

        let size: CGSize
        if let image = result.loaded?.image {
            size = ReaderImageSizing.displaySize(
                model: model,
                naturalSize: image.size,
                availableWidth: max(contentWidth, 80)
            )
        } else {
            // A failed local image and a blocked remote image use fixed
            // placeholder heights so the failure reason and load button always
            // fit without calling displaySize with a nil natural size.
            size = CGSize(
                width: max(contentWidth, 80),
                height: result.isRemoteBlocked ? 190 : 120
            )
        }
        let height = 10 + size.height + (captionHeight > 0 ? 8 + captionHeight : 0) + 10
        return .image(
            ReaderPreparedImage(
                model: model,
                image: result.loaded?.image,
                failure: result.failure,
                displaySize: size,
                caption: model.caption,
                captionHeight: captionHeight,
                height: height,
                allowsRemoteLoad: result.isRemoteBlocked
            )
        )
    }

    // MARK: - Math

    private func prepareMath(_ expression: MathExpression) async -> ReaderPreparedBlock {
        let pointSize = theme.mathPointSize(display: true)
        let image = await ReaderMathRenderer.shared.image(
            tex: expression.tex,
            display: true,
            pointSize: pointSize,
            color: theme.mathColor()
        )
        var displaySize = image?.size ?? .zero
        if displaySize.width > contentWidth, displaySize.width > 0 {
            let scale = contentWidth / displaySize.width
            displaySize = CGSize(width: contentWidth, height: displaySize.height * scale)
        }
        let fallbackHeight = ceil((expression.tex as NSString).boundingRect(
            with: CGSize(width: contentWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: theme.code],
            context: nil
        ).height)
        let height = max(displaySize.height, fallbackHeight) + 34
        return .math(
            ReaderPreparedMath(
                expression: expression,
                image: image,
                displaySize: displaySize,
                height: height
            )
        )
    }

    // MARK: - Table

    private func prepareTable(_ table: TableModel) async -> ReaderPreparedBlock {
        var header: [NSAttributedString] = []
        for cell in table.header {
            let context = tableCellContext(isHeader: true)
            let result = await inline.build(cell.inlines, context: context)
            header.append(result.attributed)
        }
        var body: [[NSAttributedString]] = []
        for row in table.rows {
            var cells: [NSAttributedString] = []
            for cell in row {
                let context = tableCellContext(isHeader: false)
                let result = await inline.build(cell.inlines, context: context)
                cells.append(result.attributed)
            }
            body.append(cells)
        }
        let metrics = TableGridMeasurer.measure(
            table: table,
            availableWidth: max(contentWidth, 80),
            theme: theme,
            headerAttributed: header,
            bodyAttributed: body
        )
        let viewport = metrics.viewportHeight(maxHeight: 480)
        let warningHeight: CGFloat = metrics.warnings.isEmpty ? 0 : 20
        return .table(
            ReaderPreparedTable(
                table: table,
                metrics: metrics,
                headerAttributed: header,
                bodyAttributed: body,
                totalHeight: 38 + viewport + 10 + warningHeight
            )
        )
    }

    private func tableCellContext(isHeader: Bool) -> ReaderInlineContext {
        var context = ReaderInlineContext(
            theme: theme,
            font: isHeader ? theme.tableHeader : theme.table,
            color: theme.bodyColor,
            mathPointSize: theme.table.pointSize
        )
        context.isTableCell = true
        context.maxInlineImageHeight = 120
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 1
        style.paragraphSpacing = 0
        context.paragraphStyle = style
        return context
    }

    // MARK: - Containers

    private func prepareCallout(_ callout: CalloutModel) async -> ReaderPreparedBlock {
        let children = await prepareChildren(callout.blocks, using: childPreparer(inset: 24))
        let childHeight = children.reduce(CGFloat(0)) { $0 + $1.block.height }
        let spacing = CGFloat(max(children.count - 1, 0)) * 8
        let labelHeight: CGFloat = 28
        let height = 16 + labelHeight + 8 + childHeight + spacing + 14
        return .callout(
            ReaderPreparedContainer(
                kind: .callout(callout.kind),
                label: callout.displayLabel,
                title: callout.title,
                children: children,
                childrenOrigin: 16 + labelHeight + 8,
                childSpacing: 8,
                height: height
            )
        )
    }

    private func prepareDetails(_ details: DetailsModel, blockID: String, expanded: Bool) async -> ReaderPreparedBlock {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 3
        var context = ReaderInlineContext(theme: theme, font: theme.heading6)
        context.paragraphStyle = style
        let summary = await inline.build(details.summary, context: context)
        let headerHeight = max(44, ceil(summary.attributed.boundingRect(
            with: CGSize(width: contentWidth - 52, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        ).height) + 20)
        let children = expanded
            ? await prepareChildren(details.blocks, using: childPreparer(inset: 24))
            : []
        let childHeight = children.reduce(CGFloat(0)) { $0 + $1.block.height }
        let spacing = CGFloat(max(children.count - 1, 0)) * 8
        let height = 12 + headerHeight + (expanded ? childHeight + spacing + 16 : 8)
        return .details(
            ReaderPreparedDetails(
                blockID: blockID,
                summary: summary.attributed,
                isOpen: expanded,
                children: children,
                headerHeight: headerHeight,
                childrenOrigin: 8 + headerHeight,
                height: height
            )
        )
    }

    private func prepareUserNote(_ note: UserNoteModel) async -> ReaderPreparedBlock {
        var queryContext = ReaderInlineContext(theme: theme, font: theme.heading6, color: theme.bodyColor)
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 3
        queryContext.paragraphStyle = style
        let query = await inline.build([.text(note.query)], context: queryContext)
        let queryHeight = ceil(query.attributed.boundingRect(
            with: CGSize(width: contentWidth - 32, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        ).height)
        let targetDisplay = note.targetPreview ?? "No target quote found in this document."
        let targetHeight = ceil((targetDisplay as NSString).boundingRect(
            with: CGSize(width: contentWidth - 32, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: theme.caption],
            context: nil
        ).height)
        let children = await prepareChildren(note.blocks, using: childPreparer(inset: 32))
        let childHeight = children.reduce(CGFloat(0)) { $0 + $1.block.height }
        let spacing = CGFloat(max(children.count - 1, 0)) * 8
        let footerHeight: CGFloat = 24
        let targetButtonSpace: CGFloat = note.anchorBlockID == nil ? 0 : 28
        let childrenOrigin = 14 + 22 + queryHeight + 4 + targetHeight + 4 + targetButtonSpace + 4
        let height = childrenOrigin + childHeight + spacing + footerHeight + 14
        return .userNote(
            ReaderPreparedUserNote(
                query: query.attributed,
                targetDisplay: targetDisplay,
                anchorBlockID: note.anchorBlockID,
                anchorResolved: note.anchorBlockID != nil,
                children: children,
                queryHeight: queryHeight,
                targetHeight: targetHeight,
                childrenOrigin: childrenOrigin,
                height: height
            )
        )
    }

    private func prepareContainer(
        kind: ReaderContainerKind,
        label: String,
        title: String?,
        children nodes: [MarkdownBlockNode]
    ) async -> ReaderPreparedBlock {
        let children = await prepareChildren(nodes, using: childPreparer(inset: 20))
        let childHeight = children.reduce(CGFloat(0)) { $0 + $1.block.height }
        let childSpacing: CGFloat = 6
        let spacing = CGFloat(max(children.count - 1, 0)) * childSpacing
        let origin = childrenOrigin(kind: kind)
        let height = origin + childHeight + spacing + 10
        return .callout(
            ReaderPreparedContainer(
                kind: kind,
                label: label,
                title: title,
                children: children,
                childrenOrigin: origin,
                childSpacing: childSpacing,
                height: height
            )
        )
    }

    private func childrenOrigin(kind: ReaderContainerKind) -> CGFloat {
        switch kind {
        case .callout: return 52
        case .quote, .list: return 10
        }
    }

    private func prepareListContainer(_ list: ListModel, blockID: String = "") async -> ReaderPreparedBlock {
        var children: [ReaderPreparedNode] = []
        for (index, item) in list.items.enumerated() {
            let marker: String
            if let checked = item.checked {
                marker = checked ? "☑ " : "☐ "
            } else {
                marker = list.ordered ? "\(list.start + index). " : "• "
            }
            let style = NSMutableParagraphStyle()
            style.firstLineHeadIndent = 0
            style.headIndent = 20
            style.lineSpacing = 3
            var context = ReaderInlineContext(theme: theme, font: theme.body)
            context.paragraphStyle = style
            var attributed = NSMutableAttributedString(string: marker, attributes: [
                .font: theme.body,
                .foregroundColor: theme.secondaryColor,
                .paragraphStyle: style,
            ])
            let built = await inline.build(item.inlines, context: context)
            attributed.append(built.attributed)
            let measured = attributed.boundingRect(
                with: CGSize(width: contentWidth - 20, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                context: nil
            )
            children.append(
                ReaderPreparedNode(
                    blockID: "\(blockID)-item-\(index)",
                    block: .prose(
                        ReaderPreparedProse(
                            attributed: attributed,
                            height: ceil(measured.height) + 8,
                            anchors: [],
                            spokenText: marker + (built.spokenText ?? item.inlines.plainText)
                        )
                    )
                )
            )
            for nested in item.blocks {
                children.append(
                    ReaderPreparedNode(blockID: nested.id, block: await prepareNode(nested))
                )
            }
        }
        let spacing = CGFloat(max(children.count - 1, 0)) * 6
        let height = 10 + children.reduce(CGFloat(0)) { $0 + $1.block.height } + spacing + 10
        return .callout(
            ReaderPreparedContainer(
                kind: .list,
                label: "List",
                title: nil,
                children: children,
                childrenOrigin: 10,
                childSpacing: 6,
                height: height
            )
        )
    }

    private func prepareChildren(
        _ nodes: [MarkdownBlockNode],
        using preparer: ReaderPreparer? = nil
    ) async -> [ReaderPreparedNode] {
        let target = preparer ?? self
        var output: [ReaderPreparedNode] = []
        for node in nodes {
            output.append(
                ReaderPreparedNode(blockID: node.id, block: await target.prepareNode(node))
            )
        }
        return output
    }

    private func prepareNode(_ node: MarkdownBlockNode) async -> ReaderPreparedBlock {
        switch node.block {
        case let .heading(level, inlines):
            return await prepareProse(
                ProseRun(
                    segments: [.heading(level: level, inlines: inlines, quote: false)],
                    segmentIDs: [node.id],
                    blockIDs: [node.id]
                )
            )
        case let .paragraph(inlines):
            return await prepareProse(
                ProseRun(
                    segments: [.paragraph(inlines: inlines, quote: false)],
                    segmentIDs: [node.id],
                    blockIDs: [node.id]
                )
            )
        case let .list(list):
            if list.items.contains(where: { $0.checked != nil }),
               !ReaderRowPlanner.hasRichNestedTaskContent(list) {
                return await prepareTaskList(list)
            }
            return await prepareListContainer(list, blockID: node.id)
        case let .blockquote(children):
            return await prepareContainer(
                kind: .quote,
                label: "Quote",
                title: nil,
                children: children
            )
        case let .codeBlock(code):
            return prepareCode(code)
        case let .table(table):
            return await prepareTable(table)
        case let .image(image):
            return await prepareImage(image)
        case let .mathBlock(expression):
            return await prepareMath(expression)
        case let .callout(callout):
            return await prepareCallout(callout)
        case let .details(details):
            return await prepareDetails(
                details,
                blockID: node.id,
                expanded: expandedBlockIDs.contains(node.id)
            )
        case let .userNote(note):
            return await prepareUserNote(note)
        case .thematicBreak:
            return .separator(ReaderPreparedSeparator(height: 25))
        case let .fallback(fallback):
            return prepareFallback(fallback)
        }
    }

    private func prepareFallback(_ fallback: HTMLFallbackModel) -> ReaderPreparedBlock {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 3
        let attributed = NSAttributedString(string: fallback.text, attributes: [
            .font: theme.body,
            .foregroundColor: theme.bodyColor,
            .paragraphStyle: style,
        ])
        let bodyHeight = ceil(attributed.boundingRect(
            with: CGSize(width: contentWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        ).height)
        return .fallback(
            ReaderPreparedFallback(
                text: fallback.text,
                warning: fallback.warning,
                height: bodyHeight + 58
            )
        )
    }
}

private extension UIFont {
    func withItalicIfPossible() -> UIFont {
        guard let descriptor = fontDescriptor.withSymbolicTraits(
            fontDescriptor.symbolicTraits.union(.traitItalic)
        ) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
