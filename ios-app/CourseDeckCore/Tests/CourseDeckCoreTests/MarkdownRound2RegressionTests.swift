import Foundation
import XCTest
@testable import CourseDeckCore

private enum Fixtures {
    static var root: URL {
        FixtureCodec.fixturesURL
    }

    static func file(_ name: String) throws -> String {
        try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
    }
}

private func allBlocksRecursively(_ blocks: [MarkdownBlockNode]) -> [MarkdownBlockNode] {
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

private func allUserNotes(_ blocks: [MarkdownBlockNode]) -> [UserNoteModel] {
    allBlocksRecursively(blocks).compactMap { node in
        if case let .userNote(note) = node.block { return note }
        return nil
    }
}

private func allDetails(_ blocks: [MarkdownBlockNode]) -> [DetailsModel] {
    allBlocksRecursively(blocks).compactMap { node in
        if case let .details(details) = node.block { return details }
        return nil
    }
}

private func allTables(_ blocks: [MarkdownBlockNode]) -> [TableModel] {
    allBlocksRecursively(blocks).compactMap { node in
        if case let .table(table) = node.block { return table }
        return nil
    }
}

private func allModelStrings(_ document: MarkdownDocument) -> [String] {
    var strings: [String] = [document.plainText]
    strings.append(contentsOf: document.warnings)

    func inlineStrings(_ inlines: [InlineNode]) {
        for node in inlines {
            switch node {
            case let .text(value), let .code(value):
                strings.append(value)
            case let .emphasis(children), let .strong(children), let .strikethrough(children),
                 let .superscript(children), let .subscripting(children),
                 let .highlight(children), let .keyboard(children), let .span(children):
                inlineStrings(children)
            case let .link(destination, title, children):
                strings.append(destination)
                if let title { strings.append(title) }
                inlineStrings(children)
            case let .image(spec, destination, title):
                strings.append(spec.alt)
                strings.append(spec.rawSpec ?? "")
                strings.append(destination)
                if let title { strings.append(title) }
            case let .math(expression):
                strings.append(expression.tex)
            case .lineBreak:
                break
            }
        }
    }

    func walk(_ nodes: [MarkdownBlockNode]) {
        for node in nodes {
            switch node.block {
            case let .heading(_, inlines), let .paragraph(inlines):
                inlineStrings(inlines)
            case let .codeBlock(code):
                strings.append(code.code)
            case let .blockquote(children):
                walk(children)
            case let .list(list):
                for item in list.items {
                    inlineStrings(item.inlines)
                    walk(item.blocks)
                }
            case let .table(table):
                for cell in table.header { inlineStrings(cell.inlines) }
                for row in table.rows { for cell in row { inlineStrings(cell.inlines) } }
            case let .image(image):
                strings.append(image.spec.alt)
                strings.append(image.spec.rawSpec ?? "")
                strings.append(image.destination)
                if let title = image.title { strings.append(title) }
                if let caption = image.caption { strings.append(caption) }
            case let .mathBlock(expression):
                strings.append(expression.tex)
            case let .callout(callout):
                if let title = callout.title { strings.append(title) }
                walk(callout.blocks)
            case let .details(details):
                inlineStrings(details.summary)
                walk(details.blocks)
            case let .userNote(note):
                strings.append(note.query)
                if let target = note.targetText { strings.append(target) }
                if let anchor = note.anchorBlockID { strings.append(anchor) }
                walk(note.blocks)
            case let .fallback(fallback):
                strings.append(fallback.rawHTML)
                strings.append(fallback.text)
            case .thematicBreak:
                break
            }
        }
    }
    walk(document.blocks)
    return strings
}

private func inlineKinds(_ inlines: [InlineNode]) -> [String] {
    inlines.map { node in
        switch node {
        case .text: return "text"
        case .emphasis: return "emphasis"
        case .strong: return "strong"
        case .strikethrough: return "strikethrough"
        case .code: return "code"
        case .link: return "link"
        case .image: return "image"
        case .math: return "math"
        case .lineBreak: return "lineBreak"
        case .superscript: return "superscript"
        case .subscripting: return "subscripting"
        case .highlight: return "highlight"
        case .keyboard: return "keyboard"
        case .span: return "span"
        }
    }
}

final class MarkdownCodeProtectionRegressionTests: XCTestCase {
    func testFenceImmediatelyAfterParagraph() {
        let document = MarkdownPipeline.parse("Paragraph text.\n```js\nlet x = 1 | 2;\n```\n")
        XCTAssertEqual(document.blocks.count, 2)
        guard case let .paragraph(inlines) = document.blocks[0].block else {
            return XCTFail("expected paragraph")
        }
        XCTAssertEqual(inlines.plainText, "Paragraph text.")
        guard case let .codeBlock(code) = document.blocks[1].block else {
            return XCTFail("expected code block")
        }
        XCTAssertEqual(code.code, "let x = 1 | 2;")
        XCTAssertTrue(code.isFenced)
    }

    func testIndentedCodeFollowedByProseKeepsBlankLine() {
        let document = MarkdownPipeline.parse("    let x = 1 | 2;\n\nAfter the code.\n")
        XCTAssertEqual(document.blocks.count, 2)
        guard case let .codeBlock(code) = document.blocks[0].block else {
            return XCTFail("expected indented code block")
        }
        XCTAssertEqual(code.code, "let x = 1 | 2;")
        XCTAssertFalse(code.isFenced)
        guard case let .paragraph(inlines) = document.blocks[1].block else {
            return XCTFail("expected paragraph after the code")
        }
        XCTAssertEqual(inlines.plainText, "After the code.")
    }

    func testFenceInListKeepsListContext() throws {
        let document = MarkdownPipeline.parse("- Item\n  ```js\n  let x = 1 | 2;\n  ```\n")
        let list = try XCTUnwrap(document.blocks.compactMap { node -> ListModel? in
            if case let .list(list) = node.block { return list }
            return nil
        }.first)
        XCTAssertEqual(list.items.count, 1)
        XCTAssertEqual(list.items[0].inlines.plainText, "Item")
        guard case let .codeBlock(code) = list.items[0].blocks.first?.block else {
            return XCTFail("expected code block nested in the list item")
        }
        XCTAssertEqual(code.language, "js")
        XCTAssertEqual(code.code, "let x = 1 | 2;")
    }

    func testListContainingOnlyAFence() throws {
        let document = MarkdownPipeline.parse("- ```js\n  let x = 1 | 2;\n  ```\n")
        XCTAssertFalse(document.plainText.contains("%%CD"))
        let list = try XCTUnwrap(document.blocks.compactMap { node -> ListModel? in
            if case let .list(list) = node.block { return list }
            return nil
        }.first)
        XCTAssertEqual(list.items.count, 1)
        XCTAssertTrue(list.items[0].inlines.isEmpty)
        guard case let .codeBlock(code) = list.items[0].blocks.first?.block else {
            return XCTFail("expected code block nested in the list item")
        }
        XCTAssertEqual(code.code, "let x = 1 | 2;")
    }

    func testPreInsideHTMLContainer() throws {
        let document = MarkdownPipeline.parse("<div><pre>| a | b |\n| --- | --- |</pre></div>\n")
        let code = try XCTUnwrap(allBlocksRecursively(document.blocks).compactMap { node -> CodeBlockModel? in
            if case let .codeBlock(code) = node.block { return code }
            return nil
        }.first)
        XCTAssertTrue(code.code.contains("| a | b |"))
        XCTAssertTrue(code.code.contains("| --- | --- |"))
        XCTAssertTrue(code.isFenced)
    }

    func testPreMixedWithHTMLTextSplitsIntoCodeBlock() throws {
        let document = MarkdownPipeline.parse(
            "<div>Before <pre>| a | b |\n| --- | --- |</pre> After</div>"
        )
        XCTAssertFalse(document.plainText.contains("%%CD"))
        let code = try XCTUnwrap(allBlocksRecursively(document.blocks).compactMap { node -> CodeBlockModel? in
            if case let .codeBlock(code) = node.block { return code }
            return nil
        }.first)
        XCTAssertTrue(code.code.contains("| a | b |"))
        XCTAssertTrue(document.plainText.contains("Before"))
        XCTAssertTrue(document.plainText.contains("After"))
    }

    func testBlockCodeTokenWithSurroundingTextDoesNotLeak() {
        let document = MarkdownPipeline.parse("Before.\n```\ncode\n```\nAfter.\n")
        XCTAssertFalse(document.plainText.contains("%%CD"))
        XCTAssertEqual(document.blocks.count, 3)
    }
}

final class MarkdownTableRepairRegressionTests: XCTestCase {
    func testConsecutiveRaggedRowsBecomeSeparateRows() throws {
        let raw = try Fixtures.file("TableCorpus/22-consecutive-ragged.md")
        let document = MarkdownPipeline.parse(raw)
        let table = try XCTUnwrap(allTables(document.blocks).first)
        XCTAssertEqual(table.rows.count, 3)
        XCTAssertEqual(table.repair?.rowCellCounts, [2, 2, 3])
        XCTAssertEqual(table.repair?.mergedRowLineCounts, [1, 1, 1])
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["1", "2", ""])
        XCTAssertEqual(table.rows[1].map { $0.inlines.plainText }, ["3", "4", ""])
        XCTAssertEqual(table.rows[2].map { $0.inlines.plainText }, ["5", "6", "7"])
    }

    func testIndentedNoOuterPipeTableSyntaxIsCode() {
        let input = "    A | B\n    --- | ---\n    one | two\n"
        let document = MarkdownPipeline.parse(input)
        XCTAssertTrue(allTables(document.blocks).isEmpty)
        let code = allBlocksRecursively(document.blocks).compactMap { node -> CodeBlockModel? in
            if case let .codeBlock(code) = node.block { return code }
            return nil
        }
        XCTAssertEqual(code.count, 1)
        XCTAssertTrue(code[0].code.contains("A | B"))
        XCTAssertFalse(code[0].isFenced)
    }

    func testIndentedOuterPipeTableStillBecomesATable() throws {
        let raw = try Fixtures.file("TableCorpus/04-blockquote-indented.md")
        let document = MarkdownPipeline.parse(raw)
        let tables = allTables(document.blocks)
        XCTAssertEqual(tables.count, 2)
        XCTAssertEqual(tables[1].header.map { $0.inlines.plainText }, ["Indented", "Table"])
    }

    func testTwoSpaceIndentedTableNestsUnderListWithSibling() throws {
        let raw = try Fixtures.file("TableCorpus/23-table-in-list.md")
        let document = MarkdownPipeline.parse(raw)
        let list = try XCTUnwrap(document.blocks.compactMap { node -> ListModel? in
            if case let .list(list) = node.block { return list }
            return nil
        }.first)
        XCTAssertEqual(list.items.count, 2)
        XCTAssertEqual(list.items[1].inlines.plainText, "Next item")
        guard case let .table(table) = list.items[0].blocks.first?.block else {
            return XCTFail("expected the table to be nested under the list item")
        }
        XCTAssertEqual(table.header.map { $0.inlines.plainText }, ["Date", "Memo"])
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["Mar 1", "Cash"])
        XCTAssertTrue(MarkdownTableRepair.repair(raw).markdown.contains("\n  | Date | Memo |"))
    }

    func testFourSpaceNestedTableStaysUnderList() throws {
        let raw = try Fixtures.file("TableCorpus/27-four-space-table-in-list.md")
        let document = MarkdownPipeline.parse(raw)
        let list = try XCTUnwrap(document.blocks.compactMap { node -> ListModel? in
            if case let .list(list) = node.block { return list }
            return nil
        }.first)
        XCTAssertEqual(list.items.count, 1)
        guard case let .table(table) = list.items[0].blocks.first?.block else {
            return XCTFail("expected a four-space-indented table nested under the list item")
        }
        XCTAssertEqual(table.header.map { $0.inlines.plainText }, ["Date", "Memo"])
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["Mar 1", "Cash"])
        XCTAssertTrue(MarkdownTableRepair.repair(raw).markdown.contains("\n    | Date | Memo |"))
    }

    func testTableFollowedByProseDoesNotSwallowParagraph() throws {
        let raw = try Fixtures.file("TableCorpus/25-table-followed-by-prose.md")
        let document = MarkdownPipeline.parse(raw)
        let table = try XCTUnwrap(allTables(document.blocks).first)
        XCTAssertEqual(table.rows.count, 1)
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["1", "2"])
        let paragraphs = document.blocks.compactMap { node -> [InlineNode]? in
            if case let .paragraph(inlines) = node.block { return inlines }
            return nil
        }
        XCTAssertEqual(paragraphs.map { $0.plainText }, ["Prose after the table."])
    }

    func testTableFollowedByListSiblingStopsAtListMarker() throws {
        let raw = try Fixtures.file("TableCorpus/26-table-followed-by-list.md")
        let document = MarkdownPipeline.parse(raw)
        let table = try XCTUnwrap(allTables(document.blocks).first)
        XCTAssertEqual(table.rows.count, 1)
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["1", "2"])
        let list = try XCTUnwrap(document.blocks.compactMap { node -> ListModel? in
            if case let .list(list) = node.block { return list }
            return nil
        }.first)
        XCTAssertEqual(list.items.map { $0.inlines.plainText }, ["next"])
    }

    func testStandaloneIndentedOuterPipeTableIsCode() throws {
        let raw = try Fixtures.file("TableCorpus/29-indented-code-outer-table.md")
        let document = MarkdownPipeline.parse(raw)
        XCTAssertTrue(allTables(document.blocks).isEmpty)
        let code = try XCTUnwrap(allBlocksRecursively(document.blocks).compactMap { node -> CodeBlockModel? in
            if case let .codeBlock(code) = node.block { return code }
            return nil
        }.first)
        XCTAssertTrue(code.code.contains("| A | B |"))
        XCTAssertTrue(code.code.contains("| --- | --- |"))
        XCTAssertFalse(code.isFenced)
        XCTAssertTrue(document.plainText.contains("Some prose."))
    }

    func testHTMLAttributePipesDoNotSplitCells() throws {
        let raw = try Fixtures.file("TableCorpus/28-html-attribute-pipes.md")
        let document = MarkdownPipeline.parse(raw)
        XCTAssertFalse(document.plainText.contains("%%CD"))
        let table = try XCTUnwrap(allTables(document.blocks).first)
        XCTAssertEqual(table.columnCount, 2)
        XCTAssertEqual(table.rows.count, 1)
        XCTAssertEqual(table.rows[0][0].inlines.plainText, "x")
        XCTAssertEqual(table.rows[0][1].inlines.plainText, "y")
    }

    func testLiveBAF30101TableAndSurroundingProse() throws {
        let document = MarkdownPipeline.parse(try Fixtures.file("Live/baf3m_01.01.lesson.md"))
        let table = try XCTUnwrap(document.tables.first { table in
            table.header.map { $0.inlines.plainText } == ["Items that Clara owns", "Dollar Value"]
        })
        XCTAssertEqual(table.rows.count, 5)
        XCTAssertEqual(
            table.rows.map { $0.map { $0.inlines.plainText } },
            [
                ["Cash", "4,000"],
                ["Investments", "9,000"],
                ["Furniture and equipment", "20,000"],
                ["Car", "25,000"],
                ["Total Assets", "$58,000"],
            ]
        )
        let paragraphs = document.blocks.compactMap { node -> String? in
            if case let .paragraph(inlines) = node.block { return inlines.plainText }
            return nil
        }
        let surrounding = paragraphs.filter {
            $0.contains("First, she lists the items")
                || $0.contains("items owned that have a dollar value")
                || $0.contains("Clara has assets totalling")
        }
        XCTAssertEqual(surrounding.count, 3)
        XCTAssertTrue(paragraphs.contains { $0.contains("First, she lists the items") })
        XCTAssertTrue(paragraphs.contains { $0.contains("items owned that have a dollar value") })
        XCTAssertTrue(paragraphs.contains { $0.contains("Clara has assets totalling") })
    }
}

