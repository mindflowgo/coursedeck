import Foundation
import SwiftSoup

/// Custom HTML→Markdown converter.
///
/// The desktop uses Turndown with the GFM plugin plus four custom rules. This
/// port keeps the same output contract for the constructs ILC lessons contain:
///
/// * Turndown core: paragraphs, headings, blockquotes, lists, list items,
///   fenced/indented code, inline code, links, images, emphasis, strong, `<br>`,
///   thematic breaks and raw-text preservation.
/// * GFM: strikethrough, tables, task-list items, highlighted code blocks.
/// * Custom: table-cell line breaks (`<br>`), `<details>/<summary>`,
///   `app-callout-goals`, and `app-row-callout` callouts.
///
/// The converter is intentionally DOM-based (SwiftSoup) rather than regex
/// based so nested tables, `<br>` in cells, colspan, and inline formatting are
/// preserved instead of corrupted.
public struct HTMLToMarkdownConverter: Sendable {
    public init() {}

    public func convert(_ html: String) throws -> String {
        let document = try SwiftSoup.parseBodyFragment(html)
        guard let body = document.body() else { return "" }
        let renderer = Renderer()
        let raw = try renderer.renderChildren(of: body, context: RenderContext())
        return Self.postProcess(raw)
    }

    static func postProcess(_ raw: String) -> String {
        var text = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "[\\t ]+\\n", with: "\n", options: .regularExpression)
            .replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
            .replacingOccurrences(of: "^\\n+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\n+$", with: "", options: .regularExpression)
        // Preserve the two-space hard break: only trim trailing spaces on
        // lines that do not end with exactly two spaces.
        text = text
            .components(separatedBy: "\n")
            .map { line -> String in
                if line.hasSuffix("  ") { return line }
                return line.replacingOccurrences(of: "[ ]+$", with: "", options: .regularExpression)
            }
            .joined(separator: "\n")
        return text.trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
    }
}

private struct RenderContext {
    var listDepth = 0
    var inTableCell = false
    var inPre = false
    var inBlockquote = false
}

private final class Renderer {
    func renderChildren(of element: Element, context: RenderContext) throws -> String {
        var output = ""
        for node in element.childNodesCopy() {
            output += try render(node, context: context)
        }
        return output
    }

    // MARK: - Dispatch

