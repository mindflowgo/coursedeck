import Foundation
import Markdown

public struct MarkdownPipelineOptions: Sendable {
    /// Directory containing the course's `assets/` folder. When set, asset
    /// references become local `file://` URLs (never API URLs).
    public var courseDirectoryURL: URL?
    public var courseID: String?
    /// Emit warnings on stderr? Core stays silent by design.
    public var maximumBlockCount: Int

    public init(
        courseDirectoryURL: URL? = nil,
        courseID: String? = nil,
        maximumBlockCount: Int = 200_000
    ) {
        self.courseDirectoryURL = courseDirectoryURL
        self.courseID = courseID
        self.maximumBlockCount = maximumBlockCount
    }
}

/// The Markdown pipeline described in PLAN §4.2:
///
/// 1. strip frontmatter
/// 2. normalize Pandoc image attributes
/// 3. rewrite `assets/` to local URLs
/// 4. protect code, TeX, and MathML
/// 5. extract callouts (body runs the full pipeline recursively)
/// 6. extract USERNOTE cards
/// 7. repair tables on the protected document
/// 8. parse blocks (swift-markdown + raw-HTML tables)
/// 9. restore math tokens as `MathExpression` values for SwiftMath
/// 10. MathML conversion (inside the restore step, before HTML sanitization)
/// 11. annotate USERNOTE anchors
/// 12. drop unsupported HTML
public enum MarkdownPipeline {
    public static func parse(
        _ raw: String,
        options: MarkdownPipelineOptions = MarkdownPipelineOptions()
    ) -> MarkdownDocument {
        let run = PipelineRun(options: options)
        return run.parseDocument(raw: raw, isFragment: false)
    }

    /// Parses a fragment with the same rules (used for nested callout,
    /// details, and USERNOTE bodies).
    public static func parseFragment(
        _ raw: String,
        options: MarkdownPipelineOptions = MarkdownPipelineOptions()
    ) -> MarkdownDocument {
        let run = PipelineRun(options: options)
        return run.parseDocument(raw: raw, isFragment: true)
    }
}

// MARK: - Box payloads

private enum BoxPayload {
    case callout(kind: CalloutKind, title: String?, body: String)
    case userNote(query: String, target: String?, body: String)
    case details(summary: String, body: String, isOpen: Bool)
}

// MARK: - Pipeline

private final class PipelineRun {
    let options: MarkdownPipelineOptions
    let protection = MarkdownProtection()
    var boxes: [BoxPayload] = []
    var warnings: [String] = []

    init(options: MarkdownPipelineOptions) {
        self.options = options
    }

    func parseDocument(raw: String, isFragment: Bool) -> MarkdownDocument {
        var text = raw
            .replacingOccurrences(of: "\u{FEFF}", with: "")
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        var frontmatter: FrontmatterDocument?
        var hadFrontmatter = false

        if !isFragment {
            do {
                let parsed = try FrontmatterDocument(parsing: text)
                if parsed.hadFrontmatter {
                    frontmatter = parsed
                    hadFrontmatter = true
                    text = parsed.body
                }
            } catch {
                warnings.append("malformedFrontmatter")
                let stripped = Self.stripFrontmatterSyntactically(text)
                if stripped != text {
                    hadFrontmatter = true
                    text = stripped
                }
            }
        }

        text = normalizePandocImageAttributes(text)
        text = rewriteAssetReferences(text)

        // Protect every code/TeX/MathML form before any table work.
        text = protection.protect(text)

        // Callouts and USERNOTE cards must be extracted before table repair;
        // their bodies recurse through the whole pipeline below.
        text = extractCalloutsAndUserNotes(text)
        text = extractDetails(text)

        let repair = MarkdownTableRepair.repair(text)
        let blocks = parseBlocks(repair)
        var document = MarkdownDocument(
            blocks: blocks,
            warnings: warnings,
            frontmatter: frontmatter,
            hadFrontmatter: hadFrontmatter
        )
        document = injectUserNoteAnchors(document)
        return document
    }

    /// Parses a body that has ALREADY been through the protection pass. The
    /// shared `protection`/`boxes` registries keep math and code tokens alive
    /// across nested callout / details / USERNOTE bodies.
    private func parseNestedProtected(_ body: String) -> [MarkdownBlockNode] {
        var text = body
        text = extractCalloutsAndUserNotes(text)
        text = extractDetails(text)
        let repair = MarkdownTableRepair.repair(text)
        return parseBlocks(repair)
    }

    // MARK: - Stage 1/2/3: frontmatter, Pandoc attrs, assets

    private static func stripFrontmatterSyntactically(_ text: String) -> String {
        guard text.hasPrefix("---") else { return text }
        guard let regex = try? NSRegularExpression(
            pattern: #"^---[ \t]*\n[\s\S]*?\n---[ \t]*\n?"#,
            options: []
        ) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              let swiftRange = Range(match.range, in: text) else {
            return text
        }
        return String(text[swiftRange.upperBound...])
    }

    private func normalizePandocImageAttributes(_ text: String) -> String {
        replace(
            pattern: #"!\[(.*?)\]\((.*?)\)\{([^}]+)\}"#,
            in: text
        ) { groups in
            let alt = groups.count > 0 ? groups[0] : ""
            let destination = groups.count > 1 ? groups[1] : ""
            let attributes = groups.count > 2 ? groups[2] : ""
            return "![\(alt)|\(attributes.trimmingCharacters(in: .whitespaces))](\(destination))"
        }
    }

    private func rewriteAssetReferences(_ text: String) -> String {
        var output = text
        output = replace(
            pattern: #"(?i)(src|href)\s*=\s*["'](?:\.\./)*(?:\./)?assets/(.*?)["']"#,
            in: output
        ) { groups in
            let attribute = groups.count > 0 ? groups[0] : "src"
            let path = groups.count > 1 ? groups[1] : ""
            let resolved = self.resolveAsset("assets/\(path)")
            return "\(attribute)=\"\(resolved)\""
        }
        output = replace(
            pattern: #"!\[(.*?)\]\((?:\.\./)*(?:\./)?assets/(.*?)\)"#,
            in: output
        ) { groups in
            let alt = groups.count > 0 ? groups[0] : ""
            let path = groups.count > 1 ? groups[1] : ""
            return "![\(alt)](\(self.resolveAsset("assets/\(path)")))"
        }
        output = replace(
            pattern: #"(?<!!)\[(.*?)\]\((?:\.\./)*(?:\./)?assets/(.*?)\)"#,
            in: output
        ) { groups in
            let label = groups.count > 0 ? groups[0] : ""
            let path = groups.count > 1 ? groups[1] : ""
            return "[\(label)](\(self.resolveAsset("assets/\(path)")))"
        }
        return output
    }

    func resolveAsset(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return trimmed }

