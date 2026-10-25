import CourseDeckCore
import UIKit

// MARK: - Table row/cell block view

final class TableBlockView: ReaderBlockView {
    private let toolbar = UIView()
    private let titleLabel = UILabel()
    private let openButton = UIButton(type: .system)
    private let warningLabel = UILabel()
    private var grid: TableGridView?
    private var prepared: ReaderPreparedTable?

    override init(frame: CGRect) {
        super.init(frame: frame)
        toolbar.backgroundColor = .clear
        titleLabel.font = .preferredFont(forTextStyle: .caption1)
        titleLabel.textColor = .secondaryLabel
        titleLabel.adjustsFontForContentSizeCategory = true
        toolbar.addSubview(titleLabel)

        openButton.setTitle("Open table", for: .normal)
        openButton.setImage(UIImage(systemName: "arrow.up.left.and.arrow.down.right"), for: .normal)
        openButton.titleLabel?.font = .preferredFont(forTextStyle: .caption1)
        openButton.accessibilityHint = "Opens the table full screen with the same scroll position."
        openButton.accessibilityIdentifier = "reader.table.open"
        openButton.addTarget(self, action: #selector(openTable), for: .touchUpInside)
        toolbar.addSubview(openButton)

        warningLabel.font = .preferredFont(forTextStyle: .caption2)
        warningLabel.textColor = .systemOrange
        warningLabel.numberOfLines = 1
        addSubview(toolbar)
        addSubview(warningLabel)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .table(value) = prepared else { return }
        self.prepared = value
        let columnCount = value.metrics.columnCount
        let rowCount = value.metrics.rowCount
        titleLabel.text = "TABLE · \(columnCount) COLUMN\(columnCount == 1 ? "" : "S") · \(rowCount) ROW\(rowCount == 1 ? "" : "S")"
        openButton.setTitle(value.metrics.hasHorizontalOverflow ? "Open table · scroll sideways" : "Open table", for: .normal)
        warningLabel.text = value.metrics.warnings.isEmpty
            ? nil
            : value.metrics.warnings.joined(separator: " · ")

        if let grid {
            grid.removeFromSuperview()
        }
        let newGrid = TableGridView()
        newGrid.configure(
            prepared: value,
            theme: context.theme,
            documentID: context.documentID,
            tableID: context.rowID,
            stateStore: context.tableScrollState,
            outerScrollView: context.outerScrollView,
            isFullScreen: false,
            onOpenDestination: { [weak self] destination, _ in
                guard let self, let url = URL(string: destination) else { return }
                self.context?.delegate?.readerBlock(self, open: url)
            },
            onShowTeX: { [weak self] tex, sourceView in
                guard let self else { return }
                self.context?.delegate?.readerBlock(self, showTeX: tex, sourceView: sourceView)
            }
        )
        addSubview(newGrid)
        grid = newGrid
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let prepared else { return }
        toolbar.frame = CGRect(x: 0, y: 0, width: bounds.width, height: 34)
        titleLabel.frame = CGRect(x: 20, y: 5, width: bounds.width * 0.55, height: 24)
        openButton.frame = CGRect(x: bounds.width - 220, y: 3, width: 210, height: 28)
        let viewport = prepared.metrics.viewportHeight(maxHeight: 480)
        grid?.frame = CGRect(x: 20, y: 34, width: max(bounds.width - 40, 1), height: viewport)
        warningLabel.frame = CGRect(
            x: 20,
            y: 34 + viewport + 2,
            width: bounds.width - 40,
            height: 16
        )
    }

    @objc private func openTable() {
        guard let prepared else { return }
        context?.delegate?.readerBlock(self, openTable: prepared, tableID: context?.rowID ?? "")
    }

    override func applyStoredTableState() {
        grid?.applyStoredState()
    }
}

// MARK: - Grid

final class TableGridView: UIView, UIScrollViewDelegate, UIContextMenuInteractionDelegate {
    private var prepared: ReaderPreparedTable?
    private var theme: ReaderTheme?
    private var documentID = ""
    private var tableID = ""
    private weak var stateStore: TableScrollStateStore?
    private var outerScrollView: UIScrollView?
    private var isFullScreen = false

    private let headerContent = TableHeaderContentView()
    private let headerClip = UIView()
    private let bodyScroll = ReaderHandoffScrollView()
    private let bodyContent = TableBodyContentView()

