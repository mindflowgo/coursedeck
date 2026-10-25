import CoreGraphics
import CourseDeckCore
import UIKit

struct TableCellFrame {
    /// `-1` for header cells.
    var row: Int
    var column: Int
    var colSpan: Int
    var rowSpan: Int
    var frame: CGRect
    var textFrame: CGRect
    var attributed: NSAttributedString
    var isHeader: Bool
    var alignment: NSTextAlignment
    var plainText: String
}

/// Measured geometry for one table. Header cells and body cells use separate
/// coordinate spaces (the header is pinned above the scrolling body).
struct TableGridMetrics {
    var columnWidths: [CGFloat]
    var rowHeights: [CGFloat]
    var headerHeight: CGFloat
    var headerCells: [TableCellFrame]
    var bodyCells: [TableCellFrame]
    var totalWidth: CGFloat
    var bodyHeight: CGFloat
    var separatorWidth: CGFloat
    var columnAlignments: [ColumnAlignment]
    var rowCount: Int
    var columnCount: Int
    var warnings: [String]

    var totalHeight: CGFloat { headerHeight + bodyHeight }
    var hasHorizontalOverflow: Bool

    init(
        columnWidths: [CGFloat],
        rowHeights: [CGFloat],
        headerHeight: CGFloat,
        headerCells: [TableCellFrame],
        bodyCells: [TableCellFrame],
        totalWidth: CGFloat,
        bodyHeight: CGFloat,
        separatorWidth: CGFloat,
        columnAlignments: [ColumnAlignment],
        rowCount: Int,
        columnCount: Int,
        warnings: [String],
        availableWidth: CGFloat
    ) {
        self.columnWidths = columnWidths
        self.rowHeights = rowHeights
        self.headerHeight = headerHeight
        self.headerCells = headerCells
        self.bodyCells = bodyCells
        self.totalWidth = totalWidth
        self.bodyHeight = bodyHeight
        self.separatorWidth = separatorWidth
        self.columnAlignments = columnAlignments
        self.rowCount = rowCount
        self.columnCount = columnCount
        self.warnings = warnings
        hasHorizontalOverflow = totalWidth > availableWidth + 0.5
    }

    func viewportHeight(maxHeight: CGFloat) -> CGFloat {
        min(totalHeight, maxHeight)
    }

    func rowOrigin(_ row: Int) -> CGFloat {
        guard row > 0, !rowHeights.isEmpty else { return 0 }
        let end = min(row, rowHeights.count)
        return rowHeights.prefix(end).reduce(0, +) + separatorWidth * CGFloat(max(end - 1, 0))
    }

    func columnOrigin(_ column: Int) -> CGFloat {
        guard column > 0, !columnWidths.isEmpty else { return 0 }
        let end = min(column, columnWidths.count)
        return columnWidths.prefix(end).reduce(0, +) + separatorWidth * CGFloat(max(end - 1, 0))
    }

    static let empty = TableGridMetrics(
        columnWidths: [],
        rowHeights: [],
        headerHeight: 0,
        headerCells: [],
        bodyCells: [],
        totalWidth: 0,
        bodyHeight: 0,
        separatorWidth: 0.5,
        columnAlignments: [],
        rowCount: 0,
        columnCount: 0,
        warnings: [],
        availableWidth: 0
    )
}

/// Column/row measurement described by PLAN §4.3:
/// * bounded sample (header + first rows + evenly spaced rows) for column widths,
/// * longest unbreakable token and p95 to avoid pathological wrapping,
/// * periodic column widths so long tables can scroll horizontally,
/// * numeric/currency alignment comes from the table model,
/// * every row measured (the table body virtualizes views, not data).
enum TableGridMeasurer {
    static let minColumnWidth: CGFloat = 56
    static let maxColumnWidth: CGFloat = 360
    static let cellHorizontalPadding: CGFloat = 12
    static let cellVerticalPadding: CGFloat = 8
    static let minimumRowHeight: CGFloat = 34
    static let minimumHeaderHeight: CGFloat = 36
    static let separatorWidth: CGFloat = 0.5
    static let sampledRows = 45