final class MarkdownPlaceholderRegressionTests: XCTestCase {
    func testCalloutTitleMathIsRestored() throws {
        let document = MarkdownPipeline.parse("> [!NOTE] $x^2$\n> Body.\n")
        let callout = try XCTUnwrap(allBlocksRecursively(document.blocks).compactMap { node -> CalloutModel? in
            if case let .callout(callout) = node.block { return callout }
            return nil
        }.first)
        XCTAssertEqual(callout.title, "x^2")
        XCTAssertFalse(callout.title?.contains("%%CD") ?? false)
    }

    func testUserNoteQueryMathIsRestored() throws {
        let document = MarkdownPipeline.parse(
            "Selected text.\n\n> [!USERNOTE] What is $x^2$?\n> <!-- target: \"Selected text.\" -->\n> Body.\n"
        )
        let note = try XCTUnwrap(allUserNotes(document.blocks).first)
        XCTAssertEqual(note.query, "What is x^2?")
        XCTAssertFalse(note.query.contains("%%CD"))
    }

    func testImageAltAndTitleMathAreRestored() throws {
        let document = MarkdownPipeline.parse(
            "![The value $x^2$|50%](assets/img/a.png \"title $y$\")\n"
        )
        let image = try XCTUnwrap(document.blocks.compactMap { node -> ImageModel? in
            if case let .image(image) = node.block { return image }
            return nil
        }.first)
        XCTAssertEqual(image.spec.alt, "The value x^2")
        XCTAssertEqual(image.title, "title y")
        XCTAssertEqual(image.spec.width?.value, 50)
    }

