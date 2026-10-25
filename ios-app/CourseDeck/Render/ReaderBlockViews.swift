import CourseDeckCore
import UIKit

struct ReaderBlockContext {
    var rowID: String
    var documentID: String
    var theme: ReaderTheme
    var tableScrollState: TableScrollStateStore
    weak var outerScrollView: UIScrollView?
    weak var delegate: ReaderBlockViewDelegate?
    var isNested: Bool
}

protocol ReaderBlockViewDelegate: AnyObject {
    func readerBlock(_ view: ReaderBlockView, open url: URL)
    func readerBlock(_ view: ReaderBlockView, openTable prepared: ReaderPreparedTable, tableID: String)
    func readerBlock(_ view: ReaderBlockView, openImage image: UIImage, title: String?)
    func readerBlock(_ view: ReaderBlockView, loadRemoteImageForRow rowID: String, block: ReaderPreparedImage)
    func readerBlock(_ view: ReaderBlockView, toggleDetails blockID: String, expanded: Bool)
    func readerBlock(_ view: ReaderBlockView, jumpToBlock blockID: String)
    func readerBlock(_ view: ReaderBlockView, copy text: String)
    func readerBlock(_ view: ReaderBlockView, showTeX tex: String, sourceView: UIView)
}

class ReaderBlockView: UIView {
    private(set) var kindKey: String = ""
    var context: ReaderBlockContext?

    func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        self.context = context
        kindKey = ReaderBlockViewFactory.key(for: prepared)
    }

    func findOuterScrollView() -> UIScrollView? {
        context?.outerScrollView
    }

    /// Called when a cell leaves the screen. Subclasses that hold scroll state
    /// keep it in the app-scoped store, so the default is a no-op.
    func prepareForReuse() {}

    /// Brief target highlight used by USERNOTE anchor jumps.
    func flash(anchorID: String?) {
        let original = backgroundColor
        UIView.animate(withDuration: 0.18, animations: {
            self.backgroundColor = UIColor.systemYellow.withAlphaComponent(0.3)
        }, completion: { _ in
            UIView.animate(withDuration: 0.7, delay: 0.25, animations: {
                self.backgroundColor = original
            })
        })
    }

    /// Re-applies table offsets after the full-screen table route changes them.
    func applyStoredTableState() {}
}

enum ReaderBlockViewFactory {
    static func key(for prepared: ReaderPreparedBlock) -> String {
        switch prepared {
        case .prose: return "prose"
        case .taskList: return "tasks"
        case .code: return "code"
        case .image: return "image"
        case .math: return "math"
        case .table: return "table"
        case .callout(let value):
            switch value.kind {
            case .callout: return "callout"
            case .quote: return "quote"
            case .list: return "list"
            }
        case .details: return "details"
        case .userNote: return "usernote"
        case .separator: return "separator"
        case .fallback: return "fallback"
        }
    }

    static func make(prepared: ReaderPreparedBlock) -> ReaderBlockView {
        switch prepared {
        case .prose: return ProseBlockView()
        case .taskList: return TaskListBlockView()
        case .code: return CodeBlockView()
        case .image: return ImageBlockView()
        case .math: return MathBlockView()
        case .table: return TableBlockView()
        case .callout(let value):
            switch value.kind {
            case .callout: return CalloutBlockView()
            case .quote: return QuoteBlockView()
            case .list: return ListBlockView()
            }
        case .details: return DetailsBlockView()
        case .userNote: return UserNoteBlockView()
        case .separator: return SeparatorBlockView()
        case .fallback: return FallbackBlockView()
        }
    }
}

// MARK: - Prose

final class ProseBlockView: ReaderBlockView, UITextViewDelegate {
    private let textView = UITextView()
    private var prepared: ReaderPreparedProse?

