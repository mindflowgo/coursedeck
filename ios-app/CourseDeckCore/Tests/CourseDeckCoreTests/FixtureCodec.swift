import Foundation
import XCTest
@testable import CourseDeckCore

/// Encodes a parsed document into the checked-in "expected block model" JSON
/// used by the Markdown corpus tests. Golden files are authored/reviewed and
/// committed under `Fixtures`.
enum FixtureCodec {
    static var fixturesURL: URL {
        guard let url = Bundle.module.url(forResource: "Fixtures", withExtension: nil) else {
            fatalError("Fixtures directory missing from test bundle")
        }
        return url
    }

    static var tableCorpusURL: URL {
        // The source directory can be supplied when regenerating goldens with
        // COURSEDECK_UPDATE_FIXTURES=1; normal test runs read the bundle copy.
        if let source = ProcessInfo.processInfo.environment["COURSEDECK_FIXTURES_SOURCE"],
           !source.isEmpty {
            return URL(fileURLWithPath: source, isDirectory: true)
                .appendingPathComponent("TableCorpus", isDirectory: true)
        }
        return fixturesURL.appendingPathComponent("TableCorpus", isDirectory: true)
    }

    static func expectedURL(for fixture: URL) -> URL {
        let base = fixture.deletingPathExtension()
        return base.appendingPathExtension("expected.json")
    }

    static func encode(_ document: MarkdownDocument) -> JSONValue {
        object([
            ("blocks", .array(document.blocks.map { encodeNode($0) })),
            ("warnings", .array(document.warnings.map { .string($0) })),
            ("hadFrontmatter", .bool(document.hadFrontmatter)),
        ])
    }

    static func encodeNode(_ node: MarkdownBlockNode) -> JSONValue {
        guard case let .object(members) = encode(node.block) else {
            return encode(node.block)
        }
        return .object([JSONMember(key: "id", value: .string(node.id))] + members)
    }

    static func encode(_ block: MarkdownBlock) -> JSONValue {
        switch block {
        case let .heading(level, inlines):
            return object([
                ("kind", .string("heading")),
                ("level", .number(String(level))),
                ("text", .string(inlines.fixtureText)),
                ("inline", inlineDetails(inlines)),
            ])
        case let .paragraph(inlines):
            return object([
                ("kind", .string("paragraph")),
                ("text", .string(inlines.fixtureText)),
                ("inline", inlineDetails(inlines)),
            ])
        case let .codeBlock(code):
            return object([
                ("kind", .string("code")),
                ("language", code.language.map(JSONValue.string) ?? .null),
                ("text", .string(code.code)),
                ("fenced", .bool(code.isFenced)),
            ])
        case let .blockquote(children):
            return object([
                ("kind", .string("blockquote")),
                ("blocks", .array(children.map { encodeNode($0) })),
            ])
        case let .list(list):
            return object([
                ("kind", .string("list")),
                ("ordered", .bool(list.ordered)),
                ("start", .number(String(list.start))),
                ("items", .array(list.items.map { item in
                    object([
                        ("text", .string(item.inlines.fixtureText)),
                        ("inline", inlineDetails(item.inlines)),
                        ("checked", item.checked.map(JSONValue.bool) ?? .null),
                        ("blocks", .array(item.blocks.map { encodeNode($0) })),
                    ])
                })),
            ])
        case let .table(table):
            var members: [(String, JSONValue)] = [
                ("kind", .string("table")),
                ("columns", .number(String(table.columnCount))),
                ("isHTML", .bool(table.isHTML)),
                ("alignments", .array(table.columnAlignments.map { .string($0.rawValue) })),
                ("header", .array(table.header.map { .string($0.inlines.fixtureText) })),
                ("headerInline", .array(table.header.map { inlineDetails($0.inlines) })),
                ("headerSpans", spans(table.header)),
                ("rows", .array(table.rows.map { row in
                    .array(row.map { .string($0.inlines.fixtureText) })
                })),
                ("rowsInline", .array(table.rows.map { row in
                    .array(row.map { inlineDetails($0.inlines) })
                })),
                ("rowSpans", .array(table.rows.map { spans($0) })),
                ("warnings", .array(table.warnings.map { .string($0) })),
            ]
            if let repair = table.repair {
                members.append(("headerCellCount", .number(String(repair.headerCellCount))))
                members.append(("rowCellCounts", .array(repair.rowCellCounts.map { .number(String($0)) })))
                members.append(("surplusCells", .number(String(repair.surplusCellCount))))
                members.append(("declaredColumns", .number(String(repair.declaredColumns))))
                members.append(("mergedHeaderLines", .number(String(repair.mergedHeaderLineCount))))
                members.append(("mergedRowLines", .array(repair.mergedRowLineCounts.map { .number(String($0)) })))
            }
            return object(members)
        case let .image(image):
            var members: [(String, JSONValue)] = [
                ("kind", .string("image")),
                ("alt", .string(image.spec.alt)),
                ("destination", .string(image.destination)),
                ("title", image.title.map(JSONValue.string) ?? .null),
                ("remote", .bool(image.isRemote)),
                ("caption", image.caption.map(JSONValue.string) ?? .null),
                ("custom", .bool(image.spec.isCustom)),
            ]
            if let width = image.spec.width {
                members.append(("width", .string(width.cssValue)))
            }
            if let height = image.spec.height {
                members.append(("height", .string(height.cssValue)))
            }
            return object(members)
        case let .mathBlock(expression):
            return object([
                ("kind", .string("math")),
                ("tex", .string(expression.tex)),
                ("display", .bool(expression.display)),
                ("isMathML", .bool(expression.isMathML)),
            ])
        case let .callout(callout):
            return object([
                ("kind", .string("callout")),
                ("type", .string(callout.kind.rawValue)),
                ("title", callout.title.map(JSONValue.string) ?? .null),
                ("blocks", .array(callout.blocks.map { encodeNode($0) })),
            ])
        case let .details(details):
            return object([
                ("kind", .string("details")),
                ("summary", .string(details.summary.fixtureText)),
                ("summaryInline", inlineDetails(details.summary)),
                ("open", .bool(details.isOpen)),
                ("blocks", .array(details.blocks.map { encodeNode($0) })),
            ])
        case let .userNote(note):
            return object([
                ("kind", .string("usernote")),
                ("query", .string(note.query)),
                ("target", note.targetText.map(JSONValue.string) ?? .null),
                ("anchor", note.anchorBlockID.map(JSONValue.string) ?? .null),
                ("blocks", .array(note.blocks.map { encodeNode($0) })),
            ])
        case .thematicBreak:
            return object([("kind", .string("thematicBreak"))])
        case let .fallback(fallback):
            return object([
                ("kind", .string("fallback")),
                ("text", .string(fallback.text)),
                ("warning", .string(fallback.warning)),
            ])
        }
    }

