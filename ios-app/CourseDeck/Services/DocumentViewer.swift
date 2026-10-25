import PDFKit
import QuickLook
import UIKit

/// Native document viewer used by image cells, image links, PDF links, and
/// office/HTML attachments. It never renders through a web view: PDFs use
/// PDFKit, images use a zoomable scroll view, and everything else uses Quick
/// Look.
enum DocumentViewer {
    @MainActor
    static func presentImage(
        _ image: UIImage,
        title: String?,
        from presenter: UIViewController
    ) {
        let viewer = ImageDocumentViewController(image: image, title: title)
        let navigation = UINavigationController(rootViewController: viewer)
        navigation.modalPresentationStyle = .fullScreen
        presenter.present(navigation, animated: true)
    }

    @MainActor
    static func present(url: URL, title: String?, from presenter: UIViewController) {
        guard FileManager.default.fileExists(atPath: url.path) else {
            presentMissing(url: url, from: presenter)
            return
        }
        let extensionName = url.pathExtension.lowercased()
        if extensionName == "pdf" {
            guard PDFDocument(url: url) != nil else {
                presentMissing(url: url, from: presenter)
                return
            }
            let viewer = PDFDocumentViewController(url: url, title: title)
            let navigation = UINavigationController(rootViewController: viewer)
            navigation.modalPresentationStyle = .fullScreen
            presenter.present(navigation, animated: true)
            return
        }
        if ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].contains(extensionName),
           let data = try? Data(contentsOf: url),
           let image = UIImage(data: data) {
            presentImage(image, title: title, from: presenter)
            return
        }
        let preview = QuickLookAttachmentViewController(url: url, title: title)
        presenter.present(preview, animated: true)
    }

    @MainActor
    private static func presentMissing(url: URL, from presenter: UIViewController) {
        let alert = UIAlertController(
            title: "File not available",
            message: "\(url.lastPathComponent) is not on this device. It may be an attachment that was not imported.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        presenter.present(alert, animated: true)
    }
}

// MARK: - Image

final class ImageDocumentViewController: UIViewController, UIScrollViewDelegate {
    private let image: UIImage
    private let scrollView = UIScrollView()
    private let imageView = UIImageView()
    private let titleText: String?

    init(image: UIImage, title: String?) {
        self.image = image
        self.titleText = title
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = titleText ?? "Image"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .close,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) }
        )
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .action,
            primaryAction: UIAction { [weak self] _ in self?.share() }
        )

        scrollView.delegate = self
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 6
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        view.addSubview(scrollView)

        imageView.image = image
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        imageView.accessibilityLabel = titleText
        imageView.accessibilityTraits = .image
        scrollView.addSubview(imageView)

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        guard scrollView.zoomScale == 1 else { return }
        layoutImage()
    }

    private func layoutImage() {
        let bounds = scrollView.bounds.size
        guard bounds.width > 0, bounds.height > 0 else { return }
        let imageSize = image.size
        guard imageSize.width > 0, imageSize.height > 0 else { return }
        let scale = min(bounds.width / imageSize.width, bounds.height / imageSize.height)
        let size = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        imageView.frame = CGRect(
            x: max((bounds.width - size.width) / 2, 0),
            y: max((bounds.height - size.height) / 2, 0),
            width: size.width,
            height: size.height
        )
        scrollView.contentSize = CGSize(width: max(size.width, bounds.width), height: max(size.height, bounds.height))
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        imageView
    }

    @objc private func doubleTap(_ gesture: UITapGestureRecognizer) {
        if scrollView.zoomScale > 1 {
            scrollView.setZoomScale(1, animated: true)
        } else {
            let point = gesture.location(in: imageView)
            let size = CGSize(width: scrollView.bounds.width / 3, height: scrollView.bounds.height / 3)
            scrollView.zoom(to: CGRect(
                x: point.x - size.width / 2,
                y: point.y - size.height / 2,
                width: size.width,
                height: size.height
            ), animated: true)
        }
    }

    private func share() {
        let activity = UIActivityViewController(activityItems: [image], applicationActivities: nil)
        activity.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItem
        present(activity, animated: true)
    }
}

// MARK: - PDF

final class PDFDocumentViewController: UIViewController {
    private let url: URL
    private let titleText: String?
    private let pdfView = PDFView()

    init(url: URL, title: String?) {
        self.url = url
        self.titleText = title
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = titleText ?? url.lastPathComponent
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .close,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) }
        )
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .action,
            primaryAction: UIAction { [weak self] _ in self?.share() }
        )
        pdfView.document = PDFDocument(url: url)
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        view.addSubview(pdfView)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        pdfView.frame = view.bounds
    }

    private func share() {
        let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        activity.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItem
        present(activity, animated: true)
    }
}

// MARK: - Quick Look

final class QuickLookAttachmentViewController: UINavigationController, QLPreviewControllerDataSource {
    private let url: URL

    init(url: URL, title: String?) {
        self.url = url
        let preview = QLPreviewController()
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        preview.dataSource = self
        setViewControllers([preview], animated: false)
        preview.navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .close,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) }
        )
        preview.title = title ?? url.lastPathComponent
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        1
    }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        url as NSURL
    }
}