    override init(frame: CGRect) {
        super.init(frame: frame)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isScrollEnabled = false
        textView.backgroundColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.dataDetectorTypes = []
        textView.delegate = self
        textView.adjustsFontForContentSizeCategory = false
        textView.linkTextAttributes = [
            .foregroundColor: UIColor.tintColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        textView.accessibilityTraits = .staticText
        textView.accessibilityIdentifier = "reader.prose"
        addSubview(textView)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.cancelsTouchesInView = false
        textView.addGestureRecognizer(tap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .prose(value) = prepared else { return }
        self.prepared = value
        textView.attributedText = value.attributed
        textView.accessibilityLabel = value.spokenText
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let context else { return }
        textView.frame = bounds.inset(by: context.theme.proseInsets)
    }

    func textView(
        _ textView: UITextView,
        shouldInteractWith URL: URL,
        in characterRange: NSRange,
        interaction: UITextItemInteraction
    ) -> Bool {
        context?.delegate?.readerBlock(self, open: URL)
        return false
    }

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard let prepared else { return }
        let point = gesture.location(in: textView)
        guard let position = textView.closestPosition(to: point) else { return }
        let offset = textView.offset(from: textView.beginningOfDocument, to: position)
        guard offset >= 0, offset < prepared.attributed.length else { return }
        if let tex = prepared.attributed.attribute(.readerTeX, at: offset, effectiveRange: nil) as? String {
            context?.delegate?.readerBlock(self, showTeX: tex, sourceView: textView)
        } else if let destination = prepared.attributed.attribute(.readerImageDestination, at: offset, effectiveRange: nil) as? String,
                  let url = URL(string: destination) {
            context?.delegate?.readerBlock(self, open: url)
        }
    }

    override func flash(anchorID: String?) {
        guard let anchorID,
              let prepared,
              let anchor = prepared.anchors.first(where: { $0.blockID == anchorID }) else {
            super.flash(anchorID: anchorID)
            return
        }
        let inset = context?.theme.proseInsets ?? .zero
        let highlight = UIView()
        highlight.backgroundColor = UIColor.systemYellow.withAlphaComponent(0.35)
        highlight.layer.cornerRadius = 3
        highlight.frame = CGRect(
            x: inset.left - 3,
            y: inset.top + anchor.top - 2,
            width: max(bounds.width - inset.left - inset.right + 6, 20),
            height: max(anchor.height + 4, 20)
        )
        highlight.isUserInteractionEnabled = false
        insertSubview(highlight, belowSubview: textView)
        UIView.animate(withDuration: 1.2, delay: 0.4, animations: {
            highlight.alpha = 0
        }, completion: { _ in
            highlight.removeFromSuperview()
        })
    }

    var accessibilityTextForTesting: String? {
        textView.accessibilityLabel
    }

    var proseContentHeightForTesting: CGFloat {
        guard textView.bounds.width > 1 else { return 0 }
        return textView.sizeThatFits(
            CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)
        ).height
    }
}

// MARK: - Code

final class CodeBlockView: ReaderBlockView {
    private let header = UIView()
    private let languageLabel = UILabel()
    private let copyButton = UIButton(type: .system)
    private let scrollView = ReaderHandoffScrollView()
    private let codeLabel = UILabel()
    private var prepared: ReaderPreparedCode?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 10
        layer.masksToBounds = true

        languageLabel.font = .preferredFont(forTextStyle: .caption1)
        languageLabel.textColor = .secondaryLabel
        languageLabel.adjustsFontForContentSizeCategory = true
        header.addSubview(languageLabel)