    func testImageAltTitleAndDestinationWithHTMLTagsHaveNoPlaceholders() throws {
        let document = MarkdownPipeline.parse(
            "![a <b> c](assets/img/x.png \"title <i>t</i>\")\n\n"
                + "![a](assets/img/a<b>.png)"
        )
        XCTAssertTrue(allModelStrings(document).allSatisfy { !$0.contains("%%CD") })
        let images = document.blocks.compactMap { node -> ImageModel? in
            if case let .image(image) = node.block { return image }
            return nil
        }
        XCTAssertEqual(images.count, 2)
        XCTAssertEqual(images[0].spec.alt, "a <b> c")
        XCTAssertEqual(images[0].title, "title <i>t</i>")
        XCTAssertEqual(images[0].destination, "assets/img/x.png")
        XCTAssertEqual(images[1].destination, "assets/img/a<b>.png")
    }

    func testHTMLImageAltAndTitleAreRestored() throws {
        let document = MarkdownPipeline.parse(
            #"<img src="assets/img/a.png" alt="$x^2$" title="`code`">"#
        )
        let image = try XCTUnwrap(allBlocksRecursively(document.blocks).compactMap { node -> ImageModel? in
            if case let .image(image) = node.block { return image }
            return nil
        }.first)
        XCTAssertEqual(image.spec.alt, "x^2")
        XCTAssertEqual(image.title, "code")
        XCTAssertFalse(image.spec.alt.contains("%%CD"))
    }

