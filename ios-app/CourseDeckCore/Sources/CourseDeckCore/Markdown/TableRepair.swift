import Foundation

/// Metadata produced by the repair pass for one table, in document order.
public struct TableRepairMetadata: Equatable, Sendable {
    public var declaredColumns: Int
    public var headerCellCount: Int
    public var rowCellCounts: [Int]
    public var columnCount: Int
    public var surplusCellCount: Int
    public var mergedHeaderLineCount: Int
    public var mergedRowLineCounts: [Int]
    public var warnings: [String]

    public init(
        declaredColumns: Int,
        headerCellCount: Int,
        rowCellCounts: [Int],
        columnCount: Int,
        surplusCellCount: Int,
        mergedHeaderLineCount: Int,
        mergedRowLineCounts: [Int],
        warnings: [String]
    ) {
        self.declaredColumns = declaredColumns
        self.headerCellCount = headerCellCount
        self.rowCellCounts = rowCellCounts
        self.columnCount = columnCount
        self.surplusCellCount = surplusCellCount
        self.mergedHeaderLineCount = mergedHeaderLineCount
        self.mergedRowLineCounts = mergedRowLineCounts
        self.warnings = warnings
    }

    public var tableRepairInfo: TableRepairInfo {
        TableRepairInfo(
            declaredColumns: declaredColumns,
            headerCellCount: headerCellCount,
            rowCellCounts: rowCellCounts,
            columnCount: columnCount,
            surplusCellCount: surplusCellCount,
            mergedHeaderLineCount: mergedHeaderLineCount,
            mergedRowLineCounts: mergedRowLineCounts,
            warnings: warnings
        )
    }
}

public struct TableRepairResult: Equatable, Sendable {
    public var markdown: String
    public var tables: [TableRepairMetadata]

    public init(markdown: String, tables: [TableRepairMetadata]) {
        self.markdown = markdown
        self.tables = tables
    }
}

/// Repairs multiline / malformed GFM tables before parsing.
///
/// Fixes over the desktop implementation (PLAN §4.3):
/// * no-outer-pipe tables: pipe expectations are computed for 0, 1, and 2
///   outer pipes in both the header and body scans;
/// * surplus cells extend the grid instead of being truncated;
/// * fenced, indented, `<pre>`, inline-code and math tokens are already
///   placeholders, so they are never table terminators and their pipes never
///   split cells;
/// * `![alt|spec](url)` pipes are content, not delimiters;
/// * CRLF input is normalized.
public enum MarkdownTableRepair {
    public static func repair(_ markdown: String) -> TableRepairResult {
        TableRepair.repair(markdown)
    }

    /// Exposed for tests and the cell splitter.
    public static func splitTableCells(_ row: String) -> [String] {
        TableRepair.splitTableCells(row)
    }
}

enum TableRepair {
    // MARK: - Public helpers

    static func splitTableCells(_ row: String) -> [String] {
        var content = row.trimmingCharacters(in: .whitespacesAndNewlines)
        if content.hasPrefix("|") { content.removeFirst() }
        if content.hasSuffix("|") && !content.hasSuffix("\\|") { content.removeLast() }

        let characters = Array(content)
        var cells: [String] = []
        var current = ""
        var index = 0

        while index < characters.count {
            let character = characters[index]

            // Escaped pipe stays in the cell.
            if character == "\\", index + 1 < characters.count, characters[index + 1] == "|" {
                current.append("\\|")
                index += 2
                continue
            }

            // Image syntax: `![alt|spec](url)` — pipes in the alt are content.
            if character == "!", index + 1 < characters.count, characters[index + 1] == "[" {
                if let end = imageSyntaxEnd(characters, from: index) {
                    current.append(contentsOf: characters[index...end])
                    index = end + 1
                    continue
                }
            }

            // Raw HTML: pipes inside tag attributes are content.
            if character == "<", index + 1 < characters.count {
                let next = characters[index + 1]
                if next.isLetter || next == "/" || next == "!" || next == "?",
                   let end = htmlTagEnd(characters, from: index) {
                    current.append(contentsOf: characters[index...end])
                    index = end + 1
                    continue
                }
            }

            if character == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
                index += 1
                continue
            }

            current.append(character)
            index += 1
        }

        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    static func isDelimiterLine(_ line: String) -> Bool {
        delimiterCells(for: line) != nil
    }

    // MARK: - Repair

