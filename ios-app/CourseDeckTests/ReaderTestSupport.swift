@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

enum ReaderTestSupport {
    static func theme(
        category: UIContentSizeCategory = .large,
        style: UIUserInterfaceStyle = .light
    ) -> ReaderTheme {
        ReaderTheme(traitCollection: traits(category: category, style: style))
    }

    static func traits(
        category: UIContentSizeCategory = .large,
        style: UIUserInterfaceStyle = .light
    ) -> UITraitCollection {
        UITraitCollection(traitsFrom: [
            UITraitCollection(preferredContentSizeCategory: category),
            UITraitCollection(userInterfaceStyle: style),
            UITraitCollection(displayScale: 2),
        ])
    }

    static func attributed(_ text: String, font: UIFont, color: UIColor = .label) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            .font: font,
            .foregroundColor: color,
        ])
    }

    static func cell(_ text: String, span: Int = 1, rowSpan: Int = 1, header: Bool = false) -> TableCellModel {
        TableCellModel(
            inlines: text.isEmpty ? [] : [.text(text)],
            colSpan: span,
            rowSpan: rowSpan,
            isHeader: header
        )
    }

    static func table(
        header: [String],
        rows: [[String]],
        alignments: [ColumnAlignment] = []
    ) -> TableModel {
        TableModel(
            header: header.map { cell($0, header: true) },
            rows: rows.map { $0.map { cell($0) } },
            columnAlignments: alignments
        )
    }

    static func measure(
        _ table: TableModel,
        width: CGFloat,
        theme: ReaderTheme
    ) -> TableGridMetrics {
        TableGridMeasurer.measure(
            table: table,
            availableWidth: width,
            theme: theme,
            headerAttributed: table.header.map { attributed($0.plainText, font: theme.tableHeader) },
            bodyAttributed: table.rows.map { row in
                row.map { attributed($0.plainText, font: theme.table) }
            }
        )
    }

    static func sampleDocument() throws -> ReaderDocument {
        try document(markdown: ReaderSampleDocument.markdown)
    }

    static func document(markdown: String) throws -> ReaderDocument {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CourseDeckTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent("assets/icons", isDirectory: true),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent("assets/img", isDirectory: true),
            withIntermediateDirectories: true
        )
        try Data(markdown.utf8).write(
            to: directory.appendingPathComponent("sample.reader.md")
        )
        try Data(ReaderSampleDocument.iconSVG.utf8).write(
            to: directory.appendingPathComponent("assets/icons/deck.svg")
        )
        return ReaderDocument(
            courseId: "sample",
            courseTitle: "Reader sample",
            target: ReaderTarget(courseId: "sample", scope: .lesson("sample"), tab: "reader"),
            title: "Reader sample",
            file: "sample.reader.md",
            markdown: markdown,
            courseDirectoryURL: directory,
            supportsCheckpoints: false,
            isReadOnly: true
        )
    }
}