    func testMathMLInHTMLAltIsRestored() throws {
        let document = MarkdownPipeline.parse(
            #"<img src="assets/img/a.png" alt="<math><mi>x</mi><mo>+</mo><mn>1</mn></math>">"#
        )
        let image = try XCTUnwrap(allBlocksRecursively(document.blocks).compactMap { node -> ImageModel? in
            if case let .image(image) = node.block { return image }
            return nil
        }.first)
        XCTAssertTrue(image.spec.alt.contains("x"))
        XCTAssertTrue(image.spec.alt.contains("1"))
        XCTAssertFalse(image.spec.alt.contains("%%CD"))
        XCTAssertFalse(image.spec.alt.contains("<math"))
    }

    func testNoPlaceholderLeaksInCorpusOrLiveFixtures() throws {
        let corpus = FixtureCodec.fixtureFiles()
        for file in corpus {
            let document = MarkdownPipeline.parse(try String(contentsOf: file, encoding: .utf8))
            for string in allModelStrings(document) {
                XCTAssertFalse(string.contains("%%CD"), "placeholder leaked in \(file.lastPathComponent): \(string)")
            }
        }
        for name in ["Live/baf3m_01.06.lesson.md", "Live/baf3m_01.01.lesson.md", "Live/clu3m_01.05.lesson.md",
                     "MathML/mcr3u_01.03.lesson.md", "MathML/mcr3u_01.06.lesson.md", "MathML/mcr3u_04.09.lesson.md"] {
            let document = MarkdownPipeline.parse(try Fixtures.file(name))
            for string in allModelStrings(document) {
                XCTAssertFalse(string.contains("%%CD"), "placeholder leaked in \(name): \(string)")
            }
        }
    }
}

