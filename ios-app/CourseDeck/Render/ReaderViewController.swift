import CourseDeckCore
import SafariServices
import UIKit

/// The native reader. It is a `UITableView` of fully measured rows:
/// * consecutive prose blocks share one selectable TextKit 2 text view,
/// * tables are fixed-height viewports with inner scrolling and a full-screen route,
/// * images, math, callouts, details, USERNOTE cards, code, and task lists each
///   have a dedicated measured view.
///
/// No web view, JavaScript runtime, or HTML layout engine is involved.
final class ReaderViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private let document: ReaderDocument
    private let initialPosition: ReaderPosition?
    private let deepLinkOffset: CGFloat
    private let tableScrollState: TableScrollStateStore

    /// Called on a debounce while scrolling and immediately on disappear.
    var onPositionChange: ((ReaderPosition) -> Void)?
    /// Registers this controller with the SwiftUI toolbar proxy.
    var onReady: ((ReaderViewController) -> Void)?

    private let tableView = UITableView(frame: .zero, style: .plain)
    private let loadingOverlay = UIView()
    private let loadingSpinner = UIActivityIndicatorView(style: .large)
    private let loadingLabel = UILabel()
    private let loadingStack = UIStackView()
    private let emptyLabel = UILabel()

    private var rows: [ReaderRow] = []
    private var prepared: [String: ReaderPreparedBlock] = [:]
    private var measuredHeights: [String: CGFloat] = [:]
    private var preparing: Set<String> = []
    private var preparationTask: [String: Task<Void, Never>] = [:]
    private var generation: [String: Int] = [:]
    private var remoteApprovedRows: Set<String> = []

    private let workLimiter = ReaderPreparationLimiter(limit: 3)
    private var theme = ReaderTheme(traitCollection: .current)
    private var lastLayoutWidth: CGFloat = 0
    private var lastContentSizeCategory: UIContentSizeCategory = .large
    private var lastStyle: UIUserInterfaceStyle = .unspecified
    private var lastScale: CGFloat = 0
    private var initialBatchRemaining = 0
    private var pendingRestore: ReaderPosition?
    private var pendingRestoreRowID: String?
    private var didRestorePosition = false
    private(set) var isInitialLoadComplete = false
    private(set) var isRestoring = false
    private var isRebuilding = false

    private var positionWorkItem: DispatchWorkItem?
    private var parseTask: Task<Void, Never>?
    private var isVisible = false

    init(
        document: ReaderDocument,
        initialPosition: ReaderPosition?,
        tableScrollState: TableScrollStateStore,
        deepLinkOffset: CGFloat = 0
    ) {
        self.document = document
        self.initialPosition = initialPosition
        self.tableScrollState = tableScrollState
        self.deepLinkOffset = deepLinkOffset
        super.init(nibName: nil, bundle: nil)
        theme = ReaderTheme(traitCollection: traitCollection)
        lastContentSizeCategory = theme.contentSizeCategory
        lastStyle = theme.userInterfaceStyle
        lastScale = theme.displayScale
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        parseTask?.cancel()
        positionWorkItem?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        configureTable()
        configureLoadingOverlay()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        theme = ReaderTheme(traitCollection: traitCollection)
        onReady?(self)
        loadDocument()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        isVisible = true
        tableView.contentInsetAdjustmentBehavior = .always
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        isVisible = false
        Task { [self] in
            await saveExactPositionNow()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        if width > 0, abs(width - lastLayoutWidth) > 0.5 {
            lastLayoutWidth = width
            if !rows.isEmpty {
                rebuildForLayoutChange()
            }
        }
        loadingOverlay.frame = view.bounds
        if !emptyLabel.isHidden {
            emptyLabel.frame = CGRect(
                x: 40,
                y: view.bounds.midY - 60,
                width: view.bounds.width - 80,
                height: 100
            )
        }
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        let updated = ReaderTheme(traitCollection: traitCollection)
        let changed = updated.contentSizeCategory != lastContentSizeCategory
            || updated.userInterfaceStyle != lastStyle
            || abs(updated.displayScale - lastScale) > 0.01
        guard changed else { return }
        lastContentSizeCategory = updated.contentSizeCategory
        lastStyle = updated.userInterfaceStyle
        lastScale = updated.displayScale
        theme = updated
        if !rows.isEmpty {
            rebuildForLayoutChange()
        }
    }

    // MARK: - Setup

    private func configureTable() {
        tableView.dataSource = self
        tableView.delegate = self
        tableView.separatorStyle = .none
        tableView.backgroundColor = .systemBackground
        tableView.estimatedRowHeight = 0
        tableView.estimatedSectionHeaderHeight = 0
        tableView.estimatedSectionFooterHeight = 0
        tableView.keyboardDismissMode = .onDrag
        tableView.contentInset = UIEdgeInsets(top: 8, left: 0, bottom: 48, right: 0)
        tableView.accessibilityIdentifier = "reader.table"
        tableView.register(ReaderBlockCell.self, forCellReuseIdentifier: "block")
        tableView.register(ReaderLoadingCell.self, forCellReuseIdentifier: "loading")
        view.addSubview(tableView)
        tableView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.topAnchor.constraint(equalTo: view.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        emptyLabel.font = .preferredFont(forTextStyle: .title3)
        emptyLabel.textColor = .secondaryLabel
        emptyLabel.textAlignment = .center
        emptyLabel.numberOfLines = 0
        emptyLabel.text = "This document has no readable content."
        emptyLabel.isHidden = true
        view.addSubview(emptyLabel)
    }

    private func configureLoadingOverlay() {
        loadingOverlay.backgroundColor = .systemBackground
        loadingOverlay.isAccessibilityElement = false
        loadingOverlay.accessibilityViewIsModal = true
        loadingSpinner.startAnimating()
        loadingLabel.text = "Preparing lesson…"
        loadingLabel.font = .preferredFont(forTextStyle: .body)
        loadingLabel.textColor = .secondaryLabel
        loadingLabel.adjustsFontForContentSizeCategory = true
        loadingLabel.accessibilityIdentifier = "reader.loading"
        loadingStack.axis = .vertical
        loadingStack.alignment = .center
        loadingStack.spacing = 12
        loadingStack.addArrangedSubview(loadingSpinner)
        loadingStack.addArrangedSubview(loadingLabel)
        loadingStack.translatesAutoresizingMaskIntoConstraints = false
        loadingOverlay.addSubview(loadingStack)
        NSLayoutConstraint.activate([
            loadingStack.centerXAnchor.constraint(equalTo: loadingOverlay.centerXAnchor),
            loadingStack.centerYAnchor.constraint(equalTo: loadingOverlay.centerYAnchor),
            loadingStack.leadingAnchor.constraint(
                greaterThanOrEqualTo: loadingOverlay.leadingAnchor,
                constant: 24
            ),
            loadingStack.trailingAnchor.constraint(
                lessThanOrEqualTo: loadingOverlay.trailingAnchor,
                constant: -24
            ),
        ])
        view.addSubview(loadingOverlay)
    }

    // MARK: - Loading and row planning

    private func loadDocument() {
        loadingOverlay.isHidden = false
        let markdown = document.markdown
        let options = MarkdownPipelineOptions(
            courseDirectoryURL: document.courseDirectoryURL,
            courseID: document.courseId
        )
        parseTask = Task { [weak self] in
            #if DEBUG
            if ProcessInfo.processInfo.environment["COURSEDECK_UI_TEST_SLOW_READER_LOAD"] == "1" {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
            }
            #endif
            let parsed = await Task.detached(priority: .userInitiated) {
                MarkdownPipeline.parse(markdown, options: options)
            }.value
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.applyParsedDocument(parsed)
            }
        }
    }

    private func applyParsedDocument(_ parsed: MarkdownDocument) {
        rows = ReaderRowPlanner.plan(document: parsed)
        tableView.reloadData()
        loadingOverlay.isHidden = true
        emptyLabel.isHidden = !rows.isEmpty
        emptyLabel.frame = CGRect(
            x: 40,
            y: view.bounds.midY - 60,
            width: view.bounds.width - 80,
            height: 100
        )
        if rows.isEmpty {
            loadingOverlay.isHidden = true
            isInitialLoadComplete = true
            return
        }
        let batch = min(rows.count, 6)
        initialBatchRemaining = batch
        for index in 0..<batch {
            prepareRow(at: index)
        }
        prepareVisibleRows()
    }

    private func finishInitialLoadIfNeeded() {
        guard initialBatchRemaining <= 0 else { return }
        loadingOverlay.isHidden = true
        if !didRestorePosition {
            didRestorePosition = true
            let target = pendingRestore ?? initialPosition
            pendingRestore = nil
            pendingRestoreRowID = nil
            Task { [weak self] in
                await self?.restore(position: target, applyDeepLinkOffset: true)
                self?.reportPosition(force: true)
                self?.isInitialLoadComplete = true
                self?.isRebuilding = false
            }
        } else if let target = pendingRestore, pendingRestoreRowID == nil {
            pendingRestore = nil
            Task { [weak self] in
                await self?.restore(position: target, applyDeepLinkOffset: false)
                self?.isRebuilding = false
            }
        } else {
            isInitialLoadComplete = true
            isRebuilding = false
        }
    }

    // MARK: - Preparation

    private func prepareRow(at index: Int) {
        guard rows.indices.contains(index) else { return }
        let row = rows[index]
        guard prepared[row.id] == nil, !preparing.contains(row.id) else { return }
        preparing.insert(row.id)
        let currentGeneration = (generation[row.id] ?? 0) + 1
        generation[row.id] = currentGeneration
        let preparer = ReaderPreparer(
            theme: theme,
            width: max(view.bounds.width, 320),
            document: document,
            allowRemoteImages: remoteApprovedRows.contains(row.id),
            expandedBlockIDs: row.expandedBlockIDs
        )
        let rowSnapshot = row
        let task = Task { [weak self] in
            guard let self else { return }
            await self.workLimiter.acquire()
            let block = await Task.detached(priority: .userInitiated) {
                await preparer.prepare(row: rowSnapshot)
            }.value
            await self.workLimiter.release()
            await MainActor.run {
                self.finishPreparation(rowID: rowSnapshot.id, block: block, expectedGeneration: currentGeneration)
            }
        }
        preparationTask[row.id] = task
    }

    private func finishPreparation(rowID: String, block: ReaderPreparedBlock, expectedGeneration: Int) {
        preparing.remove(rowID)
        preparationTask.removeValue(forKey: rowID)
        guard generation[rowID] == expectedGeneration else { return }
        prepared[rowID] = block
        measuredHeights[rowID] = block.height
        if let index = rows.firstIndex(where: { $0.id == rowID }) {
            let indexPath = IndexPath(row: index, section: 0)
            if tableView.indexPathsForVisibleRows?.contains(indexPath) == true {
                tableView.reloadRows(at: [indexPath], with: .none)
                reportPosition(force: true)
            }
        }
        if initialBatchRemaining > 0 {
            initialBatchRemaining -= 1
            finishInitialLoadIfNeeded()
        }
        if let target = pendingRestore, pendingRestoreRowID == rowID {
            pendingRestore = nil
            pendingRestoreRowID = nil
            Task { [weak self] in
                await self?.restore(position: target, applyDeepLinkOffset: false)
                self?.isRebuilding = false
            }
        }
    }

    private func prepareVisibleRows() {
        guard isVisible, !rows.isEmpty else { return }
        var indices = tableView.indexPathsForVisibleRows?.map(\.row) ?? []
        if indices.isEmpty {
            indices = Array(0..<min(rows.count, 4))
        }
        let upper = (indices.max() ?? 0) + 3
        for index in indices {
            prepareRow(at: index)
        }
        for index in (upper - 2)...upper where rows.indices.contains(index) {
            prepareRow(at: index)
        }
    }

    private func invalidateRow(_ index: Int) {
        guard rows.indices.contains(index) else { return }
        let rowID = rows[index].id
        generation[rowID] = (generation[rowID] ?? 0) + 1
        prepared.removeValue(forKey: rowID)
        measuredHeights.removeValue(forKey: rowID)
        preparing.remove(rowID)
        preparationTask[rowID]?.cancel()
        preparationTask.removeValue(forKey: rowID)
        tableView.reloadRows(at: [IndexPath(row: index, section: 0)], with: .none)
        prepareRow(at: index)
    }

    private func rebuildForLayoutChange() {
        guard !rows.isEmpty else { return }
        isRebuilding = true
        let anchor = currentPosition()
        pendingRestore = anchor
        pendingRestoreRowID = nil
        prepared.removeAll()
        measuredHeights.removeAll()
        preparing.removeAll()
        preparationTask.values.forEach { $0.cancel() }
        preparationTask.removeAll()
        for row in rows { generation[row.id] = (generation[row.id] ?? 0) + 1 }
        tableView.reloadData()
        tableView.layoutIfNeeded()
        let batch = min(rows.count, 6)
        initialBatchRemaining = batch
        for index in 0..<batch {
            prepareRow(at: index)
        }
        prepareVisibleRows()
        if batch == 0 {
            finishInitialLoadIfNeeded()
        }
    }

    // MARK: - Positions and checkpoints

    /// Recursively locate a block inside a prepared row. The returned offset is
    /// relative to the row's view and the height is the target's rendered
    /// height (prose anchors, details header, or child view).
    private func locateInRow(_ row: ReaderRow, blockID: String) -> (offset: CGFloat, height: CGFloat)? {
        guard let block = prepared[row.id] else { return nil }
        return locate(nodeID: row.id, block: block, target: blockID)
    }

    private func locate(
        nodeID: String,
        block: ReaderPreparedBlock,
        target: String
    ) -> (offset: CGFloat, height: CGFloat)? {
        switch block {
        case let .prose(prose):
            if let anchor = prose.anchors.first(where: { $0.blockID == target }) {
                return (theme.proseInsets.top + anchor.top, max(anchor.height, 1))
            }
            if nodeID == target {
                return (0, max(prose.height, 1))
            }
        case let .details(details):
            if nodeID == target {
                return (0, max(details.headerHeight, 1))
            }
            guard details.isOpen else { return nil }
            var offset = details.childrenOrigin
            for child in details.children {
                if let found = locate(nodeID: child.blockID, block: child.block, target: target) {
                    return (offset + found.offset, found.height)
                }
                offset += child.block.height + 8
            }
        case let .callout(container):
            if nodeID == target {
                return (0, max(container.height, 1))
            }
            var offset = container.childrenOrigin
            for child in container.children {
                if let found = locate(nodeID: child.blockID, block: child.block, target: target) {
                    return (offset + found.offset, found.height)
                }
                offset += child.block.height + container.childSpacing
            }
        case let .userNote(note):
            if nodeID == target {
                return (0, max(note.height, 1))
            }
            var offset = note.childrenOrigin
            for child in note.children {
                if let found = locate(nodeID: child.blockID, block: child.block, target: target) {
                    return (offset + found.offset, found.height)
                }
                offset += child.block.height + 8
            }
        case .taskList, .code, .image, .math, .table, .separator, .fallback:
            if nodeID == target {
                return (0, max(block.height, 1))
            }
        }
        return nil
    }

    /// Expand every closed `<details>` ancestor of the target, then
    /// re-prepare the affected container rows before scrolling.
    private func expandDetailsAncestors(of blockID: String) async {
        let ancestors = ReaderRowPlanner.detailsAncestors(of: blockID, in: rows)
        guard !ancestors.isEmpty else { return }
        var rowsToPrepare: [Int: Set<String>] = [:]
        for id in ancestors {
            if let index = rows.firstIndex(where: { $0.blockIDs.contains(id) }) {
                rowsToPrepare[index, default: []].insert(id)
            }
        }
        for index in rowsToPrepare.keys.sorted() {
            guard rows.indices.contains(index),
                  let ids = rowsToPrepare[index] else { continue }
            let before = rows[index].expandedBlockIDs
            rows[index].expandedBlockIDs.formUnion(ids)
            guard rows[index].expandedBlockIDs != before else { continue }
            let rowID = rows[index].id
            generation[rowID] = (generation[rowID] ?? 0) + 1
            prepared.removeValue(forKey: rowID)
            measuredHeights.removeValue(forKey: rowID)
            await prepareRowForRestore(at: index)
        }
        flushMeasuredHeights()
    }

    /// Exact position for checkpoint writes. Returns nil when any preceding
    /// row is still unmeasured, so a checkpoint can never store a pixel
    /// position built from estimated row heights.
    func currentMeasuredPosition() -> ReaderPosition? {
        let contentOffset = tableView.contentOffset.y + tableView.adjustedContentInset.top
        var cumulative: CGFloat = 0
        for (index, row) in rows.enumerated() {
            guard let height = measuredHeights[row.id] else { return nil }
            let clampedHeight = max(height, 1)
            if contentOffset < cumulative + clampedHeight || index == rows.count - 1 {
                let relative = min(max(contentOffset - cumulative, 0), clampedHeight)
                return anchorPosition(index: index, relative: relative, rowStart: cumulative)
            }
            cumulative += clampedHeight
        }
        return rows.isEmpty ? .zero : nil
    }

    /// Position for UI affordances. Uses measured heights when available and
    /// falls back to estimates only for display, never for checkpoint writes.
    func currentPosition() -> ReaderPosition {
        if let exact = currentMeasuredPosition() { return exact }
        let contentOffset = tableView.contentOffset.y + tableView.adjustedContentInset.top
        var cumulative: CGFloat = 0
        for (index, row) in rows.enumerated() {
            let height = max(measuredHeights[row.id] ?? row.estimatedHeight, 1)
            if contentOffset < cumulative + height || index == rows.count - 1 {
                let relative = min(max(contentOffset - cumulative, 0), height)
                return anchorPosition(index: index, relative: relative, rowStart: cumulative)
            }
            cumulative += height
        }
        return .zero
    }

    private func anchorPosition(index: Int, relative: CGFloat, rowStart: CGFloat) -> ReaderPosition {
        let row = rows[index]
        var candidates: [(id: String, offset: CGFloat, height: CGFloat)] = []
        for id in row.blockIDs {
            if let found = locateInRow(row, blockID: id) {
                candidates.append((id, found.offset, found.height))
            }
        }
        let containing = candidates
            .filter { relative >= $0.offset && relative <= $0.offset + max($0.height, 1) }
            .min { $0.height < $1.height }
        if let target = containing {
            let fraction = min(max((relative - target.offset) / max(target.height, 1), 0), 1)
            return ReaderPosition(
                verticalPosition: Double(rowStart + relative),
                anchorBlockID: target.id,
                anchorFraction: Double(fraction)
            )
        }
        let height = max(measuredHeights[row.id] ?? row.estimatedHeight, 1)
        return ReaderPosition(
            verticalPosition: Double(rowStart + relative),
            anchorBlockID: row.blockIDs.first,
            anchorFraction: Double(min(max(relative / height, 0), 1))
        )
    }

    func savePositionNow() {
        reportPosition(force: true)
    }

    /// Exact save used on disappear/background: measures the visible top row
    /// and all preceding rows, then reports a measured-only position.
    @discardableResult
    func saveExactPositionNow() async -> ReaderPosition? {
        guard let position = await currentExactPosition() else { return nil }
        onPositionChange?(position)
        return position
    }

    private func reportPosition(force: Bool) {
        guard force || !tableView.isDragging || !tableView.isDecelerating else { return }
        guard !rows.isEmpty else { return }
        // Defer checkpoint writes until every preceding row has a measured
        // height. The next scroll/debounce will report once it does.
        guard let position = currentMeasuredPosition() else { return }
        onPositionChange?(position)
    }

    private func schedulePositionReport() {
        positionWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.reportPosition(force: true)
        }
        positionWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: item)
    }

    @objc private func appDidEnterBackground() {
        Task { [self] in
            await saveExactPositionNow()
        }
    }

    /// Prepares every row through `target` with bounded concurrency. Only rows
    /// whose measured height is still unknown are measured; the cache survives
    /// cell reuse and scrolling.
    func prepareRowsThrough(_ target: Int) async {
        guard !rows.isEmpty else { return }
        let upper = min(max(target, 0), rows.count - 1)
        let indices = (0...upper).filter { measuredHeights[rows[$0].id] == nil }
        guard !indices.isEmpty else { return }
        let showProgress = indices.count > 6
        if showProgress {
            showRestoreProgress(completed: 0, total: indices.count)
        }
        var completed = 0
        var cursor = 0
        while cursor < indices.count {
            let batch = Array(indices[cursor..<min(cursor + 3, indices.count)])
            await measureAndApplyBatch(batch)
            completed += batch.count
            cursor += batch.count
            if showProgress {
                showRestoreProgress(completed: completed, total: indices.count)
            }
        }
        if showProgress {
            loadingOverlay.isHidden = true
            loadingSpinner.stopAnimating()
            loadingLabel.text = "Preparing lesson…"
        }
    }

    private struct RestoreMeasurement {
        var index: Int
        var rowID: String
        var generation: Int
        var block: ReaderPreparedBlock
    }

    private func measureAndApplyBatch(_ indices: [Int]) async {
        var jobs: [(index: Int, row: ReaderRow, generation: Int, preparer: ReaderPreparer)] = []
        for index in indices {
            guard rows.indices.contains(index) else { continue }
            let row = rows[index]
            guard measuredHeights[row.id] == nil else { continue }
            let currentGeneration = (generation[row.id] ?? 0) + 1
            generation[row.id] = currentGeneration
            preparing.insert(row.id)
            let preparer = ReaderPreparer(
                theme: theme,
                width: max(view.bounds.width, 320),
                document: document,
                allowRemoteImages: remoteApprovedRows.contains(row.id),
                expandedBlockIDs: row.expandedBlockIDs
            )
            jobs.append((index, row, currentGeneration, preparer))
        }
        guard !jobs.isEmpty else { return }

        let measurements = await withTaskGroup(of: RestoreMeasurement.self) { group in
            for job in jobs {
                group.addTask {
                    let block = await Task.detached(priority: .userInitiated) {
                        await job.preparer.prepare(row: job.row)
                    }.value
                    return RestoreMeasurement(
                        index: job.index,
                        rowID: job.row.id,
                        generation: job.generation,
                        block: block
                    )
                }
            }
            var output: [RestoreMeasurement] = []
            for await result in group { output.append(result) }
            return output
        }

        await MainActor.run {
            for measurement in measurements {
                guard self.generation[measurement.rowID] == measurement.generation else { continue }
                self.prepared[measurement.rowID] = measurement.block
                self.measuredHeights[measurement.rowID] = measurement.block.height
                self.preparing.remove(measurement.rowID)
                self.preparationTask[measurement.rowID]?.cancel()
                self.preparationTask[measurement.rowID] = nil
                let indexPath = IndexPath(row: measurement.index, section: 0)
                if self.tableView.indexPathsForVisibleRows?.contains(indexPath) == true {
                    self.tableView.reloadRows(at: [indexPath], with: .none)
                }
            }
        }
    }

    private func prepareRowForRestore(at index: Int) async {
        await measureAndApplyBatch([index])
    }

    private func showRestoreProgress(completed: Int, total: Int) {
        loadingLabel.text = "Restoring checkpoint… \(completed)/\(total)"
        loadingOverlay.isHidden = false
        loadingOverlay.isAccessibilityElement = false
        loadingSpinner.startAnimating()
    }

    /// Ensures the currently visible viewport is measured, then returns an
    /// exact position. Used by note creation so notes never store estimates.
    func currentExactPosition() async -> ReaderPosition? {
        let visible = tableView.indexPathsForVisibleRows?.map(\.row) ?? []
        if let top = visible.min() {
            await prepareRowsThrough(top)
        }
        return currentMeasuredPosition()
    }

    private func measuredOffset(for position: ReaderPosition) -> CGFloat {
        guard !rows.isEmpty else { return 0 }
        if let anchorID = position.anchorBlockID,
           let targetIndex = rows.firstIndex(where: { $0.blockIDs.contains(anchorID) }) {
            var cumulative: CGFloat = 0
            for index in 0..<targetIndex {
                guard let height = measuredHeights[rows[index].id] else {
                    return CGFloat(max(position.verticalPosition, 0))
                }
                cumulative += max(height, 1)
            }
            guard let rowHeight = measuredHeights[rows[targetIndex].id] else {
                return CGFloat(max(position.verticalPosition, 0))
            }
            let fraction = min(max(position.anchorFraction, 0), 1)
            if let local = locateInRow(rows[targetIndex], blockID: anchorID) {
                return cumulative + local.offset + CGFloat(fraction) * max(local.height, 1)
            }
            return cumulative + CGFloat(fraction) * max(rowHeight, 1)
        }
        // Legacy desktop pixel position (no anchor). This is not a fraction of
        // an estimated row; it is the stored pixel value.
        return CGFloat(max(position.verticalPosition, 0))
    }

    private func measuredRowStart(_ index: Int) -> CGFloat {
        guard index > 0 else { return 0 }
        var cumulative: CGFloat = 0
        for rowIndex in 0..<min(index, rows.count) {
            cumulative += max(measuredHeights[rows[rowIndex].id] ?? rows[rowIndex].estimatedHeight, 1)
        }
        return cumulative
    }

    func restore(position: ReaderPosition?, applyDeepLinkOffset: Bool) async {
        isRestoring = true
        defer { isRestoring = false }
        var targetIndex: Int?
        var rowStart: CGFloat = 0
        var desired: CGFloat = 0

        if let position {
            if let anchor = position.anchorBlockID,
               let index = rows.firstIndex(where: { $0.blockIDs.contains(anchor) }) {
                await expandDetailsAncestors(of: anchor)
                targetIndex = index
                await prepareRowsThrough(index)
                flushMeasuredHeights()
                rowStart = measuredRowStart(index)
                desired = measuredOffset(for: position)
            } else if position.verticalPosition > 0 {
                // Legacy desktop pixel position without an anchor. Measure
                // rows from the top in small concurrent batches until the
                // measured cumulative height reaches the stored position;
                // never trust estimated heights for the clamp.
                var cumulative: CGFloat = 0
                var index = 0
                let showProgress = rows.count > 6
                if showProgress { showRestoreProgress(completed: 0, total: rows.count) }
                while index < rows.count {
                    let end = min(index + 2, rows.count - 1)
                    await measureAndApplyBatch(Array(index...end))
                    var found = false
                    for rowIndex in index...end {
                        let height = max(
                            measuredHeights[rows[rowIndex].id] ?? rows[rowIndex].estimatedHeight,
                            1
                        )
                        if cumulative + height >= CGFloat(position.verticalPosition) {
                            targetIndex = rowIndex
                            rowStart = cumulative
                            desired = CGFloat(position.verticalPosition)
                            found = true
                            break
                        }
                        cumulative += height
                        if rowIndex == rows.count - 1 {
                            targetIndex = rowIndex
                            rowStart = cumulative - height
                            desired = cumulative
                            found = true
                        }
                    }
                    if showProgress {
                        showRestoreProgress(completed: min(end + 1, rows.count), total: rows.count)
                    }
                    if found { break }
                    index = end + 1
                }
                if showProgress {
                    loadingOverlay.isHidden = true
                    loadingSpinner.stopAnimating()
                    loadingLabel.text = "Preparing lesson…"
                }
                flushMeasuredHeights()
            } else {
                flushMeasuredHeights()
                desired = 0
            }
        } else {
            flushMeasuredHeights()
        }

        let inset = tableView.adjustedContentInset.top
        let adjustment = applyDeepLinkOffset ? deepLinkOffset : 0
        if let targetIndex {
            // A deep UITableView cannot necessarily scroll to a content offset
            // beyond its currently realized content size. Position the target
            // row first, then apply the intra-row anchor offset.
            tableView.scrollToRow(
                at: IndexPath(row: targetIndex, section: 0),
                at: .top,
                animated: false
            )
            let y = tableView.contentOffset.y + (desired - rowStart) + adjustment
            let maxY = max(tableView.contentSize.height - tableView.bounds.height + inset, -inset)
            tableView.setContentOffset(CGPoint(x: 0, y: min(max(y, -inset), maxY)), animated: false)
        } else {
            let y = max(desired + adjustment, 0) - inset
            let maxY = max(tableView.contentSize.height - tableView.bounds.height + inset, -inset)
            tableView.setContentOffset(CGPoint(x: 0, y: min(max(y, -inset), maxY)), animated: false)
        }
        prepareVisibleRows()
    }

    /// Installing background-measured heights does not automatically resize
    /// the table's content size. Rebuild row heights and lay out before
    /// restoring a deep offset, otherwise the content offset is clamped to the
    /// old (estimated) content height.
    private func flushMeasuredHeights() {
        tableView.reloadData()
        tableView.layoutIfNeeded()
    }

    /// Prepares the anchor row, then scrolls to its exact prose anchor (or row
    /// top for container blocks).
    func scrollToBlock(_ blockID: String) async {
        await expandDetailsAncestors(of: blockID)
        guard let index = rowIndex(containing: blockID) else { return }
        await prepareRowsThrough(index)
        flushMeasuredHeights()
        let row = rows[index]
        let local = locateInRow(row, blockID: blockID)?.offset ?? 0
        tableView.scrollToRow(
            at: IndexPath(row: index, section: 0),
            at: .top,
            animated: false
        )
        let inset = tableView.adjustedContentInset.top
        let maxY = max(tableView.contentSize.height - tableView.bounds.height + inset, -inset)
        let y = min(max(tableView.contentOffset.y + local, -inset), maxY)
        tableView.setContentOffset(CGPoint(x: 0, y: y), animated: true)
        flashBlock(blockID, rowIndex: index)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.flashBlock(blockID, rowIndex: index)
        }
    }

    // MARK: - Testing hooks

    func waitForInitialLoadForTesting() async {
        for _ in 0..<240 {
            if isInitialLoadComplete { return }
            try? await Task.sleep(nanoseconds: 25_000_000)
        }
    }

    func waitForRestoreForTesting() async {
        for _ in 0..<240 {
            if !isRestoring && !isRebuilding && preparing.isEmpty { return }
            try? await Task.sleep(nanoseconds: 25_000_000)
        }
    }

    func currentPositionForTesting() -> ReaderPosition {
        currentPosition()
    }

    func contentOffsetForTesting() -> CGPoint {
        tableView.contentOffset
    }

    func rowHeightsForTesting() -> [(String, CGFloat)] {
        rows.map { row in (row.id, prepared[row.id]?.height ?? row.estimatedHeight) }
    }

    func contentSizeForTesting() -> CGSize {
        tableView.contentSize
    }

    func visibleBlockIDsForTesting() -> [String] {
        let indices = tableView.indexPathsForVisibleRows?.map(\.row) ?? []
        return indices.flatMap { rows[$0].blockIDs }
    }

    func expandedDetailsForTesting() -> Set<String> {
        rows.reduce(into: Set<String>()) { result, row in
            result.formUnion(row.expandedBlockIDs)
        }
    }

    func isBlockVisibleForTesting(_ blockID: String) -> Bool {
        guard let index = rowIndex(containing: blockID),
              let local = locateInRow(rows[index], blockID: blockID) else { return false }
        let rowStart = measuredRowStart(index)
        let visibleTop = tableView.contentOffset.y + tableView.adjustedContentInset.top
        let visibleBottom = visibleTop + tableView.bounds.height
        let blockTop = rowStart + local.offset
        let blockBottom = blockTop + local.height
        return blockBottom > visibleTop && blockTop < visibleBottom
    }

    func setContentOffsetForTesting(_ y: CGFloat) {
        tableView.setContentOffset(CGPoint(x: 0, y: y), animated: false)
    }

    func preparedRowCountForTesting() -> Int {
        prepared.count
    }

    func themeForTesting() -> ReaderTheme {
        theme
    }

    /// True when every visible prose text view's laid-out height fits the
    /// prepared row height (no clipping at large Dynamic Type).
    func visibleProseFitsForTesting() -> Bool {
        for indexPath in tableView.indexPathsForVisibleRows ?? [] {
            guard let cell = tableView.cellForRow(at: indexPath) as? ReaderBlockCell,
                  let prose = cell.blockView as? ProseBlockView else { continue }
            prose.layoutIfNeeded()
            if prose.proseContentHeightForTesting > prose.bounds.height + 1 {
                return false
            }
        }
        return true
    }


    private func flashBlock(_ blockID: String, rowIndex: Int) {
        guard tableView.indexPathsForVisibleRows?.contains(IndexPath(row: rowIndex, section: 0)) == true else { return }
        if let cell = tableView.cellForRow(at: IndexPath(row: rowIndex, section: 0)) as? ReaderBlockCell {
            cell.blockView?.flash(anchorID: blockID)
        }
    }

    private func flashRow(_ rowIndex: Int) {
        if let cell = tableView.cellForRow(at: IndexPath(row: rowIndex, section: 0)) as? ReaderBlockCell {
            cell.blockView?.flash(anchorID: nil)
        }
    }

    private func applyDetailsToggle(blockID: String, expanded: Bool) {
        guard let index = rows.firstIndex(where: { $0.blockIDs.contains(blockID) }) else { return }
        let anchor = currentPosition()
        if expanded {
            rows[index].expandedBlockIDs.insert(blockID)
        } else {
            rows[index].expandedBlockIDs.remove(blockID)
        }
        pendingRestore = anchor
        pendingRestoreRowID = rows[index].id
        invalidateRow(index)
    }

    private func refreshVisibleTableStates() {
        for indexPath in tableView.indexPathsForVisibleRows ?? [] {
            if let cell = tableView.cellForRow(at: indexPath) as? ReaderBlockCell {
                cell.blockView?.applyStoredTableState()
            }
        }
    }

    // MARK: - UITableView

    func numberOfSections(in tableView: UITableView) -> Int { 1 }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        rows.count
    }

    func tableView(_ tableView: UITableView, estimatedHeightForRowAt indexPath: IndexPath) -> CGFloat {
        // Returning the measured/estimated height for every row lets a deep
        // scrollToRow compute a valid content position even before all cells
        // have been realized.
        let row = rows[indexPath.row]
        return max(prepared[row.id]?.height ?? row.estimatedHeight, 1)
    }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        let row = rows[indexPath.row]
        return max(prepared[row.id]?.height ?? row.estimatedHeight, 1)
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let row = rows[indexPath.row]
        guard let block = prepared[row.id] else {
            prepareRow(at: indexPath.row)
            return tableView.dequeueReusableCell(withIdentifier: "loading", for: indexPath)
        }
        let cell = tableView.dequeueReusableCell(withIdentifier: "block", for: indexPath) as! ReaderBlockCell
        let context = ReaderBlockContext(
            rowID: row.id,
            documentID: document.id,
            theme: theme,
            tableScrollState: tableScrollState,
            outerScrollView: tableView,
            delegate: self,
            isNested: false
        )
        cell.configure(prepared: block, context: context)
        return cell
    }

    func tableView(_ tableView: UITableView, willDisplay cell: UITableViewCell, forRowAt indexPath: IndexPath) {
        prepareRow(at: indexPath.row)
        if indexPath.row % 4 == 0 {
            prepareVisibleRows()
        }
    }

    func tableView(_ tableView: UITableView, didEndDisplaying cell: UITableViewCell, forRowAt indexPath: IndexPath) {
        if let cell = cell as? ReaderBlockCell {
            cell.blockView?.prepareForReuse()
        }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === tableView else { return }
        schedulePositionReport()
        if isVisible {
            prepareVisibleRows()
        }
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { schedulePositionReport() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        schedulePositionReport()
    }
}

