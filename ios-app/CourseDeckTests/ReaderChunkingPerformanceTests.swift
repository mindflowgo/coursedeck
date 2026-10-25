@testable import CourseDeck
import CourseDeckCore
import XCTest

final class ReaderChunkingPerformanceTests: XCTestCase {
    private func fixtureMarkdown() throws -> String {
        let bundle = Bundle(for: Self.self)
        let candidates = [
            bundle.url(forResource: "99kb-lesson", withExtension: "md"),
            bundle.url(forResource: "99kb-lesson", withExtension: "md", subdirectory: "Fixtures"),
        ]
        guard let url = candidates.compactMap({ $0 }).first else {
            throw XCTSkip("99kb fixture not found in test bundle")
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testProseRunsAreChunkedAndFirstViewportIsFast() async throws {
        let markdown = try fixtureMarkdown()
        XCTAssertGreaterThan(markdown.utf8.count, 90_000)
        let parsed = MarkdownPipeline.parse(markdown)
        let rows = ReaderRowPlanner.plan(document: parsed)
        let proseRows = rows.filter { if case .prose = $0.kind { return true }; return false }
        XCTAssertGreaterThan(proseRows.count, 1, "99 KB lesson must be split into multiple prose runs")

        for row in proseRows {
            guard case let .prose(run) = row.kind else { continue }
            let bytes = run.segments.reduce(0) { total, segment in
                switch segment {
                case let .heading(_, inlines, _), let .paragraph(inlines, _):
                    return total + inlines.plainText.utf8.count
                case let .list(list, _):
                    return total + list.items.reduce(0) { $0 + $1.plainText.utf8.count }
                }
            }
            XCTAssertLessThanOrEqual(
                bytes,
                ReaderRowPlanner.proseChunkByteLimit + 2_048,
                "prose chunk exceeded the configured limit"
            )
        }

        let document = try ReaderTestSupport.document(markdown: markdown)
        let preparer = ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 1_024,
            document: document,
            allowRemoteImages: false
        )
        let started = Date()
        var measuredHeight: CGFloat = 0
        var measuredRows = 0
        for row in rows {
            let block = await preparer.prepare(row: row)
            measuredHeight += block.height
            measuredRows += 1
            if measuredHeight >= 900 { break }
        }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertGreaterThan(measuredRows, 0)
        XCTAssertGreaterThanOrEqual(measuredHeight, 900)
        XCTAssertLessThan(elapsed, 0.75, "first viewport measurement took \(elapsed)s")
    }

    func testOversizeParagraphSplitsAtSentenceBoundaries() async throws {
        let paragraph = String(repeating: "This sentence exists to exercise safe splitting. ", count: 1_100)
        XCTAssertGreaterThan(paragraph.utf8.count, ReaderRowPlanner.proseChunkByteLimit)
        let markdown = "# Giant paragraph\n\n\(paragraph)\n"
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(markdown)
        let rows = ReaderRowPlanner.plan(document: parsed)
        let proseRows = rows.filter { if case .prose = $0.kind { return true }; return false }
        XCTAssertGreaterThan(proseRows.count, 1)

        let preparer = ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 1_024,
            document: document,
            allowRemoteImages: false
        )
        for row in proseRows {
            guard case let .prose(run) = row.kind else { continue }
            let bytes = run.segments.reduce(0) { total, segment in
                switch segment {
                case let .heading(_, inlines, _), let .paragraph(inlines, _):
                    return total + inlines.plainText.utf8.count
                case let .list(list, _):
                    return total + list.items.reduce(0) { $0 + $1.plainText.utf8.count }
                }
            }
            XCTAssertLessThanOrEqual(bytes, ReaderRowPlanner.proseChunkByteLimit + 2_048)
            let block = await preparer.prepare(row: row)
            XCTAssertGreaterThan(block.height, 0)
        }
    }

    func testThousandItemListSplitsAtItemBoundaries() async throws {
        var markdown = "# Long list\n\n"
        for index in 0..<1_000 {
            markdown += "- Item \(index) with enough text to cross the chunk boundary safely.\n"
        }
        let document = try ReaderTestSupport.document(markdown: markdown)
        let parsed = MarkdownPipeline.parse(markdown)
        let rows = ReaderRowPlanner.plan(document: parsed)
        let proseRows = rows.filter { if case .prose = $0.kind { return true }; return false }
        XCTAssertGreaterThan(proseRows.count, 1)

        let preparer = ReaderPreparer(
            theme: ReaderTestSupport.theme(),
            width: 1_024,
            document: document,
            allowRemoteImages: false
        )
        var itemCount = 0
        for row in proseRows {
            guard case let .prose(run) = row.kind else { continue }
            for segment in run.segments {
                if case let .list(list, _) = segment {
                    itemCount += list.items.count
                    let bytes = list.items.reduce(0) {
                        $0 + $1.inlines.plainText.utf8.count
                    }
                    XCTAssertLessThanOrEqual(bytes, ReaderRowPlanner.proseChunkByteLimit + 2_048)
                }
            }
            let block = await preparer.prepare(row: row)
            XCTAssertGreaterThan(block.height, 0)
        }
        XCTAssertEqual(itemCount, 1_000)
    }
}