final class MarkdownDetailsRegressionTests: XCTestCase {
    func testBlockquotedDetailsAreUnquoted() throws {
        let input = """
        > <details class="suggested-answer">
        > <summary>Show Suggested Answer</summary>
        > Because **revenue** increased.
        > </details>
        """
        let document = MarkdownPipeline.parse(input)
        let details = try XCTUnwrap(allDetails(document.blocks).first)
        XCTAssertEqual(details.summaryText, "Show Suggested Answer")
        let text = details.blocks.map(\.plainText).joined(separator: "\n")
        XCTAssertFalse(text.contains(">"))
        XCTAssertTrue(text.contains("Because"))
    }

    func testNestedDetailsKeepInnerContent() throws {
        let input = """
        <details>
        <summary>Outer</summary>
        Before inner.
        <details>
        <summary>Inner</summary>
        Inner body.
        </details>
        After inner.
        </details>
        """
        let document = MarkdownPipeline.parse(input)
        let details = try XCTUnwrap(allDetails(document.blocks).first)
        XCTAssertEqual(details.summaryText, "Outer")
        let text = details.blocks.map(\.plainText).joined(separator: "\n")
        XCTAssertTrue(text.contains("Before inner."))
        XCTAssertTrue(text.contains("Inner body."))
        XCTAssertTrue(text.contains("After inner."))
        let nested = details.blocks.compactMap { node -> DetailsModel? in
            if case let .details(details) = node.block { return details }
            return nil
        }
        XCTAssertEqual(nested.first?.summaryText, "Inner")
    }