    static func measure(
        table: TableModel,
        availableWidth: CGFloat,
        theme: ReaderTheme,
        headerAttributed: [NSAttributedString],
        bodyAttributed: [[NSAttributedString]]
    ) -> TableGridMetrics {
        let columnCount = max(table.columnCount, 1)
        let alignments = (0..<columnCount).map { table.alignment(at: $0) }
        let headerTexts = (0..<columnCount).map { index in
            index < headerAttributed.count
                ? headerAttributed[index]
                : NSAttributedString(string: "")
        }
        let bodyTexts = bodyAttributed.map { row in
            (0..<columnCount).map { index in
                index < row.count ? row[index] : NSAttributedString(string: "")
            }
        }

        let widths = measureColumnWidths(
            table: table,
            columnCount: columnCount,
            availableWidth: availableWidth,
            theme: theme,
            header: headerTexts,
            rows: bodyTexts
        )

        let placements = placements(table: table, columnCount: columnCount)
        var rowHeights = Array(repeating: minimumRowHeight, count: table.rows.count)
        var headerHeight = minimumHeaderHeight

        for placement in placements.header {
            let width = columnSpanWidth(
                columns: widths,
                start: placement.column,
                span: placement.colSpan
            ) - cellHorizontalPadding * 2
            let text = text(at: placement.cellIndex, in: headerTexts)
            let measured = ceil(boundingHeight(text, width: max(width, 1)))
            headerHeight = max(headerHeight, measured + cellVerticalPadding * 2)
        }

        for placement in placements.body where placement.rowSpan == 1 {
            let width = columnSpanWidth(
                columns: widths,
                start: placement.column,
                span: placement.colSpan
            ) - cellHorizontalPadding * 2
            let text = text(at: placement.cellIndex, in: bodyTexts[placement.row])
            let measured = ceil(boundingHeight(text, width: max(width, 1)))
            rowHeights[placement.row] = max(rowHeights[placement.row], measured + cellVerticalPadding * 2)
        }

        // A row-spanning cell must fit into the combined height of its rows.
        for placement in placements.body where placement.rowSpan > 1 {
            guard placement.row + placement.rowSpan <= rowHeights.count else { continue }
            let width = columnSpanWidth(
                columns: widths,
                start: placement.column,
                span: placement.colSpan
            ) - cellHorizontalPadding * 2
            let text = text(at: placement.cellIndex, in: bodyTexts[placement.row])
            let required = ceil(boundingHeight(text, width: max(width, 1))) + cellVerticalPadding * 2
            let rows = placement.row..<(placement.row + placement.rowSpan)
            let current = rows.reduce(CGFloat(0)) { $0 + rowHeights[$1] }
                + separatorWidth * CGFloat(max(placement.rowSpan - 1, 0))
            if required > current {
                rowHeights[rows.last!] += required - current
            }
        }

        let totalWidth = columnSpanWidth(columns: widths, start: 0, span: widths.count)
        let bodyHeight = rowHeights.reduce(CGFloat(0)) { $0 + $1 }
            + separatorWidth * CGFloat(max(rowHeights.count - 1, 0))

        var headerCells: [TableCellFrame] = []
        var bodyCells: [TableCellFrame] = []

        for placement in placements.header {
            let frame = CGRect(
                x: columnX(columns: widths, column: placement.column),
                y: 0,
                width: columnSpanWidth(columns: widths, start: placement.column, span: placement.colSpan),
                height: headerHeight
            )
            headerCells.append(
                cellFrame(
                    placement: placement,
                    row: -1,
                    frame: frame,
                    attributed: text(at: placement.cellIndex, in: headerTexts),
                    isHeader: true,
                    alignment: alignments[placement.column],
                    text: text(at: placement.cellIndex, in: headerTexts).string
                )
            )
        }

        for placement in placements.body where placement.row < rowHeights.count {
            let rowSpan = min(placement.rowSpan, rowHeights.count - placement.row)
            var height = rowHeights[placement.row..<(placement.row + rowSpan)].reduce(CGFloat(0)) { $0 + $1 }
            if rowSpan > 1 {
                height += separatorWidth * CGFloat(rowSpan - 1)
            }
            let frame = CGRect(
                x: columnX(columns: widths, column: placement.column),
                y: rowsY(rowHeights: rowHeights, row: placement.row),
                width: columnSpanWidth(columns: widths, start: placement.column, span: placement.colSpan),
                height: height
            )
            bodyCells.append(
                cellFrame(
                    placement: placement,
                    row: placement.row,
                    frame: frame,
                    attributed: text(at: placement.cellIndex, in: bodyTexts[placement.row]),
                    isHeader: false,
                    alignment: alignments[placement.column],
                    text: text(at: placement.cellIndex, in: bodyTexts[placement.row]).string
                )
            )
        }

        return TableGridMetrics(
            columnWidths: widths,
            rowHeights: rowHeights,
            headerHeight: headerHeight,
            headerCells: headerCells,
            bodyCells: bodyCells,
            totalWidth: totalWidth,
            bodyHeight: bodyHeight,
            separatorWidth: separatorWidth,
            columnAlignments: alignments,
            rowCount: rowHeights.count,
            columnCount: columnCount,
            warnings: table.warnings + (table.repair?.warnings ?? []),
            availableWidth: availableWidth
        )
    }