    private static func spans(_ cells: [TableCellModel]) -> JSONValue {
        .array(cells.map { cell in
            .array([.number(String(cell.colSpan)), .number(String(cell.rowSpan))])
        })
    }

    private static func inlineDetails(_ inlines: [InlineNode]) -> JSONValue {
        var kinds: [JSONValue] = []
        var math: [JSONValue] = []
        var codes: [JSONValue] = []
        var links: [JSONValue] = []
        var images: [JSONValue] = []
        var lineBreaks = 0
        var htmlStyles: [JSONValue] = []

        func walk(_ nodes: [InlineNode]) {
            for node in nodes {
                switch node {
                case .text:
                    kinds.append(.string("text"))
                case let .emphasis(children):
                    kinds.append(.string("emphasis")); walk(children)
                case let .strong(children):
                    kinds.append(.string("strong")); walk(children)
                case let .strikethrough(children):
                    kinds.append(.string("strikethrough")); walk(children)
                case let .code(value):
                    kinds.append(.string("code")); codes.append(.string(value))
                case let .link(destination, title, children):
                    kinds.append(.string("link"))
                    links.append(
                        object([
                            ("destination", .string(destination)),
                            ("title", title.map(JSONValue.string) ?? .null),
                        ])
                    )
                    walk(children)
                case let .image(spec, destination, title):
                    kinds.append(.string("image"))
                    var imageMembers: [(String, JSONValue)] = [
                        ("alt", .string(spec.alt)),
                        ("destination", .string(destination)),
                        ("title", title.map(JSONValue.string) ?? .null),
                        ("custom", .bool(spec.isCustom)),
                    ]
                    if let width = spec.width {
                        imageMembers.append(("width", .string(width.cssValue)))
                    }
                    if let height = spec.height {
                        imageMembers.append(("height", .string(height.cssValue)))
                    }
                    images.append(object(imageMembers))
                case let .math(expression):
                    kinds.append(.string("math"))
                    math.append(
                        object([
                            ("tex", .string(expression.tex)),
                            ("display", .bool(expression.display)),
                            ("isMathML", .bool(expression.isMathML)),
                        ])
                    )
                case .lineBreak:
                    kinds.append(.string("lineBreak")); lineBreaks += 1
                case let .superscript(children):
                    kinds.append(.string("superscript")); htmlStyles.append(.string("sup")); walk(children)
                case let .subscripting(children):
                    kinds.append(.string("subscripting")); htmlStyles.append(.string("sub")); walk(children)
                case let .highlight(children):
                    kinds.append(.string("highlight")); htmlStyles.append(.string("mark")); walk(children)
                case let .keyboard(children):
                    kinds.append(.string("keyboard")); htmlStyles.append(.string("kbd")); walk(children)
                case let .span(children):
                    kinds.append(.string("span")); htmlStyles.append(.string("span")); walk(children)
                }
            }
        }
        walk(inlines)

        return object([
            ("kinds", .array(kinds)),
            ("math", .array(math)),
            ("codes", .array(codes)),
            ("links", .array(links)),
            ("images", .array(images)),
            ("lineBreaks", .number(String(lineBreaks))),
            ("htmlStyles", .array(htmlStyles)),
        ])
    }

    private static func object(_ pairs: [(String, JSONValue)]) -> JSONValue {
        .object(pairs.map { JSONMember(key: $0.0, value: $0.1) })
    }

    // MARK: - Golden file IO

    static func writeExpected(_ document: MarkdownDocument, for fixture: URL) throws {
        let url = expectedURL(for: fixture)
        let data = Data(encode(document).serialized(pretty: true).utf8)
        try data.write(to: url)
    }

    static func loadExpected(for fixture: URL) throws -> JSONValue {
        let url = expectedURL(for: fixture)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw NSError(
                domain: "FixtureCodec",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Missing expected model: \(url.lastPathComponent)"]
            )
        }
        return try JSONValue(parsing: Data(contentsOf: url))
    }

    static func fixtureFiles() -> [URL] {
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: tableCorpusURL,
            includingPropertiesForKeys: nil
        )) ?? []
        return contents
            .filter { $0.pathExtension == "md" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}

extension Array where Element == InlineNode {
    /// Fixture representation: line breaks become `\n`, math/code contribute
    /// their literal text, and image alt text stands in for the image.
    var fixtureText: String { plainText }
}