    private var restoredState = false
    private var lastVisibleRange: Range<Int>?
    private var accessibilityCache: [UIAccessibilityElement] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        clipsToBounds = true
        headerClip.clipsToBounds = true
        addSubview(headerClip)
        headerClip.addSubview(headerContent)
        bodyScroll.delegate = self
        bodyScroll.contentInsetAdjustmentBehavior = .never
        bodyScroll.showsHorizontalScrollIndicator = true
        bodyScroll.showsVerticalScrollIndicator = true
        bodyScroll.alwaysBounceHorizontal = false
        bodyScroll.alwaysBounceVertical = false
        bodyScroll.addSubview(bodyContent)
        addSubview(bodyScroll)
        addInteraction(UIContextMenuInteraction(delegate: self))
        isAccessibilityElement = false
        accessibilityIdentifier = "reader.table.grid"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(
        prepared: ReaderPreparedTable,
        theme: ReaderTheme,
        documentID: String,
        tableID: String,
        stateStore: TableScrollStateStore?,
        outerScrollView: UIScrollView?,
        isFullScreen: Bool,
        onOpenDestination: ((String, UIView) -> Void)? = nil,
        onShowTeX: ((String, UIView) -> Void)? = nil
    ) {
        self.prepared = prepared
        self.theme = theme
        self.documentID = documentID
        self.tableID = tableID
        self.stateStore = stateStore
        self.outerScrollView = outerScrollView
        self.isFullScreen = isFullScreen
        self.restoredState = false
        bodyScroll.handoffScrollView = outerScrollView
        headerContent.onOpenDestination = onOpenDestination
        headerContent.onShowTeX = onShowTeX
        bodyContent.onOpenDestination = onOpenDestination
        bodyContent.onShowTeX = onShowTeX
        headerContent.configure(metrics: prepared.metrics, theme: theme)
        bodyContent.configure(metrics: prepared.metrics, table: prepared.table, theme: theme)
        let headerNames = prepared.table.header.map { $0.plainText }.filter { !$0.isEmpty }
        accessibilityLabel = "Table, \(prepared.metrics.rowCount) rows, \(prepared.metrics.columnCount) columns. Header: \(headerNames.joined(separator: ", "))."
        accessibilityHint = "Three-finger swipe scrolls the table. Swipe left or right to read cells."
        setNeedsLayout()
    }

    func applyStoredState() {
        guard let prepared else { return }
        restoredState = false
        restoreStateIfNeeded(prepared: prepared)
        setNeedsLayout()
    }

    func currentScrollOffset() -> CGPoint {
        bodyScroll.contentOffset
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let prepared else { return }
        let headerHeight = prepared.metrics.headerHeight
        let bodyViewportHeight = max(bounds.height - headerHeight, 1)
        headerClip.frame = CGRect(x: 0, y: 0, width: bounds.width, height: headerHeight)
        bodyScroll.frame = CGRect(x: 0, y: headerHeight, width: bounds.width, height: bodyViewportHeight)
        headerContent.frame = CGRect(
            x: -bodyScroll.contentOffset.x,
            y: 0,
            width: prepared.metrics.totalWidth,
            height: headerHeight
        )
        let contentWidth = max(prepared.metrics.totalWidth, bodyScroll.bounds.width)
        bodyContent.frame = CGRect(
            x: 0,
            y: 0,
            width: contentWidth,
            height: max(prepared.metrics.bodyHeight, 1)
        )
        bodyScroll.contentSize = bodyContent.bounds.size
        restoreStateIfNeeded(prepared: prepared)
        bodyContent.updateVisibleCells(scrollView: bodyScroll)
        updateAccessibilityElements(prepared: prepared)
    }

    private func restoreStateIfNeeded(prepared: ReaderPreparedTable) {
        guard !restoredState else { return }
        restoredState = true
        let maxX = max(bodyScroll.contentSize.width - bodyScroll.bounds.width, 0)
        let maxY = max(bodyScroll.contentSize.height - bodyScroll.bounds.height, 0)
        let saved = stateStore?.state(documentID: documentID, tableID: tableID)
        let horizontal = min(max(saved?.horizontal ?? 0, 0), maxX)
        let vertical = min(max(saved?.vertical ?? 0, 0), maxY)
        bodyScroll.setContentOffset(CGPoint(x: horizontal, y: vertical), animated: false)
        headerContent.frame.origin.x = -horizontal
    }

