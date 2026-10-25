import Foundation

/// MathML → TeX conversion (PLAN §4.2 step 10).
///
/// Real MCR3U lessons contain ~246 `<math>` elements, frequently inside raw
/// HTML tables. This pass runs while the MathML subtree is restored, before any
/// raw-HTML table parsing/sanitization, so cell text is never lost or parsed as
/// HTML. Unsupported elements preserve their flattened text instead of dropping
/// the subtree. The real element names are `msup`/`msub` (not `sup`/`sub`).
public struct MathMLConversion: Equatable, Sendable {
    public var tex: String
    public var display: Bool
    /// Accessibility/search text assembled from every presentation text node.
    public var flattenedText: String

    public init(tex: String, display: Bool, flattenedText: String) {
        self.tex = tex
        self.display = display
        self.flattenedText = flattenedText
    }
}

public enum MathMLConverter {
    public static func convert(_ xml: String) -> MathMLConversion {
        let root = MathMLXMLParser.parse(xml)
        let math = findElement(named: "math", in: root) ?? root
        let display = (math.attributes["display"]?.lowercased() == "block")
            || (math.attributes["mode"]?.lowercased() == "display")
        var flattened = ""
        collectText(math, into: &flattened)
        flattened = normalizeSpaces(flattened).trimmingCharacters(in: .whitespacesAndNewlines)

        var tex = renderPresentationChildren(math)
        tex = normalizeTeX(tex)
        if tex.isEmpty && !flattened.isEmpty {
            tex = escapeTeXText(flattened)
        }
        return MathMLConversion(tex: tex, display: display, flattenedText: flattened)
    }

    // MARK: - Rendering

    private static let functionNames: Set<String> = [
        "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
        "sinh", "cosh", "tanh", "log", "ln", "exp", "lim", "min", "max",
    ]

    private static let operatorMap: [String: String] = [
        "−": "-", "–": "-", "×": #"\times"#, "÷": #"\div"#, "·": #"\cdot"#,
        "≤": #"\le"#, "≥": #"\ge"#, "≠": #"\ne"#, "≈": #"\approx"#,
        "±": #"\pm"#, "∞": #"\infty"#, "→": #"\to"#, "←": #"\leftarrow"#,
        "⇒": #"\Rightarrow"#, "⇔": #"\Leftrightarrow"#, "√": #"\sqrt"#,
        "∑": #"\sum"#, "∏": #"\prod"#, "∫": #"\int"#, "∂": #"\partial"#,
        "∈": #"\in"#, "∉": #"\notin"#, "∪": #"\cup"#, "∩": #"\cap"#,
        "∠": #"\angle"#, "∴": #"\therefore"#, "°": #"^{\circ}"#,
    ]

    private static func render(_ node: MathMLXMLNode) -> String {
        switch node.name.lowercased() {
        case "math", "mrow", "mstyle", "mpadded", "mphantom", "merror", "mtd", "semantics":
            return renderPresentationChildren(node)
        case "mi":
            let text = node.textContent.trimmingCharacters(in: .whitespacesAndNewlines)
            if functionNames.contains(text) { return "\\\(text) " }
            if text.count > 1, text.allSatisfy({ $0.isLetter }) {
                return "\\mathrm{\(escapeTeXText(text))} "
            }
            return text.isEmpty ? "" : escapeTeXText(text)
        case "mn":
            return escapeTeXText(node.textContent.trimmingCharacters(in: .whitespacesAndNewlines))
        case "mo":
            let raw = node.textContent.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !raw.isEmpty else { return "" }
            let mapped = operatorMap[raw] ?? escapeTeXText(raw)
            return " \(mapped) "
        case "mtext", "ms":
            let text = escapeTeXText(node.textContent.trimmingCharacters(in: .whitespacesAndNewlines))
            return text.isEmpty ? "" : "\\text{\(text)} "
        case "msup":
            let parts = elementChildren(node)
            guard parts.count >= 2 else { return flattenChildren(node) }
            return "{\(render(parts[0]))}^{\(render(parts[1]))}"
        case "msub":
            let parts = elementChildren(node)
            guard parts.count >= 2 else { return flattenChildren(node) }
            return "{\(render(parts[0]))}_{\(render(parts[1]))}"
        case "msubsup":
            let parts = elementChildren(node)
            guard parts.count >= 3 else { return flattenChildren(node) }
            return "{\(render(parts[0]))}_{\(render(parts[1]))}^{\(render(parts[2]))}"
        case "mfrac":
            let parts = elementChildren(node)
            guard parts.count >= 2 else { return flattenChildren(node) }
            return "\\frac{\(render(parts[0]))}{\(render(parts[1]))}"
        case "msqrt":
            return "\\sqrt{\(renderPresentationChildren(node))}"
        case "mroot":
            let parts = elementChildren(node)
            guard parts.count >= 2 else { return renderPresentationChildren(node) }
            return "\\sqrt[\(render(parts[1]))]{\(render(parts[0]))}"
        case "mfenced":
            return renderFenced(node)
        case "mtable":
            return renderTable(node)
        case "mtr":
            let cells = elementChildren(node).map { render($0) }
            return cells.joined(separator: " & ")
        case "mover":
            let parts = elementChildren(node)
            guard parts.count >= 2 else { return flattenChildren(node) }
            return "\\overset{\(render(parts[1]))}{\(render(parts[0]))}"
        case "munder":
            let parts = elementChildren(node)
            guard parts.count >= 2 else { return flattenChildren(node) }
            return "\\underset{\(render(parts[1]))}{\(render(parts[0]))}"
        case "munderover":
            let parts = elementChildren(node)
            guard parts.count >= 3 else { return flattenChildren(node) }
            return "\\overset{\(render(parts[2]))}{\\underset{\(render(parts[1]))}{\(render(parts[0]))}}"
        case "mspace":
            return "\\,"
        case "annotation", "annotation-xml":
            return ""
        case "menclose":
            return "\\boxed{\(renderPresentationChildren(node))}"
        default:
            // Unsupported element: preserve its flattened text/subtree.
            return renderPresentationChildren(node)
        }
    }