    func testLiveBAF3MBlockquotedDetails() throws {
        let document = MarkdownPipeline.parse(try Fixtures.file("Live/baf3m_01.01.lesson.md"))
        let details = allDetails(document.blocks)
        XCTAssertGreaterThanOrEqual(details.count, 6)
        XCTAssertTrue(details.contains { $0.summaryText.contains("Suggested Answer") })
        for detail in details {
            let text = detail.blocks.map(\.plainText).joined(separator: "\n")
            XCTAssertFalse(text.contains("<details"), "nested details must be parsed, not left as HTML")
        }
        XCTAssertFalse(document.plainText.contains("%%CD"))
    }

    func testLiveCLU3MBlockquotedDetails() throws {
        let document = MarkdownPipeline.parse(try Fixtures.file("Live/clu3m_01.05.lesson.md"))
        let details = allDetails(document.blocks)
        XCTAssertGreaterThanOrEqual(details.count, 3)
        XCTAssertTrue(details.contains { $0.summaryText.contains("Suggested Answer") })
        XCTAssertFalse(document.plainText.contains("%%CD"))
    }
}

final class MarkdownSanitizationRegressionTests: XCTestCase {
    private func destinations(in document: MarkdownDocument) -> [String] {
        var output: [String] = []
        func walk(_ nodes: [InlineNode]) {
            for node in nodes {
                switch node {
                case let .link(destination, _, children):
                    output.append(destination)
                    walk(children)
                case let .image(_, destination, _):
                    output.append(destination)
                case let .emphasis(children), let .strong(children), let .strikethrough(children),
                     let .superscript(children), let .subscripting(children),
                     let .highlight(children), let .keyboard(children), let .span(children):
                    walk(children)
                default: break
                }
            }
        }
        for node in allBlocksRecursively(document.blocks) {
            switch node.block {
            case let .paragraph(inlines), let .heading(_, inlines): walk(inlines)
            case let .table(table):
                for cell in table.header { walk(cell.inlines) }
                for row in table.rows { for cell in row { walk(cell.inlines) } }
            default: break
            }
        }
        return output
    }

    func testVBScriptLinksAreRejected() {
        let document = MarkdownPipeline.parse(
            "<a href=\"vbscript:msgbox(1)\">raw</a>\n\n[markdown](vbscript:msgbox(1))\n"
        )
        XCTAssertFalse(destinations(in: document).contains { $0.lowercased().hasPrefix("vbscript:") })
        XCTAssertTrue(document.plainText.contains("raw"))
        XCTAssertTrue(document.plainText.contains("markdown"))
    }

    func testJavascriptImageSourcesAreRejected() {
        let document = MarkdownPipeline.parse(
            "<img src=\"javascript:alert(1)\" alt=\"html\">\n\n![markdown](javascript:alert(2))\n"
        )
        XCTAssertFalse(destinations(in: document).contains { $0.lowercased().hasPrefix("javascript:") })
    }

