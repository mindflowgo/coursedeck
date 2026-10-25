import CourseDeckCore
import Foundation

/// One or more consecutive prose-able blocks rendered into a single selectable
/// TextKit 2 text view.
struct ProseRun: Equatable {
    enum Segment: Equatable {
        case heading(level: Int, inlines: [InlineNode], quote: Bool)
        case paragraph(inlines: [InlineNode], quote: Bool)
        case list(ListModel, quote: Bool)
    }

    var segments: [Segment]
    /// One block ID per segment, used for checkpoint anchors and USERNOTE
    /// target jumps.
    var segmentIDs: [String]
    var blockIDs: [String]
}

enum ReaderRowKind: Equatable {
    case prose(ProseRun)
    case taskList(ListModel)
    case table(TableModel)
    case image(ImageModel)
    case mathBlock(MathExpression)
    case code(CodeBlockModel)
    case callout(CalloutModel)
    case details(DetailsModel)
    case userNote(UserNoteModel)
    case quote([MarkdownBlockNode])
    case list(ListModel)
    case separator
    case fallback(HTMLFallbackModel)
}

struct ReaderRow: Equatable, Identifiable {
    var id: String
    var blockIDs: [String]
    var kind: ReaderRowKind
    /// Block IDs whose `<details>` container is open. Nested details can be
    /// toggled without losing the parent row's state.
    var expandedBlockIDs: Set<String>

    init(
        id: String,
        blockIDs: [String],
        kind: ReaderRowKind,
        expandedBlockIDs: Set<String> = []
    ) {
        self.id = id
        self.blockIDs = blockIDs
        self.kind = kind
        self.expandedBlockIDs = expandedBlockIDs
    }

    var isExpanded: Bool { !expandedBlockIDs.isEmpty }

    var estimatedHeight: CGFloat {
        switch kind {
        case .prose: return 120
        case .taskList: return 120
        case .table: return 320
        case .image: return 220
        case .mathBlock: return 96
        case .code: return 150
        case .callout: return 160
        case .details: return isExpanded ? 200 : 58
        case .userNote: return 190
        case .quote: return 160
        case .list: return 160
        case .separator: return 24
        case .fallback: return 90
        }
    }
}

/// Groups top-level blocks into reader rows.
///
/// Headings, paragraphs, simple lists/quotes are accumulated into one prose
/// run so selection spans paragraphs. Task lists get a native checkbox row,
/// and a mixed blockquote/list (one containing code or a table) becomes a
/// container instead of being flattened.
enum ReaderRowPlanner {
    /// Prose runs are capped so a 99 KB lesson does not become one giant
    /// measured text view. The cap is measured in UTF-8 bytes of plain text.
    static let proseChunkByteLimit = 32 * 1024