    static func repair(_ markdown: String) -> TableRepairResult {
        guard markdown.contains("|") else {
            return TableRepairResult(markdown: markdown, tables: [])
        }

        var codeLiterals: [String] = []
        let normalized = escapeHTMLTagPipes(
            protectCodeLiterals(
                markdown
                    .replacingOccurrences(of: "\r\n", with: "\n")
                    .replacingOccurrences(of: "\r", with: "\n"),
                storage: &codeLiterals
            )
        )
        let lines = normalized.components(separatedBy: "\n")
        var result: [String] = []
        var tables: [TableRepairMetadata] = []
        var lastEmittedWasTableRow = false
        var index = 0

        while index < lines.count {
            let line = lines[index]
            guard let delimiter = delimiterCells(for: line) else {
                // Header lines for the next table may follow a table body with
                // no blank line. Separate them now, before they are emitted as
                // ordinary Markdown (otherwise the previous table consumes
                // them as extra body rows).
                if lastEmittedWasTableRow,
                   upcomingDelimiterDistance(lines, from: index) != nil {
                    result.append("")
                }
                result.append(line)
                lastEmittedWasTableRow = false
                index += 1
                continue
            }

            let parts = splitPrefix(line)
            let colCount = delimiter.cells.count
            let expectedPipes = expectedHeaderPipeCount(
                columnCount: colCount,
                outerPipes: delimiter.outerPipes
            )

            // --- Header backward scan (pipe-count based, desktop-compatible) ---
            var headerLines: [String] = []
            var pipesFound = 0
            var scan = result.count - 1
            while scan >= 0, headerLines.count < 60 {
                let candidate = result[scan]
                if isBlockBoundary(candidate) { break }
                let candidateParts = splitPrefix(candidate)

                if candidateParts.content.isEmpty {
                    guard !headerLines.isEmpty else { break }
                    // A blank line inside a multiline header is allowed only
                    // when the nearest non-blank line above is also header-like.
                    var peek = scan - 1
                    while peek >= 0, splitPrefix(result[peek]).content.isEmpty { peek -= 1 }
                    guard peek >= 0,
                          peek == scan - 1,
                          !isBlockBoundary(result[peek]),
                          splitPrefix(result[peek]).content.contains("|") else {
                        break
                    }
                    headerLines.insert(candidate, at: 0)
                    scan -= 1
                    continue
                }

                guard candidateParts.content.contains("|") else { break }
                headerLines.insert(candidate, at: 0)
                pipesFound += countPipes(candidateParts.content)
                scan -= 1

                if pipesFound >= expectedPipes {
                    // The last physical header line may already carry the full
                    // pipe count while the line above is still a continuation
                    // (for example `| Concept` over `Name | Formula | Notes`).
                    // A preceding normal row has `colCount` cells; a
                    // continuation has fewer, so merge only the latter.
                    if scan >= 0 {
                        let above = result[scan]
                        let aboveParts = splitPrefix(above)
                        if !isBlockBoundary(above),
                           !aboveParts.content.isEmpty,
                           aboveParts.content.contains("|"),
                           splitTableCells(aboveParts.content).count < colCount {
                            continue
                        }
                    }
                    break
                }
            }

            guard !headerLines.isEmpty else {
                // A delimiter row without a header is not a GFM table; leave it
                // as literal text rather than synthesizing a header.
                result.append(line)
                lastEmittedWasTableRow = false
                index += 1
                continue
            }

            if !headerLines.isEmpty {
                result.removeLast(headerLines.count)
            }

            let headerJoined = stripLines(headerLines)
            var headerCells = splitTableCells(headerJoined)
            guard !headerCells.isEmpty else {
                result.append(contentsOf: headerLines)
                result.append(line)
                lastEmittedWasTableRow = false
                index += 1
                continue
            }

            // --- Body forward scan ---
            var bodyRows: [[String]] = []
            var bodyOriginalCounts: [Int] = []
            var bodyLineCounts: [Int] = []
            index += 1

            while index < lines.count {
                let bodyLine = lines[index]
                let bodyParts = splitPrefix(bodyLine)
                if bodyParts.content.isEmpty { break }
                if isBlockBoundary(bodyLine) { break }
                if delimiterCells(for: bodyLine) != nil { break }

                // A physical line is a new row only when it contains a table
                // pipe (a no-pipe line may be a continuation only after an
                // explicit hard break). This stops prose and list siblings
                // from being swallowed as rows.
                let previousEndsHard = index > 0 && endsWithHardBreak(lines[index - 1])
                if !bodyParts.content.contains("|") && !previousEndsHard {
                    break
                }
                if !bodyParts.content.contains("|") {
                    // No-pipe continuation after a hard break is handled by the
                    // row collector below; a list marker or blockquote prose
                    // still ends the table.
                    if isListMarkerLine(bodyParts.content)
                        || (!bodyParts.quotePrefix.isEmpty) {
                        break
                    }
                }
                if isListMarkerLine(bodyParts.content) { break }

                // The next physical line is another table delimiter: the
                // current line is that table's header, so leave it for the
                // header scan.
                if let distance = upcomingDelimiterDistance(lines, from: index) {
                    let currentCells = splitTableCells(bodyParts.content).count
                    if distance == 1 || currentCells != colCount {
                        break
                    }
                }

                var rowLines = [bodyLine]
                var cursor = index + 1

                while cursor < lines.count {
                    let next = lines[cursor]
                    let nextParts = splitPrefix(next)
                    if nextParts.content.isEmpty { break }
                    if isBlockBoundary(next) { break }
                    if delimiterCells(for: next) != nil { break }

                    // Only an explicit hard break (two trailing spaces or a
                    // trailing backslash) makes the next physical line a cell
                    // continuation. Everything else is a new row, so
                    // consecutive ragged rows (2, 2, 3 cells) stay separate and
                    // short rows are padded rather than silently merged.
                    guard endsWithHardBreak(rowLines.last ?? "") else { break }
                    rowLines.append(next)
                    cursor += 1
                }

                let cells = splitTableCells(stripLines(rowLines))
                if cells.isEmpty { break }
                bodyRows.append(cells)
                bodyOriginalCounts.append(cells.count)
                bodyLineCounts.append(rowLines.count)
                index = cursor
            }

            // --- Normalize, preserve surplus cells, pad short rows ---
            let maxCells = max(
                colCount,
                headerCells.count,
                bodyRows.map(\.count).max() ?? 0
            )
            let headerCellCount = headerCells.count
            while headerCells.count < maxCells { headerCells.append("") }

            var warnings: [String] = []
            if maxCells > colCount {
                warnings.append("surplusCellsPreserved:\(maxCells - colCount)")
            }
            if headerCellCount < maxCells {
                warnings.append("headerPadded")
            }
            if bodyOriginalCounts.contains(where: { $0 < maxCells }) {
                warnings.append("shortRowsPadded")
            }

            var delimiterCellsOut = delimiter.cells.map(normalizeDelimiterCell)
            while delimiterCellsOut.count < maxCells { delimiterCellsOut.append("---") }
            if delimiterCellsOut.count > maxCells {
                delimiterCellsOut = Array(delimiterCellsOut.prefix(maxCells))
            }

            if lastEmittedWasTableRow {
                result.append("")
            }

            let preserveDeepIndent = delimiter.indent.count > 3
                && hasEnclosingListMarker(in: result, tableIndent: delimiter.indent.count)
            let baseIndent = (preserveDeepIndent || delimiter.indent.count <= 3)
                ? delimiter.indent
                : ""
            let prefix = baseIndent + delimiter.quotePrefix
            result.append(prefix + renderRow(headerCells.map(normalizeCell)))
            result.append(prefix + renderRow(delimiterCellsOut))
            for row in bodyRows {
                var normalized = row.map(normalizeCell)
                while normalized.count < maxCells { normalized.append("") }
                result.append(prefix + renderRow(normalized))
            }

            // GFM parsers can treat an immediately following non-blank line as
            // another row. Separate the table from prose/list content unless
            // the next lines are another table (the stacked-table path inserts
            // its own separator).
            if index < lines.count,
               !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
               delimiterCells(for: lines[index]) == nil,
               upcomingDelimiterDistance(lines, from: index) == nil {
                let blank = prefix.isEmpty
                    ? ""
                    : String(prefix.reversed().drop { $0 == " " }.reversed())
                result.append(blank)
            }

            tables.append(
                TableRepairMetadata(
                    declaredColumns: colCount,
                    headerCellCount: headerCellCount,
                    rowCellCounts: bodyOriginalCounts,
                    columnCount: maxCells,
                    surplusCellCount: max(0, maxCells - colCount),
                    mergedHeaderLineCount: headerLines.count,
                    mergedRowLineCounts: bodyLineCounts,
                    warnings: warnings
                )
            )
            lastEmittedWasTableRow = true
        }

        return TableRepairResult(
            markdown: restoreCodeLiterals(result.joined(separator: "\n"), storage: codeLiterals),
            tables: tables
        )
    }

