import Foundation

/// Lightweight HTML tree used for raw-HTML blocks that `.disableSmartOpts`
/// leaves as `HTMLBlock` nodes: course lessons contain raw `<table>` ledgers,
/// `<details>` answers, callout divs, and MathML already protected into tokens.
final class HTMLTreeParser {
    static let voidTags: Set<String> = [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr",
    ]

    /// Opening one of these implicitly closes an ancestor with the same name.
    static let autoClose: [String: Set<String>] = [
        "p": ["p"],
        "li": ["li"],
        "td": ["td", "th"],
        "th": ["td", "th"],
        "tr": ["tr", "td", "th"],
        "tbody": ["thead", "tbody", "tfoot"],
        "thead": ["thead", "tbody", "tfoot"],
        "tfoot": ["thead", "tbody", "tfoot"],
        "option": ["option"],
        "dt": ["dt", "dd"],
        "dd": ["dt", "dd"],
    ]

    /// Block-level start tags close an open paragraph (HTML's implied `</p>`).
    static let blockStartClosesParagraph: Set<String> = [
        "address", "article", "aside", "blockquote", "details", "div", "dl",
        "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
        "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
        "section", "table", "ul",
    ]

    static func parse(_ html: String) -> HTMLNode {
        let root = HTMLNode(tag: "#document")
        var stack: [HTMLNode] = [root]
        let characters = Array(html)
        var index = 0
        var text = ""

        func flushText() {
            guard !text.isEmpty else { return }
            let decoded = MathMLXMLParser.decodeEntities(text)
            stack[stack.count - 1].children.append(.text(decoded))
            text = ""
        }

        while index < characters.count {
            guard characters[index] == "<" else {
                text.append(characters[index])
                index += 1
                continue
            }

            if index + 3 < characters.count,
               characters[index + 1] == "!",
               characters[index + 2] == "-",
               characters[index + 3] == "-" {
                flushText()
                index = skip(until: "-->", from: index + 4, characters: characters)
                continue
            }
            if index + 8 < characters.count,
               String(characters[index..<(index + 9)]) == "<![CDATA[" {
                flushText()
                let start = index + 9
                var cursor = start
                while cursor + 2 < characters.count,
                      !(characters[cursor] == "]" && characters[cursor + 1] == "]" && characters[cursor + 2] == ">") {
                    cursor += 1
                }
                text += String(characters[start..<min(cursor, characters.count)])
                index = min(cursor + 3, characters.count)
                continue
            }
            if index + 1 < characters.count, characters[index + 1] == "?" {
                flushText()
                index = skip(until: "?>", from: index + 2, characters: characters)
                continue
            }
            if index + 1 < characters.count, characters[index + 1] == "!" {
                flushText()
                index = skip(until: ">", from: index + 2, characters: characters)
                continue
            }

            flushText()
            guard let end = findTagEnd(from: index, characters: characters) else {
                text.append(characters[index])
                index += 1
                continue
            }
            let tag = String(characters[(index + 1)..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
            index = end + 1
            if tag.isEmpty { continue }

            if tag.hasPrefix("/") {
                let name = tag.dropFirst()
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                if let position = stack.lastIndex(where: { $0.tag == name }), position > 0 {
                    stack.removeSubrange(position..<stack.count)
                }
                continue
            }

            let selfClosing = tag.hasSuffix("/")
            let content = selfClosing ? String(tag.dropLast()).trimmingCharacters(in: .whitespaces) : tag
            let name = tagName(content).lowercased()
            guard !name.isEmpty else { continue }
            let attributes = parseAttributes(content)

            if name != "p",
               Self.blockStartClosesParagraph.contains(name),
               stack.last?.tag == "p" {
                stack.removeLast()
            }
            if let closers = Self.autoClose[name] {
                while stack.count > 1, let last = stack.last, closers.contains(last.tag) {
                    stack.removeLast()
                }
            }

            let node = HTMLNode(tag: name, attributes: attributes)
            stack[stack.count - 1].children.append(.element(node))
            if !selfClosing && !Self.voidTags.contains(name) {
                stack.append(node)
            }
        }

        flushText()
        return root
    }

    private static func skip(until terminator: String, from start: Int, characters: [Character]) -> Int {
        let term = Array(terminator)
        var cursor = start
        while cursor + term.count <= characters.count {
            if Array(characters[cursor..<(cursor + term.count)]) == term {
                return cursor + term.count
            }
            cursor += 1
        }
        return characters.count
    }

    private static func findTagEnd(from start: Int, characters: [Character]) -> Int? {
        var cursor = start + 1
        var quote: Character?
        while cursor < characters.count {
            let character = characters[cursor]
            if let current = quote {
                if character == current { quote = nil }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == ">" {
                return cursor
            }
            cursor += 1
        }
        return nil
    }

    private static func tagName(_ tag: String) -> String {
        var name = ""
        for character in tag {
            if character == " " || character == "\t" || character == "\n"
                || character == "\r" || character == "/" {
                break
            }
            name.append(character)
        }
        return name
    }

    private static func parseAttributes(_ tag: String) -> [String: String] {
        let pattern = #"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [:] }
        let range = NSRange(tag.startIndex..<tag.endIndex, in: tag)
        var attributes: [String: String] = [:]
        for match in regex.matches(in: tag, options: [], range: range) {
            guard let nameRange = Range(match.range(at: 1), in: tag) else { continue }
            let name = String(tag[nameRange]).lowercased()
            var value = ""
            if let doubleRange = Range(match.range(at: 2), in: tag) {
                value = String(tag[doubleRange])
            } else if let singleRange = Range(match.range(at: 3), in: tag) {
                value = String(tag[singleRange])
            }
            attributes[name] = MathMLXMLParser.decodeEntities(value)
        }
        return attributes
    }
}

final class HTMLNode {
    var tag: String
    var attributes: [String: String]
    var children: [HTMLChild]

    init(tag: String, attributes: [String: String] = [:], children: [HTMLChild] = []) {
        self.tag = tag
        self.attributes = attributes
        self.children = children
    }

    var textContent: String {
        children.map { child in
            switch child {
            case let .text(text): return text
            case let .element(element): return element.textContent
            }
        }.joined()
    }

    func firstElement(named name: String) -> HTMLNode? {
        for child in children {
            if case let .element(element) = child {
                if element.tag == name { return element }
                if let found = element.firstElement(named: name) { return found }
            }
        }
        return nil
    }
}

enum HTMLChild {
    case element(HTMLNode)
    case text(String)
}

/// Conversion hook surface shared with `MarkdownPipeline`.
struct HTMLConversionContext {
    var inlineMarkdown: (String) -> [InlineNode]
    var parseMarkdown: (String) -> [MarkdownBlockNode]
    var resolveAsset: (String) -> String
    var isRemote: (String) -> Bool
    /// Restores protected TeX/MathML/code placeholders in attribute text.
    var restoreText: (String) -> String
    var isSafeLink: (String) -> Bool
    var isSafeImageSource: (String) -> Bool
    /// Recognises a paragraph made only of a block-code placeholder (for
    /// `<pre>` nested in HTML containers).
    var blockCode: ([InlineNode]) -> MarkdownBlock?
    /// Splits block-code placeholders out of mixed inline text (for `<pre>`
    /// embedded in otherwise ordinary HTML paragraphs).
    var splitBlockCode: ([InlineNode]) -> [MarkdownBlock]?
    var warning: (String) -> Void
}

/// Converts raw HTML blocks into the block model. Raw HTML is never executed
/// and unsupported elements degrade to text with a visible warning.
final class RawHTMLBlockConverter {
    static let blockTags: Set<String> = [
        "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset",
        "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
        "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
        "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
    ]

    static let droppedTags: Set<String> = [
        "script", "style", "noscript", "form", "input", "button", "select",
        "textarea", "link", "meta", "base", "title", "head",
    ]

    let context: HTMLConversionContext

    init(context: HTMLConversionContext) {
        self.context = context
    }

    func blocks(from html: String) -> [MarkdownBlock] {
        let root = HTMLTreeParser.parse(html)
        return blocks(from: root.children)
    }

    /// Inline-only conversion for HTML that appeared inside a Markdown
    /// paragraph (or a `<summary>`).
    func inlineNodesPublic(_ children: [HTMLChild]) -> [InlineNode] {
        inlineNodes(from: children)
    }

    // MARK: - Block grouping

    private func blocks(from children: [HTMLChild]) -> [MarkdownBlock] {
        var output: [MarkdownBlock] = []
        var inlineBuffer: [InlineNode] = []

        func flushInline() {
            if let split = context.splitBlockCode(inlineBuffer), !split.isEmpty {
                output.append(contentsOf: split)
                inlineBuffer = []
                return
            }
            if let code = context.blockCode(inlineBuffer) {
                output.append(code)
                inlineBuffer = []
                return
            }
            if inlineBuffer.count == 1, case let .image(spec, destination, title)? = inlineBuffer.first {
                output.append(
                    .image(
                        ImageModel(
                            spec: spec,
                            destination: destination,
                            title: title,
                            isRemote: context.isRemote(destination),
                            caption: ImageModel.caption(for: spec)
                        )
                    )
                )
                inlineBuffer = []
                return
            }
            let hasContent = inlineBuffer.contains { node in
                switch node {
                case let .text(text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                case .lineBreak: return false
                default: return true
                }
            }
            if hasContent {
                output.append(.paragraph(inlineBuffer))
            }
            inlineBuffer = []
        }

        for child in children {
            switch child {
            case let .text(text):
                let nodes = context.inlineMarkdown(text)
                inlineBuffer.append(contentsOf: nodes)
            case let .element(element):
                if Self.blockTags.contains(element.tag) {
                    flushInline()
                    output.append(contentsOf: block(from: element))
                } else if element.tag == "img" {
                    if let image = image(from: element) {
                        inlineBuffer.append(.image(image.spec, destination: image.destination, title: image.title))
                    }
                } else if element.tag == "br" {
                    inlineBuffer.append(.lineBreak)
                } else if Self.droppedTags.contains(element.tag) {
                    continue
                } else if element.tag == "iframe" || element.tag == "object" || element.tag == "embed" {
                    flushInline()
                    output.append(contentsOf: embeddedFallback(element))
                } else {
                    inlineBuffer.append(contentsOf: inlineNodes(from: [child]))
                }
            }
        }

        flushInline()
        return output
    }

    private func block(from element: HTMLNode) -> [MarkdownBlock] {
        switch element.tag {
        case "table":
            return [table(from: element)]
        case "p":
            let inlines = inlineNodes(from: element.children)
            return inlines.isEmpty ? [] : [.paragraph(inlines)]
        case "h1", "h2", "h3", "h4", "h5", "h6":
            let level = Int(element.tag.dropFirst()) ?? 1
            let inlines = inlineNodes(from: element.children)
            return inlines.isEmpty ? [] : [.heading(level: level, inlines: inlines)]
        case "ul", "ol":
            return [list(from: element)]
        case "blockquote":
            let inner = blocks(from: element.children)
            return inner.isEmpty ? [] : [.blockquote(convertBlocksToNodes(inner))]
        case "pre":
            let text = element.textContent
            return [.codeBlock(CodeBlockModel(code: text, language: nil, isFenced: true))]
        case "hr":
            return [.thematicBreak]
        case "details":
            return [details(from: element)]
        case "figure":
            return figure(from: element)
        case "div", "section", "article", "header", "footer", "main", "aside", "nav",
             "address", "fieldset", "dl", "dt", "dd", "thead", "tbody", "tfoot", "tr", "td", "th":
            if let callout = callout(from: element) { return [callout] }
            return blocks(from: element.children)
        case "img":
            if let image = image(from: element) { return [.image(image)] }
            return []
        default:
            if Self.droppedTags.contains(element.tag) { return [] }
            if element.tag == "iframe" || element.tag == "object" || element.tag == "embed" {
                return embeddedFallback(element)
            }
            let inner = blocks(from: element.children)
            if inner.isEmpty {
                let inlines = inlineNodes(from: element.children)
                return inlines.isEmpty ? [] : [.paragraph(inlines)]
            }
            return inner
        }
    }

    private func figure(from element: HTMLNode) -> [MarkdownBlock] {
        var output: [MarkdownBlock] = []
        var caption: [InlineNode] = []
        if let figcaption = element.firstElement(named: "figcaption") {
            caption = inlineNodes(from: figcaption.children)
        }
        if let imageNode = element.firstElement(named: "img"),
           let image = image(from: imageNode) {
            var model = image
            if model.caption == nil {
                model.caption = caption.plainText.isEmpty ? nil : caption.plainText
            }
            output.append(.image(model))
        }
        let remainder = blocks(from: element.children.filter { child in
            if case let .element(element) = child {
                return element.tag != "img" && element.tag != "figcaption"
            }
            return true
        })
        output.append(contentsOf: remainder)
        return output
    }

    private func list(from element: HTMLNode) -> MarkdownBlock {
        let ordered = element.tag == "ol"
        let start = Int(element.attributes["start"] ?? "") ?? 1
        var items: [ListItemModel] = []

        for child in element.children {
            guard case let .element(item) = child, item.tag == "li" else { continue }
            var leading: [InlineNode] = []
            var nested: [MarkdownBlock] = []
            var seenBlock = false

            for itemChild in item.children {
                switch itemChild {
                case let .text(text):
                    let nodes = context.inlineMarkdown(text)
                    if seenBlock {
                        if !nodes.isEmpty { nested.append(.paragraph(nodes)) }
                    } else {
                        leading.append(contentsOf: nodes)
                    }
                case let .element(childElement):
                    if Self.blockTags.contains(childElement.tag) {
                        let converted = block(from: childElement)
                        if !seenBlock, leading.isEmpty, nested.isEmpty,
                           converted.count == 1, case let .paragraph(paragraph) = converted[0] {
                            leading = paragraph
                            seenBlock = true
                        } else {
                            seenBlock = true
                            nested.append(contentsOf: converted)
                        }
                    } else {
                        let nodes = inlineNodes(from: [itemChild])
                        if seenBlock {
                            if !nodes.isEmpty { nested.append(.paragraph(nodes)) }
                        } else {
                            leading.append(contentsOf: nodes)
                        }
                    }
                }
            }

            items.append(
                ListItemModel(
                    inlines: leading,
                    blocks: convertBlocksToNodes(nested),
                    checked: nil
                )
            )
        }

        return .list(ListModel(ordered: ordered, start: start, items: items))
    }

    private func details(from element: HTMLNode) -> MarkdownBlock {
        let summaryNode = element.firstElement(named: "summary")
        let summary = summaryNode.map { inlineNodes(from: $0.children) } ?? []
        let bodyChildren = element.children.filter { child in
            if case let .element(element) = child { return element.tag != "summary" }
            return true
        }
        let body = blocks(from: bodyChildren)
        return .details(
            DetailsModel(
                summary: summary.isEmpty ? [.text("Suggested Answer")] : summary,
                blocks: convertBlocksToNodes(body),
                isOpen: element.attributes["open"] != nil
            )
        )
    }

    private func callout(from element: HTMLNode) -> MarkdownBlock? {
        let classes = (element.attributes["class"] ?? "").lowercased()
        guard classes.contains("callout") else { return nil }
        var kind: CalloutKind = .note
        if let range = classes.range(of: #"callout-(note|tip|important|warning|caution)"#,
                                    options: .regularExpression) {
            let marker = String(classes[range]).replacingOccurrences(of: "callout-", with: "")
            kind = CalloutKind(marker: marker) ?? .note
        }
        let body = convertBlocksToNodes(blocks(from: element.children))
        return .callout(CalloutModel(kind: kind, title: nil, blocks: body))
    }

    private func embeddedFallback(_ element: HTMLNode) -> [MarkdownBlock] {
        let source = element.attributes["src"] ?? element.attributes["data"] ?? ""
        let text = source.isEmpty ? "Embedded content" : "Embedded content: \(source)"
        context.warning("embeddedContentDropped")
        return [
            .fallback(
                HTMLFallbackModel(
                    rawHTML: "",
                    text: text,
                    warning: "Embedded \(element.tag) content is not supported"
                )
            ),
        ]
    }

    // MARK: - Inline conversion

    private func inlineNodes(from children: [HTMLChild]) -> [InlineNode] {
        var output: [InlineNode] = []
        for child in children {
            switch child {
            case let .text(text):
                let nodes = context.inlineMarkdown(text)
                if nodes.isEmpty, !text.isEmpty {
                    // Preserve the whitespace between adjacent inline HTML
                    // elements (`</strong> <code>`), which Markdown parsing
                    // alone would drop.
                    let collapsed = text.replacingOccurrences(
                        of: "\\s+",
                        with: " ",
                        options: .regularExpression
                    )
                    if !collapsed.isEmpty { output.append(.text(collapsed)) }
                } else {
                    output.append(contentsOf: nodes)
                }
            case let .element(element):
                output.append(contentsOf: inlineNodes(from: element))
            }
        }
        return output
    }

    private func inlineNodes(from element: HTMLNode) -> [InlineNode] {
        switch element.tag {
        case "br":
            return [.lineBreak]
        case "img":
            return image(from: element).map {
                [InlineNode.image($0.spec, destination: $0.destination, title: $0.title)]
            } ?? []
        case "a":
            let children = inlineNodes(from: element.children)
            let destination = context.resolveAsset(element.attributes["href"] ?? "")
            guard isSafeLink(destination) else { return children }
            return [
                .link(
                    destination: destination,
                    title: element.attributes["title"].map(context.restoreText),
                    children: children
                ),
            ]
        case "strong", "b":
            return [.strong(inlineNodes(from: element.children))]
        case "em", "i":
            return [.emphasis(inlineNodes(from: element.children))]
        case "del", "s", "strike":
            return [.strikethrough(inlineNodes(from: element.children))]
        case "code":
            return [.code(MathMLXMLParser.decodeEntities(element.textContent))]
        case "sup":
            return [.superscript(inlineNodes(from: element.children))]
        case "sub":
            return [.subscripting(inlineNodes(from: element.children))]
        case "mark":
            return [.highlight(inlineNodes(from: element.children))]
        case "kbd":
            return [.keyboard(inlineNodes(from: element.children))]
        case "span":
            return [.span(inlineNodes(from: element.children))]
        case "math":
            let conversion = MathMLConverter.convert(renderElement(element))
            return [.math(MathExpression(tex: conversion.tex, display: conversion.display, isMathML: true))]
        case "script", "style", "noscript", "form", "textarea", "select", "button", "input":
            return []
        case "iframe", "object", "embed":
            context.warning("embeddedContentDropped")
            return element.attributes["src"].map { [.text($0)] } ?? []
        case "table", "ul", "ol":
            // A block element inside inline content is flattened to text.
            let flattened = element.textContent
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return flattened.isEmpty ? [] : context.inlineMarkdown(flattened)
        default:
            return inlineNodes(from: element.children)
        }
    }

    private func image(from element: HTMLNode) -> ImageModel? {
        guard element.tag == "img" else { return nil }
        let rawSource = element.attributes["src"] ?? ""
        guard !rawSource.isEmpty else { return nil }
        let destination = context.resolveAsset(rawSource)
        guard context.isSafeImageSource(destination) else { return nil }
        let alt = context.restoreText(element.attributes["alt"] ?? "")
        var specText = alt
        if let width = element.attributes["width"], !width.isEmpty,
           let height = element.attributes["height"], !height.isEmpty {
            specText = "\(alt)|\(width)x\(height)"
        } else if let width = element.attributes["width"], !width.isEmpty {
            specText = "\(alt)|\(width)"
        } else if let height = element.attributes["height"], !height.isEmpty {
            specText = "\(alt)|height=\(height)"
        }
        let spec = ImageSpecParser.parse(specText)
        let model = ImageModel(
            spec: spec,
            destination: destination,
            title: element.attributes["title"].map(context.restoreText),
            isRemote: context.isRemote(destination),
            caption: ImageModel.caption(for: spec)
        )
        return model
    }

    // MARK: - Tables

    private func table(from element: HTMLNode) -> MarkdownBlock {
        var headRows: [HTMLNode] = []
        var bodyRows: [HTMLNode] = []

        func collectRows(_ node: HTMLNode, inHead: Bool) {
            for child in node.children {
                guard case let .element(childElement) = child else { continue }
                switch childElement.tag {
                case "thead":
                    collectRows(childElement, inHead: true)
                case "tbody", "tfoot":
                    collectRows(childElement, inHead: false)
                case "tr":
                    if inHead { headRows.append(childElement) } else { bodyRows.append(childElement) }
                case "table":
                    continue
                default:
                    collectRows(childElement, inHead: inHead)
                }
            }
        }
        collectRows(element, inHead: false)

        // No <thead>: a first row of <th> cells is the header.
        if headRows.isEmpty, let first = bodyRows.first,
           first.children.contains(where: { child in
               if case let .element(element) = child { return element.tag == "th" }
               return false
           }) {
            headRows = [first]
            bodyRows.removeFirst()
        }

        func convertRow(_ row: HTMLNode) -> [TableCellModel] {
            var cells: [TableCellModel] = []
            for child in row.children {
                guard case let .element(cell) = child, cell.tag == "td" || cell.tag == "th" else { continue }
                let colSpan = Int(cell.attributes["colspan"] ?? "") ?? 1
                let rowSpan = Int(cell.attributes["rowspan"] ?? "") ?? 1
                let hasNestedTable = cell.firstElement(named: "table") != nil
                if hasNestedTable {
                    context.warning("nestedHTMLTableFlattened")
                }
                let inlines = inlineNodes(from: cell.children)
                cells.append(
                    TableCellModel(
                        inlines: inlines.isEmpty && hasNestedTable
                            ? context.inlineMarkdown(cell.textContent)
                            : inlines,
                        colSpan: colSpan,
                        rowSpan: rowSpan,
                        isHeader: cell.tag == "th"
                    )
                )
            }
            return cells
        }

        let header = headRows.first.map(convertRow) ?? []
        // Extra <thead> rows are still ledger data: keep them at the top of
        // the body instead of dropping them.
        var rows = headRows.dropFirst().map(convertRow) + bodyRows.map(convertRow)
        if !header.isEmpty {
            let headerSpans = header.reduce(0) { $0 + $1.colSpan }
            for index in rows.indices where rows[index].reduce(0, { $0 + $1.colSpan }) < headerSpans {
                while rows[index].reduce(0, { $0 + $1.colSpan }) < headerSpans {
                    rows[index].append(TableCellModel(inlines: []))
                }
            }
        }

        let columnCount = max(
            header.reduce(0) { $0 + $1.colSpan },
            rows.map { $0.reduce(0) { $0 + $1.colSpan } }.max() ?? 0
        )
        guard columnCount > 0 else {
            context.warning("emptyHTMLTableFlattened")
            let text = element.textContent.trimmingCharacters(in: .whitespacesAndNewlines)
            return .fallback(
                HTMLFallbackModel(
                    rawHTML: "",
                    text: text,
                    warning: "Raw HTML table had no rows and was flattened"
                )
            )
        }

        var alignments: [ColumnAlignment] = []
        let alignmentRow = headRows.first ?? bodyRows.first
        if let alignmentRow {
            for child in alignmentRow.children {
                guard case let .element(cell) = child, cell.tag == "td" || cell.tag == "th" else { continue }
                alignments.append(alignment(from: cell))
            }
        }
        while alignments.count < columnCount { alignments.append(.none) }

        var warnings: [String] = []
        if header.isEmpty { warnings.append("htmlTableWithoutHeader") }
        if let repair = element.attributes["data-repair"] { warnings.append(repair) }

        return .table(
            TableModel(
                header: header,
                rows: rows,
                columnAlignments: alignments,
                isHTML: true,
                warnings: warnings,
                repair: nil
            )
        )
    }

    private func alignment(from cell: HTMLNode) -> ColumnAlignment {
        if let align = cell.attributes["align"]?.lowercased() {
            switch align {
            case "left": return .left
            case "center": return .center
            case "right": return .right
            default: break
            }
        }
        if let style = cell.attributes["style"]?.lowercased(),
           let range = style.range(of: #"text-align\s*:\s*(left|center|right)"#, options: .regularExpression) {
            let value = String(style[range]).split(separator: ":").last?
                .trimmingCharacters(in: .whitespaces) ?? ""
            switch value {
            case "left": return .left
            case "center": return .center
            case "right": return .right
            default: break
            }
        }
        return .none
    }

    // MARK: - Helpers

    /// Converts `[MarkdownBlock]` to nodes for nested containers. IDs are
    /// assigned by the pipeline when the containing document is built; nested
    /// bodies get a local assigner so anchors remain deterministic.
    private func convertBlocksToNodes(_ blocks: [MarkdownBlock]) -> [MarkdownBlockNode] {
        var assigner = MarkdownBlockID.Assigner()
        return blocks.map { assigner.node(for: $0) }
    }

    private func renderElement(_ element: HTMLNode) -> String {
        var output = "<\(element.tag)"
        for (name, value) in element.attributes {
            output += " \(name)=\"\(value.replacingOccurrences(of: "\"", with: "&quot;"))\""
        }
        output += ">"
        output += element.textContent
        output += "</\(element.tag)>"
        return output
    }

    private func isSafeLink(_ destination: String) -> Bool {
        context.isSafeLink(destination)
    }
}