    // MARK: - Column measurement

    private static func measureColumnWidths(
        table: TableModel,
        columnCount: Int,
        availableWidth: CGFloat,
        theme: ReaderTheme,
        header: [NSAttributedString],
        rows: [[NSAttributedString]]
    ) -> [CGFloat] {
        var required = Array(repeating: minColumnWidth, count: columnCount)
        let sampleIndices = sampledRowIndices(count: rows.count)
        let headerAttributes = theme.tableHeader
        let bodyAttributes = theme.table

        for placement in placements(table: table, columnCount: columnCount).header {
            let text = text(at: placement.cellIndex, in: header)
            let width = requiredWidth(text, attributes: headerAttributes)
            distribute(width, across: placement.column, span: placement.colSpan, into: &required)
        }

        for rowIndex in sampleIndices where rowIndex < rows.count {
            let row = rows[rowIndex]
            let tableRow = table.rows[rowIndex]
            var column = 0
            for (cellIndex, cell) in tableRow.enumerated() {
                let text = text(at: cellIndex, in: row)
                let width = requiredWidth(text, attributes: bodyAttributes)
                distribute(width, across: column, span: cell.colSpan, into: &required)
                column += cell.colSpan
            }
        }

        // Long unbreakable tokens set a floor without letting a huge token
        // force a 2,000 point column.
        for (rowIndex, row) in rows.enumerated() where sampleIndices.contains(rowIndex) {
            for (column, text) in row.enumerated() where column < required.count {
                let longest = longestTokenWidth(text, attributes: bodyAttributes)
                required[column] = max(required[column], min(longest + cellHorizontalPadding * 2, maxColumnWidth))
            }
        }

        let clamped = required.map { min(max($0 + cellHorizontalPadding * 2, minColumnWidth), maxColumnWidth) }
        let separatorTotal = separatorWidth * CGFloat(max(columnCount - 1, 0))
        let total = clamped.reduce(0, +) + separatorTotal
        guard total < availableWidth else { return clamped }

        let extra = availableWidth - total
        let weights = clamped.map { max($0 - minColumnWidth, 1) }
        let weightSum = weights.reduce(0, +)
        guard weightSum > 0 else {
            return clamped.map { $0 + extra / CGFloat(columnCount) }
        }
        return zip(clamped, weights).map { width, weight in
            width + extra * (weight / weightSum)
        }
    }

    private static func distribute(_ width: CGFloat, across column: Int, span: Int, into required: inout [CGFloat]) {
        guard !required.isEmpty else { return }
        let effectiveSpan = min(max(span, 1), required.count - column)
        guard effectiveSpan > 0 else { return }
        let perColumn = width / CGFloat(effectiveSpan)
        for index in column..<(column + effectiveSpan) {
            required[index] = max(required[index], perColumn)
        }
    }

    static func sampledRowIndices(count: Int) -> Set<Int> {
        guard count > 0 else { return [] }
        if count <= sampledRows {
            return Set(0..<count)
        }
        var result = Set(0..<min(25, count))
        result.formUnion((count - 5)..<count)
        let strideValue = max(count / 20, 1)
        var index = 0
        while index < count {
            result.insert(index)
            index += strideValue
        }
        return result
    }

    private static func requiredWidth(_ text: NSAttributedString, attributes: UIFont) -> CGFloat {
        guard text.length > 0 else { return 0 }
        return ceil(text.boundingRect(
            with: CGSize(width: 10_000, height: 10_000),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        ).width)
    }

    private static func longestTokenWidth(_ text: NSAttributedString, attributes: UIFont) -> CGFloat {
        guard text.length > 0 else { return 0 }
        let tokens = text.string.split(whereSeparator: { $0.isWhitespace })
        var longest: CGFloat = 0
        let attrs: [NSAttributedString.Key: Any] = [
            .font: attributes,
        ]
        for token in tokens {
            let width = (String(token) as NSString).size(withAttributes: attrs).width
            longest = max(longest, width)
        }
        return ceil(longest)
    }

    // MARK: - Placement

    private struct Placement {
        var row: Int
        var column: Int
        var cellIndex: Int
        var colSpan: Int
        var rowSpan: Int
    }

    private struct Placements {
        var header: [Placement]
        var body: [Placement]
    }

