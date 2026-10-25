import CourseDeckCore
import UIKit

/// Full-screen table route. It shares `TableScrollStateStore` with the
/// embedded viewport so the same horizontal/vertical offsets are restored on
/// both sides. Column widths are re-measured for the larger width.
final class TableFullScreenViewController: UIViewController {
    private var prepared: ReaderPreparedTable
    private let theme: ReaderTheme
    private let documentID: String
    private let tableID: String
    private let tableTitle: String
    private let stateStore: TableScrollStateStore
    private let courseDirectoryURL: URL
    private let onClose: () -> Void

    private let grid = TableGridView()
    private var measuredWidth: CGFloat = 0
    private var measurementTask: Task<Void, Never>?

    init(
        prepared: ReaderPreparedTable,
        theme: ReaderTheme,
        documentID: String,
        tableID: String,
        title: String,
        stateStore: TableScrollStateStore,
        courseDirectoryURL: URL,
        onClose: @escaping () -> Void
    ) {
        self.prepared = prepared
        self.theme = theme
        self.documentID = documentID
        self.tableID = tableID
        self.tableTitle = title
        self.stateStore = stateStore
        self.courseDirectoryURL = courseDirectoryURL
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.title = tableTitle.isEmpty ? "Table" : tableTitle
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .done,
            primaryAction: UIAction { [weak self] _ in
                self?.finish()
            }
        )
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            image: UIImage(systemName: "ellipsis.circle"),
            menu: UIMenu(children: [
                UIAction(title: "Copy Table as TSV", image: UIImage(systemName: "tablecells")) { [weak self] _ in
                    guard let self else { return }
                    UIPasteboard.general.string = self.prepared.table.tsv(includeHeader: true)
                },
                UIAction(title: "Copy Table Header", image: UIImage(systemName: "rectangle.topthird.inset.filled")) { [weak self] _ in
                    guard let self else { return }
                    UIPasteboard.general.string = self.prepared.table.header
                        .map(\.plainText)
                        .joined(separator: "\t")
                },
            ])
        )
        grid.configure(
            prepared: prepared,
            theme: theme,
            documentID: documentID,
            tableID: tableID,
            stateStore: stateStore,
            outerScrollView: nil,
            isFullScreen: true,
            onOpenDestination: { [weak self] destination, _ in
                self?.openDestination(destination)
            },
            onShowTeX: { [weak self] tex, sourceView in
                self?.showTeX(tex, sourceView: sourceView)
            }
        )
        view.addSubview(grid)
        grid.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            grid.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            grid.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            grid.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            grid.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let available = max(view.bounds.width - 32, 240)
        guard abs(available - measuredWidth) > 1 else { return }
        measuredWidth = available
        remeasure(for: available)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        grid.applyStoredState()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        measurementTask?.cancel()
    }

    private func remeasure(for width: CGFloat) {
        measurementTask?.cancel()
        let prepared = self.prepared
        let theme = self.theme
        measurementTask = Task { [weak self] in
            let metrics = await Task.detached(priority: .userInitiated) {
                TableGridMeasurer.measure(
                    table: prepared.table,
                    availableWidth: width,
                    theme: theme,
                    headerAttributed: prepared.headerAttributed,
                    bodyAttributed: prepared.bodyAttributed
                )
            }.value
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self else { return }
                var updated = prepared
                updated.metrics = metrics
                updated.totalHeight = metrics.totalHeight
                self.prepared = updated
                self.grid.configure(
                    prepared: updated,
                    theme: theme,
                    documentID: self.documentID,
                    tableID: self.tableID,
                    stateStore: self.stateStore,
                    outerScrollView: nil,
                    isFullScreen: true,
                    onOpenDestination: { [weak self] destination, _ in
                        self?.openDestination(destination)
                    },
                    onShowTeX: { [weak self] tex, sourceView in
                        self?.showTeX(tex, sourceView: sourceView)
                    }
                )
                self.view.layoutIfNeeded()
                self.grid.layoutIfNeeded()
                self.grid.applyStoredState()
            }
        }
    }

    private func finish() {
        onClose()
        dismiss(animated: true)
    }

    private func openDestination(_ destination: String) {
        guard let url = URL(string: destination) else { return }
        switch ReaderLinkResolver.resolve(url, courseDirectoryURL: courseDirectoryURL) {
        case let .external(external):
            UIApplication.shared.open(external)
        case let .localFile(file):
            DocumentViewer.present(url: file, title: nil, from: self)
        case let .deepLink(route):
            NotificationCenter.default.post(name: .courseDeckOpenDeepLink, object: route)
        case let .missing(name):
            showAlert("Link unavailable", "“\(name)” was not found in this course.")
        case let .fragment(fragment):
            showAlert("Link unavailable", "The target “#\(fragment)” is only available in the reader.")
        case let .unsupported(value):
            showAlert("Unsupported link", "This build cannot open “\(value)”.")
        }
    }

    private func showTeX(_ tex: String, sourceView: UIView) {
        let alert = UIAlertController(title: "TeX source", message: tex, preferredStyle: .actionSheet)
        alert.addAction(UIAlertAction(title: "Copy TeX", style: .default) { _ in
            UIPasteboard.general.string = tex
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        if let popover = alert.popoverPresentationController {
            popover.sourceView = sourceView
            popover.sourceRect = sourceView.bounds
        }
        present(alert, animated: true)
    }

    private func showAlert(_ title: String, _ message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}