// MARK: - ReaderBlockViewDelegate

extension ReaderViewController: ReaderBlockViewDelegate {
    func readerBlock(_ view: ReaderBlockView, open url: URL) {
        switch ReaderLinkResolver.resolve(url, courseDirectoryURL: document.courseDirectoryURL) {
        case let .external(external):
            let scheme = external.scheme?.lowercased()
            if scheme == "http" || scheme == "https" {
                let safari = SFSafariViewController(url: external)
                safari.preferredControlTintColor = view.tintColor
                present(safari, animated: true)
            } else {
                UIApplication.shared.open(external)
            }

        case let .localFile(file):
            DocumentViewer.present(url: file, title: nil, from: self)

        case let .fragment(fragment):
            if rowIndex(containing: fragment) != nil {
                Task { await scrollToBlock(fragment) }
            } else {
                // A heading slug may not be a block ID; search headings by
                // normalized text before giving up.
                if let headingID = headingBlockID(matchingFragment: fragment) {
                    Task { await scrollToBlock(headingID) }
                } else {
                    showLinkAlert("Link unavailable", message: "The target “#\(fragment)” was not found in this document.")
                }
            }

        case let .deepLink(route):
            NotificationCenter.default.post(name: .courseDeckOpenDeepLink, object: route)

        case let .missing(name):
            showLinkAlert(
                "Link unavailable",
                message: "“\(name)” is not inside this course’s asset folder or was not imported."
            )

        case let .unsupported(value):
            showLinkAlert("Unsupported link", message: "This build cannot open “\(value)”.")
        }
    }