    /// Replaces `|` inside raw HTML tags with a numeric entity so the GFM
    /// table parser sees one cell. `HTMLTreeParser`/`HTMLInlineTag` decode the
    /// entity back to `|` in cell text and attributes.
    static func escapeHTMLTagPipes(_ text: String) -> String {
        let characters = Array(text)
        var output = ""
        output.reserveCapacity(text.count)
        var index = 0
        while index < characters.count {
            guard characters[index] == "<", index + 1 < characters.count else {
                output.append(characters[index])
                index += 1
                continue
            }
            let next = characters[index + 1]
            if next.isLetter || next == "/" || next == "!" || next == "?",
               let end = htmlTagEnd(characters, from: index) {
                let tag = String(characters[index...end])
                    .replacingOccurrences(of: "|", with: "&#124;")
                output += tag
                index = end + 1
                continue
            }
            output.append(characters[index])
            index += 1
        }
        return output
    }

    /// Protects code literals for callers that invoke the repairer directly.
    /// The full pipeline already protects code before this point; this keeps
    /// the public API safe on its own (desktop parity).
    private static func protectCodeLiterals(_ text: String, storage: inout [String]) -> String {
        var output = protect(
            text,
            pattern: #"(?s)```[\s\S]*?```|~~~[\s\S]*?~~~"#,
            storage: &storage
        )
        output = protect(
            output,
            pattern: #"(?is)<pre\b[^>]*>[\s\S]*?</pre>"#,
            storage: &storage
        )
        output = protect(output, pattern: #"`[^`\n]+`"#, storage: &storage)
        output = protectIndentedCode(output, storage: &storage)
        return output
    }

    /// Indented code is protected only when it is not an indented table
    /// (PLAN §4.3 keeps indented tables parseable).
    private static func protectIndentedCode(_ text: String, storage: inout [String]) -> String {
        let lines = text.components(separatedBy: "\n")
        var output: [String] = []
        var index = 0
        while index < lines.count {
            let line = lines[index]
            let indented = line.hasPrefix("    ") || line.hasPrefix("\t")
            let previousBlank = index == 0
                || output.last?.trimmingCharacters(in: .whitespaces).isEmpty == true
            guard indented, previousBlank else {
                output.append(line)
                index += 1
                continue
            }

            var run = [line]
            var cursor = index + 1
            while cursor < lines.count {
                let candidate = lines[cursor]
                if candidate.hasPrefix("    ") || candidate.hasPrefix("\t")
                    || candidate.trimmingCharacters(in: .whitespaces).isEmpty {
                    run.append(candidate)
                    cursor += 1
                } else {
                    break
                }
            }
            while run.last?.trimmingCharacters(in: .whitespaces).isEmpty == true {
                run.removeLast()
            }
            let stripped = run.map { value -> String in
                if value.hasPrefix("    ") { return String(value.dropFirst(4)) }
                if value.hasPrefix("\t") { return String(value.dropFirst()) }
                return value
            }
            if let delimiterIndex = stripped.firstIndex(where: { isDelimiterLine($0) }) {
                let delimiter = stripped[delimiterIndex]
                    .trimmingCharacters(in: .whitespaces)
                let header = delimiterIndex > 0
                    ? stripped[delimiterIndex - 1].trimmingCharacters(in: .whitespaces)
                    : ""
                // Only the explicit outer-pipe form in a table context stays a
                // table; a standalone indented table-like block is code.
                if delimiter.hasPrefix("|"), header.hasPrefix("|") {
                    let leading = line.prefix { $0 == " " }.count
                    let previousRaw = output.last(where: {
                        !$0.trimmingCharacters(in: .whitespaces).isEmpty
                    })?.trimmingCharacters(in: .whitespaces) ?? ""
                    let followsBlockquoteTable = previousRaw.hasPrefix(">")
                        && previousRaw.contains("|")
                    let hasListContext = hasEnclosingListMarker(
                        in: output,
                        tableIndent: max(leading, 4)
                    )
                    if hasListContext || followsBlockquoteTable {
                        output.append(line)
                        index += 1
                        continue
                    }
                }
            }

            let indexOfLiteral = storage.count
            storage.append(run.joined(separator: "\n"))
            output.append("%%CDREPAIRCODE\(indexOfLiteral)%%")
            index = cursor
        }
        return output.joined(separator: "\n")
    }

    private static func protect(_ text: String, pattern: String, storage: inout [String]) -> String {
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
            output.replaceSubrange(matchRange, with: "%%CDREPAIRCODE\(index)%%")
        }
        return output
    }

