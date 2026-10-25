import Foundation

/// A protected fenced / indented / `<pre>` code block.
public struct ProtectedCodeBlock: Equatable, Sendable {
    public var code: String
    public var language: String?
    /// Fenced and `<pre>` blocks are fenced; indented blocks are not.
    public var isFenced: Bool

    public init(code: String, language: String? = nil, isFenced: Bool = true) {
        self.code = code
        self.language = language
        self.isFenced = isFenced
    }
}

/// An image whose Markdown syntax was protected because its alt text or
/// destination contains a pipe. Table parsing must see one cell, never two.
public struct ProtectedImage: Equatable, Sendable {
    public var alt: String
    public var destination: String
    public var title: String?

    public init(alt: String, destination: String, title: String? = nil) {
        self.alt = alt
        self.destination = destination
        self.title = title
    }
}

/// Protects every code and math form *before* table repair (PLAN §4.2 step 4 /
/// §4.3). Distinct token namespaces keep table repair from treating a code or
/// math span as a table terminator, and no token contains `|`, `$`, or a
/// backtick, so pipes inside math/image specs can never split cells.
final class MarkdownProtection {
    static let blockCodePrefix = "%%CDBLOCKCODE"
    static let inlineCodePrefix = "%%CDCODE"
    static let mathMLPrefix = "%%CDMATHML"

    private(set) var blockCodes: [ProtectedCodeBlock] = []
    private(set) var inlineCodes: [String] = []
    private(set) var images: [ProtectedImage] = []
    private(set) var mathTokens: [MathToken] = []
    private(set) var mathMLBlocks: [String] = []
    private(set) var htmlTags: [String] = []
    private var mathMLCache: [Int: MathExpression] = [:]

    /// Runs the protection pass. Code is protected first, then MathML, then
    /// HTML tags, then image specs and TeX. HTML tag/attribute regions are
    /// removed before TeX extraction so `$…$` inside `alt`/`href` is not
    /// mistaken for math; the tags are restored before any HTML parsing.
    func protect(_ markdown: String) -> String {
        var text = protectFencedCode(markdown)
        text = protectPreTags(text)
        text = protectIndentedCode(text)
        text = protectInlineCode(text)
        text = protectMathML(text)
        // Images first: an image alt/title may itself contain `<tag>`, and the
        // whole Markdown image is hidden before TeX and HTML-tag protection.
        text = protectImages(text)
        text = protectHTMLTags(text)
        let extraction = MarkdownMathExtractor.extract(from: text)
        text = extraction.markdown
        mathTokens.append(contentsOf: extraction.tokens)
        text = restoreHTMLTags(text)
        return text
    }

    func inlineCode(at index: Int) -> String? {
        index >= 0 && index < inlineCodes.count ? inlineCodes[index] : nil
    }

    func mathToken(at index: Int) -> MathToken? {
        index >= 0 && index < mathTokens.count ? mathTokens[index] : nil
    }

    func mathMLExpression(at index: Int) -> MathExpression? {
        guard index >= 0 && index < mathMLBlocks.count else { return nil }
        if let cached = mathMLCache[index] { return cached }
        let conversion = MathMLConverter.convert(mathMLBlocks[index])
        let expression = MathExpression(tex: conversion.tex, display: conversion.display, isMathML: true)
        mathMLCache[index] = expression
        return expression
    }

    func blockCode(at index: Int) -> ProtectedCodeBlock? {
        index >= 0 && index < blockCodes.count ? blockCodes[index] : nil
    }

    func image(at index: Int) -> ProtectedImage? {
        index >= 0 && index < images.count ? images[index] : nil
    }

    // MARK: - Fenced code

    private struct Fence {
        var character: Character
        var length: Int
        var info: String
        var language: String?
        var quoteDepth: Int
        var indent: String
        var listPrefix: String
    }

