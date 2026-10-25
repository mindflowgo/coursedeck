import Foundation

// MARK: - Inline model

/// A parsed LaTeX expression. `Core` never renders math itself (SwiftMath lives
/// in the app target); it only carries the TeX, display mode, and provenance.
public struct MathExpression: Equatable, Sendable {
    public var tex: String
    public var display: Bool
    public var isMathML: Bool

    public init(tex: String, display: Bool = false, isMathML: Bool = false) {
        self.tex = tex
        self.display = display
        self.isMathML = isMathML
    }
}

/// Rich inline content shared by paragraphs, headings, table cells, quiz text,
/// and callout/details bodies. Table cells use exactly this AST (PLAN §4.3
/// "Cell inline AST"), so styling, links, math, images, and `<br>` survive
/// table repair.
public indirect enum InlineNode: Equatable, Sendable {
    case text(String)
    case emphasis([InlineNode])
    case strong([InlineNode])
    case strikethrough([InlineNode])
    case code(String)
    case link(destination: String, title: String?, children: [InlineNode])
    case image(ImageSpec, destination: String, title: String?)
    case math(MathExpression)
    case lineBreak
    case superscript([InlineNode])
    /// Named `subscripting` because `subscript` is a Swift declaration keyword.
    case subscripting([InlineNode])
    case highlight([InlineNode])
    case keyboard([InlineNode])
    case span([InlineNode])

    /// Plain text used for selection, search, anchors, and copy/TSV fallbacks.
    public var plainText: String {
        switch self {
        case let .text(value): return value
        case let .emphasis(children),
             let .strong(children),
             let .strikethrough(children),
             let .superscript(children),
             let .subscripting(children),
             let .highlight(children),
             let .keyboard(children),
             let .span(children):
            return children.map(\.plainText).joined()
        case let .code(value): return value
        case let .link(_, _, children): return children.map(\.plainText).joined()
        case let .image(spec, _, _): return spec.alt
        case let .math(expression): return expression.tex
        case .lineBreak: return "\n"
        }
    }
}

public extension Array where Element == InlineNode {
    var plainText: String {
        map(\.plainText).joined()
    }

    /// Text with inline line breaks normalized to spaces; used for table cell
    /// copy and VoiceOver labels.
    var flattenedText: String {
        plainText.replacingOccurrences(of: "\n", with: " ")
    }
}

// MARK: - Tables

public enum ColumnAlignment: String, Equatable, Sendable {
    case none
    case left
    case center
    case right
}

public struct TableCellModel: Equatable, Sendable {
    public var inlines: [InlineNode]
    public var colSpan: Int
    public var rowSpan: Int
    public var isHeader: Bool

    public init(
        inlines: [InlineNode] = [],
        colSpan: Int = 1,
        rowSpan: Int = 1,
        isHeader: Bool = false
    ) {
        self.inlines = inlines
        self.colSpan = max(1, colSpan)
        self.rowSpan = max(1, rowSpan)
        self.isHeader = isHeader
    }

    public var plainText: String { inlines.plainText }
}

/// Repair metadata captured while normalizing a table. Kept on the model so
/// the renderer/diagnostics can prove no ledger data was dropped.
public struct TableRepairInfo: Equatable, Sendable {
    /// Column count declared by the delimiter row.
    public var declaredColumns: Int
    /// Cell count of the physical header row before padding.
    public var headerCellCount: Int
    /// Cell count of each physical body row before padding.
    public var rowCellCounts: [Int]
    /// Final column count after extending for surplus cells.
    public var columnCount: Int
    /// How many surplus cells were preserved beyond the delimiter schema.
    public var surplusCellCount: Int
    /// Number of physical lines that were folded into the header row.
    public var mergedHeaderLineCount: Int
    /// Number of physical lines folded into each body row.
    public var mergedRowLineCounts: [Int]
    public var warnings: [String]