    private static func renderPresentationChildren(_ node: MathMLXMLNode) -> String {
        var pieces: [String] = []
        for child in node.children {
            switch child {
            case let .element(element):
                // `annotation` duplicates presentation content; skip it.
                if element.name.lowercased() == "annotation"
                    || element.name.lowercased() == "annotation-xml" {
                    continue
                }
                let rendered = render(element).trimmingCharacters(in: .whitespacesAndNewlines)
                if !rendered.isEmpty { pieces.append(rendered) }
            case let .text(text):
                let mapped = operatorMap[text] ?? text
                let trimmed = mapped.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { pieces.append(trimmed) }
            }
        }
        return pieces.joined(separator: " ")
    }

    private static func renderFenced(_ node: MathMLXMLNode) -> String {
        let open = node.attributes["open"] ?? "("
        let close = node.attributes["close"] ?? ")"
        let separators = node.attributes["separators"] ?? ","
        let children = elementChildren(node)
        let body: String
        if separators.isEmpty {
            body = children.map { render($0) }.joined(separator: " ")
        } else {
            let separator = escapeTeXText(String(separators.prefix(1)))
            body = children.map { render($0) }.joined(separator: " \(separator) ")
        }
        return "\\left\(escapeDelimiter(open)) \(body) \\right\(escapeDelimiter(close))"
    }

    private static func renderTable(_ node: MathMLXMLNode) -> String {
        let rows = elementChildren(node).filter { $0.name.lowercased() == "mtr" }
        let rendered = rows.map { row -> String in
            let cells = elementChildren(row).map { render($0) }
            return cells.joined(separator: " & ")
        }
        return "\\begin{matrix} \(rendered.joined(separator: " \\\\ ")) \\end{matrix}"
    }

    private static func flattenChildren(_ node: MathMLXMLNode) -> String {
        node.children.map { child in
            switch child {
            case let .element(element): return render(element)
            case let .text(text): return text
            }
        }.joined(separator: " ")
    }

    // MARK: - Text extraction

    private static func collectText(_ node: MathMLXMLNode, into output: inout String) {
        if node.name.lowercased() == "annotation" || node.name.lowercased() == "annotation-xml" {
            return
        }
        output += node.textContent
        output += " "
        for child in node.children {
            if case let .element(element) = child {
                collectText(element, into: &output)
            }
        }
    }

    private static func findElement(named name: String, in node: MathMLXMLNode) -> MathMLXMLNode? {
        if node.name.lowercased() == name { return node }
        for child in node.children {
            if case let .element(element) = child,
               let found = findElement(named: name, in: element) {
                return found
            }
        }
        return nil
    }

    private static func elementChildren(_ node: MathMLXMLNode) -> [MathMLXMLNode] {
        node.children.compactMap { child in
            if case let .element(element) = child { return element }
            return nil
        }
    }

    // MARK: - Text cleanup