    private func headingBlockID(matchingFragment fragment: String) -> String? {
        let normalized = fragment
            .replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        for row in rows {
            guard case let .prose(run) = row.kind else { continue }
            for (index, segment) in run.segments.enumerated() {
                guard case let .heading(_, inlines, _) = segment else { continue }
                let text = inlines.plainText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if text == normalized || normalized.isEmpty {
                    return index < run.segmentIDs.count ? run.segmentIDs[index] : row.blockIDs.first
                }
            }
        }
        return nil
    }

    private func showLinkAlert(_ title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    func readerBlock(_ view: ReaderBlockView, openTable preparedTable: ReaderPreparedTable, tableID: String) {
        let controller = TableFullScreenViewController(
            prepared: preparedTable,
            theme: theme,
            documentID: document.id,
            tableID: tableID,
            title: document.title,
            stateStore: tableScrollState,
            courseDirectoryURL: document.courseDirectoryURL
        ) { [weak self] in
            self?.refreshVisibleTableStates()
        }
        let navigation = UINavigationController(rootViewController: controller)
        navigation.modalPresentationStyle = .fullScreen
        present(navigation, animated: true)
    }

    func readerBlock(_ view: ReaderBlockView, openImage image: UIImage, title: String?) {
        DocumentViewer.presentImage(image, title: title, from: self)
    }

    func readerBlock(_ view: ReaderBlockView, loadRemoteImageForRow rowID: String, block: ReaderPreparedImage) {
        let alert = UIAlertController(
            title: "Load remote image?",
            message: "This lesson references an image on \(URL(string: block.model.destination)?.host ?? "a remote server"). Loading it sends a request to that server.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Load image", style: .default) { [weak self] _ in
            guard let self else { return }
            self.remoteApprovedRows.insert(rowID)
            if let index = self.rows.firstIndex(where: { $0.id == rowID }) {
                self.invalidateRow(index)
            }
        })
        present(alert, animated: true)
    }