        // Lesson Markdown sometimes points at `../assets/...` (for example
        // attachments under `assets/alt`). Strip leading parent segments and
        // then validate the final path against the course directory; the data
        // root is untrusted and path traversal must still fail.
        var candidate = trimmed
        while candidate.hasPrefix("../") {
            candidate.removeFirst(3)
        }
        while candidate.hasPrefix("./") {
            candidate.removeFirst(2)
        }
        guard candidate.hasPrefix("assets/") else {
            return trimmed
        }
        let relative = String(candidate.dropFirst("assets/".count))
        let components = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains(".."), !relative.hasPrefix("/") else {
            return ""
        }
        guard let courseDirectory = options.courseDirectoryURL else {
            return candidate
        }
        let assetsRoot = courseDirectory
            .appendingPathComponent("assets", isDirectory: true)
            .standardizedFileURL
        let url = assetsRoot
            .appendingPathComponent(relative)
            .standardizedFileURL
        let resolvedRoot = assetsRoot.resolvingSymlinksInPath()
        let resolvedURL = url.resolvingSymlinksInPath()
        let rootPath = resolvedRoot.path.hasSuffix("/")
            ? resolvedRoot.path
            : resolvedRoot.path + "/"
        guard resolvedURL.path.hasPrefix(rootPath) else { return "" }
        return url.absoluteString
    }

    func isRemoteAsset(_ value: String) -> Bool {
        let lowered = value.lowercased()
        return lowered.hasPrefix("http://") || lowered.hasPrefix("https://")
    }

    func isSafeLink(_ value: String) -> Bool {
        MarkdownURLSafety.isSafeLink(value) && isAllowedFileURL(value)
    }

    func isSafeImageSource(_ value: String) -> Bool {
        MarkdownURLSafety.isSafeImageSource(value) && isAllowedFileURL(value)
    }

    /// `file:` URLs are accepted only when they resolve inside the course
    /// assets folder. Without a course root they are rejected.
    private func isAllowedFileURL(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("file:") else { return true }
        guard trimmed.lowercased().hasPrefix("file://"),
              let url = URL(string: trimmed),
              let courseDirectory = options.courseDirectoryURL else {
            return false
        }
        let assetsRoot = courseDirectory
            .appendingPathComponent("assets", isDirectory: true)
            .standardizedFileURL
        let resolvedRoot = assetsRoot.resolvingSymlinksInPath()
        let resolvedURL = url.standardizedFileURL.resolvingSymlinksInPath()
        let rootPath = resolvedRoot.path.hasSuffix("/")
            ? resolvedRoot.path
            : resolvedRoot.path + "/"
        return resolvedURL.path == resolvedRoot.path
            || resolvedURL.path.hasPrefix(rootPath)
    }

    // MARK: - Stage 5/6: callouts and USERNOTE

    private func extractCalloutsAndUserNotes(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n")
        var output: [String] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            if let marker = calloutMarker(line) {
                var body: [String] = []
                var cursor = index + 1
                while cursor < lines.count, let unquoted = unquote(lines[cursor]) {
                    body.append(unquoted)
                    cursor += 1
                }
                let bodyText = body.joined(separator: "\n")
                let boxIndex = boxes.count
                boxes.append(
                    .callout(
                        kind: marker.kind,
                        title: marker.title.map(restorePlainText),
                        body: bodyText
                    )
                )
                output.append("")
                output.append("%%CDCALLOUT\(boxIndex)%%")
                output.append("")
                index = cursor
                continue
            }

            if let note = userNoteMarker(line) {
                var body: [String] = []
                var cursor = index + 1
                while cursor < lines.count, let unquoted = unquote(lines[cursor]) {
                    body.append(unquoted)
                    cursor += 1
                }
                let rawBody = body.joined(separator: "\n")
                let target = Self.extractUserNoteTarget(rawBody).map(restorePlainText)
                let bodyText = Self.removingUserNoteTargetComment(rawBody)
                let boxIndex = boxes.count
                boxes.append(
                    .userNote(
                        query: restorePlainText(note),
                        target: target,
                        body: bodyText
                    )
                )
                output.append("")
                output.append("%%CDUSERNOTE\(boxIndex)%%")
                output.append("")
                index = cursor
                continue
            }

            output.append(line)
            index += 1
        }

        return output.joined(separator: "\n")
    }

    private func calloutMarker(_ line: String) -> (kind: CalloutKind, title: String?)? {
        let pattern = #"^\s{0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = regex.firstMatch(in: line, options: [], range: range),
              let kindRange = Range(match.range(at: 1), in: line) else {
            return nil
        }
        let kind = CalloutKind(marker: String(line[kindRange])) ?? .note
        var title: String?
        if let titleRange = Range(match.range(at: 2), in: line) {
            let value = String(line[titleRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { title = value }
        }
        return (kind, title)
    }

    private func userNoteMarker(_ line: String) -> String? {
        let pattern = #"^\s{0,3}>\s*\[!USERNOTE\]\s*(.*)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = regex.firstMatch(in: line, options: [], range: range) else { return nil }
        if let queryRange = Range(match.range(at: 1), in: line) {
            return String(line[queryRange]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return ""
    }

    private func unquote(_ line: String) -> String? {
        let characters = Array(line)
        var index = 0
        while index < characters.count, index < 4,
              characters[index] == " " || characters[index] == "\t" {
            index += 1
        }
        guard index < characters.count, characters[index] == ">" else { return nil }
        index += 1
        if index < characters.count, characters[index] == " " { index += 1 }
        return String(characters[index...])
    }

    private static func extractUserNoteTarget(_ body: String) -> String? {
        let pattern = #"<!--\s*target:\s*"([\s\S]*?)"\s*-->"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(body.startIndex..<body.endIndex, in: body)
        guard let match = regex.firstMatch(in: body, options: [], range: range),
              let targetRange = Range(match.range(at: 1), in: body) else {
            return nil
        }
        return String(body[targetRange])
            .replacingOccurrences(of: "\\\"", with: "\"")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func removingUserNoteTargetComment(_ body: String) -> String {
        let pattern = #"<!--\s*target:\s*[\s\S]*?-->"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return body
        }
        let range = NSRange(body.startIndex..<body.endIndex, in: body)
        return regex.stringByReplacingMatches(in: body, options: [], range: range, withTemplate: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Details

    /// Balanced `<details>` extraction. Nested details stay inside the outer
    /// body (and are extracted recursively by `parseNestedProtected`), and any
    /// common blockquote prefix depth is removed before parsing (live BAF3M/
    /// CLU3M details sit inside callout blockquotes).
    private func extractDetails(_ text: String) -> String {
        let tagPattern = #"(?is)</?details\b"#
        guard let tagRegex = try? NSRegularExpression(pattern: tagPattern) else {
            return text
        }
        var output = ""
        var searchStart = text.startIndex

        while searchStart < text.endIndex,
              let openRange = text.range(
                of: "<details",
                options: [.caseInsensitive],
                range: searchStart..<text.endIndex
              ) {
            let nameEnd = openRange.upperBound
            guard nameEnd < text.endIndex else { break }
            let afterName = text[nameEnd]
            guard afterName.isWhitespace || afterName == ">" || afterName == "/" else {
                output += text[searchStart..<nameEnd]
                searchStart = nameEnd
                continue
            }
            guard let tagEnd = findTagEnd(in: text, from: nameEnd) else { break }
            let openTag = String(text[openRange.lowerBound...tagEnd])
            output += text[searchStart..<openRange.lowerBound]

            if openTag.hasSuffix("/>") {
                output += openTag
                searchStart = text.index(after: tagEnd)
                continue
            }

            let innerStart = text.index(after: tagEnd)
            var depth = 1
            var closeStart: String.Index?
            var closeEnd: String.Index?
            var scan = innerStart

            while scan < text.endIndex {
                let fullRange = NSRange(scan..<text.endIndex, in: text)
                guard let match = tagRegex.firstMatch(in: text, options: [], range: fullRange),
                      let matchRange = Range(match.range, in: text) else {
                    break
                }
                let matchTagEnd = findTagEnd(in: text, from: matchRange.upperBound)
                guard let matchTagEnd else { break }
                let tagText = String(text[matchRange.lowerBound...matchTagEnd])
                if tagText.lowercased().hasPrefix("</") {
                    depth -= 1
                    if depth == 0 {
                        closeStart = matchRange.lowerBound
                        closeEnd = text.index(after: matchTagEnd)
                        break
                    }
                } else if !tagText.hasSuffix("/>") {
                    depth += 1
                }
                scan = text.index(after: matchTagEnd)
            }

            guard let closeStart, let closeEnd else {
                output += text[openRange.lowerBound...]
                return output
            }

            let inner = String(text[innerStart..<closeStart])
            let quoteDepth = quoteDepthBefore(text, at: openRange.lowerBound)
            let strippedInner = stripQuoteDepth(inner, depth: quoteDepth)

            var summary = "Suggested Answer"
            var body = strippedInner
            if let summaryRegex = try? NSRegularExpression(
                pattern: #"(?is)<summary\b[^>]*>([\s\S]*?)</summary>"#,
                options: []
            ) {
                let range = NSRange(strippedInner.startIndex..<strippedInner.endIndex, in: strippedInner)
                if let match = summaryRegex.firstMatch(in: strippedInner, options: [], range: range),
                   let contentRange = Range(match.range(at: 1), in: strippedInner),
                   let fullRange = Range(match.range, in: strippedInner) {
                    let summaryText = String(strippedInner[contentRange])
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !summaryText.isEmpty { summary = summaryText }
                    body = String(strippedInner[fullRange.upperBound...])
                }
            }

            let boxIndex = boxes.count
            boxes.append(
                .details(
                    summary: summary,
                    body: body,
                    isOpen: detailsTagIsOpen(openTag)
                )
            )
            output += "\n\n%%CDDETAILS\(boxIndex)%%\n\n"
            searchStart = closeEnd
        }

        if searchStart < text.endIndex {
            output += text[searchStart...]
        }
        return output
    }

    private func findTagEnd(in text: String, from start: String.Index) -> String.Index? {
        var index = start
        var quote: Character?
        while index < text.endIndex {
            let character = text[index]
            if let current = quote {
                if character == current { quote = nil }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == ">" {
                return index
            }
            index = text.index(after: index)
        }
        return nil
    }

    private func quoteDepthBefore(_ text: String, at index: String.Index) -> Int {
        let lineStart = text[..<index].lastIndex(of: "\n").map { text.index(after: $0) }
            ?? text.startIndex
        let prefix = text[lineStart..<index]
        var depth = 0
        var cursor = prefix.startIndex
        while cursor < prefix.endIndex {
            if prefix[cursor] == ">" { depth += 1 }
            cursor = prefix.index(after: cursor)
        }
        return depth
    }

    private func stripQuoteDepth(_ value: String, depth: Int) -> String {
        guard depth > 0 else { return value }
        return value
            .components(separatedBy: "\n")
            .map { stripOneQuoteLine($0, depth: depth) }
            .joined(separator: "\n")
    }

    private func stripOneQuoteLine(_ line: String, depth: Int) -> String {
        var characters = Array(line)
        var index = 0
        var remaining = depth
        while remaining > 0 {
            let start = index
            var spaces = 0
            while index < characters.count,
                  (characters[index] == " " || characters[index] == "\t"),
                  spaces < 4 {
                index += 1
                spaces += 1
            }
            guard index < characters.count, characters[index] == ">" else {
                index = start
                break
            }
            index += 1
            if index < characters.count, characters[index] == " " { index += 1 }
            remaining -= 1
        }
        return index < characters.count ? String(characters[index...]) : ""
    }

    private func detailsTagIsOpen(_ tag: String) -> Bool {
        tag.range(
            of: #"(?i)(?:^|\s)open(?:\s|=|>)"#,
            options: .regularExpression
        ) != nil
    }

    // MARK: - Stage 7/8: parse blocks

    private func parseBlocks(_ repair: TableRepairResult) -> [MarkdownBlockNode] {
        let document = Document(parsing: repair.markdown, options: [.disableSmartOpts])
        let sourceLines = repair.markdown.components(separatedBy: "\n")
        var metadataCursor = 0
        var assigner = MarkdownBlockID.Assigner()
        var blocks: [MarkdownBlockNode] = []

        for markup in document.children {
            let converted = mapBlock(
                markup,
                tableMetadata: repair.tables,
                tableIndex: &metadataCursor,
                sourceLines: sourceLines
            )
            for block in converted {
                let node = assigner.node(for: block)
                blocks.append(
                    MarkdownBlockNode(
                        id: node.id,
                        block: namespaceNestedBlock(node.block, parentID: node.id)
                    )
                )
            }
            if blocks.count > options.maximumBlockCount {
                warnings.append("blockLimitReached")
                break
            }
        }

        return blocks
    }

    /// Nested containers use local ID assigners. Prefixing every nested ID with
    /// its parent's ID makes IDs globally unique while keeping them stable
    /// across reparses (the parent ID is stable).
    private func namespaceNestedBlock(_ block: MarkdownBlock, parentID: String) -> MarkdownBlock {
        switch block {
        case let .blockquote(children):
            return .blockquote(children.map { renamedNode($0, parentID: parentID) })
        case .list(var list):
            list.items = list.items.map { item in
                var updated = item
                updated.blocks = item.blocks.map { renamedNode($0, parentID: parentID) }
                return updated
            }
            return .list(list)
        case .callout(var callout):
            callout.blocks = callout.blocks.map { renamedNode($0, parentID: parentID) }
            return .callout(callout)
        case .details(var details):
            details.blocks = details.blocks.map { renamedNode($0, parentID: parentID) }
            return .details(details)
        case .userNote(var note):
            note.blocks = note.blocks.map { renamedNode($0, parentID: parentID) }
            return .userNote(note)
        default:
            return block
        }
    }

    private func renamedNode(_ node: MarkdownBlockNode, parentID: String) -> MarkdownBlockNode {
        let newID = "\(parentID)/\(node.id)"
        return MarkdownBlockNode(
            id: newID,
            block: namespaceNestedBlock(node.block, parentID: newID)
        )
    }

    private func mapBlock(
        _ markup: Markup,
        tableMetadata: [TableRepairMetadata],
        tableIndex: inout Int,
        sourceLines: [String]
    ) -> [MarkdownBlock] {
        if let heading = markup as? Heading {
            return [.heading(level: heading.level, inlines: inlineNodes(heading.children))]
        }

        if let paragraph = markup as? Paragraph {
            let inlines = inlineNodes(paragraph.children)
            if let split = splitBlockCodeInlines(inlines) { return split }
            if let boxBlocks = resolveBoxToken(inlines) { return boxBlocks }
            if inlines.count == 1, case let .image(spec, destination, title) = inlines[0] {
                let model = ImageModel(
                    spec: spec,
                    destination: destination,
                    title: title,
                    isRemote: isRemoteAsset(destination),
                    caption: ImageModel.caption(for: spec)
                )
                return [.image(model)]
            }
            if inlines.count == 1, case let .math(expression) = inlines[0], expression.display {
                return [.mathBlock(expression)]
            }
            return inlines.isEmpty ? [] : [.paragraph(inlines)]
        }

        if let code = markup as? CodeBlock {
            return [
                .codeBlock(
                    CodeBlockModel(
                        code: code.code,
                        language: code.language,
                        isFenced: isFencedCodeBlock(code, sourceLines: sourceLines)
                    )
                ),
            ]
        }

        if let quote = markup as? BlockQuote {
            var assigner = MarkdownBlockID.Assigner()
            var children: [MarkdownBlock] = []
            for child in quote.children {
                children.append(
                    contentsOf: mapBlock(
                        child,
                        tableMetadata: tableMetadata,
                        tableIndex: &tableIndex,
                        sourceLines: sourceLines
                    )
                )
            }
            return children.isEmpty ? [] : [.blockquote(children.map { assigner.node(for: $0) })]
        }

        if markup is UnorderedList || markup is OrderedList {
            return [
                listBlock(
                    markup,
                    tableMetadata: tableMetadata,
                    tableIndex: &tableIndex,
                    sourceLines: sourceLines
                ),
            ]
        }

        if let table = markup as? Table {
            let block = tableBlock(
                table,
                metadata: tableIndex < tableMetadata.count ? tableMetadata[tableIndex].tableRepairInfo : nil
            )
            tableIndex += 1
            return [.table(block)]
        }

        if let html = markup as? HTMLBlock {
            let converter = makeHTMLConverter(tableMetadata: tableMetadata, tableIndex: &tableIndex)
            let blocks = converter.blocks(from: html.rawHTML)
            if !blocks.isEmpty { return blocks }
            let text = protection.htmlToText(html.rawHTML)
            return text.isEmpty ? [] : [
                .fallback(
                    HTMLFallbackModel(
                        rawHTML: html.rawHTML,
                        text: text,
                        warning: "Unsupported raw HTML block was flattened"
                    )
                ),
            ]
        }

        if markup is ThematicBreak {
            return [.thematicBreak]
        }

        let text = plainText(of: markup).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? [] : [
            .fallback(
                HTMLFallbackModel(
                    rawHTML: markup.format(),
                    text: text,
                    warning: "Unsupported block type \(type(of: markup))"
                )
            ),
        ]
    }

    // MARK: - Lists

    private func listBlock(
        _ markup: Markup,
        tableMetadata: [TableRepairMetadata],
        tableIndex: inout Int,
        sourceLines: [String]
    ) -> MarkdownBlock {
        let ordered = markup is OrderedList
        let start = (markup as? OrderedList).map { Int($0.startIndex) } ?? 1
        var items: [ListItemModel] = []
        var nestedAssigner = MarkdownBlockID.Assigner()

        for child in markup.children {
            guard let item = child as? ListItem else { continue }
            var inlines: [InlineNode] = []
            var nested: [MarkdownBlockNode] = []
            var consumedLeadingParagraph = false

            for itemChild in item.children {
                if let paragraph = itemChild as? Paragraph, !consumedLeadingParagraph, inlines.isEmpty {
                    let nodes = inlineNodes(paragraph.children)
                    if let split = splitBlockCodeInlines(nodes) {
                        nested.append(contentsOf: split.map { nestedAssigner.node(for: $0) })
                    } else {
                        inlines = nodes
                    }
                    consumedLeadingParagraph = true
                    continue
                }
                let converted = mapBlock(
                    itemChild,
                    tableMetadata: tableMetadata,
                    tableIndex: &tableIndex,
                    sourceLines: sourceLines
                )
                nested.append(contentsOf: converted.map { nestedAssigner.node(for: $0) })
            }

            let checked: Bool?
            switch item.checkbox {
            case .some(.checked): checked = true
            case .some(.unchecked): checked = false
            case .none: checked = nil
            }
            items.append(ListItemModel(inlines: inlines, blocks: nested, checked: checked))
        }

        return .list(ListModel(ordered: ordered, start: start, items: items))
    }

    // MARK: - Tables

    private func tableBlock(_ table: Table, metadata: TableRepairInfo?) -> TableModel {
        let header: [TableCellModel] = Array(table.head.cells).map { cell in
            TableCellModel(
                inlines: self.inlineNodes(cell.children),
                colSpan: Int(cell.colspan),
                rowSpan: Int(cell.rowspan),
                isHeader: true
            )
        }
        let rows: [[TableCellModel]] = Array(table.body.rows).map { row in
            Array(row.cells).map { cell in
                TableCellModel(
                    inlines: self.inlineNodes(cell.children),
                    colSpan: Int(cell.colspan),
                    rowSpan: Int(cell.rowspan),
                    isHeader: false
                )
            }
        }
        var alignments = table.columnAlignments.map { alignment -> ColumnAlignment in
            guard let alignment else { return .none }
            switch alignment {
            case .left: return .left
            case .center: return .center
            case .right: return .right
            }
        }

        let columnCount = max(
            header.reduce(0) { $0 + $1.colSpan },
            rows.map { $0.reduce(0) { $0 + $1.colSpan } }.max() ?? 0,
            alignments.count
        )
        while alignments.count < columnCount { alignments.append(.none) }

        var normalizedHeader = header
        while normalizedHeader.reduce(0, { $0 + $1.colSpan }) < columnCount {
            normalizedHeader.append(TableCellModel(inlines: []))
        }
        var normalizedRows = rows
        for index in normalizedRows.indices {
            while normalizedRows[index].reduce(0, { $0 + $1.colSpan }) < columnCount {
                normalizedRows[index].append(TableCellModel(inlines: []))
            }
        }

        var warnings = metadata?.warnings ?? []
        if metadata?.surplusCellCount ?? 0 > 0 {
            warnings.append("surplusCellsPreserved")
        }
        return TableModel(
            header: normalizedHeader,
            rows: normalizedRows,
            columnAlignments: alignments,
            isHTML: false,
            warnings: warnings,
            repair: metadata
        )
    }

    // MARK: - HTML converter

    private func makeHTMLConverter(
        tableMetadata: [TableRepairMetadata],
        tableIndex: inout Int
    ) -> RawHTMLBlockConverter {
        let context = HTMLConversionContext(
            inlineMarkdown: { [weak self] text in
                self?.inlineMarkdown(text) ?? [.text(text)]
            },
            parseMarkdown: { [weak self] text in
                self?.parseNestedProtected(text) ?? []
            },
            resolveAsset: { [weak self] value in
                self?.resolveAsset(value) ?? value
            },
            isRemote: { [weak self] value in
                self?.isRemoteAsset(value) ?? false
            },
            restoreText: { [weak self] value in
                self?.restorePlainText(value) ?? value
            },
            isSafeLink: { [weak self] value in
                self?.isSafeLink(value) ?? false
            },
            isSafeImageSource: { [weak self] value in
                self?.isSafeImageSource(value) ?? false
            },
            blockCode: { [weak self] inlines in
                self?.blockCodeBlock(for: inlines)
            },
            splitBlockCode: { [weak self] inlines in
                self?.splitBlockCodeInlines(inlines)
            },
            warning: { [weak self] warning in
                self?.warnings.append(warning)
            }
        )
        return RawHTMLBlockConverter(context: context)
    }

    // MARK: - Boxes

    /// Splits a paragraph whose inline text mixes one or more block-code
    /// placeholders with ordinary prose into code blocks and paragraphs.
    /// Placeholders may have been merged by the Markdown parser, so a pure
    /// "token only" check is not enough.
    private func splitBlockCodeInlines(_ inlines: [InlineNode]) -> [MarkdownBlock]? {
        let pattern = #"%%CDBLOCKCODE(\d+)%%"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }

        var output: [MarkdownBlock] = []
        var buffer: [InlineNode] = []
        var found = false

        func flush() {
            if !buffer.isEmpty {
                output.append(.paragraph(buffer))
                buffer = []
            }
        }

        for inline in inlines {
            guard case let .text(text) = inline, text.contains("%%CDBLOCKCODE") else {
                buffer.append(inline)
                continue
            }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            let matches = regex.matches(in: text, options: [], range: range)
            guard !matches.isEmpty else {
                buffer.append(inline)
                continue
            }
            var cursor = text.startIndex
            for match in matches {
                guard let matchRange = Range(match.range, in: text),
                      let indexRange = Range(match.range(at: 1), in: text),
                      let index = Int(text[indexRange]) else { continue }
                if cursor < matchRange.lowerBound {
                    buffer.append(contentsOf: textNodes(String(text[cursor..<matchRange.lowerBound])))
                }
                if let code = protection.blockCode(at: index) {
                    flush()
                    output.append(
                        .codeBlock(
                            CodeBlockModel(
                                code: code.code,
                                language: code.language,
                                isFenced: code.isFenced
                            )
                        )
                    )
                    found = true
                }
                cursor = matchRange.upperBound
            }
            if cursor < text.endIndex {
                buffer.append(contentsOf: textNodes(String(text[cursor...])))
            }
        }

        flush()
        return found ? output : nil
    }

    /// Used by the raw-HTML converter for `<pre>` placeholders that reach it as
    /// paragraph text.
    func blockCodeBlock(for inlines: [InlineNode]) -> MarkdownBlock? {
        let text = inlines.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let regex = try? NSRegularExpression(pattern: #"^%%CDBLOCKCODE(\d+)%%$"#),
              let match = regex.firstMatch(
                in: text,
                options: [],
                range: NSRange(text.startIndex..<text.endIndex, in: text)
              ),
              let indexRange = Range(match.range(at: 1), in: text),
              let index = Int(text[indexRange]),
              let code = protection.blockCode(at: index) else {
            return nil
        }
        return .codeBlock(
            CodeBlockModel(code: code.code, language: code.language, isFenced: code.isFenced)
        )
    }

    /// swift-markdown's AST does not expose whether a code block was fenced.
    /// Check the repaired source line at the block's range.
    private func isFencedCodeBlock(_ code: CodeBlock, sourceLines: [String]) -> Bool {
        if let line = code.range?.lowerBound.line, line > 0, line <= sourceLines.count {
            let source = sourceLines[line - 1]
                .trimmingCharacters(in: .whitespaces)
            if source.hasPrefix("```") || source.hasPrefix("~~~") {
                return true
            }
            if !source.isEmpty {
                return false
            }
        }
        return code.language != nil
    }

    private func resolveBoxToken(_ inlines: [InlineNode]) -> [MarkdownBlock]? {
        let text = inlines.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
        let pattern = #"^%%CD(CALLOUT|USERNOTE|DETAILS)(\d+)%%$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(
                in: text,
                options: [],
                range: NSRange(text.startIndex..<text.endIndex, in: text)
              ),
              let kindRange = Range(match.range(at: 1), in: text),
              let indexRange = Range(match.range(at: 2), in: text),
              let index = Int(text[indexRange]),
              index >= 0, index < boxes.count else {
            return nil
        }

        switch String(text[kindRange]) {
        case "CALLOUT":
            guard case let .callout(kind, title, body) = boxes[index] else { return nil }
            let nested = parseNestedProtected(body)
            return [.callout(CalloutModel(kind: kind, title: title, blocks: nested))]
        case "DETAILS":
            guard case let .details(summary, body, isOpen) = boxes[index] else { return nil }
            let nested = parseNestedProtected(body)
            return [
                .details(
                    DetailsModel(
                        summary: inlineMarkdown(summary),
                        blocks: nested,
                        isOpen: isOpen
                    )
                ),
            ]
        case "USERNOTE":
            guard case let .userNote(query, target, body) = boxes[index] else { return nil }
            let nested = parseNestedProtected(body)
            return [
                .userNote(
                    UserNoteModel(
                        query: query,
                        targetText: target,
                        anchorBlockID: nil,
                        blocks: nested
                    )
                ),
            ]
        default:
            return nil
        }
    }

    private func injectUserNoteAnchors(_ document: MarkdownDocument) -> MarkdownDocument {
        var records: [(id: String, text: String)] = []
        collectAnchorRecords(document.blocks, into: &records)
        var blocks = document.blocks
        resolveAnchors(in: &blocks, records: records)
        var updated = document
        updated.blocks = blocks
        return updated
    }

    private func collectAnchorRecords(
        _ nodes: [MarkdownBlockNode],
        into records: inout [(id: String, text: String)]
    ) {
        for node in nodes {
            switch node.block {
            case .userNote:
                // A note's own body never serves as an anchor target.
                continue
            case let .blockquote(children):
                // Post-order so the deepest matching paragraph wins.
                collectAnchorRecords(children, into: &records)
                records.append((node.id, node.plainText))
            case let .list(list):
                for item in list.items { collectAnchorRecords(item.blocks, into: &records) }
                records.append((node.id, node.plainText))
            case let .callout(callout):
                collectAnchorRecords(callout.blocks, into: &records)
                records.append((node.id, node.plainText))
            case let .details(details):
                collectAnchorRecords(details.blocks, into: &records)
                records.append((node.id, node.plainText))
            default:
                records.append((node.id, node.plainText))
            }
        }
    }

    private func resolveAnchors(
        in nodes: inout [MarkdownBlockNode],
        records: [(id: String, text: String)]
    ) {
        for index in nodes.indices {
            switch nodes[index].block {
            case .userNote(var note):
                if let target = note.targetText,
                   !target.isEmpty,
                   note.anchorBlockID == nil {
                    note.anchorBlockID = anchorID(
                        for: target,
                        in: records,
                        excluding: nodes[index].id
                    )
                }
                nodes[index] = MarkdownBlockNode(id: nodes[index].id, block: .userNote(note))

            case .blockquote(var children):
                resolveAnchors(in: &children, records: records)
                nodes[index] = MarkdownBlockNode(
                    id: nodes[index].id,
                    block: .blockquote(children)
                )

            case .list(var list):
                for itemIndex in list.items.indices {
                    var item = list.items[itemIndex]
                    resolveAnchors(in: &item.blocks, records: records)
                    list.items[itemIndex] = item
                }
                nodes[index] = MarkdownBlockNode(id: nodes[index].id, block: .list(list))

            case .callout(var callout):
                resolveAnchors(in: &callout.blocks, records: records)
                nodes[index] = MarkdownBlockNode(id: nodes[index].id, block: .callout(callout))

            case .details(var details):
                resolveAnchors(in: &details.blocks, records: records)
                nodes[index] = MarkdownBlockNode(id: nodes[index].id, block: .details(details))

            default:
                break
            }
        }
    }

    private func anchorID(
        for target: String,
        in records: [(id: String, text: String)],
        excluding noteID: String
    ) -> String? {
        let needle = Self.normalizedWhitespace(target)
        guard !needle.isEmpty else { return nil }
        for record in records where record.id != noteID {
            if Self.normalizedWhitespace(record.text).contains(needle) {
                return record.id
            }
        }
        return nil
    }

    private static func normalizedWhitespace(_ value: String) -> String {
        value
            .split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" })
            .joined(separator: " ")
    }

    // MARK: - Inline mapping

    private func inlineMarkdown(_ text: String) -> [InlineNode] {
        guard !text.isEmpty else { return [] }
        let document = Document(parsing: text, options: [.disableSmartOpts])
        var nodes: [InlineNode] = []
        for block in document.children {
            if let paragraph = block as? Paragraph {
                nodes.append(contentsOf: inlineNodes(paragraph.children))
            } else if let heading = block as? Heading {
                nodes.append(contentsOf: inlineNodes(heading.children))
            } else if let html = block as? HTMLBlock {
                nodes.append(contentsOf: inlineNodesFromRawHTML(html.rawHTML))
            } else if let code = block as? CodeBlock {
                nodes.append(.code(code.code))
            } else {
                let value = plainText(of: block)
                if !value.isEmpty { nodes.append(.text(value)) }
            }
        }
        return nodes
    }

    private func inlineNodesFromRawHTML(_ html: String) -> [InlineNode] {
        let root = HTMLTreeParser.parse(html)
        let converter = RawHTMLBlockConverter(
            context: HTMLConversionContext(
                inlineMarkdown: { [weak self] text in self?.inlineMarkdown(text) ?? [.text(text)] },
                parseMarkdown: { [weak self] text in self?.parseNestedProtected(text) ?? [] },
                resolveAsset: { [weak self] value in self?.resolveAsset(value) ?? value },
                isRemote: { [weak self] value in self?.isRemoteAsset(value) ?? false },
                restoreText: { [weak self] value in self?.restorePlainText(value) ?? value },
                isSafeLink: { [weak self] value in self?.isSafeLink(value) ?? false },
                isSafeImageSource: { [weak self] value in self?.isSafeImageSource(value) ?? false },
                blockCode: { [weak self] inlines in self?.blockCodeBlock(for: inlines) },
                splitBlockCode: { [weak self] inlines in self?.splitBlockCodeInlines(inlines) },
                warning: { [weak self] warning in self?.warnings.append(warning) }
            )
        )
        let nodes = converter.inlineNodesPublic(root.children)
        return nodes.isEmpty ? [.text(protection.htmlToText(html))] : nodes
    }

    private func inlineNodes(_ children: MarkupChildren) -> [InlineNode] {
        var output: [InlineNode] = []
        var frames: [InlineFrame] = []
        var dropDepth = 0

        func append(_ node: InlineNode) {
            if let frame = frames.last {
                frame.nodes.append(node)
            } else {
                output.append(node)
            }
        }

        func append(contentsOf nodes: [InlineNode]) {
            for node in nodes { append(node) }
        }

        func closeFrame() {
            guard let frame = frames.popLast() else { return }
            if case let .link(destination, _) = frame.kind,
               !isSafeLink(destination) {
                // Rejected links keep their text, never the destination.
                for node in frame.nodes { append(node) }
                return
            }
            for node in frame.wrapped() { append(node) }
        }

        for child in children {
            if let html = child as? InlineHTML {
                let tag = HTMLInlineTag(rawHTML: html.rawHTML)
                if tag.isClosing {
                    if dropDepth > 0, ["script", "style", "iframe", "form", "textarea", "select"].contains(tag.name) {
                        dropDepth -= 1
                        continue
                    }
                    if let last = frames.last, last.matches(tag.name) {
                        closeFrame()
                    }
                    continue
                }

                if dropDepth > 0 {
                    if ["script", "style", "iframe", "form", "textarea", "select"].contains(tag.name),
                       !tag.isSelfClosing {
                        dropDepth += 1
                    }
                    continue
                }

                switch tag.name {
                case "br":
                    append(.lineBreak)
                case "img":
                    if let node = imageInline(fromHTMLAttributes: tag.attributes) { append(node) }
                case "script", "style", "iframe", "form", "textarea", "select":
                    if !tag.isSelfClosing { dropDepth += 1 }
                case "math":
                    break
                default:
                    var attributes = tag.attributes
                    if let title = attributes["title"] {
                        attributes["title"] = restorePlainText(title)
                    }
                    if let kind = InlineFrame.Kind(tag: tag.name, attributes: attributes) {
                        if !tag.isSelfClosing {
                            frames.append(InlineFrame(kind: kind))
                        } else {
                            append(contentsOf: kind.emptyNodes())
                        }
                    }
                }
                continue
            }

            guard dropDepth == 0 else { continue }

            if let text = child as? Text {
                append(contentsOf: textNodes(text.string))
            } else if let emphasis = child as? Emphasis {
                append(.emphasis(inlineSequence(emphasis.children)))
            } else if let strong = child as? Strong {
                append(.strong(inlineSequence(strong.children)))
            } else if let strike = child as? Strikethrough {
                append(.strikethrough(inlineSequence(strike.children)))
            } else if let code = child as? InlineCode {
                append(.code(code.code))
            } else if let link = child as? Link {
                let destination = link.destination ?? ""
                let children = inlineSequence(link.children)
                if isSafeLink(destination) {
                    append(
                        .link(
                            destination: destination,
                            title: link.title.map(restorePlainText),
                            children: children
                        )
                    )
                } else {
                    append(contentsOf: children)
                }
            } else if let image = child as? Image {
                let alt = restorePlainText(image.plainText)
                let spec = ImageSpecParser.parse(alt)
                let destination = restoreTokenText(image.source ?? "")
                if isSafeImageSource(destination) {
                    append(
                        .image(
                            spec,
                            destination: destination,
                            title: image.title.map(restorePlainText)
                        )
                    )
                } else {
                    append(.text(spec.alt))
                }
            } else if child is SoftBreak || child is LineBreak {
                append(.lineBreak)
            } else if let heading = child as? Heading {
                append(contentsOf: inlineNodes(heading.children))
            } else if let paragraph = child as? Paragraph {
                append(contentsOf: inlineNodes(paragraph.children))
            } else {
                let value = plainText(of: child)
                if !value.isEmpty { append(contentsOf: textNodes(value)) }
            }
        }

        while !frames.isEmpty { closeFrame() }
        return output
    }

    private func inlineSequence(_ children: MarkupChildren) -> [InlineNode] {
        inlineNodes(children)
    }

    /// Restores protected TeX/MathML/inline-code placeholders to plain text.
    /// Used for image alt/title, callout titles, and USERNOTE queries/targets,
    /// which are metadata strings rather than renderable inline ASTs. Also
    /// handles raw `$…$`/`<math>` captured before protection (image attributes).
    func restorePlainText(_ text: String) -> String {
        guard !text.isEmpty else { return text }
        var value = restoreHTMLTagTokens(text)
        value = value.replacingOccurrences(
            of: #"`([^`\n]+)`"#,
            with: "$1",
            options: .regularExpression
        )
        value = textNodes(value).map(\.plainText).joined()
        value = restoreRawMathML(value)

        let extraction = MarkdownMathExtractor.extract(from: value)
        value = extraction.markdown
        for token in extraction.tokens {
            value = value.replacingOccurrences(of: token.id, with: token.math)
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Restores only protection tokens (HTML tags and inline math/code), used
    /// for image destinations where Markdown/link parsing would be wrong.
    func restoreTokenText(_ text: String) -> String {
        guard !text.isEmpty else { return text }
        let tags = restoreHTMLTagTokens(text)
        return textNodes(tags).map(\.plainText).joined()
    }

    private func restoreHTMLTagTokens(_ text: String) -> String {
        guard text.contains("%%CDHTMLTAG") else { return text }
        guard let regex = try? NSRegularExpression(pattern: #"%%CDHTMLTAG(\d+)%%"#) else {
            return text
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = regex.matches(in: text, options: [], range: range)
        guard !matches.isEmpty else { return text }
        var output = text
        for match in matches.reversed() {
            guard let matchRange = Range(match.range, in: output),
                  let indexRange = Range(match.range(at: 1), in: output),
                  let index = Int(output[indexRange]),
                  index >= 0, index < protection.htmlTags.count else {
                continue
            }
            output.replaceSubrange(matchRange, with: protection.htmlTags[index])
        }
        return output
    }

    private func restoreRawMathML(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(
            pattern: #"(?is)<math\b[^>]*>[\s\S]*?</math>"#
        ) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = regex.matches(in: text, options: [], range: range)
        guard !matches.isEmpty else { return text }
        var output = text
        for match in matches.reversed() {
            guard let matchRange = Range(match.range, in: output) else { continue }
            let xml = String(output[matchRange])
            let conversion = MathMLConverter.convert(xml)
            let replacement = conversion.flattenedText.isEmpty
                ? conversion.tex
                : conversion.flattenedText
            output.replaceSubrange(matchRange, with: replacement)
        }
        return output
    }

    /// Splits protected tokens out of a text run, linkifies bare URLs, and
    /// leaves everything else as text.
    func textNodes(_ text: String) -> [InlineNode] {
        guard !text.isEmpty else { return [] }
        let pattern = #"%%CD(IMAGE|MATHML|MATH|CODE)(\d+)%%"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return [.text(text)]
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = regex.matches(in: text, options: [], range: range)
        if matches.isEmpty {
            return linkifiedText(text)
        }

        var output: [InlineNode] = []
        var cursor = text.startIndex
        for match in matches {
            guard let matchRange = Range(match.range, in: text) else { continue }
            if cursor < matchRange.lowerBound {
                output.append(contentsOf: linkifiedText(String(text[cursor..<matchRange.lowerBound])))
            }
            let kind = Range(match.range(at: 1), in: text).map { String(text[$0]) } ?? ""
            let index = Range(match.range(at: 2), in: text).flatMap { Int(text[$0]) } ?? -1
            switch kind {
            case "MATH":
                if let token = protection.mathToken(at: index) {
                    output.append(.math(MathExpression(tex: token.math, display: token.display)))
                }
            case "IMAGE":
                if let image = protection.image(at: index) {
                    let alt = restorePlainText(image.alt)
                    let spec = ImageSpecParser.parse(alt)
                    let destination = restoreTokenText(image.destination)
                    if isSafeImageSource(destination) {
                        output.append(
                            .image(
                                spec,
                                destination: destination,
                                title: image.title.map(restorePlainText)
                            )
                        )
                    } else {
                        output.append(.text(spec.alt))
                    }
                }
            case "MATHML":
                if let expression = protection.mathMLExpression(at: index) {
                    output.append(.math(expression))
                }
            case "CODE":
                if let code = protection.inlineCode(at: index) {
                    output.append(.code(code))
                }
            default:
                output.append(.text(String(text[matchRange])))
            }
            cursor = matchRange.upperBound
        }
        if cursor < text.endIndex {
            output.append(contentsOf: linkifiedText(String(text[cursor...])))
        }
        return output
    }

    private func linkifiedText(_ text: String) -> [InlineNode] {
        guard text.contains("http://") || text.contains("https://") else {
            return [.text(text)]
        }
        let pattern = #"https?://[^\s<>()\[\]]+"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return [.text(text)]
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = regex.matches(in: text, options: [], range: range)
        guard !matches.isEmpty else { return [.text(text)] }

        var output: [InlineNode] = []
        var cursor = text.startIndex
        for match in matches {
            guard let matchRange = Range(match.range, in: text) else { continue }
            if cursor < matchRange.lowerBound {
                output.append(.text(String(text[cursor..<matchRange.lowerBound])))
            }
            var destination = String(text[matchRange])
            var trailing = ""
            while let last = destination.last, ".,;:!?)]}".contains(last) {
                trailing = String(last) + trailing
                destination.removeLast()
            }
            output.append(
                .link(
                    destination: destination,
                    title: nil,
                    children: [.text(destination)]
                )
            )
            if !trailing.isEmpty { output.append(.text(trailing)) }
            cursor = matchRange.upperBound
        }
        if cursor < text.endIndex {
            output.append(.text(String(text[cursor...])))
        }
        return output
    }

    private func imageInline(fromHTMLAttributes attributes: [String: String]) -> InlineNode? {
        guard let source = attributes["src"], !source.isEmpty else { return nil }
        let destination = resolveAsset(source)
        guard isSafeImageSource(destination) else { return nil }
        let alt = restorePlainText(attributes["alt"] ?? "")
        var specText = alt
        if let width = attributes["width"], let height = attributes["height"] {
            specText = "\(alt)|\(width)x\(height)"
        } else if let width = attributes["width"] {
            specText = "\(alt)|\(width)"
        } else if let height = attributes["height"] {
            specText = "\(alt)|height=\(height)"
        }
        return .image(
            ImageSpecParser.parse(specText),
            destination: destination,
            title: attributes["title"].map(restorePlainText)
        )
    }

    // MARK: - Helpers

    private func plainText(of markup: Markup) -> String {
        if let plain = markup as? PlainTextConvertibleMarkup {
            return plain.plainText
        }
        var output = ""
        for child in markup.children {
            output += plainText(of: child)
        }
        return output
    }

    private func replace(
        pattern: String,
        in text: String,
        transform: ([String]) -> String
    ) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return text
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = regex.matches(in: text, options: [], range: range)
        guard !matches.isEmpty else { return text }

        var output = text
        for match in matches.reversed() {
            guard let matchRange = Range(match.range, in: output) else { continue }
            var groups: [String] = []
            for index in 1..<match.numberOfRanges {
                if let groupRange = Range(match.range(at: index), in: output) {
                    groups.append(String(output[groupRange]))
                } else {
                    groups.append("")
                }
            }
            output.replaceSubrange(matchRange, with: transform(groups))
        }
        return output
    }
}

// MARK: - Raw HTML inline frames

private final class InlineFrame {
    enum Kind {
        case strong
        case emphasis
        case strikethrough
        case superscript
        case subscripting
        case highlight
        case keyboard
        case span
        case link(destination: String, title: String?)

        init?(tag: String, attributes: [String: String]) {
            switch tag {
            case "strong", "b": self = .strong
            case "em", "i": self = .emphasis
            case "del", "s", "strike": self = .strikethrough
            case "sup": self = .superscript
            case "sub": self = .subscripting
            case "mark": self = .highlight
            case "kbd": self = .keyboard
            case "span": self = .span
            case "a":
                let destination = attributes["href"] ?? ""
                self = .link(destination: destination, title: attributes["title"])
            default: return nil
            }
        }

        var tagNames: [String] {
            switch self {
            case .strong: return ["strong", "b"]
            case .emphasis: return ["em", "i"]
            case .strikethrough: return ["del", "s", "strike"]
            case .superscript: return ["sup"]
            case .subscripting: return ["sub"]
            case .highlight: return ["mark"]
            case .keyboard: return ["kbd"]
            case .span: return ["span"]
            case .link: return ["a"]
            }
        }

        func emptyNodes() -> [InlineNode] { [] }
    }

    let kind: Kind
    var nodes: [InlineNode] = []

    init(kind: Kind) {
        self.kind = kind
    }

    func matches(_ tag: String) -> Bool {
        kind.tagNames.contains(tag)
    }

    func wrapped() -> [InlineNode] {
        switch kind {
        case .strong: return [.strong(nodes)]
        case .emphasis: return [.emphasis(nodes)]
        case .strikethrough: return [.strikethrough(nodes)]
        case .superscript: return [.superscript(nodes)]
        case .subscripting: return [.subscripting(nodes)]
        case .highlight: return [.highlight(nodes)]
        case .keyboard: return [.keyboard(nodes)]
        case .span: return [.span(nodes)]
        case let .link(destination, title):
            return [.link(destination: destination, title: title, children: nodes)]
        }
    }
}

private struct HTMLInlineTag {
    var name: String
    var attributes: [String: String]
    var isClosing: Bool
    var isSelfClosing: Bool

    init(rawHTML: String) {
        var value = rawHTML.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("<") { value.removeFirst() }
        if value.hasSuffix(">") { value.removeLast() }
        isClosing = value.hasPrefix("/")
        if isClosing { value.removeFirst() }
        isSelfClosing = value.hasSuffix("/")
        if isSelfClosing { value.removeLast() }
        let parts = value.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" })
        name = parts.first.map { String($0).lowercased() } ?? ""
        attributes = [:]
        guard parts.count > 1 else { return }
        let attributeText = parts.dropFirst().joined(separator: " ")
        let pattern = #"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return }
        let range = NSRange(attributeText.startIndex..<attributeText.endIndex, in: attributeText)
        for match in regex.matches(in: attributeText, options: [], range: range) {
            guard let nameRange = Range(match.range(at: 1), in: attributeText) else { continue }
            let attributeName = String(attributeText[nameRange]).lowercased()
            if let doubleRange = Range(match.range(at: 2), in: attributeText) {
                attributes[attributeName] = MathMLXMLParser.decodeEntities(
                    String(attributeText[doubleRange])
                )
            } else if let singleRange = Range(match.range(at: 3), in: attributeText) {
                attributes[attributeName] = MathMLXMLParser.decodeEntities(
                    String(attributeText[singleRange])
                )
            }
        }
    }
}
