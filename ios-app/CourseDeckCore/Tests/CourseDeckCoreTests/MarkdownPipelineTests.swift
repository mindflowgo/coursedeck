import Foundation
import XCTest
@testable import CourseDeckCore

final class MarkdownCorpusTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        let url = FixtureCodec.tableCorpusURL.appendingPathComponent(name)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func parseJSONFixture(_ name: String) throws -> MarkdownDocument {
        MarkdownPipeline.parse(try fixture(name))
    }

    private func tables(in document: MarkdownDocument) -> [TableModel] {
        document.blocks.compactMap { node in
            if case let .table(table) = node.block { return table }
            return nil
        }
    }

    private func allTables(in document: MarkdownDocument) -> [TableModel] {
        var output: [TableModel] = []
        func walk(_ blocks: [MarkdownBlockNode]) {
            for node in blocks {
                switch node.block {
                case let .table(table): output.append(table)
                case let .blockquote(children): walk(children)
                case let .callout(callout): walk(callout.blocks)
                case let .details(details): walk(details.blocks)
                case let .userNote(note): walk(note.blocks)
                case let .list(list):
                    for item in list.items { walk(item.blocks) }
                default: break
                }
            }
        }
        walk(document.blocks)
        return output
    }

    // MARK: - Golden corpus

    func testTableCorpusMatchesExpectedModels() throws {
        let files = FixtureCodec.fixtureFiles()
        XCTAssertFalse(files.isEmpty, "table corpus must be checked in")

        let environment = ProcessInfo.processInfo.environment
        let update = environment["COURSEDECK_UPDATE_FIXTURES"] == "1"
        let allowWrite = environment["COURSEDECK_ALLOW_FIXTURE_WRITE"] == "1"
        if update && !allowWrite {
            XCTFail("COURSEDECK_UPDATE_FIXTURES requires COURSEDECK_ALLOW_FIXTURE_WRITE=1")
            return
        }
        for file in files {
            let raw = try String(contentsOf: file, encoding: .utf8)
            let document = MarkdownPipeline.parse(raw)
            XCTAssertFalse(
                document.plainText.contains("%%CD"),
                "placeholder leaked in \(file.lastPathComponent)"
            )
            if update {
                try FixtureCodec.writeExpected(document, for: file)
                continue
            }
            let expected = try FixtureCodec.loadExpected(for: file)
            let actual = FixtureCodec.encode(document)
            XCTAssertEqual(
                actual,
                expected,
                "expected block model drifted for \(file.lastPathComponent)"
            )
        }
    }

    // MARK: - Targeted table cases

    func testNoOuterPipeTwoColumns() throws {
        let document = try parseJSONFixture("07-no-outer-pipe-2.md")
        let tables = self.tables(in: document)
        XCTAssertEqual(tables.count, 1)
        XCTAssertEqual(tables[0].header.map { $0.inlines.plainText }, ["Item", "Amount"])
        XCTAssertEqual(tables[0].rows.map { $0.map { $0.inlines.plainText } }, [["Rent", "1200"], ["Food", "300"]])
    }

    func testNoOuterPipeThreeColumnsRaggedRows() throws {
        let document = try parseJSONFixture("08-no-outer-pipe-3-ragged.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 3)
        XCTAssertEqual(table.rows.count, 3)
        XCTAssertEqual(table.repair?.rowCellCounts, [2, 3, 3])
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["1", "2", ""])
        XCTAssertEqual(table.rows[2].map { $0.inlines.plainText }, ["6", "7", "8"])
    }

    func testNoOuterPipeFiveColumns() throws {
        let document = try parseJSONFixture("09-no-outer-pipe-5.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 5)
        XCTAssertEqual(table.header.map { $0.inlines.plainText }, ["Date", "Account", "P.R.", "Debit", "Credit"])
    }

    func testStackedTablesStaySeparate() throws {
        let document = try parseJSONFixture("01-stacked-journal.md")
        let tables = self.tables(in: document)
        XCTAssertEqual(tables.count, 2)
        XCTAssertEqual(tables[0].header.map { $0.inlines.plainText }, ["General Journal", "Page 3"])
        XCTAssertEqual(
            tables[1].header.map { $0.inlines.plainText },
            ["Date\n20--", "Accounts and Explanation", "P.R.", "Debit", "Credit"]
        )
        XCTAssertEqual(tables[1].rows.count, 2)
        XCTAssertEqual(tables[1].rows[0][2].inlines.plainText, "")
    }

    func testMultilineHeaderAndCells() throws {
        let document = try parseJSONFixture("02-multiline-rubric.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 4)
        XCTAssertEqual(table.header[0].inlines.plainText, "Level 4\n(80 – 100%)")
        XCTAssertEqual(table.header[3].inlines.plainText, "Level 1\n(50 – 59%)")
        XCTAssertTrue(table.rows[0][0].inlines.plainText.contains("designation/\ncertification"))
        XCTAssertEqual(table.repair?.mergedHeaderLineCount, 5)
    }

    func testMultilineHeaderWithFullPipeCountOnLastLine() throws {
        let document = try parseJSONFixture("14-multiline-header.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 3)
        XCTAssertEqual(table.header[0].inlines.plainText, "Concept\nName")
        XCTAssertEqual(table.header[1].inlines.plainText, "Math\nFormula")
        XCTAssertEqual(table.header[2].inlines.plainText, "Notes")
    }

    func testMultilineHeaderWhenLastLineHasFullPipeCount() throws {
        let document = try parseJSONFixture("20-multiline-header-full-pipes.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 3)
        XCTAssertEqual(table.header[0].inlines.plainText, "Concept\nName")
        XCTAssertEqual(table.header[1].inlines.plainText, "Formula")
        XCTAssertEqual(table.header[2].inlines.plainText, "Notes")
        XCTAssertEqual(table.repair?.mergedHeaderLineCount, 2)
    }

    func testInlineCodeDoesNotTerminateAMultilineRow() throws {
        let document = try parseJSONFixture("21-inline-code-multiline-row.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 2)
        XCTAssertEqual(table.rows.count, 1)
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["code\ncontinued text", "result"])
        guard case let .code(code) = table.rows[0][0].inlines.first else {
            return XCTFail("expected inline code in the multiline cell")
        }
        XCTAssertEqual(code, "code")
    }

    func testRepairProtectsCodeFencesWhenCalledDirectly() {
        let fence = "```markdown\n| Not | A | Real | Table |\n| --- | --- | --- | --- |\n```"
        XCTAssertEqual(MarkdownTableRepair.repair(fence).markdown, fence)
        let tilde = "~~~\n| Not | A | Table |\n| --- | --- | --- |\n~~~"
        XCTAssertEqual(MarkdownTableRepair.repair(tilde).markdown, tilde)
        let pre = "<pre>| Not | A | Table |\n| --- | --- | --- |</pre>"
        XCTAssertEqual(MarkdownTableRepair.repair(pre).markdown, pre)
    }

    func testSurplusCellsArePreserved() throws {
        let document = try parseJSONFixture("15-surplus-cells.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 3)
        XCTAssertEqual(table.repair?.surplusCellCount, 1)
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["1", "2", "3"])
        XCTAssertEqual(table.rows[1].map { $0.inlines.plainText }, ["4", "5", ""])
        XCTAssertEqual(table.header.map { $0.inlines.plainText }, ["A", "B", ""])
    }

    func testHeaderlessPipeTextDoesNotBecomeATable() {
        let document = MarkdownPipeline.parse("A | B\nC | D\n")
        XCTAssertTrue(document.tables.isEmpty)
        XCTAssertTrue(document.plainText.contains("A | B"))
    }

    func testHeaderOnlyAndSameColumnStackedTables() throws {
        let document = try parseJSONFixture("05-header-only-stacked.md")
        let tables = self.tables(in: document)
        XCTAssertEqual(tables.count, 3)
        XCTAssertTrue(tables[0].headerOnly)
        XCTAssertEqual(tables[1].rows.count, 1)
        XCTAssertEqual(tables[2].rows.count, 1)
    }

    func testEscapedPipesRemainCellContent() throws {
        let document = try parseJSONFixture("03-escaped-pipes.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 2)
        XCTAssertEqual(table.header.map { $0.inlines.plainText }, ["Header | one", "Header | two"])
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["a | b", "c | d"])
    }

    func testCurrencyStaysLiteralInCells() throws {
        let document = try parseJSONFixture("10-currency.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.rows[0][1].inlines.plainText, "$1,500")
        XCTAssertEqual(table.rows[1][1].inlines.plainText, "$45,000")
        for row in table.rows {
            for cell in row {
                XCTAssertFalse(cell.inlines.contains { if case .math = $0 { return true } else { return false } })
            }
        }
        XCTAssertEqual(table.columnAlignments, [.none, .right, .right])
    }

    func testMathPipesInCells() throws {
        let document = try parseJSONFixture("11-math-in-cells.md")
        let tables = self.tables(in: document)
        let first = tables[0]
        XCTAssertEqual(first.rows.map { $0[1].inlines.plainText }, ["|x|", "5x", "2^3 = 8"])
        for row in first.rows {
            guard case let .math(expression) = row[1].inlines.first else {
                return XCTFail("expected math cell, got \(row[1].inlines)")
            }
            XCTAssertFalse(expression.tex.isEmpty)
        }
        let second = tables[1]
        XCTAssertEqual(second.rows[0][0].inlines.plainText, "$1,500")
        guard case let .math(expression) = second.rows[0][1].inlines.first else {
            return XCTFail("expected math in the second table")
        }
        XCTAssertEqual(expression.tex, "x")
    }

    func testCellInlineASTCoversRichContent() throws {
        let input = """
        | Rich |
        | --- |
        | **bold** *italic* ~~strike~~ `code` [link](https://example.com) $x^2$ ![alt](assets/img/i.png)<br>next |
        """
        let document = MarkdownPipeline.parse(input)
        let table = try XCTUnwrap(tables(in: document).first)
        let inlines = table.rows[0][0].inlines
        XCTAssertTrue(inlines.contains { if case .strong = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .emphasis = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .strikethrough = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .code(let value) = $0 { return value == "code" } else { return false } })
        XCTAssertTrue(inlines.contains { if case .link(let destination, _, _) = $0 { return destination == "https://example.com" } else { return false } })
        XCTAssertTrue(inlines.contains { if case .math(let expression) = $0 { return expression.tex == "x^2" } else { return false } })
        XCTAssertTrue(inlines.contains { if case .image(let spec, _, _) = $0 { return spec.alt == "alt" } else { return false } })
        XCTAssertTrue(inlines.contains { if case .lineBreak = $0 { return true } else { return false } })
    }

    func testImagePipeIsCellContent() throws {
        let document = try parseJSONFixture("12-image-pipe-in-cell.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 2)
        XCTAssertEqual(table.rows.count, 2)
        guard case let .image(spec, destination, _) = table.rows[0][0].inlines.first else {
            return XCTFail("expected image cell")
        }
        XCTAssertEqual(spec.alt, "Diagram")
        XCTAssertEqual(spec.width?.value, 50)
        XCTAssertEqual(spec.width?.unit, .percent)
        XCTAssertEqual(destination, "assets/img/diagram.png")

        guard case let .image(spec2, _, _) = table.rows[1][0].inlines.first else {
            return XCTFail("expected second image cell")
        }
        XCTAssertEqual(spec2.width?.value, 300)
        XCTAssertEqual(spec2.height?.value, 200)
    }

    func testCodeFormsAreProtectedFromTableRepair() throws {
        let document = try parseJSONFixture("13-code-forms.md")
        let codeBlocks = document.blocks.compactMap { node -> CodeBlockModel? in
            if case let .codeBlock(code) = node.block { return code }
            return nil
        }
        XCTAssertEqual(codeBlocks.count, 3)
        XCTAssertEqual(codeBlocks[0].language, "swift")
        XCTAssertTrue(codeBlocks[0].code.contains("| not | a | table |"))
        XCTAssertTrue(codeBlocks[1].code.contains("indented code | pipe"))
        XCTAssertTrue(codeBlocks[2].code.contains("| pre | table |"))

        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 2)
        XCTAssertEqual(table.rows.count, 1)
        guard case let .code(inline) = table.rows[0][1].inlines.first else {
            return XCTFail("expected inline code in the table cell")
        }
        XCTAssertEqual(inline, "inline | code")
    }

    func testCRLFInputParsesAsTable() throws {
        let document = try parseJSONFixture("18-crlf.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.header.map { $0.inlines.plainText }, ["Name", "Value"])
        XCTAssertEqual(table.rows.count, 2)
        XCTAssertFalse(document.plainText.contains("\r"))
    }

    func testGeneratedNoOuterPipeTableWithMath() throws {
        let document = try parseJSONFixture("16-generated-no-outer.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.columnCount, 4)
        XCTAssertEqual(table.rows.count, 3)
        guard case let .math(first) = table.rows[0][2].inlines.first else {
            return XCTFail("expected math")
        }
        XCTAssertEqual(first.tex, "x^2")
    }

    func testBlockquotedAndIndentedTables() throws {
        let document = try parseJSONFixture("04-blockquote-indented.md")
        var blockquoted: TableModel?
        for node in document.blocks {
            if case let .blockquote(children) = node.block {
                blockquoted = children.compactMap { child -> TableModel? in
                    if case let .table(table) = child.block { return table }
                    return nil
                }.first
            }
        }
        let quoted = try XCTUnwrap(blockquoted)
        XCTAssertEqual(quoted.header.map { $0.inlines.plainText }, ["Criterion", "Weight"])
        XCTAssertEqual(quoted.rows.map { $0.map { $0.inlines.plainText } }, [["Accuracy", "50%"], ["Clarity", "50%"]])

        let tables = self.tables(in: document)
        XCTAssertEqual(tables.count, 1)
        XCTAssertEqual(tables[0].header.map { $0.inlines.plainText }, ["Indented", "Table"])
    }

    func testRawHTMLTableWithSpans() throws {
        let document = try parseJSONFixture("17-raw-html-table.md")
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertTrue(table.isHTML)
        XCTAssertEqual(table.header.map { $0.inlines.plainText }, ["Name", "Amount"])
        XCTAssertEqual(table.columnAlignments, [.left, .right])
        XCTAssertEqual(table.rows.count, 2)
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["Cash", "$1,500"])
        XCTAssertEqual(table.rows[1].count, 1)
        XCTAssertEqual(table.rows[1][0].colSpan, 2)
        XCTAssertEqual(table.rows[1][0].inlines.plainText, "Total assets")
    }

    func test500RowLedgerPreservesEveryRow() throws {
        let raw = try fixture("19-500-row-ledger.md")
        let start = Date()
        let document = MarkdownPipeline.parse(raw)
        let elapsed = Date().timeIntervalSince(start)
        let table = try XCTUnwrap(tables(in: document).first)
        XCTAssertEqual(table.rows.count, 500)
        XCTAssertEqual(table.columnCount, 5)
        XCTAssertEqual(table.rows[0].map { $0.inlines.plainText }, ["Row 1", "Account 1", "1", "3", "2"])
        XCTAssertEqual(table.rows[499].map { $0.inlines.plainText }, ["Row 500", "Account 500", "0", "1500", "1000"])
        XCTAssertLessThan(elapsed, 10.0, "500-row ledger parse took \(elapsed)s")
    }
}

final class MarkdownMathTests: XCTestCase {
    func testCurrencyAndMathHeuristics() {
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("x^2"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("\\frac{1}{2}"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("x_1"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("x"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("a + b = c"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("30^\\circ"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("2^3 = 8"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("5 \\times 10^3"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("5x"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("2n"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("a, k, d, c"))
        XCTAssertTrue(InlineMathHeuristic.isLikelyInlineMath("|x|"))

        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("1500 and then "))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("20 plus 40 per hour"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("45,000"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("1,500"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("cash and assets"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("5k"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("2m"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("3b"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("5,000"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("1,500.50"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("5000 and rising"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("5+"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("5, 10, 15"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("speed"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("a / b"))
        XCTAssertFalse(InlineMathHeuristic.isLikelyInlineMath("1/2"))
    }

    func testAllFiveDelimitersExtract() {
        let input = """
        Inline $x^2$ and display $$\\frac{a}{b}$$ with \\(y_1\\) and \\[z^3\\].
        Parenthesized (\\frac{P(x)}{Q(x)}) and (Q(x)\\neq0).
        """
        let extraction = MarkdownMathExtractor.extract(from: input)
        XCTAssertEqual(extraction.tokens.count, 6)
        XCTAssertTrue(extraction.tokens.contains { $0.display && $0.math == "\\frac{a}{b}" })
        XCTAssertTrue(extraction.tokens.contains { $0.display && $0.math == "z^3" })
        XCTAssertTrue(extraction.tokens.contains { $0.math == "x^2" })
        XCTAssertTrue(extraction.tokens.contains { $0.math == "y_1" })
        XCTAssertTrue(extraction.tokens.contains { $0.math == "\\frac{P(x)}{Q(x)}" })
        XCTAssertTrue(extraction.tokens.contains { $0.math == "Q(x)\\neq0" })
    }

    func testCurrencyIsNeverPairedAcrossTableCells() {
        let input = "| $1,500 | $2,000 |\n| $1,500 | $x$ |\n|$1,500|$x$|"
        let extraction = MarkdownMathExtractor.extract(from: input)
        XCTAssertEqual(extraction.tokens.count, 2)
        XCTAssertTrue(extraction.tokens.allSatisfy { $0.math == "x" })
        XCTAssertTrue(extraction.markdown.contains("$1,500"))
        XCTAssertTrue(extraction.markdown.contains("$2,000"))
    }

    func testCodeIsNeverMath() {
        let input = "Use `const $price = 100;` or:\n```\nconst $total = $price * 2;\n```"
        let extraction = MarkdownMathExtractor.extract(from: input)
        XCTAssertTrue(extraction.tokens.isEmpty)
        XCTAssertTrue(extraction.markdown.contains("const $price = 100;"))
    }

    func testImageAndLinkURLsAreNotParenthesizedMath() throws {
        let document = MarkdownPipeline.parse(
            "![A person|25%](./assets/img/clu3m_01.02.200.jpg)\n\nSee [guide](https://example.com/a_b/intro)."
        )
        let imageNode = document.blocks.compactMap { node -> ImageModel? in
            if case let .image(image) = node.block { return image }
            return nil
        }.first
        XCTAssertNotNil(imageNode)
        XCTAssertEqual(imageNode?.destination, "assets/img/clu3m_01.02.200.jpg")
        XCTAssertEqual(imageNode?.spec.width?.value, 25)

        var linkedDestination: String?
        func walk(_ node: InlineNode) {
            switch node {
            case let .link(destination, _, children):
                linkedDestination = destination
                children.forEach(walk)
            case let .emphasis(children), let .strong(children), let .strikethrough(children),
                 let .superscript(children), let .subscripting(children),
                 let .highlight(children), let .keyboard(children), let .span(children):
                children.forEach(walk)
            default: break
            }
        }
        for block in document.blocks {
            if case let .paragraph(inlines) = block.block { inlines.forEach(walk) }
        }
        XCTAssertEqual(linkedDestination, "https://example.com/a_b/intro")
    }

    func testMathPipesWithoutSpacesInCells() throws {
        let document = MarkdownPipeline.parse("|A|B|\n|---|---|\n|$|x|$|$5x$|\n|$1,500|$2,000|")
        let table = try XCTUnwrap(document.tables.first)
        XCTAssertEqual(table.columnCount, 2)
        XCTAssertEqual(table.rows.count, 2)
        guard case let .math(first) = table.rows[0][0].inlines.first else {
            return XCTFail("expected absolute-value math")
        }
        XCTAssertEqual(first.tex, "|x|")
        guard case let .math(second) = table.rows[0][1].inlines.first else {
            return XCTFail("expected coefficient math")
        }
        XCTAssertEqual(second.tex, "5x")
        XCTAssertEqual(table.rows[1][0].inlines.plainText, "$1,500")
        XCTAssertEqual(table.rows[1][1].inlines.plainText, "$2,000")
    }

    func testDisplayAndInlineMathReachTheBlockModel() throws {
        let document = MarkdownPipeline.parse("Inline $x^2$ then\n\n$$\\int_0^1 x dx$$\n")
        var sawInline = false
        var sawDisplayBlock = false
        for node in document.blocks {
            if case let .mathBlock(expression) = node.block {
                sawDisplayBlock = true
                XCTAssertTrue(expression.display)
                XCTAssertEqual(expression.tex, "\\int_0^1 x dx")
            }
            if case let .paragraph(inlines) = node.block {
                for inline in inlines {
                    if case let .math(expression) = inline {
                        sawInline = true
                        XCTAssertEqual(expression.tex, "x^2")
                    }
                }
            }
        }
        XCTAssertTrue(sawInline)
        XCTAssertTrue(sawDisplayBlock)
    }
}

final class MarkdownImageSpecTests: XCTestCase {
    func testPlainAltText() {
        let spec = ImageSpecParser.parse("A simple illustration")
        XCTAssertEqual(spec.alt, "A simple illustration")
        XCTAssertNil(spec.rawSpec)
        XCTAssertNil(spec.width)
        XCTAssertFalse(spec.isCustom)
    }

    func testEmptySpecAfterPipe() {
        let spec = ImageSpecParser.parse("Image alt|")
        XCTAssertEqual(spec.alt, "Image alt")
        XCTAssertEqual(spec.rawSpec, "")
        XCTAssertFalse(spec.isCustom)
    }

    func testNamedPresets() {
        let cases: [(String, String, Double)] = [
            ("Diagram|xs", "160px", 160),
            ("Diagram|thumb", "160px", 160),
            ("Diagram|sm", "280px", 280),
            ("Diagram|small", "280px", 280),
            ("Diagram|md", "480px", 480),
            ("Diagram|medium", "480px", 480),
            ("Diagram|lg", "720px", 720),
            ("Diagram|large", "720px", 720),
        ]
        for (input, expectedCSS, expectedValue) in cases {
            let spec = ImageSpecParser.parse(input)
            XCTAssertEqual(spec.alt, "Diagram")
            XCTAssertTrue(spec.isCustom)
            XCTAssertEqual(spec.width?.cssValue, expectedCSS)
            XCTAssertEqual(spec.width?.value, expectedValue)
            XCTAssertNil(spec.height)
        }
        let full = ImageSpecParser.parse("Diagram|full")
        XCTAssertEqual(full.namedSize, .full)
        XCTAssertEqual(full.width?.cssValue, "100%")
        XCTAssertEqual(full.width?.fraction, 1)
        let xl = ImageSpecParser.parse("Diagram|xl")
        XCTAssertEqual(xl.namedSize, .xl)
    }

    func testDimensionPairsAndUnits() {
        let pair = ImageSpecParser.parse("Chart|300x200")
        XCTAssertEqual(pair.width?.value, 300)
        XCTAssertEqual(pair.height?.value, 200)

        let mixed = ImageSpecParser.parse("Banner|50%x300px")
        XCTAssertEqual(mixed.width?.cssValue, "50%")
        XCTAssertEqual(mixed.height?.cssValue, "300px")

        let rem = ImageSpecParser.parse("Icon|10remx5rem")
        XCTAssertEqual(rem.width?.cssValue, "10rem")
        XCTAssertEqual(rem.height?.cssValue, "5rem")
    }

    func testKeyValueAndStandaloneDimensions() {
        let keyed = ImageSpecParser.parse("Graph|width=50% height=150")
        XCTAssertEqual(keyed.width?.cssValue, "50%")
        XCTAssertEqual(keyed.height?.cssValue, "150px")

        let shorthand = ImageSpecParser.parse("Graph|w=400 h=200px")
        XCTAssertEqual(shorthand.width?.cssValue, "400px")
        XCTAssertEqual(shorthand.height?.cssValue, "200px")

        let percent = ImageSpecParser.parse("Illustration|50%")
        XCTAssertEqual(percent.width?.cssValue, "50%")
        XCTAssertNil(percent.height)

        let number = ImageSpecParser.parse("Illustration|450")
        XCTAssertEqual(number.width?.cssValue, "450px")
    }

    func testLastPipeWins() {
        let spec = ImageSpecParser.parse("Diagram|with|pipe|50%")
        XCTAssertEqual(spec.alt, "Diagram|with|pipe")
        XCTAssertEqual(spec.width?.cssValue, "50%")
    }

    func testIconDetectionAndCaps() {
        XCTAssertTrue(ImageSpecParser.isIcon(destination: "/assets/icons/arrow.svg", alt: "arrow", isCustom: false))
        XCTAssertTrue(ImageSpecParser.isIcon(destination: "/icons/folder.png", alt: "folder", isCustom: false))
        XCTAssertTrue(ImageSpecParser.isIcon(destination: "/content/symbol.svg", alt: "symbol", isCustom: false))
        XCTAssertFalse(ImageSpecParser.isIcon(destination: "/content/img/diagram.svg", alt: "symbol", isCustom: false))
        XCTAssertTrue(ImageSpecParser.isIcon(destination: "/assets/img/badge.png", alt: "Unit 1 badge", isCustom: false))
        XCTAssertFalse(ImageSpecParser.isIcon(destination: "/assets/img/photo.png", alt: "A family photo", isCustom: false))
        XCTAssertEqual(ImageSpecParser.defaultMaxHeight, 480)
        XCTAssertEqual(ImageSpecParser.iconMaxHeight, 32)
    }

    func testPandocAttributesBecomePipeSpecs() throws {
        let document = MarkdownPipeline.parse("![Diagram](assets/img/d.png){width=300px}")
        let image = try XCTUnwrap(document.blocks.compactMap { node -> ImageModel? in
            if case let .image(image) = node.block { return image }
            return nil
        }.first)
        XCTAssertEqual(image.spec.alt, "Diagram")
        XCTAssertEqual(image.spec.rawSpec, "width=300px")
        XCTAssertEqual(image.spec.width?.value, 300)
    }

    func testAssetRewriteUsesLocalFileURLs() throws {
        let courseDirectory = URL(fileURLWithPath: "/tmp/coursedeck/mcr3u", isDirectory: true)
        let document = MarkdownPipeline.parse(
            "![Diagram|50%](./assets/img/diagram.png)\n\n[Notes](assets/locker_docs/notes.pdf)",
            options: MarkdownPipelineOptions(courseDirectoryURL: courseDirectory, courseID: "mcr3u")
        )
        let image = try XCTUnwrap(document.blocks.compactMap { node -> ImageModel? in
            if case let .image(image) = node.block { return image }
            return nil
        }.first)
        XCTAssertEqual(image.destination, "file:///tmp/coursedeck/mcr3u/assets/img/diagram.png")
        var linkDestination: String?
        func walk(_ node: InlineNode) {
            switch node {
            case let .link(destination, _, children):
                linkDestination = destination
                children.forEach(walk)
            case let .emphasis(children), let .strong(children), let .strikethrough(children),
                 let .superscript(children), let .subscripting(children),
                 let .highlight(children), let .keyboard(children), let .span(children):
                children.forEach(walk)
            default: break
            }
        }
        for block in document.blocks {
            if case let .paragraph(inlines) = block.block { inlines.forEach(walk) }
        }
        XCTAssertEqual(
            linkDestination,
            "file:///tmp/coursedeck/mcr3u/assets/locker_docs/notes.pdf"
        )
    }
}

final class MarkdownCalloutTests: XCTestCase {
    func testAllCalloutKindsAndTitle() throws {
        let input = """
        > [!NOTE]
        > Note body.

        > [!TIP] Custom title
        > Tip body.

        > [!IMPORTANT]
        > Important body.

        > [!WARNING]
        > Warning body.

        > [!CAUTION]
        > Caution body.
        """
        let document = MarkdownPipeline.parse(input)
        let callouts = document.blocks.compactMap { node -> CalloutModel? in
            if case let .callout(callout) = node.block { return callout }
            return nil
        }
        XCTAssertEqual(callouts.count, 5)
        XCTAssertEqual(callouts.map(\.kind), [.note, .tip, .important, .warning, .caution])
        XCTAssertEqual(callouts[1].title, "Custom title")
        XCTAssertEqual(callouts[1].displayLabel, "Custom title")
        XCTAssertEqual(callouts[0].displayLabel, "NOTE")
    }

    func testCalloutBodyRunsFullPipelineRecursively() throws {
        let input = """
        > [!NOTE]
        > Intro paragraph.
        >
        > | A | B |
        > | --- | --- |
        > | 1 | 2 |
        >
        > Math $x^2$ and `code`.
        >
        > > [!TIP]
        > > Nested tip.
        """
        let document = MarkdownPipeline.parse(input)
        let callout = try XCTUnwrap(document.blocks.compactMap { node -> CalloutModel? in
            if case let .callout(callout) = node.block { return callout }
            return nil
        }.first)
        XCTAssertEqual(callout.kind, .note)
        let tables = callout.blocks.compactMap { node -> TableModel? in
            if case let .table(table) = node.block { return table }
            return nil
        }
        XCTAssertEqual(tables.count, 1)
        XCTAssertEqual(tables[0].rows[0].map { $0.inlines.plainText }, ["1", "2"])
        let nested = callout.blocks.compactMap { node -> CalloutModel? in
            if case let .callout(callout) = node.block { return callout }
            return nil
        }
        XCTAssertEqual(nested.first?.kind, .tip)
        XCTAssertTrue(document.plainText.contains("x^2"))
    }

    func testDetailsExtraction() throws {
        let input = """
        <details class="suggested-answer">
        <summary>Suggested Answer</summary>
        <p>Because **revenue** increased.</p>
        <ul><li>First</li><li>Second</li></ul>
        </details>
        """
        let document = MarkdownPipeline.parse(input)
        let details = try XCTUnwrap(document.blocks.compactMap { node -> DetailsModel? in
            if case let .details(details) = node.block { return details }
            return nil
        }.first)
        XCTAssertEqual(details.summaryText, "Suggested Answer")
        XCTAssertFalse(details.isOpen)
        XCTAssertTrue(details.blocks.contains { node in
            if case let .paragraph(inlines) = node.block {
                return inlines.contains { if case .strong = $0 { return true } else { return false } }
            }
            return false
        })
        XCTAssertTrue(details.blocks.contains { node in
            if case .list = node.block { return true }
            return false
        })
    }

    func testUsernoteTargetAndAnchor() throws {
        let input = """
        The selected quote is here.

        > [!USERNOTE] Why does this matter?
        > <!-- target: "selected quote" -->
        > Because **it does**.
        """
        let document = MarkdownPipeline.parse(input)
        let note = try XCTUnwrap(document.userNotes.first)
        XCTAssertEqual(note.query, "Why does this matter?")
        XCTAssertEqual(note.targetText, "selected quote")
        XCTAssertNotNil(note.anchorBlockID)
        XCTAssertEqual(note.targetPreview, "selected quote")
        XCTAssertTrue(note.blocks.contains { node in
            if case let .paragraph(inlines) = node.block {
                return inlines.contains { if case .strong = $0 { return true } else { return false } }
            }
            return false
        })
    }

    func testUsernoteBodySharesMathAndCodeTokens() throws {
        let input = """
        > [!USERNOTE] Why?
        > <!-- target: "does not matter" -->
        > Formula $x^2$ and `code | pipe`.
        """
        let document = MarkdownPipeline.parse(input)
        let note = try XCTUnwrap(document.userNotes.first)
        let paragraph = try XCTUnwrap(note.blocks.compactMap { node -> [InlineNode]? in
            if case let .paragraph(inlines) = node.block { return inlines }
            return nil
        }.first)
        XCTAssertTrue(paragraph.contains { if case .math(let math) = $0 { return math.tex == "x^2" } else { return false } })
        XCTAssertTrue(paragraph.contains { if case .code(let code) = $0 { return code == "code | pipe" } else { return false } })
    }

    func testUsernoteWithMissingTargetHasNoAnchor() throws {
        let input = """
        Some paragraph.

        > [!USERNOTE] Query
        > <!-- target: "not present anywhere" -->
        > Body.
        """
        let document = MarkdownPipeline.parse(input)
        let note = try XCTUnwrap(document.userNotes.first)
        XCTAssertNil(note.anchorBlockID)
        XCTAssertEqual(note.targetText, "not present anywhere")
    }

    func testUsernoteWithEscapedQuotesInTarget() throws {
        let input = """
        > [!USERNOTE] Query
        > <!-- target: "he said \\"hello\\"" -->
        > Body.
        """
        let document = MarkdownPipeline.parse(input)
        let note = try XCTUnwrap(document.userNotes.first)
        XCTAssertEqual(note.targetText, "he said \"hello\"")
    }
}

final class MarkdownInlineAndBlockTests: XCTestCase {
    func testInlineASTCoversRichContent() throws {
        let input = """
        **Bold** *italic* ~~strike~~ `code` [link](https://example.com) $x^2$
        H<sub>2</sub>O and x<sup>2</sup> plus <mark>mark</mark> <kbd>Cmd</kbd> <span>span</span>
        """
        let document = MarkdownPipeline.parse(input)
        let inlines = try XCTUnwrap(document.blocks.compactMap { node -> [InlineNode]? in
            if case let .paragraph(inlines) = node.block { return inlines }
            return nil
        }.first)

        XCTAssertTrue(inlines.contains { if case .strong = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .emphasis = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .strikethrough = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .code(let value) = $0 { return value == "code" } else { return false } })
        XCTAssertTrue(inlines.contains { if case .link(let destination, _, _) = $0 { return destination == "https://example.com" } else { return false } })
        XCTAssertTrue(inlines.contains { if case .math(let expression) = $0 { return expression.tex == "x^2" } else { return false } })
        XCTAssertTrue(inlines.contains { if case .subscripting = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .superscript = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .highlight = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .keyboard = $0 { return true } else { return false } })
        XCTAssertTrue(inlines.contains { if case .span = $0 { return true } else { return false } })
    }

    func testListsAndTaskCheckboxes() throws {
        let input = """
        - [x] Done
        - [ ] Todo
          - Nested

        1. First
        2. Second
        """
        let document = MarkdownPipeline.parse(input)
        let lists = document.blocks.compactMap { node -> ListModel? in
            if case let .list(list) = node.block { return list }
            return nil
        }
        XCTAssertEqual(lists.count, 2)
        XCTAssertEqual(lists[0].items.count, 2)
        XCTAssertEqual(lists[0].items[0].checked, true)
        XCTAssertEqual(lists[0].items[1].checked, false)
        XCTAssertFalse(lists[0].items[1].blocks.isEmpty)
        XCTAssertEqual(lists[1].ordered, true)
        XCTAssertEqual(lists[1].start, 1)
        XCTAssertEqual(lists[1].items.map { $0.inlines.plainText }, ["First", "Second"])
    }

    func testTableTSVIncludesHeaderAndInlineContent() throws {
        let document = MarkdownPipeline.parse(
            "| Name | Formula |\n| --- | --- |\n| Root | $x^2$ |\n| Code | `y` |"
        )
        let table = try XCTUnwrap(document.tables.first)
        XCTAssertEqual(table.tsv(), "Name\tFormula\nRoot\tx^2\nCode\ty")
        XCTAssertEqual(table.tsv(includeHeader: false), "Root\tx^2\nCode\ty")
    }

    func testRemoteImageAndCaption() throws {
        let document = MarkdownPipeline.parse("![A diagram of the water cycle](https://example.com/diagram.png)")
        let image = try XCTUnwrap(document.blocks.compactMap { node -> ImageModel? in
            if case let .image(image) = node.block { return image }
            return nil
        }.first)
        XCTAssertTrue(image.isRemote)
        XCTAssertEqual(image.caption, "A diagram of the water cycle")
        XCTAssertEqual(ImageModel.caption(for: ImageSpecParser.parse("photo.png")), nil)
    }

    func testHTMLTableRowspanIsPreserved() throws {
        let html = """
        <table><tr><th>A</th><th>B</th></tr>
        <tr><td rowspan="2">Span</td><td>one</td></tr>
        <tr><td>two</td></tr></table>
        """
        let document = MarkdownPipeline.parse(html)
        let table = try XCTUnwrap(document.tables.first)
        XCTAssertEqual(table.rows[0][0].rowSpan, 2)
        XCTAssertEqual(table.rows[0][1].plainText, "one")
        XCTAssertEqual(table.rows[1][0].plainText, "two")
    }

    func testBlockquotedFenceIsProtected() throws {
        let input = "> ```js\n> let x = 1 | 2\n> ```\n"
        let document = MarkdownPipeline.parse(input)
        let quote = try XCTUnwrap(document.blocks.compactMap { node -> [MarkdownBlockNode]? in
            if case let .blockquote(children) = node.block { return children }
            return nil
        }.first)
        let code = try XCTUnwrap(quote.compactMap { node -> CodeBlockModel? in
            if case let .codeBlock(code) = node.block { return code }
            return nil
        }.first)
        XCTAssertEqual(code.language, "js")
        XCTAssertEqual(code.code, "let x = 1 | 2")
    }

    func testHeadingsBlockquotesCodeAndThematicBreak() throws {
        let input = """
        # Title

        > Quote

        ```swift
        let x = 1
        ```

        ---
        """
        let document = MarkdownPipeline.parse(input)
        guard case let .heading(level, inlines) = document.blocks[0].block else {
            return XCTFail("expected heading")
        }
        XCTAssertEqual(level, 1)
        XCTAssertEqual(inlines.plainText, "Title")
        XCTAssertTrue(document.blocks.contains { if case .blockquote = $0.block { return true } else { return false } })
        XCTAssertTrue(document.blocks.contains { if case .codeBlock = $0.block { return true } else { return false } })
        XCTAssertTrue(document.blocks.contains { if case .thematicBreak = $0.block { return true } else { return false } })
    }

    func testFrontmatterIsStrippedButPreservedOnDocument() throws {
        let input = """
        ---
        title: Lesson
        customKey: keep-me
        ---

        # Body
        """
        let document = MarkdownPipeline.parse(input)
        XCTAssertTrue(document.hadFrontmatter)
        XCTAssertEqual(document.frontmatter?.value(forKey: "customKey")?.stringValue, "keep-me")
        XCTAssertFalse(document.plainText.contains("customKey"))
        XCTAssertEqual(document.blocks.count, 1)
    }

    func testMalformedFrontmatterWarnsAndStillParsesBody() throws {
        let input = """
        ---
        title: [unclosed
        ---

        Body paragraph.
        """
        let document = MarkdownPipeline.parse(input)
        XCTAssertTrue(document.hadFrontmatter)
        XCTAssertTrue(document.warnings.contains("malformedFrontmatter"))
        XCTAssertTrue(document.plainText.contains("Body paragraph."))
    }

    func testStableBlockIDsAcrossReparsesAndSmallEdits() {
        let input = """
        # Section

        First paragraph with math $x^2$.

        | A | B |
        | --- | --- |
        | 1 | 2 |

        ## Subsection

        Second paragraph.
        """
        let first = MarkdownPipeline.parse(input)
        let second = MarkdownPipeline.parse(input)
        XCTAssertEqual(first.blocks.map(\.id), second.blocks.map(\.id))
        XCTAssertEqual(Set(first.blocks.map(\.id)).count, first.blocks.count)
        XCTAssertEqual(first.blocks[0].id, "h-section")
        XCTAssertEqual(first.blocks[3].id, "h-subsection")

        let edited = MarkdownPipeline.parse(input.replacingOccurrences(of: "First paragraph", with: "Edited paragraph"))
        XCTAssertEqual(first.blocks.map(\.id), edited.blocks.map(\.id), "IDs should survive small paragraph edits")
    }

    func testUnsupportedHTMLIsDroppedOrFlattened() throws {
        let input = """
        <script>alert("x")</script>
        <div class="callout callout-warning"><p>Raw callout.</p></div>
        <iframe src="https://example.com/embed"></iframe>
        """
        let document = MarkdownPipeline.parse(input)
        XCTAssertFalse(document.plainText.contains("alert("))
        XCTAssertTrue(document.blocks.contains { node in
            if case let .callout(callout) = node.block {
                return callout.kind == .warning
            }
            return false
        })
        XCTAssertTrue(document.blocks.contains { node in
            if case let .fallback(fallback) = node.block {
                return fallback.text.contains("example.com/embed")
            }
            return false
        })
        XCTAssertFalse(document.plainText.contains("<iframe"))
    }

    func testDangerousLinksAreNotLinked() {
        let document = MarkdownPipeline.parse("<a href=\"javascript:alert(1)\">Click</a>")
        var foundDangerous = false
        func walk(_ node: InlineNode) {
            switch node {
            case let .link(destination, _, children):
                if destination.lowercased().hasPrefix("javascript:") { foundDangerous = true }
                children.forEach(walk)
            default: break
            }
        }
        for block in document.blocks {
            if case let .paragraph(inlines) = block.block { inlines.forEach(walk) }
        }
        XCTAssertFalse(foundDangerous)
        XCTAssertTrue(document.plainText.contains("Click"))
    }
}

final class MarkdownMathMLTests: XCTestCase {
    private func mathMLFixture(_ name: String) throws -> String {
        let url = FixtureCodec.fixturesURL
            .appendingPathComponent("MathML", isDirectory: true)
            .appendingPathComponent(name)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testUnitConversions() {
        let frac = MathMLConverter.convert(
            #"<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>"#
        )
        XCTAssertTrue(frac.tex.contains("\\frac{1}{2}"))

        let root = MathMLConverter.convert(
            #"<math><msqrt><mi>x</mi><mo>+</mo><mn>1</mn></msqrt></math>"#
        )
        XCTAssertTrue(root.tex.contains("\\sqrt{"))

        let power = MathMLConverter.convert(
            #"<math><msup><mi>x</mi><mn>2</mn></msup></math>"#
        )
        XCTAssertTrue(power.tex.contains("^{2}"))

        let sub = MathMLConverter.convert(
            #"<math><msub><mi>a</mi><mi>n</mi></msub></math>"#
        )
        XCTAssertTrue(sub.tex.contains("_{n}"))

        let fenced = MathMLConverter.convert(
            #"<math><mfenced open="(" close=")"><mi>x</mi></mfenced></math>"#
        )
        XCTAssertTrue(fenced.tex.contains("\\left("))
        XCTAssertTrue(fenced.tex.contains("\\right)"))

        let table = MathMLConverter.convert(
            #"<math><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr></mtable></math>"#
        )
        XCTAssertTrue(table.tex.contains("\\begin{matrix}"))
        XCTAssertTrue(table.tex.contains("1 & 2"))

        let display = MathMLConverter.convert(
            #"<math display="block"><mi>x</mi></math>"#
        )
        XCTAssertTrue(display.display)
    }

    func testUnsupportedElementPreservesText() {
        let conversion = MathMLConverter.convert(
            #"<math><munknown><mi>keep</mi><mn>42</mn></munknown></math>"#
        )
        XCTAssertTrue(conversion.tex.contains("keep"))
        XCTAssertTrue(conversion.tex.contains("42"))
        XCTAssertTrue(conversion.flattenedText.contains("keep"))
    }

    /// PLAN §4.2/§4.7: MCR3U 01.03/01.06/04.09 are the live MathML fixtures.
    func testLiveMathMLFixturesNeverLoseText() throws {
        let fixtures: [(String, Int)] = [
            ("mcr3u_01.03.lesson.md", 37),
            ("mcr3u_01.06.lesson.md", 136),
            ("mcr3u_04.09.lesson.md", 37),
        ]
        for (name, expectedMathTags) in fixtures {
            let raw = try mathMLFixture(name)
            let matches = mathTags(in: raw)
            XCTAssertEqual(matches.count, expectedMathTags, "\(name) math tag count")

            var fracCount = 0
            var sqrtCount = 0
            var powerCount = 0
            for xml in matches {
                let conversion = MathMLConverter.convert(xml)
                XCTAssertFalse(conversion.tex.isEmpty, "empty conversion in \(name)")

                let sourceTokens = alphanumericTokens(in: MathMLXMLParser.decodeEntities(stripTags(xml)))
                for token in sourceTokens {
                    XCTAssertTrue(
                        conversion.tex.contains(token),
                        "\(name): token '\(token)' was lost converting \(xml.prefix(80))"
                    )
                }
                if xml.contains("<mfrac") {
                    fracCount += 1
                    XCTAssertTrue(conversion.tex.contains("\\frac"), "mfrac must render as \\frac")
                }
                if xml.contains("<msqrt") {
                    sqrtCount += 1
                    XCTAssertTrue(conversion.tex.contains("\\sqrt"), "msqrt must render as \\sqrt")
                }
                if xml.contains("<msup") {
                    powerCount += 1
                    XCTAssertTrue(conversion.tex.contains("^{"), "msup must render as a superscript")
                }
                if xml.contains("<mi>x</mi>") && xml.contains("<mn>2</mn>") && xml.contains("<msup") {
                    XCTAssertTrue(conversion.tex.contains("x"))
                }
            }
            if name != "mcr3u_01.06.lesson.md" {
                XCTAssertGreaterThan(fracCount, 0, "\(name) must exercise mfrac")
            }
            if name == "mcr3u_01.03.lesson.md" {
                XCTAssertGreaterThan(sqrtCount, 0, "01.03 must exercise msqrt")
            }
            XCTAssertGreaterThan(powerCount, 0, "\(name) must exercise msup")
        }
    }

    func testPipelineKeepsEveryMathMLExpression() throws {
        for name in ["mcr3u_01.03.lesson.md", "mcr3u_04.09.lesson.md"] {
            let raw = try mathMLFixture(name)
            let document = MarkdownPipeline.parse(raw)
            let mathCount = countMath(in: document)
            XCTAssertGreaterThanOrEqual(
                mathCount,
                mathTags(in: raw).count,
                "\(name): every MathML expression must become a math node"
            )
            XCTAssertFalse(document.plainText.contains("<math"), "\(name): MathML must not leak as text")
            XCTAssertTrue(document.blocks.contains { node in
                if case let .table(table) = node.block { return !table.rows.isEmpty }
                return false
            }, "\(name): at least one raw HTML table should parse")
        }
    }

    // MARK: - Helpers

    private func mathTags(in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(
            pattern: #"(?is)<math\b[^>]*>[\s\S]*?</math>"#
        ) else { return [] }
        let nsRange = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.matches(in: text, options: [], range: nsRange).compactMap { match in
            Range(match.range, in: text).map { String(text[$0]) }
        }
    }

    private func stripTags(_ xml: String) -> String {
        xml.replacingOccurrences(of: #"<[^>]+>"#, with: " ", options: .regularExpression)
    }

    private func alphanumericTokens(in text: String) -> [String] {
        text.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
            .filter { $0.count <= 24 }
    }

    private func countMath(in document: MarkdownDocument) -> Int {
        var count = 0
        func walk(inlines: [InlineNode]) {
            for inline in inlines {
                switch inline {
                case .math: count += 1
                case let .emphasis(children), let .strong(children), let .strikethrough(children),
                     let .superscript(children), let .subscripting(children),
                     let .highlight(children), let .keyboard(children), let .span(children):
                    walk(inlines: children)
                case let .link(_, _, children):
                    walk(inlines: children)
                default: break
                }
            }
        }
        func walk(_ blocks: [MarkdownBlockNode]) {
            for node in blocks {
                switch node.block {
                case let .heading(_, inlines), let .paragraph(inlines):
                    walk(inlines: inlines)
                case let .blockquote(children): walk(children)
                case let .list(list):
                    for item in list.items { walk(inlines: item.inlines); walk(item.blocks) }
                case let .table(table):
                    for cell in table.header { walk(inlines: cell.inlines) }
                    for row in table.rows { for cell in row { walk(inlines: cell.inlines) } }
                case let .mathBlock: count += 1
                case let .callout(callout): walk(callout.blocks)
                case let .details(details): walk(details.blocks)
                case let .userNote(note): walk(note.blocks)
                default: break
                }
            }
        }
        walk(document.blocks)
        return count
    }
}

final class MarkdownLiveFixtureTests: XCTestCase {
    func testBAF3MRubricFixtureParsesWithoutDataLoss() throws {
        let url = FixtureCodec.fixturesURL
            .appendingPathComponent("Live", isDirectory: true)
            .appendingPathComponent("baf3m_01.06.lesson.md")
        let raw = try String(contentsOf: url, encoding: .utf8)
        let document = MarkdownPipeline.parse(raw)
        XCTAssertFalse(document.blocks.isEmpty)
        var tables: [TableModel] = []
        for node in document.blocks {
            if case let .table(table) = node.block { tables.append(table) }
        }
        XCTAssertFalse(tables.isEmpty)
        // Every rubric "Level 4" header must have kept its descriptor and the
        // following level line (PLAN §4.3 multiline header gate).
        let rubricTables = tables.filter { table in
            table.header.contains { cell in
                cell.inlines.plainText.contains("Level 4")
                    && cell.inlines.plainText.contains("(80")
            }
        }
        XCTAssertGreaterThanOrEqual(rubricTables.count, 4)
        for table in rubricTables {
            XCTAssertEqual(table.columnCount, 4)
        }
        let firstRubric = try XCTUnwrap(rubricTables.first)
        XCTAssertEqual(firstRubric.repair?.headerCellCount, 4)
        XCTAssertEqual(firstRubric.repair?.rowCellCounts.first, 4)
        XCTAssertEqual(firstRubric.repair?.mergedHeaderLineCount, 5)
        XCTAssertEqual(
            firstRubric.header.map { $0.inlines.plainText },
            [
                "Level 4\n(80 – 100%)",
                "Level 3\n(70 - 79%)",
                "Level 2\n(60 – 69%)",
                "Level 1\n(50 – 59%)",
            ]
        )
        XCTAssertEqual(
            firstRubric.rows[0][0].inlines.plainText,
            "Student demonstrates thorough understanding of the education and designation/\n"
                + "certification required in accounting and types of business ownership"
        )
        XCTAssertEqual(
            firstRubric.rows[0][3].inlines.plainText,
            "Student demonstrates limited understanding of the education and designation/\n"
                + "certification required in accounting and types of business ownership"
        )
        XCTAssertGreaterThan(document.plainText.count, 5_000)
    }

    func testMalformedStackedHTMLInLessonDoesNotCrash() throws {
        let url = FixtureCodec.fixturesURL
            .appendingPathComponent("MathML", isDirectory: true)
            .appendingPathComponent("mcr3u_01.06.lesson.md")
        let raw = try String(contentsOf: url, encoding: .utf8)
        let start = Date()
        let document = MarkdownPipeline.parse(raw)
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertLessThan(elapsed, 15.0, "99 KB MathML lesson parse took \(elapsed)s")
        XCTAssertGreaterThan(document.blocks.count, 10)
        XCTAssertLessThanOrEqual(document.warnings.filter { $0 == "malformedFrontmatter" }.count, 1)
    }
}