    public init(
        declaredColumns: Int,
        headerCellCount: Int,
        rowCellCounts: [Int],
        columnCount: Int,
        surplusCellCount: Int,
        mergedHeaderLineCount: Int = 1,
        mergedRowLineCounts: [Int] = [],
        warnings: [String] = []
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
}

public struct TableModel: Equatable, Sendable {
    /// Empty for headerless raw HTML tables. Markdown tables always have one.
    public var header: [TableCellModel]
    public var rows: [[TableCellModel]]
    public var columnAlignments: [ColumnAlignment]
    public var isHTML: Bool
    public var warnings: [String]
    public var repair: TableRepairInfo?

    public init(
        header: [TableCellModel] = [],
        rows: [[TableCellModel]] = [],
        columnAlignments: [ColumnAlignment] = [],
        isHTML: Bool = false,
        warnings: [String] = [],
        repair: TableRepairInfo? = nil
    ) {
        self.header = header
        self.rows = rows
        self.columnAlignments = columnAlignments
        self.isHTML = isHTML
        self.warnings = warnings
        self.repair = repair
    }

    public var headerOnly: Bool { !header.isEmpty && rows.isEmpty }

    /// Widest row measured in spanned columns.
    public var columnCount: Int {
        var count = header.reduce(0) { $0 + $1.colSpan }
        for row in rows {
            count = max(count, row.reduce(0) { $0 + $1.colSpan })
        }
        count = max(count, columnAlignments.count)
        if let repair { count = max(count, repair.columnCount) }
        return count
    }

    public func alignment(at index: Int) -> ColumnAlignment {
        index < columnAlignments.count ? columnAlignments[index] : .none
    }

    /// TSV copy used by the table long-press menu ("Copy as TSV", header
    /// included). Cells are flattened to one line, tabs/newlines are removed,
    /// and `colspan`/`rowspan` are expanded into real columns with empty
    /// placeholders so copy output keeps the visual grid.
    public func tsv(includeHeader: Bool = true) -> String {
        var gridRows: [[TableCellModel]] = []
        if includeHeader, !header.isEmpty { gridRows.append(header) }
        gridRows.append(contentsOf: rows)
        guard !gridRows.isEmpty else { return "" }

        let columns = max(columnCount, 1)
        var grid = [[String]](
            repeating: [String](repeating: "", count: columns),
            count: gridRows.count
        )
        var covered = Set<Int>()

        for (rowIndex, row) in gridRows.enumerated() {
            var column = 0
            for cell in row {
                while column < columns, covered.contains(rowIndex * columns + column) {
                    column += 1
                }
                guard column < columns else { break }
                grid[rowIndex][column] = cell.plainText
                    .replacingOccurrences(of: "\t", with: " ")
                    .replacingOccurrences(of: "\n", with: " ")
                let spanColumns = min(cell.colSpan, columns - column)
                for offset in 0..<spanColumns {
                    covered.insert(rowIndex * columns + column + offset)
                }
                let spanRows = min(cell.rowSpan, gridRows.count - rowIndex)
                if spanRows > 1 {
                    for rowOffset in 1..<spanRows {
                        for offset in 0..<spanColumns {
                            covered.insert((rowIndex + rowOffset) * columns + column + offset)
                        }
                    }
                }
                column += cell.colSpan
            }
        }

        return grid.map { $0.joined(separator: "\t") }.joined(separator: "\n")
    }
}

// MARK: - Blocks

public struct CodeBlockModel: Equatable, Sendable {
    public var code: String
    public var language: String?
    public var isFenced: Bool

    public init(code: String, language: String? = nil, isFenced: Bool = true) {
        self.code = code
        self.language = language
        self.isFenced = isFenced
    }
}

public struct ListModel: Equatable, Sendable {
    public var ordered: Bool
    public var start: Int
    public var items: [ListItemModel]

    public init(ordered: Bool, start: Int = 1, items: [ListItemModel] = []) {
        self.ordered = ordered
        self.start = start
        self.items = items
    }
}

public struct ListItemModel: Equatable, Sendable {
    /// Inline content of the item's first paragraph.
    public var inlines: [InlineNode]
    /// Nested blocks (nested lists, code, tables, additional paragraphs).
    public var blocks: [MarkdownBlockNode]
    /// `nil` when the item is not a GFM task list item.
    public var checked: Bool?