    static func plan(document: MarkdownDocument) -> [ReaderRow] {
        var rows: [ReaderRow] = []
        var run: ProseRun?
        var runBytes = 0

        func flush() {
            guard let current = run, !current.segments.isEmpty else { return }
            rows.append(
                ReaderRow(
                    id: "prose-\(rows.count)-\(current.blockIDs.first ?? UUID().uuidString)",
                    blockIDs: current.blockIDs,
                    kind: .prose(current)
                )
            )
            run = nil
            runBytes = 0
        }

        func appendSegment(_ segment: ProseRun.Segment, ids: [String]) {
            let bytes = proseLength(segment)
            if runBytes > 0,
               runBytes >= Self.proseChunkByteLimit
                   || runBytes + bytes > Self.proseChunkByteLimit {
                flush()
            }
            append(segment, ids: ids, to: &run)
            runBytes += bytes
        }

        func appendParagraph(_ inlines: [InlineNode], quote: Bool, ids: [String]) {
            for chunk in Self.splitInlines(inlines, limit: Self.proseChunkByteLimit) {
                appendSegment(.paragraph(inlines: chunk, quote: quote), ids: ids)
            }
        }

        func appendList(_ list: ListModel, quote: Bool, ids: [String]) {
            for chunk in Self.splitList(list, limit: Self.proseChunkByteLimit) {
                appendSegment(.list(chunk, quote: quote), ids: ids)
            }
        }

        for node in document.blocks {
            switch node.block {
            case let .heading(level, inlines):
                appendSegment(.heading(level: level, inlines: inlines, quote: false), ids: [node.id])
            case let .paragraph(inlines):
                appendParagraph(inlines, quote: false, ids: [node.id])
            case let .list(list):
                if list.items.contains(where: { $0.checked != nil }) {
                    if hasRichNestedTaskContent(list) {
                        flush()
                        rows.append(
                            ReaderRow(
                                id: node.id,
                                blockIDs: [node.id] + collectIDs(node.block),
                                kind: .list(list)
                            )
                        )
                    } else {
                        flush()
                        rows.append(
                            ReaderRow(
                                id: node.id,
                                blockIDs: [node.id] + collectIDs(node.block),
                                kind: .taskList(list)
                            )
                        )
                    }
                } else if canRenderAsProse(node.block) {
                    appendList(list, quote: false, ids: [node.id] + collectIDs(node.block))
                } else {
                    flush()
                    rows.append(
                        ReaderRow(
                            id: node.id,
                            blockIDs: [node.id] + collectIDs(node.block),
                            kind: .list(list)
                        )
                    )
                }
            case let .blockquote(children):
                if children.allSatisfy({ canRenderAsProse($0.block) }) {
                    for child in children {
                        switch child.block {
                        case let .heading(level, inlines):
                            appendSegment(.heading(level: level, inlines: inlines, quote: true), ids: [child.id] + collectIDs(child.block))
                        case let .paragraph(inlines):
                            appendParagraph(inlines, quote: true, ids: [child.id] + collectIDs(child.block))
                        case let .list(list):
                            appendList(list, quote: true, ids: [child.id] + collectIDs(child.block))
                        default:
                            break
                        }
                    }
                } else {
                    flush()
                    rows.append(
                        ReaderRow(
                            id: node.id,
                            blockIDs: [node.id] + collectIDs(node.block),
                            kind: .quote(children)
                        )
                    )
                }
            case let .table(table):
                flush()
                rows.append(ReaderRow(id: node.id, blockIDs: [node.id], kind: .table(table)))
            case let .image(image):
                flush()
                rows.append(ReaderRow(id: node.id, blockIDs: [node.id], kind: .image(image)))
            case let .mathBlock(expression):
                flush()
                rows.append(ReaderRow(id: node.id, blockIDs: [node.id], kind: .mathBlock(expression)))
            case let .codeBlock(code):
                flush()
                rows.append(ReaderRow(id: node.id, blockIDs: [node.id], kind: .code(code)))
            case let .callout(callout):
                flush()
                rows.append(
                    ReaderRow(
                        id: node.id,
                        blockIDs: [node.id] + collectIDs(node.block),
                        kind: .callout(callout)
                    )
                )
            case let .details(details):
                flush()
                rows.append(
                    ReaderRow(
                        id: node.id,
                        blockIDs: [node.id] + collectIDs(node.block),
                        kind: .details(details),
                        expandedBlockIDs: details.isOpen ? [node.id] : []
                    )
                )
            case let .userNote(note):
                flush()
                rows.append(
                    ReaderRow(
                        id: node.id,
                        blockIDs: [node.id] + collectIDs(node.block),
                        kind: .userNote(note)
                    )
                )
            case .thematicBreak:
                flush()
                rows.append(ReaderRow(id: node.id, blockIDs: [node.id], kind: .separator))
            case let .fallback(fallback):
                flush()
                rows.append(ReaderRow(id: node.id, blockIDs: [node.id], kind: .fallback(fallback)))
            }
        }
        flush()
        return rows
    }

    private static func append(_ segment: ProseRun.Segment, ids: [String], to run: inout ProseRun?) {
        if run == nil {
            run = ProseRun(segments: [], segmentIDs: [], blockIDs: [])
        }
        guard var current = run else { return }
        current.segments.append(segment)
        if let segmentID = ids.first {
            current.segmentIDs.append(segmentID)
        } else {
            current.segmentIDs.append("")
        }
        for id in ids where !current.blockIDs.contains(id) {
            current.blockIDs.append(id)
        }
        run = current
    }

    private static func proseLength(_ segment: ProseRun.Segment) -> Int {
        switch segment {
        case let .heading(_, inlines, _), let .paragraph(inlines, _):
            return inlines.plainText.utf8.count
        case let .list(list, _):
            return list.items.reduce(0) { total, item in
                total
                    + item.inlines.plainText.utf8.count
                    + item.blocks.map(\.plainText).joined().utf8.count
            }
        }
    }