    private func protectFencedCode(_ markdown: String) -> String {
        let lines = markdown.components(separatedBy: "\n")
        var output: [String] = []
        var index = 0

        while index < lines.count {
            guard let fence = fenceInfo(lines[index]) else {
                output.append(lines[index])
                index += 1
                continue
            }

            var cursor = index + 1
            var body: [String] = []
            var closed = false
            while cursor < lines.count {
                if isClosingFence(lines[cursor], fence: fence) {
                    closed = true
                    break
                }
                var bodyLine = stripBlockquotePrefix(lines[cursor], depth: fence.quoteDepth)
                if !fence.listPrefix.isEmpty {
                    // Strip the list-item continuation indent equal to the
                    // marker prefix (`- ` -> two columns).
                    var removed = 0
                    while removed < fence.listPrefix.count,
                          let first = bodyLine.first,
                          first == " " || first == "\t" {
                        bodyLine.removeFirst()
                        removed += 1
                    }
                }
                if !fence.indent.isEmpty, bodyLine.hasPrefix(fence.indent) {
                    bodyLine = String(bodyLine.dropFirst(fence.indent.count))
                }
                body.append(bodyLine)
                cursor += 1
            }

            let codeIndex = blockCodes.count
            blockCodes.append(
                ProtectedCodeBlock(
                    code: body.joined(separator: "\n"),
                    language: fence.language,
                    isFenced: true
                )
            )
            // Keep the token on its own line, surrounded by blank lines, so
            // the block parser and table repair both see a block boundary.
            // The list/blockquote prefix keeps the code nested in its parent.
            let basePrefix = fence.listPrefix.isEmpty ? fence.indent : fence.listPrefix
            let prefix = basePrefix + String(repeating: "> ", count: fence.quoteDepth)
            if output.last?.trimmingCharacters(in: .whitespaces).isEmpty == false {
                output.append("")
            }
            output.append("\(prefix)\(Self.blockCodePrefix)\(codeIndex)%%")
            output.append("")
            index = closed ? cursor + 1 : cursor
        }

        return output.joined(separator: "\n")
    }