    private func persistState() {
        stateStore?.setState(
            TableScrollStateStore.State(
                horizontal: bodyScroll.contentOffset.x,
                vertical: bodyScroll.contentOffset.y
            ),
            documentID: documentID,
            tableID: tableID
        )
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        headerContent.frame.origin.x = -scrollView.contentOffset.x
        persistState()
        bodyContent.updateVisibleCells(scrollView: scrollView)
        if let prepared, visibleRowRange() != lastVisibleRange {
            lastVisibleRange = visibleRowRange()
            updateAccessibilityElements(prepared: prepared)
        }
    }

    private func visibleRowRange() -> Range<Int>? {
        guard let prepared, bodyContent.bounds.height > 0 else { return nil }
        let visible = bodyScroll.bounds
        let startY = visible.minY
        let endY = visible.maxY
        var first: Int?
        var last: Int?
        var y: CGFloat = 0
        for (index, height) in prepared.metrics.rowHeights.enumerated() {
            let rowMax = y + height
            if rowMax >= startY, y <= endY {
                if first == nil { first = index }
                last = index
            }
            y = rowMax + prepared.metrics.separatorWidth
        }
        guard let first, let last else { return nil }
        return first..<(last + 1)
    }

    // MARK: Accessibility

    private func updateAccessibilityElements(prepared: ReaderPreparedTable) {
        var elements: [UIAccessibilityElement] = []
        let headerNames = prepared.table.header.map { $0.plainText }.filter { !$0.isEmpty }
        let summary = UIAccessibilityElement(accessibilityContainer: self)
        summary.accessibilityFrame = UIAccessibility.convertToScreenCoordinates(
            CGRect(x: 0, y: 0, width: max(bounds.width, 1), height: max(prepared.metrics.headerHeight, 1)),
            in: self
        )
        summary.accessibilityLabel = "Table, \(prepared.metrics.rowCount) rows, \(prepared.metrics.columnCount) columns. Header: \(headerNames.joined(separator: ", "))."
        summary.accessibilityValue = "Three-finger swipe scrolls the table. Swipe left or right to read cells."
        summary.accessibilityTraits = .header
        elements.append(summary)

        let headerElements = prepared.metrics.headerCells.map { cell -> UIAccessibilityElement in
            let element = UIAccessibilityElement(accessibilityContainer: self)
            let frame = headerContent.convert(cell.frame, to: nil)
            element.accessibilityFrame = frame
            let headerText = cell.plainText.isEmpty ? "empty" : cell.plainText
            element.accessibilityLabel = "Column \(cell.column + 1) header: \(headerText)"
            element.accessibilityValue = "Column \(cell.column + 1) of \(prepared.metrics.columnCount), header"
            element.accessibilityTraits = .header
            return element
        }
        elements.append(contentsOf: headerElements)

        let visible = bodyScroll.bounds
        let bodyElements = prepared.metrics.bodyCells.compactMap { cell -> UIAccessibilityElement? in
            guard cell.frame.intersects(visible) else { return nil }
            let element = UIAccessibilityElement(accessibilityContainer: self)
            let frame = bodyContent.convert(cell.frame, to: nil)
            element.accessibilityFrame = frame
            let text = cell.plainText.isEmpty ? "Empty cell" : cell.plainText
            element.accessibilityLabel = text
            let headerText = headerName(for: cell.column, prepared: prepared)
            element.accessibilityValue = "Row \(cell.row + 1) of \(prepared.metrics.rowCount), column \(cell.column + 1) of \(prepared.metrics.columnCount). Header: \(headerText)"
            element.accessibilityTraits = .staticText
            return element
        }
        elements.append(contentsOf: bodyElements)
        accessibilityElements = elements
        accessibilityCache = elements
    }

    private func headerName(for column: Int, prepared: ReaderPreparedTable) -> String {
        let names = prepared.table.header
        var gridColumn = 0
        for cell in names {
            if column >= gridColumn, column < gridColumn + cell.colSpan {
                return cell.plainText.isEmpty ? "none" : cell.plainText
            }
            gridColumn += cell.colSpan
        }
        return "none"
    }

    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        let page = max(bodyScroll.bounds.height * 0.85, 80)
        var offset = bodyScroll.contentOffset
        switch direction {
        case .down:
            offset.y = min(offset.y + page, max(bodyScroll.contentSize.height - bodyScroll.bounds.height, 0))
        case .up:
            offset.y = max(offset.y - page, 0)
        case .left:
            offset.x = max(offset.x - page, 0)
        case .right:
            offset.x = min(offset.x + page, max(bodyScroll.contentSize.width - bodyScroll.bounds.width, 0))
        @unknown default:
            return false
        }
        bodyScroll.setContentOffset(offset, animated: false)
        if let prepared { updateAccessibilityElements(prepared: prepared) }
        return true
    }