    public init(
        inlines: [InlineNode] = [],
        blocks: [MarkdownBlockNode] = [],
        checked: Bool? = nil
    ) {
        self.inlines = inlines
        self.blocks = blocks
        self.checked = checked
    }

    public var plainText: String { inlines.plainText }
}

public struct ImageModel: Equatable, Sendable {
    public var spec: ImageSpec
    public var destination: String
    public var title: String?
    /// Remote images must not be fetched without explicit confirmation
    /// (PLAN §4.5); the reader shows a placeholder until then.
    public var isRemote: Bool
    public var caption: String?

    public init(
        spec: ImageSpec,
        destination: String,
        title: String? = nil,
        isRemote: Bool = false,
        caption: String? = nil
    ) {
        self.spec = spec
        self.destination = destination
        self.title = title
        self.isRemote = isRemote
        self.caption = caption
    }

    public static func caption(for spec: ImageSpec) -> String? {
        let alt = spec.alt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !alt.isEmpty else { return nil }
        // File names are not meaningful captions.
        if alt.range(
            of: #"\.(jpe?g|png|gif|webp|svg)$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil {
            return nil
        }
        return alt
    }
}

public enum CalloutKind: String, Equatable, Sendable, CaseIterable {
    case note
    case tip
    case important
    case warning
    case caution

    public var defaultLabel: String { rawValue.uppercased() }

    public init?(marker: String) {
        self.init(rawValue: marker.lowercased())
    }
}

public struct CalloutModel: Equatable, Sendable {
    public var kind: CalloutKind
    public var title: String?
    public var blocks: [MarkdownBlockNode]

    public init(kind: CalloutKind, title: String? = nil, blocks: [MarkdownBlockNode] = []) {
        self.kind = kind
        self.title = title
        self.blocks = blocks
    }

    public var displayLabel: String { title?.isEmpty == false ? title! : kind.defaultLabel }
}

public struct DetailsModel: Equatable, Sendable {
    public var summary: [InlineNode]
    public var blocks: [MarkdownBlockNode]
    /// Details start collapsed by default (PLAN §4.5).
    public var isOpen: Bool

    public init(summary: [InlineNode] = [], blocks: [MarkdownBlockNode] = [], isOpen: Bool = false) {
        self.summary = summary
        self.blocks = blocks
        self.isOpen = isOpen
    }

    public var summaryText: String { summary.plainText }
}

public struct UserNoteModel: Equatable, Sendable {
    public var query: String
    public var targetText: String?
    /// Resolved stable block ID of the paragraph the note refers to. `nil`
    /// when the target quote can no longer be found (PLAN §4.5).
    public var anchorBlockID: String?
    public var blocks: [MarkdownBlockNode]

    public init(
        query: String,
        targetText: String? = nil,
        anchorBlockID: String? = nil,
        blocks: [MarkdownBlockNode] = []
    ) {
        self.query = query
        self.targetText = targetText
        self.anchorBlockID = anchorBlockID
        self.blocks = blocks
    }

    public var targetPreview: String? {
        guard let targetText, !targetText.isEmpty else { return nil }
        let flattened = targetText
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return flattened.count > 160 ? String(flattened.prefix(157)) + "…" : flattened
    }
}

public struct HTMLFallbackModel: Equatable, Sendable {
    public var rawHTML: String
    public var text: String
    public var warning: String

    public init(rawHTML: String, text: String, warning: String) {
        self.rawHTML = rawHTML
        self.text = text
        self.warning = warning
    }
}

/// One top-level block plus its deterministic anchor ID.
public struct MarkdownBlockNode: Equatable, Sendable, Identifiable {
    public var id: String
    public var block: MarkdownBlock

    public init(id: String, block: MarkdownBlock) {
        self.id = id
        self.block = block
    }