    /// Split an inline AST at sentence/line boundaries before the 32 KB cap.
    /// A single text node can be far larger than the cap (a generated lesson
    /// paragraph), so text is split into sentence-sized pieces while emphasis,
    /// links, math, and images stay intact.
    static func splitInlines(_ inlines: [InlineNode], limit: Int) -> [[InlineNode]] {
        guard inlines.plainText.utf8.count > limit else { return [inlines] }
        var chunks: [[InlineNode]] = []
        var current: [InlineNode] = []
        var bytes = 0

        func flush() {
            guard !current.isEmpty else { return }
            chunks.append(current)
            current = []
            bytes = 0
        }

        func appendText(_ text: String) {
            guard !text.isEmpty else { return }
            let textBytes = text.utf8.count
            if bytes > 0 && bytes + textBytes > limit {
                flush()
            }
            current.append(.text(text))
            bytes += textBytes
            if bytes >= limit { flush() }
        }

        for node in inlines {
            if case let .text(value) = node {
                for piece in textPieces(value) {
                    if piece.utf8.count > limit {
                        for slice in splitTextByBytes(piece, limit: limit) {
                            appendText(slice)
                        }
                    } else {
                        appendText(piece)
                    }
                }
            } else {
                let nodeBytes = max(node.plainText.utf8.count, 1)
                if bytes > 0 && bytes + nodeBytes > limit {
                    flush()
                }
                current.append(node)
                bytes += nodeBytes
                if bytes >= limit { flush() }
            }
        }
        flush()
        return chunks.isEmpty ? [inlines] : chunks
    }

    /// Split a list at item boundaries. Ordered numbering is preserved across
    /// chunks by advancing `start`.
    static func splitList(_ list: ListModel, limit: Int) -> [ListModel] {
        guard !list.items.isEmpty else { return [list] }
        let total = proseLength(.list(list, quote: false))
        guard total > limit else { return [list] }
        var chunks: [ListModel] = []
        var items: [ListItemModel] = []
        var bytes = 0
        var chunkStart = list.start
        var itemOffset = 0

        func flush() {
            guard !items.isEmpty else { return }
            chunks.append(ListModel(ordered: list.ordered, start: chunkStart, items: items))
            items = []
            bytes = 0
            chunkStart = list.start + itemOffset
        }

        for item in list.items {
            let itemBytes = max(
                item.inlines.plainText.utf8.count + item.blocks.map(\.plainText).joined().utf8.count,
                1
            )
            if !items.isEmpty && bytes + itemBytes > limit {
                flush()
            }
            items.append(item)
            bytes += itemBytes
            itemOffset += 1
        }
        flush()
        return chunks.isEmpty ? [list] : chunks
    }

    private static func textPieces(_ text: String) -> [String] {
        var pieces: [String] = []
        var current = ""
        for character in text {
            current.append(character)
            if character == "." || character == "!" || character == "?" || character == "\n" {
                if !current.isEmpty { pieces.append(current) }
                current = ""
            }
        }
        if !current.isEmpty { pieces.append(current) }
        return pieces.isEmpty ? [text] : pieces
    }

    private static func splitTextByBytes(_ text: String, limit: Int) -> [String] {
        var pieces: [String] = []
        var current = ""
        var bytes = 0
        for character in text {
            let characterBytes = String(character).utf8.count
            if bytes > 0 && bytes + characterBytes > limit {
                pieces.append(current)
                current = ""
                bytes = 0
            }
            current.append(character)
            bytes += characterBytes
        }
        if !current.isEmpty { pieces.append(current) }
        return pieces
    }

    /// Any nested content in a task item is treated as rich: a nested list or
    /// paragraph can contain inline math/images or rich children, which the
    /// flat task row cannot preserve. Route the list through the container so
    /// `prepareNode` rebuilds each nested block.
    static func hasRichNestedTaskContent(_ list: ListModel) -> Bool {
        list.items.contains { item in
            item.checked != nil && !item.blocks.isEmpty
        }
    }