    func readerBlock(_ view: ReaderBlockView, toggleDetails blockID: String, expanded: Bool) {
        applyDetailsToggle(blockID: blockID, expanded: expanded)
    }

    func readerBlock(_ view: ReaderBlockView, jumpToBlock blockID: String) {
        Task { [weak self] in
            await self?.scrollToBlock(blockID)
        }
    }

    func readerBlock(_ view: ReaderBlockView, copy text: String) {
        UIPasteboard.general.string = text
        UIAccessibility.post(notification: .announcement, argument: "Copied")
    }

    func readerBlock(_ view: ReaderBlockView, showTeX tex: String, sourceView: UIView) {
        let alert = UIAlertController(title: "TeX source", message: tex, preferredStyle: .actionSheet)
        alert.addAction(UIAlertAction(title: "Copy TeX", style: .default) { _ in
            UIPasteboard.general.string = tex
            UIAccessibility.post(notification: .announcement, argument: "TeX copied")
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        if let popover = alert.popoverPresentationController {
            popover.sourceView = sourceView
            popover.sourceRect = sourceView.bounds
        }
        present(alert, animated: true)
    }

    private func rowIndex(containing blockID: String) -> Int? {
        rows.firstIndex(where: { $0.blockIDs.contains(blockID) })
    }
}

// MARK: - Preparation limiter

actor ReaderPreparationLimiter {
    private let limit: Int
    private var active = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(limit: Int) {
        self.limit = max(1, limit)
    }

    func acquire() async {
        if active < limit {
            active += 1
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func release() {
        if waiters.isEmpty {
            active = max(active - 1, 0)
        } else {
            let continuation = waiters.removeFirst()
            continuation.resume()
        }
    }
}