    private static func restoreCodeLiterals(_ text: String, storage: [String]) -> String {
        guard !storage.isEmpty else { return text }
        var output = text
        for (index, literal) in storage.enumerated() {
            output = output.replacingOccurrences(of: "%%CDREPAIRCODE\(index)%%", with: literal)
        }
        return output
    }

    // MARK: - Line prefixes

    struct LineParts {
        var indent: String
        var quotePrefix: String
        var content: String

        /// Indentation that keeps a table inside its list item. Indentation
        /// of four or more is preserved only when an enclosing list marker is
        /// found (see `hasEnclosingListMarker`); otherwise it is dropped so a
        /// standalone indented outer-pipe table still parses as a table.
        func emissionPrefix(preserveDeepIndent: Bool) -> String {
            let base = (preserveDeepIndent || indent.count <= 3) ? indent : ""
            return base + quotePrefix
        }
    }

    static func splitPrefix(_ line: String) -> LineParts {
        let characters = Array(line)
        var index = 0
        while index < characters.count, characters[index] == " " || characters[index] == "\t" {
            index += 1
        }
        let indent = index == 0 ? "" : String(characters[0..<index])
        var depth = 0
        while index < characters.count, characters[index] == ">" {
            depth += 1
            index += 1
            if index < characters.count, characters[index] == " " { index += 1 }
            while index < characters.count, characters[index] == " " || characters[index] == "\t" {
                index += 1
            }
        }
        let content = index < characters.count ? String(characters[index...]) : ""
        let quotePrefix = depth == 0 ? "" : String(repeating: "> ", count: depth)
        return LineParts(indent: indent, quotePrefix: quotePrefix, content: content)
    }