    func testDataAndJavascriptImageSourcesAreRejected() {
        let document = MarkdownPipeline.parse("![x](data:image/png;base64,AAAA)")
        XCTAssertFalse(destinations(in: document).contains { $0.lowercased().hasPrefix("data:") })
    }

    func testFormContentIsDropped() {
        let document = MarkdownPipeline.parse(
            "<form action=\"/submit\"><label>Secret label</label><input value=\"hidden\"><button>Go</button></form>\n"
        )
        XCTAssertFalse(document.plainText.contains("Secret label"))
        XCTAssertFalse(document.plainText.contains("hidden"))
        XCTAssertFalse(document.plainText.contains("Go"))
    }
}

final class MarkdownNestedAnchorRegressionTests: XCTestCase {
    func testUserNoteInsideCalloutResolvesAnchor() throws {
        let input = """
        The selected quote is here.

        > [!NOTE]
        > Intro.
        > > [!USERNOTE] Why?
        > > <!-- target: "selected quote" -->
        > > Body.
        """
        let document = MarkdownPipeline.parse(input)
        let notes = allUserNotes(document.blocks)
        XCTAssertEqual(notes.count, 1)
        let note = try XCTUnwrap(notes.first)
        XCTAssertEqual(note.targetText, "selected quote")
        XCTAssertNotNil(note.anchorBlockID)
        XCTAssertEqual(note.anchorBlockID, document.blockID(containing: "selected quote"))
    }

    func testBlockIDPrefersDeepestNestedMatch() throws {
        let input = """
        > [!NOTE]
        > The inner target.

        > [!USERNOTE] Query
        > <!-- target: "The inner target." -->
        > Body.
        """
        let document = MarkdownPipeline.parse(input)
        let note = try XCTUnwrap(document.userNotes.first)
        XCTAssertNotNil(note.anchorBlockID)
        XCTAssertEqual(note.anchorBlockID, document.blockID(containing: "The inner target."))
        XCTAssertTrue(note.anchorBlockID?.contains("/") == true, "anchor should target the nested paragraph")
    }

    func testNestedBlockIDsAreGloballyUnique() {
        let input = """
        # Section

        > [!NOTE]
        > Inside callout.
        > > [!USERNOTE] Query
        > > Body.
        """
        let document = MarkdownPipeline.parse(input)
        let ids = allBlocksRecursively(document.blocks).map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "duplicate nested IDs: \(ids)")
    }
}

final class MarkdownAssetContainmentRegressionTests: XCTestCase {
    func testTraversalIsRejected() {
        let course = URL(fileURLWithPath: "/tmp/coursedeck/mcr3u", isDirectory: true)
        let document = MarkdownPipeline.parse(
            "![escape](assets/../../etc/passwd)",
            options: MarkdownPipelineOptions(courseDirectoryURL: course, courseID: "mcr3u")
        )
        for node in document.blocks {
            if case let .image(image) = node.block {
                XCTAssertFalse(image.destination.contains(".."))
                XCTAssertFalse(image.destination.contains("/etc/passwd"))
            }
        }
        XCTAssertFalse(document.plainText.contains("etc/passwd"))
    }

    func testInsideAssetsStillResolves() throws {
        let course = URL(fileURLWithPath: "/tmp/coursedeck/mcr3u", isDirectory: true)
        let document = MarkdownPipeline.parse(
            "![ok](assets/img/ok.png)",
            options: MarkdownPipelineOptions(courseDirectoryURL: course, courseID: "mcr3u")
        )
        let image = try XCTUnwrap(document.blocks.compactMap { node -> ImageModel? in
            if case let .image(image) = node.block { return image }
            return nil
        }.first)
        XCTAssertEqual(image.destination, "file:///tmp/coursedeck/mcr3u/assets/img/ok.png")
    }

