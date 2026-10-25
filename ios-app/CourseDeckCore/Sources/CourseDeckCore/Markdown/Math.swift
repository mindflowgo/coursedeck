import Foundation

/// Port of the desktop `isLikelyInlineMath` heuristic (PLAN §4.4), including
/// the digit-leading math tests and the `5k/2m/3b` currency-magnitude rejection.
public enum InlineMathHeuristic {
    private static let commandPattern = #"\\[a-zA-Z]+"#
    private static let escapedSymbolPattern = #"\\([\\$&#%_{}\[\]|<>~^+\-/*=])"#
    private static let unicodeMathSymbols = CharacterSet(charactersIn: "≠≈≤≥±×÷·√∞∫∑∏∂∇∈∉⊂⊃∪∩∧∨")
    private static let wordListPattern =
        #"\b(and|then|the|or|of|in|to|for|with|by|at|from|is|are|was|were|assets|cash|debt|revenue|cost|expense|expenses|inventory)\b"#
    private static let twoWordsPattern = #"\b[a-zA-Z]{2,}\s+[a-zA-Z]{2,}\b"#
    private static let singleLetterPattern = #"^[a-zA-Z]$"#
    private static let coefficientPattern = #"^\d+(?:\.\d+)?[a-zA-Z]$"#
    private static let magnitudeSuffixPattern = #"[kmb]$"#
    private static let letterListPattern = #"^[a-zA-Z](?:\s*,\s*[a-zA-Z])+$"#
    private static let absoluteValuePattern = #"^\|[^|]+\|$"#
    private static let threeLetterWordPattern = #"[a-zA-Z]{3,}"#
    private static let relationSymbols = CharacterSet(charactersIn: "=<>+*")
    private static let strictRelations = CharacterSet(charactersIn: "=<>")
    private static let letters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
    private static let digitsAndCurrency = CharacterSet(charactersIn: "0123456789,.")

    public static func isLikelyInlineMath(_ content: String) -> Bool {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        // 1. Explicit LaTeX commands: \frac, \sqrt, \alpha, \neq, \times …
        if matches(commandPattern, trimmed) { return true }
        // 2. Structural notation: exponents, subscripts, TeX grouping.
        if trimmed.contains(where: { $0 == "^" || $0 == "_" || $0 == "{" || $0 == "}" }) {
            return true
        }
        // 3. Escaped symbols and Unicode math symbols.
        if matches(escapedSymbolPattern, trimmed) { return true }
        if trimmed.unicodeScalars.contains(where: { unicodeMathSymbols.contains($0) }) { return true }
        // 4. Symbolic expressions with a relation or variable ($x = 2$).
        if containsAny(trimmed, in: relationSymbols),
           containsAny(trimmed, in: strictRelations) || containsLetter(trimmed),
           !matches(threeLetterWordPattern, trimmed) {
            return true
        }
        // 4b. Absolute value: $|x|$ (a pipe inside a protected math span is
        // content, never a table delimiter — PLAN §4.3).
        if matches(absoluteValuePattern, trimmed),
           trimmed.contains(where: { !$0.isWhitespace && $0 != "|" }) {
            return true
        }
        // 5. Single algebraic variable: $x$.
        if matches(singleLetterPattern, trimmed) { return true }
        // 6. Numeric coefficient with a variable ($5x$, $2n$) but not
        //    $5k / $2m / $3b, which are currency magnitudes.
        if matches(coefficientPattern, trimmed) && !matches(magnitudeSuffixPattern, trimmed) {
            return true
        }
        // 7. Comma-separated single-letter lists: $a, k, d, c$.
        if matches(letterListPattern, trimmed) { return true }

        // 8. Currency / plain-prose guards.
        if let first = trimmed.unicodeScalars.first, digitsAndCurrency.contains(first) {
            return false
        }
        if matches(wordListPattern, trimmed) { return false }
        if matches(threeLetterWordPattern, trimmed) { return false }
        if matches(twoWordsPattern, trimmed) { return false }
        return false
    }

    // MARK: - Helpers