    private func fenceInfo(_ line: String) -> Fence? {
        let parts = TableRepair.splitPrefix(line)
        let quoteDepth = parts.quotePrefix.filter { $0 == ">" }.count
        let content = stripBlockquotePrefix(line, depth: quoteDepth)
        let characters = Array(content)
        var spaces = 0
        while spaces < characters.count, spaces < 4, characters[spaces] == " " {
            spaces += 1
        }
        guard spaces <= 3, spaces < characters.count else { return nil }

        var markerIndex = spaces
        var listPrefix = ""
        var indent = String(content.prefix(spaces))
        if characters[spaces] != "`", characters[spaces] != "~" {
            // A fence may start on a list marker line: `- ```js`.
            guard let markerEnd = listMarkerEnd(characters, at: spaces) else { return nil }
            listPrefix = String(characters[0..<markerEnd])
            markerIndex = markerEnd
            indent = ""
            guard markerIndex < characters.count else { return nil }
        }

        let marker = characters[markerIndex]
        guard marker == "`" || marker == "~" else { return nil }
        var length = 0
        while markerIndex + length < characters.count,
              characters[markerIndex + length] == marker {
            length += 1
        }
        guard length >= 3 else { return nil }
        let info = String(characters[(markerIndex + length)...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if marker == "`" && info.contains("`") { return nil }
        let language = info.split(whereSeparator: { $0 == " " || $0 == "\t" }).first.map(String.init)
        return Fence(
            character: marker,
            length: length,
            info: info,
            language: language,
            quoteDepth: quoteDepth,
            indent: indent,
            listPrefix: listPrefix
        )
    }

    /// Returns the index just after a list marker (`- `, `* `, `1. `) at `start`.
    private func listMarkerEnd(_ characters: [Character], at start: Int) -> Int? {
        guard start < characters.count else { return nil }
        var index = start
        let first = characters[index]
        if first == "-" || first == "*" || first == "+" {
            index += 1
        } else if first.isNumber {
            while index < characters.count, characters[index].isNumber { index += 1 }
            guard index < characters.count,
                  characters[index] == "." || characters[index] == ")" else { return nil }
            index += 1
        } else {
            return nil
        }
        guard index < characters.count,
              characters[index] == " " || characters[index] == "\t" else { return nil }
        while index < characters.count,
              characters[index] == " " || characters[index] == "\t" {
            index += 1
        }
        return index
    }

    private func isClosingFence(_ line: String, fence: Fence) -> Bool {
        let content = stripBlockquotePrefix(line, depth: fence.quoteDepth)
        let characters = Array(content)
        var spaces = 0
        while spaces < characters.count, spaces < 4, characters[spaces] == " " {
            spaces += 1
        }
        guard spaces <= 3 else { return false }
        var length = 0
        while spaces + length < characters.count, characters[spaces + length] == fence.character {
            length += 1
        }
        guard length >= fence.length else { return false }
        let rest = String(characters[(spaces + length)...]).trimmingCharacters(in: .whitespaces)
        return rest.isEmpty
    }

    private func stripBlockquotePrefix(_ line: String, depth: Int) -> String {
        guard depth > 0 else { return line }
        let characters = Array(line)
        var index = 0
        var remaining = depth
        while remaining > 0 {
            while index < characters.count, characters[index] == " " || characters[index] == "\t" {
                index += 1
            }
            guard index < characters.count, characters[index] == ">" else { break }
            index += 1
            if index < characters.count, characters[index] == " " { index += 1 }
            remaining -= 1
        }
        return index < characters.count ? String(characters[index...]) : ""
    }

    // MARK: - <pre> blocks

    private func protectPreTags(_ markdown: String) -> String {
        guard let regex = try? NSRegularExpression(
            pattern: #"(?is)<pre\b[^>]*>([\s\S]*?)</pre>"#,
            options: []
        ) else { return markdown }
        let source = markdown as NSString
        let matches = regex.matches(
            in: markdown,
            options: [],
            range: NSRange(location: 0, length: source.length)
        )
        guard !matches.isEmpty else { return markdown }

        var text = markdown
        for match in matches.reversed() {
            guard let contentRange = Range(match.range(at: 1), in: text),
                  let fullRange = Range(match.range, in: text) else { continue }
            let inner = String(text[contentRange])
            let code = htmlToText(inner)
            let codeIndex = blockCodes.count
            blockCodes.append(ProtectedCodeBlock(code: code, language: nil, isFenced: true))
            text.replaceSubrange(
                fullRange,
                with: "\n\n\(Self.blockCodePrefix)\(codeIndex)%%\n\n"
            )
        }
        return text
    }

    // MARK: - Indented code

    private func protectIndentedCode(_ markdown: String) -> String {
        let lines = markdown.components(separatedBy: "\n")
        var output: [String] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            guard line.hasPrefix("    ") || line.hasPrefix("\t") else {
                output.append(line)
                index += 1
                continue
            }
            // Indented code requires a blank line (or the start of the
            // document) before it; indented tables and list continuations do
            // not count as code.
            let previousIsBlank = index == 0 || output.last?.trimmingCharacters(in: .whitespaces).isEmpty == true
            guard previousIsBlank else {
                output.append(line)
                index += 1
                continue
            }

            var cursor = index
            var body: [String] = []
            while cursor < lines.count {
                let candidate = lines[cursor]
                if candidate.hasPrefix("    ") {
                    body.append(String(candidate.dropFirst(4)))
                } else if candidate.hasPrefix("\t") {
                    body.append(String(candidate.dropFirst()))
                } else if candidate.trimmingCharacters(in: .whitespaces).isEmpty {
                    body.append("")
                } else {
                    break
                }
                cursor += 1
            }

            var trailingBlankCount = 0
            while body.last?.isEmpty == true {
                body.removeLast()
                trailingBlankCount += 1
            }
            guard let firstContent = body.first?.trimmingCharacters(in: .whitespaces), !firstContent.isEmpty else {
                output.append(line)
                index += 1
                continue
            }

            let leading = line.prefix { $0 == " " }.count
            let previousRaw = output.last(where: {
                !$0.trimmingCharacters(in: .whitespaces).isEmpty
            })
            let hasListContext = TableRepair.hasEnclosingListMarker(
                in: output,
                tableIndent: max(leading, 4)
            )
            if !shouldTreatIndentedRunAsCode(
                body,
                previousRaw: previousRaw,
                hasListContext: hasListContext
            ) {
                output.append(line)
                index += 1
                continue
            }

            let codeIndex = blockCodes.count
            blockCodes.append(
                ProtectedCodeBlock(code: body.joined(separator: "\n"), language: nil, isFenced: false)
            )
            // Preserve a list-item indent (indent beyond the required four
            // spaces) so the code block stays nested under its list item.
            let listIndent = min(max(leading - 4, 0), 3)
            let prefix = String(repeating: " ", count: listIndent)
            if output.last?.trimmingCharacters(in: .whitespaces).isEmpty == false {
                output.append("")
            }
            output.append("\(prefix)\(Self.blockCodePrefix)\(codeIndex)%%")
            // Re-process the trailing blank lines instead of consuming them.
            index = cursor - trailingBlankCount
            if index >= lines.count || !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                output.append("")
            }
        }

        return output.joined(separator: "\n")
    }