    private static func normalizeTeX(_ value: String) -> String {
        var text = value
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\{\\s+", with: "{", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s+\\}", with: "}", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\^\\s+\\{", with: "^{", options: .regularExpression)
        text = text.replacingOccurrences(of: "_\\s+\\{", with: "_{", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\\\frac\\{\\s+", with: "\\frac{", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizeSpaces(_ value: String) -> String {
        value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    private static func escapeTeXText(_ value: String) -> String {
        var output = ""
        for character in value {
            switch character {
            case "\\", "{", "}", "$", "&", "#", "%", "_", "^": output.append("\\\(character)")
            default: output.append(character)
            }
        }
        return output
    }

    private static func escapeDelimiter(_ value: String) -> String {
        switch value {
        case "(", ")", "[", "]", "|", ".", "/": return value
        case "{": return "\\{"
        case "}": return "\\}"
        case "<": return "\\langle"
        case ">": return "\\rangle"
        default: return escapeTeXText(value)
        }
    }
}

// MARK: - Tolerant XML tree

final class MathMLXMLNode {
    var name: String
    var attributes: [String: String]
    var children: [MathMLXMLChild]

    init(name: String, attributes: [String: String] = [:], children: [MathMLXMLChild] = []) {
        self.name = name
        self.attributes = attributes
        self.children = children
    }

    /// Direct text children only; `collectText` walks descendant elements.
    var textContent: String {
        children.compactMap { child in
            if case let .text(text) = child { return text }
            return nil
        }.joined()
    }
}

enum MathMLXMLChild {
    case element(MathMLXMLNode)
    case text(String)
}

enum MathMLXMLParser {
    static func parse(_ xml: String) -> MathMLXMLNode {
        let root = MathMLXMLNode(name: "#document")
        var stack: [MathMLXMLNode] = [root]
        let characters = Array(xml)
        var index = 0
        var textBuffer = ""

        func flushText() {
            guard !textBuffer.isEmpty else { return }
            let decoded = decodeEntities(textBuffer)
            if !decoded.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                stack[stack.count - 1].children.append(.text(decoded))
            }
            textBuffer = ""
        }

        while index < characters.count {
            let character = characters[index]
            guard character == "<" else {
                textBuffer.append(character)
                index += 1
                continue
            }

            // Comment / CDATA / processing instruction.
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
                textBuffer += String(characters[start..<min(cursor, characters.count)])
                index = min(cursor + 3, characters.count)
                continue
            }
            if index + 1 < characters.count, characters[index + 1] == "?" {
                flushText()
                index = skip(until: "?>", from: index + 2, characters: characters)
                continue
            }

            flushText()
            guard let end = findTagEnd(from: index, characters: characters) else {
                index += 1
                continue
            }
            let tag = String(characters[(index + 1)..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
            index = end + 1
            if tag.isEmpty { continue }

            if tag.hasPrefix("/") {
                let name = tag.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if let position = stack.lastIndex(where: { $0.name.lowercased() == name }), position > 0 {
                    stack.removeSubrange(position..<stack.count)
                }
                continue
            }

            let selfClosing = tag.hasSuffix("/")
            let content = selfClosing ? String(tag.dropLast()).trimmingCharacters(in: .whitespaces) : tag
            let name = tagName(content)
            guard !name.isEmpty else { continue }
            let node = MathMLXMLNode(name: name, attributes: parseAttributes(content))
            stack[stack.count - 1].children.append(.element(node))
            if !selfClosing {
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
            if let currentQuote = quote {
                if character == currentQuote { quote = nil }
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
        let scalars = tag.unicodeScalars
        var name = ""
        for scalar in scalars {
            if scalar == " " || scalar == "\t" || scalar == "\n" || scalar == "\r" || scalar == "/" {
                break
            }
            name.unicodeScalars.append(scalar)
        }
        return name.trimmingCharacters(in: .whitespacesAndNewlines)
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
            attributes[name] = decodeEntities(value)
        }
        return attributes
    }

    static func decodeEntities(_ value: String) -> String {
        var text = value
        let named: [String: String] = [
            "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
            "&apos;": "'", "&#39;": "'", "&nbsp;": " ", "&minus;": "−",
            "&times;": "×", "&divide;": "÷", "&le;": "≤", "&ge;": "≥",
            "&ne;": "≠", "&plusmn;": "±", "&infin;": "∞", "&rarr;": "→",
        ]
        for (entity, replacement) in named {
            text = text.replacingOccurrences(of: entity, with: replacement)
        }
        guard text.contains("&#") else { return text }
        let pattern = #"&#(x?[0-9A-Fa-f]+);"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        for match in regex.matches(in: text, options: [], range: range).reversed() {
            guard let full = Range(match.range(at: 0), in: text),
                  let valueRange = Range(match.range(at: 1), in: text) else { continue }
            let raw = String(text[valueRange])
            let scalarValue: UInt32?
            if raw.lowercased().hasPrefix("x") {
                scalarValue = UInt32(raw.dropFirst(), radix: 16)
            } else {
                scalarValue = UInt32(raw, radix: 10)
            }
            if let scalarValue, let scalar = UnicodeScalar(scalarValue) {
                text.replaceSubrange(full, with: String(Character(scalar)))
            }
        }
        return text
    }
}