    private static func matches(_ pattern: String, _ text: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func containsAny(_ text: String, in set: CharacterSet) -> Bool {
        text.unicodeScalars.contains(where: { set.contains($0) })
    }

    private static func containsLetter(_ text: String) -> Bool {
        text.unicodeScalars.contains(where: { letters.contains($0) })
    }
}

/// A captured math span. `id` is the placeholder left in the protected
/// Markdown (`%%CDMATH0%%`) and never contains `|`, `$`, or backticks.
public struct MathToken: Equatable, Sendable {
    public var id: String
    public var math: String
    public var display: Bool

    public init(id: String, math: String, display: Bool) {
        self.id = id
        self.math = math
        self.display = display
    }
}

public struct MathExtractionResult: Equatable, Sendable {
    public var markdown: String
    public var tokens: [MathToken]

    public init(markdown: String, tokens: [MathToken]) {
        self.markdown = markdown
        self.tokens = tokens
    }
}

/// Extraction order matches the desktop: `$$`, `\[`, `\(`, `$…$`, then
/// parenthesized LaTeX. Code must already be protected (PLAN §4.2 step 4).
public enum MarkdownMathExtractor {
    public static func makeTokenString(_ index: Int) -> String { "%%CDMATH\(index)%%" }

    public static func extract(from markdown: String) -> MathExtractionResult {
        var tokens: [MathToken] = []
        var codeBlocks: [String] = []
        var inlineCode: [String] = []

        // The pipeline protects code before calling this extractor, but the
        // public API must also be safe on its own (PLAN §4.4 "protect code
        // before extraction").
        var text = protect(markdown, pattern: #"(?s)```[\s\S]*?```|~~~[\s\S]*?~~~"#,
                           prefix: "%%CDMATHFENCE", storage: &codeBlocks)
        text = protect(text, pattern: #"`[^`\n]+`"#,
                       prefix: "%%CDMATHINLINE", storage: &inlineCode)

        replaceDisplay(pattern: #"\$\$([\s\S]+?)\$\$"#, display: true, in: &text, tokens: &tokens)
        replaceDisplay(pattern: #"\\\[([\s\S]+?)\\\]"#, display: true, in: &text, tokens: &tokens)
        replaceDisplay(pattern: #"\\\(([\s\S]+?)\\\)"#, display: false, in: &text, tokens: &tokens)
        text = replaceDollarMath(in: text, tokens: &tokens)
        text = replaceParenthesizedMath(in: text, tokens: &tokens)

        text = restore(text, prefix: "%%CDMATHINLINE", storage: inlineCode)
        text = restore(text, prefix: "%%CDMATHFENCE", storage: codeBlocks)
        return MathExtractionResult(markdown: text, tokens: tokens)
    }

    private static func protect(
        _ text: String,
        pattern: String,
        prefix: String,
        storage: inout [String]
    ) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = regex.matches(in: text, options: [], range: range)
        guard !matches.isEmpty else { return text }

        var output = text
        for match in matches.reversed() {
            guard let matchRange = Range(match.range, in: output) else { continue }
            let literal = String(output[matchRange])
            let index = storage.count
            storage.append(literal)
            output.replaceSubrange(matchRange, with: "\(prefix)\(index)%%")
        }
        return output
    }

    private static func restore(_ text: String, prefix: String, storage: [String]) -> String {
        guard !storage.isEmpty else { return text }
        var output = text
        for (index, literal) in storage.enumerated() {
            output = output.replacingOccurrences(of: "\(prefix)\(index)%%", with: literal)
        }
        return output
    }

    static func isWordCharacter(_ character: Character) -> Bool {
        character.isLetter || character.isNumber || character == "_"
    }

    // MARK: - Pattern passes

    private static func replaceDisplay(
        pattern: String,
        display: Bool,
        in text: inout String,
        tokens: inout [MathToken]
    ) {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return }
        let source = text as NSString
        let fullRange = NSRange(location: 0, length: source.length)
        let matches = regex.matches(in: text, options: [], range: fullRange)
        guard !matches.isEmpty else { return }

        for match in matches.reversed() {
            let contentRange = match.range(at: 1)
            guard contentRange.location != NSNotFound,
                  let swiftContent = Range(contentRange, in: text) else { continue }
            let content = String(text[swiftContent]).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !content.isEmpty,
                  let swiftMatch = Range(match.range, in: text) else { continue }
            let token = MathToken(
                id: makeTokenString(tokens.count),
                math: content,
                display: display
            )
            tokens.append(token)
            text.replaceSubrange(swiftMatch, with: token.id)
        }
    }

    private static func replaceDollarMath(in text: String, tokens: inout [MathToken]) -> String {
        let characters = Array(text)
        var output = ""
        output.reserveCapacity(text.count)
        var index = 0

        while index < characters.count {
            let character = characters[index]
            let isOpening: Bool = {
                guard character == "$" else { return false }
                if index > 0 {
                    let previous = characters[index - 1]
                    if previous == "\\" || isWordCharacter(previous) { return false }
                }
                guard index + 1 < characters.count else { return false }
                return !characters[index + 1].isWhitespace
            }()

            guard isOpening else {
                output.append(character)
                index += 1
                continue
            }

            // Stop at the first closing candidate. This deliberately refuses
            // to look past an invalid `$` so two currency cells
            // (`| $1,500 | $2,000 |`) can never be paired into one span.
            var closing = index + 1
            while closing < characters.count, characters[closing] != "$", characters[closing] != "\n" {
                closing += 1
            }

            guard closing < characters.count, characters[closing] == "$" else {
                output.append(character)
                index += 1
                continue
            }

            let content = String(characters[(index + 1)..<closing])
            let closingValid = closing > index + 1
                && !characters[closing - 1].isWhitespace
                && (closing + 1 >= characters.count || !characters[closing + 1].isNumber)

            if closingValid && InlineMathHeuristic.isLikelyInlineMath(content) {
                let token = MathToken(
                    id: makeTokenString(tokens.count),
                    math: content.trimmingCharacters(in: .whitespacesAndNewlines),
                    display: false
                )
                tokens.append(token)
                output.append(token.id)
                index = closing + 1
                continue
            }

            output.append(character)
            index += 1
        }

        return output
    }

    private static func replaceParenthesizedMath(in text: String, tokens: inout [MathToken]) -> String {
        let characters = Array(text)
        var output = ""
        output.reserveCapacity(text.count)
        var index = 0
        let prosePattern =
            #"\b(and|or|the|in|at|for|with|by|from|note|see)\b"#
        let latexPattern = #"\\[a-zA-Z]+"#
        let notationCharacters = Set<Character>(["^", "_", "{", "}"])
        let operatorCharacters = Set<Character>(["=", "+", "-", "*", "/"])

        while index < characters.count {
            guard characters[index] == "(" else {
                output.append(characters[index])
                index += 1
                continue
            }
            // A "(" directly after "]" is a markdown link/image destination.
            if index > 0 && characters[index - 1] == "]" {
                output.append(characters[index])
                index += 1
                continue
            }

            var depth = 1
            var cursor = index + 1
            while cursor < characters.count, depth > 0, characters[cursor] != "\n" {
                if characters[cursor] == "\\" {
                    cursor += 2
                    continue
                }
                if characters[cursor] == "(" { depth += 1 }
                if characters[cursor] == ")" { depth -= 1 }
                cursor += 1
            }

            guard depth == 0 else {
                output.append(characters[index])
                index += 1
                continue
            }

            let inner = String(characters[(index + 1)..<(cursor - 1)])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let innerCharacters = Array(inner)
            let hasLatex = inner.range(of: latexPattern, options: .regularExpression) != nil
            let hasNotation = innerCharacters.contains(where: { notationCharacters.contains($0) })
                && innerCharacters.contains(where: { operatorCharacters.contains($0) })
            let isNotProse = inner.range(
                of: prosePattern,
                options: [.regularExpression, .caseInsensitive]
            ) == nil

            if (hasLatex || hasNotation) && isNotProse {
                let token = MathToken(
                    id: makeTokenString(tokens.count),
                    math: inner,
                    display: false
                )
                tokens.append(token)
                output.append(token.id)
                index = cursor
                continue
            }

            output.append(characters[index])
            index += 1
        }

        return output
    }
}