    // MARK: Context menu

    func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        configurationForMenuAtLocation location: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard let prepared else { return nil }
        let point = convert(location, to: bodyContent)
        guard let cell = prepared.metrics.bodyCells.first(where: { $0.frame.contains(point) }) else {
            let headerPoint = convert(location, to: headerContent)
            if let headerCell = prepared.metrics.headerCells.first(where: {
                $0.frame.contains(headerPoint)
            }) {
                return menuConfiguration(cell: headerCell, prepared: prepared)
            }
            return nil
        }
        return menuConfiguration(cell: cell, prepared: prepared)
    }

    private func menuConfiguration(cell: TableCellFrame, prepared: ReaderPreparedTable) -> UIContextMenuConfiguration {
        let cellText = cell.plainText
        let rowText = rowText(cell.row, prepared: prepared)
        let tsv = prepared.table.tsv(includeHeader: true)
        let copyCell = UIAction(title: "Copy Cell", image: UIImage(systemName: "doc.on.doc")) { _ in
            UIPasteboard.general.string = cellText
        }
        let copyRow = UIAction(title: "Copy Row", image: UIImage(systemName: "rectangle.split.3x1")) { _ in
            UIPasteboard.general.string = rowText
        }
        let copyTSV = UIAction(title: "Copy Table as TSV", image: UIImage(systemName: "tablecells")) { _ in
            UIPasteboard.general.string = tsv
        }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in
            UIMenu(title: cellText.isEmpty ? "Empty cell" : cellText, children: [copyCell, copyRow, copyTSV])
        }
    }

    private func rowText(_ row: Int, prepared: ReaderPreparedTable) -> String {
        guard row >= 0, row < prepared.table.rows.count else { return "" }
        return prepared.table.rows[row].map { $0.plainText.replacingOccurrences(of: "\n", with: " ") }
            .joined(separator: "\t")
    }
}

// MARK: - Header