    struct DelimiterInfo {
        var cells: [String]
        var indent: String
        var quotePrefix: String
        var outerPipes: Int
    }

    static func delimiterCells(for line: String) -> DelimiterInfo? {
        let parts = splitPrefix(line)
        let content = parts.content.trimmingCharacters(in: .whitespaces)
        guard content.contains("|") else { return nil }

        var outerPipes = 0
        if content.hasPrefix("|") { outerPipes += 1 }
        if content.hasSuffix("|") && !content.hasSuffix("\\|") { outerPipes += 1 }

        let cells = splitTableCells(content)
        guard !cells.isEmpty else { return nil }
        let pattern = #"^:?-{3,}:?$"#
        guard cells.allSatisfy({
            $0.range(of: pattern, options: .regularExpression) != nil
        }) else {
            return nil
        }
        return DelimiterInfo(
            cells: cells,
            indent: parts.indent,
            quotePrefix: parts.quotePrefix,
            outerPipes: outerPipes
        )
    }

    static func expectedHeaderPipeCount(columnCount: Int, outerPipes: Int) -> Int {
        max(columnCount - 1 + max(0, min(2, outerPipes)), 1)
    }

    static func normalizeDelimiterCell(_ cell: String) -> String {
        let trimmed = cell.trimmingCharacters(in: .whitespaces)
        let left = trimmed.hasPrefix(":")
        let right = trimmed.hasSuffix(":")
        if left && right { return ":---:" }
        if left { return ":---" }
        if right { return "---:" }
        return "---"
    }

    static func renderRow(_ cells: [String]) -> String {
        "| " + cells.joined(separator: " | ") + " |"
    }

    static func normalizeCell(_ raw: String) -> String {
        let normalized = raw.replacingOccurrences(of: "\r", with: "")
        var physical = normalized.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        while physical.first?.isEmpty == true { physical.removeFirst() }
        while physical.last?.isEmpty == true { physical.removeLast() }
        var cell = physical.joined(separator: "<br>")
        cell = cell.replacingOccurrences(
            of: #"[ \t]+"#,
            with: " ",
            options: .regularExpression
        )
        return cell.trimmingCharacters(in: .whitespaces)
    }

    static func stripLines(_ lines: [String]) -> String {
        lines.map { splitPrefix($0).content }
            .joined(separator: "\n")
    }

    static func countPipes(_ text: String) -> Int {
        var count = 0
        let characters = Array(text)
        var index = 0
        while index < characters.count {
            if characters[index] == "\\", index + 1 < characters.count, characters[index + 1] == "|" {
                index += 2
                continue
            }
            if characters[index] == "<", index + 1 < characters.count {
                let next = characters[index + 1]
                if next.isLetter || next == "/" || next == "!" || next == "?",
                   let end = htmlTagEnd(characters, from: index) {
                    index = end + 1
                    continue
                }
            }
            if characters[index] == "|" { count += 1 }
            index += 1
        }
        return count
    }