        copyButton.setImage(UIImage(systemName: "doc.on.doc"), for: .normal)
        copyButton.accessibilityLabel = "Copy code"
        copyButton.addTarget(self, action: #selector(copyCode), for: .touchUpInside)
        header.addSubview(copyButton)

        codeLabel.numberOfLines = 0
        codeLabel.lineBreakMode = .byClipping
        codeLabel.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        codeLabel.textColor = .label
        scrollView.addSubview(codeLabel)
        scrollView.alwaysBounceVertical = false
        scrollView.showsVerticalScrollIndicator = true
        scrollView.showsHorizontalScrollIndicator = true
        addSubview(header)
        addSubview(scrollView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .code(value) = prepared else { return }
        self.prepared = value
        languageLabel.text = value.language?.uppercased() ?? "CODE"
        codeLabel.attributedText = value.attributed
        scrollView.handoffScrollView = context.outerScrollView
        scrollView.setContentOffset(.zero, animated: false)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        header.frame = CGRect(x: 0, y: 0, width: bounds.width, height: 36)
        languageLabel.frame = CGRect(x: 14, y: 8, width: bounds.width - 60, height: 20)
        copyButton.frame = CGRect(x: bounds.width - 42, y: 6, width: 32, height: 28)
        let viewport = CGRect(x: 0, y: 36, width: bounds.width, height: max(bounds.height - 42, 20))
        scrollView.frame = viewport
        guard let prepared else { return }
        let textWidth = ceil(prepared.attributed.boundingRect(
            with: CGSize(width: 4_000, height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        ).width)
        let labelWidth = min(max(textWidth + 24, viewport.width), 4_100)
        codeLabel.frame = CGRect(
            x: 12,
            y: 8,
            width: labelWidth,
            height: max(prepared.textHeight + 8, viewport.height)
        )
        scrollView.contentSize = CGSize(
            width: max(labelWidth + 16, viewport.width),
            height: max(prepared.textHeight + 16, viewport.height)
        )
    }

    @objc private func copyCode() {
        guard let prepared else { return }
        context?.delegate?.readerBlock(self, copy: prepared.plainText)
    }
}

// MARK: - Math block

final class MathBlockView: ReaderBlockView {
    private let imageView = UIImageView()
    private let fallbackLabel = UILabel()
    private var prepared: ReaderPreparedMath?

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        addSubview(imageView)
        fallbackLabel.numberOfLines = 0
        fallbackLabel.textAlignment = .center
        fallbackLabel.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        fallbackLabel.textColor = .secondaryLabel
        addSubview(fallbackLabel)
        let tap = UITapGestureRecognizer(target: self, action: #selector(copyTeX))
        addGestureRecognizer(tap)
        isAccessibilityElement = true
        accessibilityTraits = .staticText
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .math(value) = prepared else { return }
        self.prepared = value
        imageView.image = value.image
        fallbackLabel.text = value.image == nil ? value.expression.tex : nil
        accessibilityLabel = "Equation: \(value.expression.tex)"
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let prepared else { return }
        let inner = bounds.insetBy(dx: 20, dy: 14)
        if prepared.image != nil {
            let size = prepared.displaySize
            imageView.frame = CGRect(
                x: inner.midX - size.width / 2,
                y: inner.midY - size.height / 2,
                width: size.width,
                height: size.height
            )
            fallbackLabel.frame = .zero
        } else {
            imageView.frame = .zero
            fallbackLabel.frame = inner
        }
    }

    @objc private func copyTeX() {
        guard let prepared else { return }
        context?.delegate?.readerBlock(self, showTeX: prepared.expression.tex, sourceView: self)
    }
}

// MARK: - Image

final class ImageBlockView: ReaderBlockView {
    private let imageView = UIImageView()
    private let captionLabel = UILabel()
    private let placeholder = UIView()
    private let placeholderLabel = UILabel()
    private let loadButton = UIButton(type: .system)
    private var prepared: ReaderPreparedImage?

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        imageView.accessibilityTraits = .image
        addSubview(imageView)
        let tap = UITapGestureRecognizer(target: self, action: #selector(openImage))
        imageView.addGestureRecognizer(tap)

        captionLabel.numberOfLines = 0
        captionLabel.font = .preferredFont(forTextStyle: .caption1)
        captionLabel.textColor = .secondaryLabel
        captionLabel.textAlignment = .center
        addSubview(captionLabel)

        placeholder.backgroundColor = .secondarySystemBackground
        placeholder.layer.cornerRadius = 10
        placeholderLabel.numberOfLines = 0
        placeholderLabel.font = .preferredFont(forTextStyle: .footnote)
        placeholderLabel.textColor = .secondaryLabel
        placeholderLabel.textAlignment = .center
        placeholder.addSubview(placeholderLabel)
        loadButton.setTitle("Load remote image", for: .normal)
        loadButton.addTarget(self, action: #selector(loadRemote), for: .touchUpInside)
        placeholder.addSubview(loadButton)
        addSubview(placeholder)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .image(value) = prepared else { return }
        self.prepared = value
        imageView.image = value.image
        captionLabel.text = value.caption
        let alt = value.model.spec.alt
        if value.image != nil {
            imageView.isHidden = false
            placeholder.isHidden = true
            imageView.accessibilityLabel = value.caption ?? (alt.isEmpty ? "Image" : alt)
        } else {
            imageView.isHidden = true
            placeholder.isHidden = false
            let failure = value.failure ?? "Image unavailable"
            placeholderLabel.text = alt.isEmpty ? failure : "\(alt)\n\(failure)"
            loadButton.isHidden = !value.allowsRemoteLoad
            placeholder.accessibilityLabel = placeholderLabel.text
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let prepared else { return }
        let contentWidth = bounds.width - 40
        let imageHeight = prepared.displaySize.height
        imageView.frame = CGRect(
            x: bounds.midX - prepared.displaySize.width / 2,
            y: 10,
            width: prepared.displaySize.width,
            height: imageHeight
        )
        let captionY = 10 + imageHeight + (prepared.captionHeight > 0 ? 8 : 0)
        captionLabel.frame = CGRect(
            x: 20,
            y: captionY,
            width: contentWidth,
            height: prepared.captionHeight
        )
        placeholder.frame = CGRect(
            x: 20,
            y: 10,
            width: contentWidth,
            height: prepared.displaySize.height
        )
        let buttonHeight: CGFloat = prepared.allowsRemoteLoad ? 32 : 0
        let buttonGap: CGFloat = buttonHeight > 0 ? 8 : 0
        placeholderLabel.frame = CGRect(
            x: 16,
            y: 12,
            width: max(contentWidth - 32, 20),
            height: max(placeholder.frame.height - 24 - buttonHeight - buttonGap, 20)
        )
        loadButton.frame = buttonHeight > 0
            ? CGRect(
                x: 16,
                y: placeholder.frame.height - 12 - buttonHeight,
                width: max(contentWidth - 32, 20),
                height: buttonHeight
            )
            : .zero
    }

    @objc private func openImage() {
        guard let prepared, let image = prepared.image else { return }
        context?.delegate?.readerBlock(
            self,
            openImage: image,
            title: prepared.caption ?? prepared.model.spec.alt
        )
    }

    @objc private func loadRemote() {
        guard let prepared else { return }
        context?.delegate?.readerBlock(
            self,
            loadRemoteImageForRow: context?.rowID ?? "",
            block: prepared
        )
    }

    var placeholderFramesForTesting: (placeholder: CGRect, label: CGRect, button: CGRect) {
        (placeholder.frame, placeholderLabel.frame, loadButton.frame)
    }
}

// MARK: - Task list

final class TaskListBlockView: ReaderBlockView {
    private let headerLabel = UILabel()
    private var rowViews: [TaskRowView] = []
    private var prepared: ReaderPreparedTaskList?

    override init(frame: CGRect) {
        super.init(frame: frame)
        headerLabel.font = .preferredFont(forTextStyle: .caption1)
        headerLabel.textColor = .secondaryLabel
        addSubview(headerLabel)
        accessibilityTraits = .staticText
        accessibilityIdentifier = "reader.tasklist"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .taskList(value) = prepared else { return }
        self.prepared = value
        headerLabel.text = "TASKS · READ-ONLY"
        rowViews.forEach { $0.removeFromSuperview() }
        rowViews = value.items.enumerated().map { index, item in
            let row = TaskRowView()
            row.configure(item: item, index: index + 1)
            addSubview(row)
            return row
        }
        accessibilityLabel = "Task list, \(value.items.count) items, read-only. Edit the Markdown to change task state."
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        headerLabel.frame = CGRect(x: 20, y: 4, width: bounds.width - 40, height: 20)
        var y: CGFloat = 28
        for row in rowViews {
            row.frame = CGRect(x: 20, y: y, width: bounds.width - 40, height: row.itemHeight)
            y += row.itemHeight
        }
    }
}

final class TaskRowView: UIView {
    private let checkView = UIImageView()
    private let label = UILabel()
    private(set) var itemHeight: CGFloat = 28

    func configure(item: ReaderPreparedTaskItem, index: Int) {
        let symbol = item.checked ? "checkmark.square.fill" : "square"
        checkView.image = UIImage(systemName: symbol)
        checkView.tintColor = item.checked ? .systemGreen : .secondaryLabel
        checkView.contentMode = .scaleAspectFit
        if checkView.superview == nil { addSubview(checkView) }
        label.numberOfLines = 0
        label.attributedText = item.attributed
        if label.superview == nil { addSubview(label) }
        itemHeight = item.height
        isAccessibilityElement = true
        accessibilityLabel = "\(item.checked ? "Completed" : "Not completed"): \(item.text)"
        accessibilityHint = "Read-only. Edit the Markdown to change the task state."
        accessibilityTraits = .staticText
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        checkView.frame = CGRect(x: 0, y: 4, width: 22, height: 22)
        label.frame = CGRect(x: 32, y: 0, width: max(bounds.width - 32, 20), height: bounds.height)
    }
}

// MARK: - Separator / fallback

final class SeparatorBlockView: ReaderBlockView {
    private let line = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        line.backgroundColor = .separator
        addSubview(line)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        line.frame = CGRect(x: 20, y: bounds.midY, width: max(bounds.width - 40, 1), height: 1 / max(traitCollection.displayScale, 1))
    }
}

final class FallbackBlockView: ReaderBlockView {
    private let warningLabel = UILabel()
    private let bodyLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemOrange.withAlphaComponent(0.08)
        layer.cornerRadius = 8
        warningLabel.font = .preferredFont(forTextStyle: .caption1)
        warningLabel.textColor = .systemOrange
        warningLabel.numberOfLines = 2
        bodyLabel.font = .preferredFont(forTextStyle: .body)
        bodyLabel.textColor = .label
        bodyLabel.numberOfLines = 0
        addSubview(warningLabel)
        addSubview(bodyLabel)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .fallback(value) = prepared else { return }
        warningLabel.text = "UNSUPPORTED HTML · \(value.warning)"
        bodyLabel.text = value.text
        accessibilityLabel = "\(value.warning). \(value.text)"
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        warningLabel.frame = CGRect(x: 14, y: 10, width: bounds.width - 28, height: 20)
        bodyLabel.frame = CGRect(x: 14, y: 34, width: bounds.width - 28, height: max(bounds.height - 42, 0))
    }
}

// MARK: - Handoff scroll view

/// Nested scroller used by code blocks and the table body. When the inner
/// scroller is at its top/bottom and the drag continues outward, it refuses the
/// pan so the outer reader scroll view receives it. Horizontal drags always
/// stay inside the table/code viewport.
final class ReaderHandoffScrollView: UIScrollView, UIGestureRecognizerDelegate {
    weak var handoffScrollView: UIScrollView?

    override init(frame: CGRect) {
        super.init(frame: frame)
        panGestureRecognizer.delegate = self
        isDirectionalLockEnabled = true
        bounces = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer {
            let velocity = panGestureRecognizer.velocity(in: self)
            if abs(velocity.y) > abs(velocity.x) {
                let top = -adjustedContentInset.top
                let bottom = max(
                    contentSize.height - bounds.height + adjustedContentInset.bottom,
                    top
                )
                if velocity.y > 0, contentOffset.y <= top + 0.5 { return false }
                if velocity.y < 0, contentOffset.y >= bottom - 0.5 { return false }
            }
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
}