    public var plainText: String {
        switch block {
        case let .heading(_, inlines), let .paragraph(inlines):
            return inlines.plainText
        case let .codeBlock(code):
            return code.code
        case let .blockquote(children):
            return children.map(\.plainText).joined(separator: "\n")
        case let .list(list):
            return list.items.map { item in
                ([item.plainText] + item.blocks.map(\.plainText)).joined(separator: "\n")
            }.joined(separator: "\n")
        case let .table(table):
            var lines: [String] = []
            if !table.header.isEmpty {
                lines.append(table.header.map(\.plainText).joined(separator: " "))
            }
            lines.append(contentsOf: table.rows.map { $0.map(\.plainText).joined(separator: " ") })
            return lines.joined(separator: "\n")
        case let .image(image):
            return image.caption ?? image.spec.alt
        case let .mathBlock(expression):
            return expression.tex
        case let .callout(callout):
            return callout.blocks.map(\.plainText).joined(separator: "\n")
        case let .details(details):
            return ([details.summaryText] + details.blocks.map(\.plainText)).joined(separator: "\n")
        case let .userNote(note):
            return ([note.query, note.targetText ?? ""] + note.blocks.map(\.plainText))
                .joined(separator: "\n")
        case .thematicBreak:
            return ""
        case let .fallback(fallback):
            return fallback.text
        }
    }
}

public indirect enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, inlines: [InlineNode])
    case paragraph([InlineNode])
    case codeBlock(CodeBlockModel)
    case blockquote([MarkdownBlockNode])
    case list(ListModel)
    case table(TableModel)
    case image(ImageModel)
    case mathBlock(MathExpression)
    case callout(CalloutModel)
    case details(DetailsModel)
    case userNote(UserNoteModel)
    case thematicBreak
    case fallback(HTMLFallbackModel)
}

// MARK: - Document

public struct MarkdownDocument: Equatable, Sendable {
    public var blocks: [MarkdownBlockNode]
    public var warnings: [String]
    public var frontmatter: FrontmatterDocument?
    public var hadFrontmatter: Bool

    public init(
        blocks: [MarkdownBlockNode] = [],
        warnings: [String] = [],
        frontmatter: FrontmatterDocument? = nil,
        hadFrontmatter: Bool = false
    ) {
        self.blocks = blocks
        self.warnings = warnings
        self.frontmatter = frontmatter
        self.hadFrontmatter = hadFrontmatter
    }

    public var plainText: String {
        blocks.map(\.plainText).joined(separator: "\n\n")
    }

    public var tables: [TableModel] {
        blocks.compactMap { node in
            if case let .table(table) = node.block { return table }
            return nil
        }
    }

    /// Every block in document order, including blocks nested under
    /// blockquotes, lists, callouts, details, and USERNOTE cards.
    public var allBlockNodes: [MarkdownBlockNode] {
        var output: [MarkdownBlockNode] = []
        func walk(_ nodes: [MarkdownBlockNode]) {
            for node in nodes {
                output.append(node)
                switch node.block {
                case let .blockquote(children):
                    walk(children)
                case let .list(list):
                    for item in list.items { walk(item.blocks) }
                case let .callout(callout):
                    walk(callout.blocks)
                case let .details(details):
                    walk(details.blocks)
                case let .userNote(note):
                    walk(note.blocks)
                default:
                    break
                }
            }
        }
        walk(blocks)
        return output
    }

    public var userNotes: [UserNoteModel] {
        allBlockNodes.compactMap { node in
            if case let .userNote(note) = node.block { return note }
            return nil
        }
    }