    static func endsWithHardBreak(_ line: String) -> Bool {
        var trimmed = line
        if trimmed.hasSuffix("\r") { trimmed.removeLast() }
        if trimmed.hasSuffix("\\") { return true }
        guard trimmed.hasSuffix("  ") else { return false }
        var count = 0
        for character in trimmed.reversed() {
            if character == " " { count += 1 } else { break }
        }
        return count >= 2
    }

    /// True when a line at a lower indentation is the list marker that owns a
    /// deeply indented table. Table rows/blockquote rows in between are
    /// skipped; prose at lower indentation ends the search.
    static func hasEnclosingListMarker(in lines: [String], tableIndent: Int) -> Bool {
        guard tableIndent > 3 else { return false }
        var index = lines.count - 1
        var inspected = 0
        while index >= 0, inspected < 40 {
            let line = lines[index]
            let parts = splitPrefix(line)
            if parts.content.trimmingCharacters(in: .whitespaces).isEmpty {
                index -= 1
                inspected += 1
                continue
            }
            let content = parts.content.trimmingCharacters(in: .whitespaces)
            if isListMarkerLine(content), parts.indent.count < tableIndent {
                return true
            }
            if !parts.quotePrefix.isEmpty && content.contains("|") {
                index -= 1
                inspected += 1
                continue
            }
            if parts.indent.count >= tableIndent {
                index -= 1
                inspected += 1
                continue
            }
            return false
        }
        return false
    }

    static func isListMarkerLine(_ content: String) -> Bool {
        content.range(
            of: #"^(?:[-*+]|\d{1,9}[.)])\s+"#,
            options: .regularExpression
        ) != nil
    }

    static func isBlockBoundary(_ line: String) -> Bool {
        let content = splitPrefix(line).content.trimmingCharacters(in: .whitespaces)
        if content.isEmpty { return false }
        if content.hasPrefix("%%CDBLOCKCODE")
            || content.hasPrefix("%%CDREPAIRCODE")
            || content.hasPrefix("%%CDCALLOUT")
            || content.hasPrefix("%%CDUSERNOTE")
            || content.hasPrefix("%%CDDETAILS") {
            return true
        }
        if content.range(of: #"^#{1,6}\s"#, options: .regularExpression) != nil { return true }
        if content.range(of: #"^---+$"#, options: .regularExpression) != nil { return true }
        if content.range(of: #"^<[/!]?(table|div|p|h[1-6]|details|ul|ol|pre|blockquote)\b"#,
                         options: [.regularExpression, .caseInsensitive]) != nil {
            return true
        }
        return false
    }

    static func upcomingDelimiterDistance(
        _ lines: [String],
        from start: Int,
        limit: Int = 5
    ) -> Int? {
        var index = start + 1
        var steps = 1
        while index < lines.count, steps <= limit {
            let line = lines[index]
            let parts = splitPrefix(line)
            if parts.content.isEmpty || isBlockBoundary(line) { return nil }
            if delimiterCells(for: line) != nil { return steps }
            index += 1
            steps += 1
        }
        return nil
    }

    private static func htmlTagEnd(_ characters: [Character], from start: Int) -> Int? {
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

    /// Finds the end index of `![alt](url)`, allowing pipes in alt and balanced
    /// parentheses in the destination.
    private static func imageSyntaxEnd(_ characters: [Character], from start: Int) -> Int? {
        var index = start + 2 // skip "!["
        var bracketDepth = 0
        while index < characters.count {
            let character = characters[index]
            if character == "\\" { index += 2; continue }
            if character == "[" { bracketDepth += 1 }
            if character == "]" {
                if bracketDepth == 0 {
                    guard index + 1 < characters.count, characters[index + 1] == "(" else { return nil }
                    break
                }
                bracketDepth -= 1
            }
            index += 1
        }
        guard index < characters.count, characters[index] == "]" else { return nil }
        index += 2 // skip "]("
        var parenDepth = 1
        while index < characters.count {
            let character = characters[index]
            if character == "\\" { index += 2; continue }
            if character == "(" { parenDepth += 1 }
            if character == ")" {
                parenDepth -= 1
                if parenDepth == 0 { return index }
            }
            index += 1
        }
        return nil
    }
}