    /// Details block IDs that must be open for `target` to be rendered.
    /// Walks rows/callouts/lists/quotes/detail bodies recursively.
    static func detailsAncestors(of target: String, in rows: [ReaderRow]) -> Set<String> {
        var result = Set<String>()
        for row in rows {
            guard row.blockIDs.contains(target) else { continue }
            switch row.kind {
            case let .details(details):
                if target != row.id {
                    collectDetailsAncestors(in: details.blocks, target: target, into: &result)
                    if row.blockIDs.contains(target) { result.insert(row.id) }
                }
            case let .callout(callout):
                collectDetailsAncestors(in: callout.blocks, target: target, into: &result)
            case let .quote(children):
                collectDetailsAncestors(in: children, target: target, into: &result)
            case let .list(list):
                for item in list.items {
                    collectDetailsAncestors(in: item.blocks, target: target, into: &result)
                }
            case let .userNote(note):
                collectDetailsAncestors(in: note.blocks, target: target, into: &result)
            default:
                break
            }
        }
        return result
    }

    private static func collectDetailsAncestors(
        in nodes: [MarkdownBlockNode],
        target: String,
        into result: inout Set<String>
    ) {
        for node in nodes {
            if node.id == target { return }
            switch node.block {
            case let .details(details):
                var nested = Set<String>()
                collectDetailsAncestors(in: details.blocks, target: target, into: &nested)
                if !nested.isEmpty || details.blocks.contains(where: { $0.id == target }) {
                    result.formUnion(nested)
                    result.insert(node.id)
                    return
                }
            case let .callout(callout):
                var nested = Set<String>()
                collectDetailsAncestors(in: callout.blocks, target: target, into: &nested)
                if !nested.isEmpty || callout.blocks.contains(where: { $0.id == target }) {
                    result.formUnion(nested)
                    return
                }
            case let .blockquote(children):
                var nested = Set<String>()
                collectDetailsAncestors(in: children, target: target, into: &nested)
                if !nested.isEmpty || children.contains(where: { $0.id == target }) {
                    result.formUnion(nested)
                    return
                }
            case let .list(list):
                for item in list.items {
                    var nested = Set<String>()
                    collectDetailsAncestors(in: item.blocks, target: target, into: &nested)
                    if !nested.isEmpty || item.blocks.contains(where: { $0.id == target }) {
                        result.formUnion(nested)
                        return
                    }
                }
            case let .userNote(note):
                var nested = Set<String>()
                collectDetailsAncestors(in: note.blocks, target: target, into: &nested)
                if !nested.isEmpty || note.blocks.contains(where: { $0.id == target }) {
                    result.formUnion(nested)
                    return
                }
            default:
                break
            }
        }
    }

    /// True when the block can be rendered entirely inside a text view without
    /// losing structure. Code, tables, images, math blocks, and nested cards
    /// force a container row instead.
    static func canRenderAsProse(_ block: MarkdownBlock) -> Bool {
        switch block {
        case .heading, .paragraph:
            return true
        case .thematicBreak:
            return false
        case let .list(list):
            return !list.items.contains(where: { $0.checked != nil })
                && list.items.allSatisfy { item in
                    item.blocks.allSatisfy { canRenderAsProse($0.block) }
                }
        case let .blockquote(children):
            return children.allSatisfy { canRenderAsProse($0.block) }
        default:
            return false
        }
    }

    /// Every nested block ID, used for USERNOTE anchor jumps and checkpoint
    /// restore.
    static func collectIDs(_ block: MarkdownBlock, prefix: String? = nil) -> [String] {
        switch block {
        case let .blockquote(children):
            return children.flatMap { [$0.id] + collectIDs($0.block, prefix: prefix) }
        case let .list(list):
            return list.items.flatMap { item in
                item.blocks.flatMap { [$0.id] + collectIDs($0.block, prefix: prefix) }
            }
        case let .callout(callout):
            return callout.blocks.flatMap { [$0.id] + collectIDs($0.block, prefix: prefix) }
        case let .details(details):
            return details.blocks.flatMap { [$0.id] + collectIDs($0.block, prefix: prefix) }
        case let .userNote(note):
            return note.blocks.flatMap { [$0.id] + collectIDs($0.block, prefix: prefix) }
        default:
            return []
        }
    }
}

extension MarkdownBlockNode {
    var allNestedIDs: [String] {
        [id] + ReaderRowPlanner.collectIDs(block)
    }
}