    private func shouldTreatIndentedRunAsCode(
        _ body: [String],
        previousRaw: String?,
        hasListContext: Bool
    ) -> Bool {
        guard let first = body.first?
            .trimmingCharacters(in: .whitespacesAndNewlines), !first.isEmpty else {
            return false
        }
        // An indented block is a table only when it uses the explicit
        // outer-pipe form (`| A | B |` over `| --- | --- |`) AND has a table
        // context: a preceding list marker (four-space nested table) or a
        // preceding blockquote table (fixture 04). A standalone indented
        // outer-pipe table is code by default (CommonMark) and is preserved.
        if let delimiterIndex = body.firstIndex(where: { TableRepair.isDelimiterLine("    " + $0) }) {
            let delimiter = body[delimiterIndex].trimmingCharacters(in: .whitespaces)
            let header = delimiterIndex > 0
                ? body[delimiterIndex - 1].trimmingCharacters(in: .whitespaces)
                : ""
            if delimiter.hasPrefix("|"), header.hasPrefix("|") {
                let previousTrimmed = previousRaw?
                    .trimmingCharacters(in: .whitespaces) ?? ""
                let followsBlockquoteTable = previousTrimmed.hasPrefix(">")
                    && previousTrimmed.contains("|")
                if hasListContext || followsBlockquoteTable {
                    return false
                }
                return true
            }
            return true
        }
        let listPrefixes = ["- ", "* ", "+ ", "> ", "| ", "|"]
        if listPrefixes.contains(where: { first.hasPrefix($0) }) { return false }
        if first.range(of: #"^\d+[.)]\s"#, options: .regularExpression) != nil { return false }
        if first.hasPrefix("<") { return false }
        return true
    }

    // MARK: - Inline code

    private func protectInlineCode(_ markdown: String) -> String {
        let characters = Array(markdown)
        var output = ""
        output.reserveCapacity(markdown.count)
        var index = 0

        while index < characters.count {
            guard characters[index] == "`" else {
                output.append(characters[index])
                index += 1
                continue
            }

            var runLength = 0
            while index + runLength < characters.count, characters[index + runLength] == "`" {
                runLength += 1
            }

            var cursor = index + runLength
            var found = false
            while cursor < characters.count {
                guard characters[cursor] == "`" else {
                    cursor += 1
                    continue
                }
                var closingLength = 0
                while cursor + closingLength < characters.count, characters[cursor + closingLength] == "`" {
                    closingLength += 1
                }
                if closingLength == runLength {
                    var content = String(characters[(index + runLength)..<cursor])
                    // CommonMark: trim one leading/trailing space when present.
                    if content.hasPrefix(" "), content.hasSuffix(" "), content.count > 1,
                       content.trimmingCharacters(in: .whitespaces).isEmpty == false {
                        content.removeFirst()
                        content.removeLast()
                    }
                    content = content.replacingOccurrences(of: "\n", with: " ")
                    let codeIndex = inlineCodes.count
                    inlineCodes.append(content)
                    output.append("\(Self.inlineCodePrefix)\(codeIndex)%%")
                    index = cursor + closingLength
                    found = true
                    break
                }
                cursor += closingLength
            }

            if !found {
                output.append(contentsOf: characters[index..<(index + runLength)])
                index += runLength
            }
        }

        return output
    }

    // MARK: - Images

    /// Replaces `![alt|spec](destination)` with a pipe-free token. Without
    /// this, GFM's table parser (swift-markdown) treats the alt/spec pipe as
    /// a cell delimiter even though our repair pass does not.
    private func protectImages(_ markdown: String) -> String {
        guard let regex = try? NSRegularExpression(
            pattern: #"!\[([^\]]*)\]\(([^)]*)\)"#,
            options: []
        ) else { return markdown }
        let source = markdown as NSString
        let matches = regex.matches(
            in: markdown,
            options: [],
            range: NSRange(location: 0, length: source.length)
        )
        guard !matches.isEmpty else { return markdown }

        var text = markdown
        for match in matches.reversed() {
            guard let fullRange = Range(match.range, in: text),
                  let altRange = Range(match.range(at: 1), in: text),
                  let destinationRange = Range(match.range(at: 2), in: text) else {
                continue
            }
            let alt = String(text[altRange])
            var destination = String(text[destinationRange])
            var title: String?
            // Markdown image titles: ![alt](url "title")
            if destination.hasSuffix("\""),
               let quote = destination.range(of: " \"", options: .backwards) {
                title = String(destination[quote.upperBound...].dropLast())
                destination = String(destination[..<quote.lowerBound])
                    .trimmingCharacters(in: .whitespaces)
            }
            let index = images.count
            images.append(ProtectedImage(alt: alt, destination: destination, title: title))
            text.replaceSubrange(fullRange, with: "%%CDIMAGE\(index)%%")
        }
        return text
    }

    // MARK: - MathML

    private func protectMathML(_ markdown: String) -> String {
        guard let regex = try? NSRegularExpression(
            pattern: #"(?is)<math\b[^>]*>[\s\S]*?</math>"#,
            options: []
        ) else { return markdown }
        let source = markdown as NSString
        let matches = regex.matches(
            in: markdown,
            options: [],
            range: NSRange(location: 0, length: source.length)
        )
        guard !matches.isEmpty else { return markdown }

        var text = markdown
        for match in matches.reversed() {
            guard let range = Range(match.range, in: text) else { continue }
            let xml = String(text[range])
            let index = mathMLBlocks.count
            mathMLBlocks.append(xml)
            text.replaceSubrange(range, with: "\(Self.mathMLPrefix)\(index)%%")
        }
        return text
    }

    // MARK: - HTML tags

    /// Replaces complete HTML tags/comments with tokens while TeX is scanned,
    /// so `$x$` in `alt`/`title`/`href` attributes is never extracted as math
    /// and pipes in attributes never reach table repair. Tags are restored
    /// before callout/details extraction and Markdown parsing.
    private func protectHTMLTags(_ markdown: String) -> String {
        let characters = Array(markdown)
        var output = ""
        output.reserveCapacity(markdown.count)
        var index = 0

        while index < characters.count {
            guard characters[index] == "<", index + 1 < characters.count else {
                output.append(characters[index])
                index += 1
                continue
            }
            let next = characters[index + 1]
            var isTag = next.isLetter || next == "/" || next == "!" || next == "?"
            if isTag, next.isLetter {
                var nameEnd = index + 1
                while nameEnd < characters.count,
                      characters[nameEnd].isLetter || characters[nameEnd].isNumber
                        || characters[nameEnd] == "-" || characters[nameEnd] == ":" {
                    nameEnd += 1
                }
                if nameEnd < characters.count {
                    let afterName = characters[nameEnd]
                    isTag = afterName == ">" || afterName == "/"
                        || afterName == " " || afterName == "\t"
                        || afterName == "\n" || afterName == "\r"
                } else {
                    isTag = false
                }
            }
            guard isTag, let end = htmlTagEnd(characters, from: index) else {
                output.append(characters[index])
                index += 1
                continue
            }
            let tag = String(characters[index...end])
            let tagIndex = htmlTags.count
            htmlTags.append(tag)
            output.append("%%CDHTMLTAG\(tagIndex)%%")
            index = end + 1
        }
        return output
    }

    private func htmlTagEnd(_ characters: [Character], from start: Int) -> Int? {
        var index = start + 1
        var quote: Character?
        while index < characters.count {
            let character = characters[index]
            if let current = quote {
                if character == current { quote = nil }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == ">" {
                return index
            }
            index += 1
        }
        return nil
    }

    private func restoreHTMLTags(_ text: String) -> String {
        guard !htmlTags.isEmpty else { return text }
        var output = text
        for (index, tag) in htmlTags.enumerated() {
            output = output.replacingOccurrences(of: "%%CDHTMLTAG\(index)%%", with: tag)
        }
        return output
    }

    // MARK: - HTML text helper

    func htmlToText(_ html: String) -> String {
        var text = html
        // Never surface script/style/noscript body text in a fallback block.
        text = text.replacingOccurrences(
            of: #"(?is)<(script|style|noscript|template|form|button|select|textarea)\b[^>]*>[\s\S]*?</\1\s*>"#,
            with: "",
            options: .regularExpression
        )
        text = text.replacingOccurrences(of: #"(?i)<br\s*/?>"#, with: "\n", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?i)</(p|div|li|pre|tr)>"#, with: "\n", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        text = MathMLXMLParser.decodeEntities(text)
        return text.trimmingCharacters(in: .newlines)
    }
}

// MARK: - Token parsing

/// Shared token recognition for the block and inline parsers.
enum MarkdownToken {
    static func match(_ text: String) -> (kind: Kind, index: Int)? {
        let pattern = #"^%%CD(BLOCKCODE|CODE|IMAGE|MATHML|MATH)(\d+)%%$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(
                in: text,
                options: [],
                range: NSRange(text.startIndex..<text.endIndex, in: text)
              ),
              let kindRange = Range(match.range(at: 1), in: text),
              let indexRange = Range(match.range(at: 2), in: text),
              let index = Int(text[indexRange]) else {
            return nil
        }
        switch String(text[kindRange]) {
        case "BLOCKCODE": return (.blockCode, index)
        case "CODE": return (.inlineCode, index)
        case "IMAGE": return (.image, index)
        case "MATHML": return (.mathML, index)
        case "MATH": return (.math, index)
        default: return nil
        }
    }

    enum Kind {
        case blockCode
        case inlineCode
        case image
        case mathML
        case math
    }
}