    func render(_ node: Node, context: RenderContext) throws -> String {
        if let text = node as? TextNode {
            if context.inPre { return text.getWholeText() }
            return escapeText(normalizeWhitespace(text.getWholeText()))
        }
        if node is DataNode { return "" }
        if node is Comment { return "" }
        guard let element = node as? Element else { return "" }

        let tag = element.tagNameNormal()
        if isHidden(element) { return "" }

        switch tag {
        case "script", "style", "noscript", "iframe", "form", "object", "embed",
             "button", "nav", "progress", "canvas", "template", "svg":
            return ""
        case "video", "audio", "source", "track":
            return ""
        case "p":
            let content = try renderChildren(of: element, context: context)
            if context.inTableCell { return content + "<br>" }
            let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "" : "\n\n\(trimmed)\n\n"
        case "div", "section", "article", "header", "footer", "main", "aside", "figure":
            if let callout = try calloutKind(for: element) {
                return try renderCallout(element, kind: callout, context: context)
            }
            let content = try renderChildren(of: element, context: context)
            if context.inTableCell { return content + "<br>" }
            let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "" : "\n\n\(trimmed)\n\n"
        case "h1", "h2", "h3", "h4", "h5", "h6":
            let level = Int(tag.dropFirst()) ?? 1
            let content = try renderChildren(of: element, context: context)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if content.isEmpty { return "" }
            if context.inTableCell { return content + "<br>" }
            return "\n\n\(String(repeating: "#", count: max(1, min(level, 6)))) \(content)\n\n"
        case "blockquote":
            let content = try renderChildren(of: element, context: context)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !content.isEmpty else { return "" }
            let quoted = content
                .components(separatedBy: "\n")
                .map { $0.isEmpty ? ">" : "> \($0)" }
                .joined(separator: "\n")
            return "\n\n\(quoted)\n\n"
        case "ul":
            return try renderList(element, ordered: false, context: context)
        case "ol":
            return try renderList(element, ordered: true, context: context)
        case "li":
            let content = try renderChildren(of: element, context: context)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return content.isEmpty ? "" : "\n\(content)\n"
        case "pre":
            return try renderPre(element, context: context)
        case "hr":
            return "\n\n---\n\n"
        case "br":
            return context.inTableCell ? "<br>" : "  \n"
        case "table":
            return try renderTable(element, context: context)
        case "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col":
            // Handled by renderTable; a stray row/cell is flattened.
            let content = try renderChildren(of: element, context: context)
            return context.inTableCell ? content + "<br>" : content
        case "details":
            return try renderDetails(element)
        case "summary":
            let content = try renderChildren(of: element, context: context)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return "<summary>\(escapeHTML(content))</summary>\n\n"
        case "a":
            return try renderLink(element, context: context)
        case "img":
            return try renderImage(element)
        case "strong", "b":
            return try renderWrapped(element, marker: "**", context: context)
        case "em", "i":
            return try renderWrapped(element, marker: "*", context: context)
        case "del", "s", "strike":
            return try renderWrapped(element, marker: "~~", context: context)
        case "code":
            return try renderInlineCode(element)
        case "sup", "sub", "mark", "kbd", "abbr", "ins":
            let content = try renderChildren(of: element, context: context)
            guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "" }
            return "<\(tag)>\(content)</\(tag)>"
        case "math":
            return try renderMathML(element)
        case "dl":
            let content = try renderChildren(of: element, context: context)
            return content.isEmpty ? "" : "\n\n\(content)\n\n"
        case "dt":
            let content = try renderChildren(of: element, context: context)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return content.isEmpty ? "" : "**\(content)**\n"
        case "dd":
            let content = try renderChildren(of: element, context: context)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return content.isEmpty ? "" : "    \(content)\n"
        case "input":
            return ""
        default:
            let content = try renderChildren(of: element, context: context)
            if context.inTableCell { return content }
            return content
        }
    }

    // MARK: - Blocks

    private func renderList(_ element: Element, ordered: Bool, context: RenderContext) throws -> String {
        let items = element.children().array().filter { $0.tagNameNormal() == "li" }
        guard !items.isEmpty else { return "" }
        var lines: [String] = []
        var index = 1
        for item in items {
            var marker = ordered ? "\(index). " : "- "
            index += 1

            if let checkbox = try item.select("input[type=checkbox]").first() {
                let checked = checkbox.hasAttr("checked")
                marker = "- [\(checked ? "x" : " ")] "
                try checkbox.remove()
            }

            var itemContext = context
            itemContext.listDepth += 1
            var content = try renderChildren(of: item, context: itemContext)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            content = content.replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)

            if context.inTableCell {
                let flattened = content
                    .components(separatedBy: "\n")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
                    .joined(separator: "<br>")
                lines.append(marker + flattened)
                continue
            }

            let indent = String(repeating: " ", count: marker.count)
            let contentLines = content.components(separatedBy: "\n")
            var rendered = marker + (contentLines.first ?? "")
            for line in contentLines.dropFirst() {
                rendered += "\n" + (line.isEmpty ? "" : indent + line)
            }
            lines.append(rendered)
        }
        let body = lines.joined(separator: "\n")
        return context.inTableCell ? body + "<br>" : "\n\n\(body)\n\n"
    }

    private func renderPre(_ element: Element, context: RenderContext) throws -> String {
        let codeElement = try element.select("code").first()
        let source = codeElement ?? element
        let text = rawText(of: source)
        if context.inTableCell {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "" : inlineCode(trimmed) + "<br>"
        }
        let language = codeLanguage(source)
        let fence = text.contains("```") ? "~~~" : "```"
        let trimmed = text.trimmingCharacters(in: .newlines)
        guard !trimmed.isEmpty else { return "" }
        return "\n\n\(fence)\(language)\n\(trimmed)\n\(fence)\n\n"
    }

    private func renderDetails(_ element: Element) throws -> String {
        let summary = element.children().array().first { $0.tagNameNormal() == "summary" }
        let summaryText = summary.map { (try? $0.text()) ?? "" } ?? "Suggested Answer"
        let className = ((try? element.attr("class")) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let cls = className.isEmpty ? "suggested-answer" : className
        var body = ""
        for child in element.childNodesCopy() {
            if let childElement = child as? Element, childElement.tagNameNormal() == "summary" {
                continue
            }
            body += try render(child, context: RenderContext())
        }
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return "\n\n<details class=\"\(escapeHTML(cls))\">\n<summary>\(escapeHTML(summaryText.trimmingCharacters(in: .whitespacesAndNewlines)))</summary>\n\n\(trimmed)\n\n</details>\n\n"
    }

    private func renderLink(_ element: Element, context: RenderContext) throws -> String {
        let href = try element.attr("href").trimmingCharacters(in: .whitespacesAndNewlines)
        let title = try element.attr("title")
        var text = try renderChildren(of: element, context: context)
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { text = href }
        guard !href.isEmpty else { return text }
        if href.lowercased().hasPrefix("javascript:") { return text }
        let titlePart = title.isEmpty ? "" : " \"\(title.replacingOccurrences(of: "\"", with: "\\\""))\""
        return "[\(text)](\(href)\(titlePart))"
    }

    private func renderImage(_ element: Element) throws -> String {
        let alt = try element.attr("alt")
        let title = try element.attr("title")
        let src = try element.attr("src").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !src.isEmpty else { return "" }
        let safeAlt = alt.replacingOccurrences(of: "]", with: "\\]")
        let titlePart = title.isEmpty ? "" : " \"\(title.replacingOccurrences(of: "\"", with: "\\\""))\""
        return "![\(safeAlt)](\(src)\(titlePart))"
    }

    private func renderWrapped(_ element: Element, marker: String, context: RenderContext) throws -> String {
        let content = try renderChildren(of: element, context: context)
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return "\(marker)\(trimmed)\(marker)"
    }

    private func renderInlineCode(_ element: Element) throws -> String {
        let text = rawText(of: element)
        guard !text.isEmpty else { return "" }
        return inlineCode(text)
    }

    private func renderMathML(_ element: Element) throws -> String {
        let xml = try element.outerHtml()
        let conversion = MathMLConverter.convert(xml)
        if !conversion.tex.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if conversion.display {
                return "\n\n$$\n\(conversion.tex)\n$$\n\n"
            }
            return "$\(conversion.tex)$"
        }
        let flattened = conversion.flattenedText.trimmingCharacters(in: .whitespacesAndNewlines)
        return flattened.isEmpty ? "" : escapeText(flattened)
    }

    // MARK: - Callouts

    private func calloutKind(for element: Element) throws -> String? {
        let className = ((try? element.className()) ?? "").lowercased()
        if className.contains("app-callout-goals") { return "NOTE" }
        guard className.contains("app-row-callout") else { return nil }
        let text = ((try? element.text()) ?? "").lowercased()
        if text.contains("warning") || text.contains("caution") { return "WARNING" }
        if text.contains("try it") || text.contains("try_it") { return "IMPORTANT" }
        if text.contains("think") { return "TIP" }
        return "NOTE"
    }

    private func renderCallout(_ element: Element, kind: String, context: RenderContext) throws -> String {
        let content = try renderChildren(of: element, context: context)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return "" }
        // The cleaner already emits the `<h3>Learning Goals & Success
        // Criteria</h3>` heading for the goals callout. Do not prepend a
        // second one here. Empty lines are dropped so a callout never emits a
        // bare `>` line.
        let quoted = content
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { "> \($0)" }
            .joined(separator: "\n")
        return "\n\n> [!\(kind)]\n\(quoted)\n\n"
    }

    // MARK: - Tables

    private func renderTable(_ element: Element, context: RenderContext) throws -> String {
        let rows = try ownRows(of: element)
        guard !rows.isEmpty else { return "" }

        let headerRow: Element
        var bodyRows: [Element]
        if let thead = try element.select("thead").first() {
            let theadRows = try thead.select("tr").array()
            if let first = theadRows.first {
                headerRow = first
                bodyRows = Array(theadRows.dropFirst()) + rows.filter { row in
                    !theadRows.contains(where: { $0 === row })
                }
            } else {
                headerRow = rows[0]
                bodyRows = Array(rows.dropFirst())
            }
        } else {
            headerRow = rows[0]
            bodyRows = Array(rows.dropFirst())
        }

        let headerCells = try cells(of: headerRow)
        var renderedHeader = try renderCells(headerRow)
        var renderedBody: [[String]] = []
        for row in bodyRows {
            renderedBody.append(try renderCells(row))
        }

        let columnCount = max(
            renderedHeader.count,
            renderedBody.map(\.count).max() ?? 0
        )
        guard columnCount > 0 else { return "" }
        while renderedHeader.count < columnCount {
            renderedHeader.append("")
        }
        for index in renderedBody.indices where renderedBody[index].count < columnCount {
            renderedBody[index].append(contentsOf: Array(repeating: "", count: columnCount - renderedBody[index].count))
        }

        let alignments = try headerCells.map { try alignment(of: $0) }
        let headerLine = "| " + renderedHeader.joined(separator: " | ") + " |"
        let delimiterCells = (0..<columnCount).map { index -> String in
            let alignment = index < alignments.count ? alignments[index] : .none
            switch alignment {
            case .left: return ":---"
            case .right: return "---:"
            case .center: return ":---:"
            case .none: return "---"
            }
        }
        let delimiterLine = "| " + delimiterCells.joined(separator: " | ") + " |"
        var lines = [headerLine, delimiterLine]
        for row in renderedBody {
            lines.append("| " + row.joined(separator: " | ") + " |")
        }
        return "\n\n" + lines.joined(separator: "\n") + "\n\n"
    }

    private enum Alignment {
        case none, left, right, center
    }

    private func alignment(of cell: Element) throws -> Alignment {
        let align = (try cell.attr("align")).lowercased()
        let style = (try cell.attr("style")).lowercased()
        if let match = style.range(of: "text-align\\s*:\\s*(left|right|center)", options: .regularExpression) {
            let value = String(style[match]).split(separator: ":").last?
                .trimmingCharacters(in: .whitespaces) ?? ""
            switch value {
            case "left": return .left
            case "right": return .right
            case "center": return .center
            default: break
            }
        }
        switch align {
        case "left": return .left
        case "right": return .right
        case "center": return .center
        default: return .none
        }
    }

    private func ownRows(of table: Element) throws -> [Element] {
        try table.select("tr").array().filter { row in
            var parent = row.parent()
            while let current = parent {
                if current === table { return true }
                if current.tagNameNormal() == "table" { return false }
                parent = current.parent()
            }
            return false
        }
    }

    private func cells(of row: Element) throws -> [Element] {
        try row.children().array().filter {
            let tag = $0.tagNameNormal()
            return tag == "td" || tag == "th"
        }
    }

    /// Renders one row, expanding `colspan` with empty cells so a spanned
    /// column never duplicates its neighbour's content.
    private func renderCells(_ row: Element) throws -> [String] {
        var output: [String] = []
        for cell in try cells(of: row) {
            output.append(try renderCell(cell))
            let colspan = Int((try? cell.attr("colspan")) ?? "") ?? 1
            if colspan > 1 {
                output.append(contentsOf: Array(repeating: "", count: colspan - 1))
            }
        }
        return output
    }

    private func renderCell(_ cell: Element) throws -> String {
        var context = RenderContext()
        context.inTableCell = true
        var content = try renderChildren(of: cell, context: context)
        content = content
            .replacingOccurrences(of: "\\n{2,}", with: "<br>", options: .regularExpression)
            .replacingOccurrences(of: "\n", with: "<br>")
            .replacingOccurrences(of: "(<br>){2,}", with: "<br>", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return escapeTablePipes(content)
    }

    // MARK: - Helpers

    private func isHidden(_ element: Element) -> Bool {
        let style = ((try? element.attr("style")) ?? "").lowercased()
        if style.contains("display:none") || style.contains("display: none") { return true }
        if element.hasClass("hidden") || element.hasClass("sr-only") { return true }
        if element.tagNameNormal() == "input" { return false }
        return false
    }

    private func rawText(of element: Element) -> String {
        var output = ""
        for node in element.childNodesCopy() {
            if let text = node as? TextNode {
                output += text.getWholeText()
            } else if let data = node as? DataNode {
                output += data.getWholeData()
            } else if let child = node as? Element {
                output += rawText(of: child)
            }
        }
        return output
    }

    private func codeLanguage(_ element: Element) -> String {
        let className = (try? element.attr("class")) ?? ""
        for token in className.split(separator: " ") {
            if token.hasPrefix("language-") {
                return String(token.dropFirst("language-".count))
            }
            if token.hasPrefix("lang-") {
                return String(token.dropFirst("lang-".count))
            }
        }
        return ""
    }

    private func inlineCode(_ text: String) -> String {
        let longestRun = text
            .components(separatedBy: "`")
            .map(\.count)
            .max() ?? 0
        let fence = String(repeating: "`", count: max(1, longestRun + 1))
        let padded = text.hasPrefix("`") || text.hasSuffix("`") ? " \(text) " : text
        return "\(fence)\(padded)\(fence)"
    }

    private func normalizeWhitespace(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .replacingOccurrences(of: "[\\t\\n\\r\\f ]+", with: " ", options: .regularExpression)
    }

    private func escapeText(_ text: String) -> String {
        var value = text
        value = value.replacingOccurrences(of: "\\", with: "\\\\")
        value = value.replacingOccurrences(of: "`", with: "\\`")
        value = value.replacingOccurrences(of: "*", with: "\\*")
        value = value.replacingOccurrences(of: "_", with: "\\_")
        value = value.replacingOccurrences(of: "[", with: "\\[")
        value = value.replacingOccurrences(of: "]", with: "\\]")
        return value
    }

    private func escapeHTML(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    private func escapeTablePipes(_ text: String) -> String {
        var output = ""
        var previous: Character?
        for character in text {
            if character == "|", previous != "\\" {
                output.append("\\")
            }
            output.append(character)
            previous = character
        }
        return output
    }
}