final class TableHeaderContentView: UIView {
    var onOpenDestination: ((String, UIView) -> Void)?
    var onShowTeX: ((String, UIView) -> Void)?
    private var metrics: TableGridMetrics?
    private var theme: ReaderTheme?
    private var textViews: [TableCellTextView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(metrics: TableGridMetrics, theme: ReaderTheme) {
        self.metrics = metrics
        self.theme = theme
        textViews.forEach { $0.removeFromSuperview() }
        textViews = metrics.headerCells.map { cell in
            let view = TableCellTextView()
            view.configure(cell: cell, isHeader: true)
            view.onOpenDestination = onOpenDestination
            view.onTeX = onShowTeX
            addSubview(view)
            return view
        }
        isAccessibilityElement = false
        setNeedsLayout()
        setNeedsDisplay()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let metrics else { return }
        for (index, view) in textViews.enumerated() {
            let cell = metrics.headerCells[index]
            view.frame = cell.textFrame
        }
    }

    override func draw(_ rect: CGRect) {
        super.draw(rect)
        guard let metrics, let theme else { return }
        UIColor.secondarySystemBackground.setFill()
        UIBezierPath(rect: rect).fill()
        theme.separatorColor.setFill()
        for cell in metrics.headerCells where cell.frame.intersects(rect) {
            let x = cell.frame.minX
            let line = UIBezierPath(rect: CGRect(x: x, y: 0, width: metrics.separatorWidth, height: bounds.height))
            line.fill()
        }
        UIColor.separator.setFill()
        UIBezierPath(rect: CGRect(x: 0, y: bounds.height - metrics.separatorWidth, width: bounds.width, height: metrics.separatorWidth)).fill()
    }
}

// MARK: - Body

final class TableBodyContentView: UIView {
    var onOpenDestination: ((String, UIView) -> Void)?
    var onShowTeX: ((String, UIView) -> Void)?
    private var metrics: TableGridMetrics?
    private var table: TableModel?
    private var theme: ReaderTheme?
    private var visibleViews: [Int: TableCellTextView] = [:]
    private var reusePool: [TableCellTextView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(metrics: TableGridMetrics, table: TableModel, theme: ReaderTheme) {
        self.metrics = metrics
        self.table = table
        self.theme = theme
        visibleViews.values.forEach { $0.removeFromSuperview() }
        visibleViews.removeAll()
        isAccessibilityElement = false
        setNeedsLayout()
        setNeedsDisplay()
    }

    func updateVisibleCells(scrollView: UIScrollView) {
        guard let metrics else { return }
        let visible = scrollView.bounds.insetBy(dx: -40, dy: -200)
        var needed = Set<Int>()
        for (index, cell) in metrics.bodyCells.enumerated() where cell.frame.intersects(visible) {
            needed.insert(index)
            if visibleViews[index] == nil {
                let view = reusePool.popLast() ?? TableCellTextView()
                view.configure(cell: cell, isHeader: false)
                view.onOpenDestination = onOpenDestination
                view.onTeX = onShowTeX
                addSubview(view)
                visibleViews[index] = view
            }
        }
        for (index, view) in visibleViews where !needed.contains(index) {
            view.removeFromSuperview()
            if reusePool.count < 24 { reusePool.append(view) }
            visibleViews.removeValue(forKey: index)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let metrics else { return }
        for (index, view) in visibleViews {
            view.frame = metrics.bodyCells[index].textFrame
        }
    }

    override func draw(_ rect: CGRect) {
        super.draw(rect)
        guard let metrics, let theme else { return }
        for (row, height) in metrics.rowHeights.enumerated() {
            let y = metrics.rowOrigin(row)
            let rowRect = CGRect(x: 0, y: y, width: bounds.width, height: height)
            guard rowRect.intersects(rect) else { continue }
            if row % 2 == 1 {
                theme.tableAlternateRow.setFill()
                UIBezierPath(rect: rowRect).fill()
            }
            theme.separatorColor.setFill()
            UIBezierPath(rect: CGRect(x: 0, y: y + height, width: bounds.width, height: metrics.separatorWidth)).fill()
        }
        for column in 0..<metrics.columnWidths.count {
            let x = metrics.columnOrigin(column)
            theme.separatorColor.setFill()
            UIBezierPath(rect: CGRect(x: x, y: rect.minY, width: metrics.separatorWidth, height: rect.height)).fill()
        }
        UIColor.separator.setFill()
        UIBezierPath(rect: CGRect(x: 0, y: 0, width: metrics.separatorWidth, height: bounds.height)).fill()
        UIBezierPath(rect: CGRect(x: bounds.width - metrics.separatorWidth, y: 0, width: metrics.separatorWidth, height: bounds.height)).fill()
    }
}

// MARK: - Cell text view

final class TableCellTextView: UITextView {
    var onTeX: ((String, UIView) -> Void)?
    var onOpenDestination: ((String, UIView) -> Void)?

    convenience init() {
        self.init(frame: .zero, textContainer: nil)
    }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        isEditable = false
        isSelectable = true
        isScrollEnabled = false
        backgroundColor = .clear
        textContainerInset = .zero
        self.textContainer.lineFragmentPadding = 0
        self.textContainer.widthTracksTextView = true
        dataDetectorTypes = []
        adjustsFontForContentSizeCategory = false
        isAccessibilityElement = false
        linkTextAttributes = [
            .foregroundColor: UIColor.tintColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.cancelsTouchesInView = false
        addGestureRecognizer(tap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(cell: TableCellFrame, isHeader: Bool) {
        attributedText = cell.attributed
        textAlignment = cell.alignment
        backgroundColor = .clear
        setNeedsLayout()
    }

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard let attributedText else { return }
        let point = gesture.location(in: self)
        guard let position = closestPosition(to: point) else { return }
        let offset = self.offset(from: beginningOfDocument, to: position)
        guard offset >= 0, offset < attributedText.length else { return }
        if let tex = attributedText.attribute(.readerTeX, at: offset, effectiveRange: nil) as? String {
            onTeX?(tex, self)
        } else if let destination = attributedText.attribute(
            .readerImageDestination,
            at: offset,
            effectiveRange: nil
        ) as? String {
            onOpenDestination?(destination, self)
        }
    }
}