    func testDirectFileURLsOutsideAssetsAreRejected() throws {
        let course = URL(fileURLWithPath: "/tmp/coursedeck/mcr3u", isDirectory: true)
        let input = """
        ![markdown image](file:///etc/passwd)

        [markdown link](file:///etc/passwd)

        <img src="file:///etc/passwd" alt="html image">

        <a href="file:///etc/passwd">html link</a>
        """
        for options in [
            MarkdownPipelineOptions(courseDirectoryURL: course, courseID: "mcr3u"),
            MarkdownPipelineOptions(),
        ] {
            let document = MarkdownPipeline.parse(input, options: options)
            for string in allModelStrings(document) {
                XCTAssertFalse(string.contains("file:///etc/passwd"), string)
            }
            for node in allBlocksRecursively(document.blocks) {
                switch node.block {
                case let .image(image):
                    XCTAssertFalse(image.destination.lowercased().hasPrefix("file:"))
                case let .paragraph(inlines):
                    for inline in inlines {
                        if case let .link(destination, _, _) = inline {
                            XCTAssertFalse(destination.lowercased().hasPrefix("file:"))
                        }
                    }
                default:
                    break
                }
            }
        }
    }
}

final class MarkdownCellASTRegressionTests: XCTestCase {
    func testHTMLCellRecursesInlineFormatting() throws {
        let raw = try Fixtures.file("TableCorpus/24-html-cell-inline.md")
        let document = MarkdownPipeline.parse(raw)
        let table = try XCTUnwrap(allTables(document.blocks).first)
        let kinds = inlineKinds(table.rows[0][0].inlines)
        XCTAssertTrue(kinds.contains("strong"))
        XCTAssertTrue(kinds.contains("emphasis"))
        XCTAssertTrue(kinds.contains("code"))
        XCTAssertTrue(kinds.contains("link"))
        XCTAssertTrue(kinds.contains("lineBreak"))
        XCTAssertEqual(table.rows[0][0].inlines.plainText, "bold em code link\nnext")
        XCTAssertEqual(table.rows[0][1].rowSpan, 2)
    }

    func testTSVExpandsColSpanAndRowSpan() throws {
        let raw = try Fixtures.file("TableCorpus/24-html-cell-inline.md")
        let document = MarkdownPipeline.parse(raw)
        let table = try XCTUnwrap(allTables(document.blocks).first)
        let tsv = table.tsv()
        XCTAssertEqual(
            tsv,
            "Formatting\tSpan\nbold em code link next\tspan\nplain\t"
        )
    }

    func testHTMLImageUnsafeSourceDropped() {
        let document = MarkdownPipeline.parse("<img src=\"vbscript:evil\" alt=\"bad\">")
        XCTAssertFalse(allBlocksRecursively(document.blocks).contains { node in
            if case let .image(image) = node.block {
                return image.destination.lowercased().hasPrefix("vbscript:")
            }
            return false
        })
    }
}

final class MarkdownMathMLTagRegressionTests: XCTestCase {
    func testPlanTagsConvert() {
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><mroot><mi>x</mi><mn>3</mn></mroot></math>"#)
                .tex.contains("\\sqrt[3]{x}")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><mover><mi>x</mi><mn>2</mn></mover></math>"#)
                .tex.contains("\\overset{2}{x}")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><munder><mi>x</mi><mi>n</mi></munder></math>"#)
                .tex.contains("\\underset{n}{x}")
        )
        XCTAssertTrue(
            MathMLConverter.convert(
                #"<math><munderover><mi>x</mi><mn>1</mn><mn>2</mn></munderover></math>"#
            ).tex.contains("\\overset{2}{\\underset{1}{x}}")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><mstyle mathvariant="bold"><mi>x</mi></mstyle></math>"#)
                .tex.contains("x")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><mi>a</mi><mspace width="1em"/><mi>b</mi></math>"#)
                .tex.contains("\\,")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><mtext>hello</mtext></math>"#)
                .tex.contains("\\text{hello}")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><ms>literal</ms></math>"#)
                .tex.contains("literal")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><menclose><mi>x</mi></menclose></math>"#)
                .tex.contains("\\boxed{x}")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><mpadded><mi>x</mi></mpadded></math>"#)
                .tex.contains("x")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><mphantom><mi>hidden</mi></mphantom></math>"#)
                .tex.contains("hidden")
        )
        XCTAssertTrue(
            MathMLConverter.convert(#"<math><merror><mtext>oops</mtext></merror></math>"#)
                .tex.contains("oops")
        )
    }
}