    /// Block whose text contains `target`, searched recursively (deepest
    /// match first) so a note inside a callout anchors to the specific
    /// paragraph, matching `injectUserNoteAnchors`. USERNOTE bodies are
    /// skipped so a note never anchors to itself or another note.
    public func blockID(containing target: String) -> String? {
        let needle = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return nil }
        let normalizedNeedle = Self.normalizeWhitespace(needle)
        return Self.findBlockID(in: blocks, needle: normalizedNeedle)
    }

    private static func findBlockID(
        in nodes: [MarkdownBlockNode],
        needle: String
    ) -> String? {
        for node in nodes {
            switch node.block {
            case .userNote:
                continue
            case let .blockquote(children):
                if let found = findBlockID(in: children, needle: needle) { return found }
            case let .list(list):
                for item in list.items {
                    if let found = findBlockID(in: item.blocks, needle: needle) {
                        return found
                    }
                }
            case let .callout(callout):
                if let found = findBlockID(in: callout.blocks, needle: needle) { return found }
            case let .details(details):
                if let found = findBlockID(in: details.blocks, needle: needle) { return found }
            default:
                break
            }
            if normalizeWhitespace(node.plainText).contains(needle) {
                return node.id
            }
        }
        return nil
    }

    private static func normalizeWhitespace(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\r\n", with: "\n")
            .split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" })
            .joined(separator: " ")
    }
}

// MARK: - Stable block identifiers

/// Deterministic anchor IDs. Headings use a slug path + occurrence; other
/// blocks use the current heading section + type + ordinal within the section.
/// FNV-1a is used instead of `Hasher` because Swift's hash seed changes per
/// process, which would break persisted checkpoint anchors.
public enum MarkdownBlockID {
    public struct Assigner {
        private var headingPath: [String] = []
        private var headingSlugCounts: [String: Int] = [:]
        private var sectionCounts: [String: Int] = [:]

        public init() {}

        public mutating func node(for block: MarkdownBlock) -> MarkdownBlockNode {
            let id: String
            switch block {
            case let .heading(level, inlines):
                let slug = MarkdownBlockID.slug(inlines.plainText)
                let base = "h-\(slug.isEmpty ? "section" : slug)"
                let occurrence = (headingSlugCounts[base] ?? 0) + 1
                headingSlugCounts[base] = occurrence
                id = occurrence == 1 ? base : "\(base)-\(occurrence)"
                updateHeadingPath(level: level, slug: slug.isEmpty ? "section" : slug)
            default:
                let type = MarkdownBlockID.typeName(block)
                let section = headingPath.isEmpty ? "root" : headingPath.joined(separator: "/")
                let key = "\(section)/\(type)"
                let occurrence = (sectionCounts[key] ?? 0) + 1
                sectionCounts[key] = occurrence
                id = "b-\(MarkdownBlockID.hash("\(key)-\(occurrence)"))"
            }
            return MarkdownBlockNode(id: id, block: block)
        }

        private mutating func updateHeadingPath(level: Int, slug: String) {
            let depth = max(1, min(level, 6))
            if headingPath.count >= depth {
                headingPath = Array(headingPath.prefix(depth - 1))
            }
            headingPath.append(slug)
        }
    }

    public static func slug(_ text: String) -> String {
        let lowered = text.lowercased()
        var out = ""
        var lastDash = false
        for scalar in lowered.unicodeScalars {
            let isASCIIAlphaNum = (scalar.value >= 97 && scalar.value <= 122)
                || (scalar.value >= 48 && scalar.value <= 57)
            if isASCIIAlphaNum {
                out.unicodeScalars.append(scalar)
                lastDash = false
            } else if !lastDash && !out.isEmpty {
                out.append("-")
                lastDash = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return String(out.prefix(64))
    }

    /// Stable 64-bit FNV-1a hash rendered as 16 hex characters.
    public static func hash(_ value: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(format: "%016llx", hash)
    }

    private static func typeName(_ block: MarkdownBlock) -> String {
        switch block {
        case .heading: return "heading"
        case .paragraph: return "paragraph"
        case .codeBlock: return "code"
        case .blockquote: return "quote"
        case .list: return "list"
        case .table: return "table"
        case .image: return "image"
        case .mathBlock: return "math"
        case .callout: return "callout"
        case .details: return "details"
        case .userNote: return "usernote"
        case .thematicBreak: return "hr"
        case .fallback: return "html"
        }
    }
}