    private static func placements(table: TableModel, columnCount: Int) -> Placements {
        func place(_ cells: [TableCellModel], row: Int) -> [Placement] {
            var occupied = Set<Int>()
            var output: [Placement] = []
            var column = 0
            for (cellIndex, cell) in cells.enumerated() {
                while occupied.contains(column) { column += 1 }
                guard column < columnCount else { break }
                let colSpan = min(max(cell.colSpan, 1), columnCount - column)
                for index in 0..<colSpan {
                    occupied.insert(column + index)
                }
                output.append(
                    Placement(
                        row: row,
                        column: column,
                        cellIndex: cellIndex,
                        colSpan: colSpan,
                        rowSpan: max(cell.rowSpan, 1)
                    )
                )
                column += colSpan
            }
            return output
        }

        let header = place(table.header, row: 0)
        var body: [Placement] = []
        var occupiedRows: [Set<Int>] = []
        for (rowIndex, row) in table.rows.enumerated() {
            if occupiedRows.count <= rowIndex {
                occupiedRows.append([])
            }
            var column = 0
            for (cellIndex, cell) in row.enumerated() {
                while occupiedRows[rowIndex].contains(column) { column += 1 }
                guard column < columnCount else { break }
                let colSpan = min(max(cell.colSpan, 1), columnCount - column)
                let rowSpan = max(cell.rowSpan, 1)
                for offset in 0..<rowSpan {
                    while occupiedRows.count <= rowIndex + offset {
                        occupiedRows.append([])
                    }
                    for index in 0..<colSpan {
                        occupiedRows[rowIndex + offset].insert(column + index)
                    }
                }
                body.append(
                    Placement(
                        row: rowIndex,
                        column: column,
                        cellIndex: cellIndex,
                        colSpan: colSpan,
                        rowSpan: rowSpan
                    )
                )
                column += colSpan
            }
        }
        return Placements(header: header, body: body)
    }

    // MARK: - Geometry

    private static func columnX(columns: [CGFloat], column: Int) -> CGFloat {
        guard column > 0 else { return 0 }
        let prefix = columns.prefix(column).reduce(CGFloat(0)) { $0 + $1 }
        return prefix + separatorWidth * CGFloat(column)
    }

    private static func columnSpanWidth(columns: [CGFloat], start: Int, span: Int) -> CGFloat {
        guard start < columns.count else { return 0 }
        let end = min(start + max(span, 1), columns.count)
        let width = columns[start..<end].reduce(CGFloat(0)) { $0 + $1 }
        return width + separatorWidth * CGFloat(max(end - start - 1, 0))
    }

    private static func rowsY(rowHeights: [CGFloat], row: Int) -> CGFloat {
        guard row > 0 else { return 0 }
        let prefix = rowHeights.prefix(row).reduce(CGFloat(0)) { $0 + $1 }
        return prefix + separatorWidth * CGFloat(row)
    }

    private static func cellFrame(
        placement: Placement,
        row: Int,
        frame: CGRect,
        attributed: NSAttributedString,
        isHeader: Bool,
        alignment: ColumnAlignment,
        text: String
    ) -> TableCellFrame {
        let textFrame = frame.insetBy(
            dx: cellHorizontalPadding,
            dy: cellVerticalPadding
        )
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = textAlignment(alignment)
        paragraph.lineSpacing = 1
        paragraph.paragraphSpacing = 0
        let aligned = NSMutableAttributedString(attributedString: attributed)
        aligned.addAttribute(
            .paragraphStyle,
            value: paragraph,
            range: NSRange(location: 0, length: aligned.length)
        )
        return TableCellFrame(
            row: row,
            column: placement.column,
            colSpan: placement.colSpan,
            rowSpan: placement.rowSpan,
            frame: frame,
            textFrame: textFrame,
            attributed: aligned,
            isHeader: isHeader,
            alignment: textAlignment(alignment),
            plainText: text
        )
    }

    static func textAlignment(_ alignment: ColumnAlignment) -> NSTextAlignment {
        switch alignment {
        case .right: return .right
        case .center: return .center
        case .left, .none: return .natural
        }
    }

    private static func text(at index: Int, in row: [NSAttributedString]) -> NSAttributedString {
        guard !row.isEmpty else { return NSAttributedString(string: "") }
        return row[min(max(index, 0), row.count - 1)]
    }

    private static func boundingHeight(_ text: NSAttributedString, width: CGFloat) -> CGFloat {
        guard text.length > 0 else { return 0 }
        return text.boundingRect(
            with: CGSize(width: max(width, 1), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        ).height
    }
}
