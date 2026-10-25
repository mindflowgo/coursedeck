import CourseDeckCore
import UIKit

// MARK: - Callout

final class CalloutBlockView: ReaderBlockView {
    private let accent = UIView()
    private let iconView = UIImageView()
    private let label = UILabel()
    private var childViews: [ReaderBlockView] = []
    private var prepared: ReaderPreparedContainer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 10
        layer.masksToBounds = true
        accent.layer.cornerRadius = 2
        addSubview(accent)
        iconView.contentMode = .scaleAspectFit
        addSubview(iconView)
        label.font = .preferredFont(forTextStyle: .caption1)
        label.textColor = .secondaryLabel
        label.numberOfLines = 2
        addSubview(label)
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .callout(value) = prepared else { return }
        self.prepared = value
        configureStyle(kind: value.kind)
        label.text = value.label.uppercased()
        childViews.forEach { $0.removeFromSuperview() }
        childViews = value.children.map { child in
            let view = ReaderBlockViewFactory.make(prepared: child.block)
            var childContext = context
            childContext.isNested = true
            view.configure(prepared: child.block, context: childContext)
            addSubview(view)
            return view
        }
        accessibilityLabel = "\(value.label) callout"
        setNeedsLayout()
    }

    private func configureStyle(kind: ReaderContainerKind) {
        var color = UIColor.systemBlue
        var symbol = "info.circle.fill"
        if case let .callout(calloutKind) = kind {
            switch calloutKind {
            case .note:
                color = .systemBlue
                symbol = "info.circle.fill"
            case .tip:
                color = .systemGreen
                symbol = "lightbulb.fill"
            case .important:
                color = .systemPurple
                symbol = "exclamationmark.circle.fill"
            case .warning:
                color = .systemOrange
                symbol = "exclamationmark.triangle.fill"
            case .caution:
                color = .systemRed
                symbol = "exclamationmark.octagon.fill"
            }
        }
        accent.backgroundColor = color
        iconView.image = UIImage(systemName: symbol)
        iconView.tintColor = color
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let prepared else { return }
        accent.frame = CGRect(x: 0, y: 0, width: 4, height: bounds.height)
        iconView.frame = CGRect(x: 14, y: 14, width: 22, height: 22)
        label.frame = CGRect(x: 44, y: 14, width: bounds.width - 58, height: 24)
        var y = prepared.childrenOrigin
        for (index, view) in childViews.enumerated() {
            let height = prepared.children[index].block.height
            view.frame = CGRect(x: 12, y: y, width: bounds.width - 24, height: height)
            y += height + prepared.childSpacing
        }
    }
}

// MARK: - Quote / list containers

final class QuoteBlockView: ReaderBlockView {
    private let bar = UIView()
    private var childViews: [ReaderBlockView] = []
    private var prepared: ReaderPreparedContainer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        bar.backgroundColor = .tertiaryLabel
        bar.layer.cornerRadius = 2
        addSubview(bar)
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .callout(value) = prepared else { return }
        self.prepared = value
        childViews.forEach { $0.removeFromSuperview() }
        childViews = value.children.map { child in
            let view = ReaderBlockViewFactory.make(prepared: child.block)
            var childContext = context
            childContext.isNested = true
            view.configure(prepared: child.block, context: childContext)
            addSubview(view)
            return view
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        bar.frame = CGRect(x: 0, y: 8, width: 3, height: max(bounds.height - 16, 1))
        guard let prepared else { return }
        var y = prepared.childrenOrigin
        for (index, view) in childViews.enumerated() {
            let height = prepared.children[index].block.height
            view.frame = CGRect(x: 14, y: y, width: bounds.width - 20, height: height)
            y += height + prepared.childSpacing
        }
    }
}

final class ListBlockView: ReaderBlockView {
    private var childViews: [ReaderBlockView] = []
    private var prepared: ReaderPreparedContainer?

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .callout(value) = prepared else { return }
        self.prepared = value
        childViews.forEach { $0.removeFromSuperview() }
        childViews = value.children.map { child in
            let view = ReaderBlockViewFactory.make(prepared: child.block)
            var childContext = context
            childContext.isNested = true
            view.configure(prepared: child.block, context: childContext)
            addSubview(view)
            return view
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let prepared else { return }
        var y = prepared.childrenOrigin
        for (index, view) in childViews.enumerated() {
            let height = prepared.children[index].block.height
            view.frame = CGRect(x: 0, y: y, width: bounds.width, height: height)
            y += height + prepared.childSpacing
        }
    }
}

// MARK: - Details

final class DetailsBlockView: ReaderBlockView {
    private let header = UIControl()
    private let chevron = UIImageView()
    private let summaryLabel = UILabel()
    private var childViews: [ReaderBlockView] = []
    private var prepared: ReaderPreparedDetails?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 10
        header.addTarget(self, action: #selector(toggle), for: .touchUpInside)
        header.isAccessibilityElement = true
        header.accessibilityTraits = .button
        header.accessibilityIdentifier = "reader.details"
        addSubview(header)
        summaryLabel.numberOfLines = 0
        summaryLabel.isUserInteractionEnabled = false
        header.addSubview(summaryLabel)
        chevron.contentMode = .scaleAspectFit
        chevron.tintColor = .secondaryLabel
        header.addSubview(chevron)
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .details(value) = prepared else { return }
        self.prepared = value
        summaryLabel.attributedText = value.summary
        chevron.image = UIImage(systemName: value.isOpen ? "chevron.down" : "chevron.right")
        header.accessibilityLabel = "\(value.isOpen ? "Hide" : "Show") details: \(value.summary.string)"
        header.accessibilityValue = value.isOpen ? "Expanded" : "Collapsed"
        childViews.forEach { $0.removeFromSuperview() }
        childViews = value.children.map { child in
            let view = ReaderBlockViewFactory.make(prepared: child.block)
            var childContext = context
            childContext.isNested = true
            view.configure(prepared: child.block, context: childContext)
            addSubview(view)
            return view
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let prepared else { return }
        header.frame = CGRect(x: 0, y: 8, width: bounds.width, height: prepared.headerHeight)
        chevron.frame = CGRect(x: bounds.width - 34, y: 8 + (prepared.headerHeight - 20) / 2, width: 20, height: 20)
        summaryLabel.frame = CGRect(
            x: 16,
            y: 8,
            width: bounds.width - 58,
            height: prepared.headerHeight
        )
        var y = prepared.childrenOrigin
        for (index, view) in childViews.enumerated() {
            let height = prepared.children[index].block.height
            view.frame = CGRect(x: 12, y: y, width: bounds.width - 24, height: height)
            y += height + 8
        }
    }

    @objc private func toggle() {
        guard let prepared else { return }
        context?.delegate?.readerBlock(
            self,
            toggleDetails: prepared.blockID,
            expanded: !prepared.isOpen
        )
    }
}

// MARK: - USERNOTE

final class UserNoteBlockView: ReaderBlockView {
    private let kicker = UILabel()
    private let queryLabel = UILabel()
    private let targetLabel = UILabel()
    private let targetButton = UIButton(type: .system)
    private let readOnlyLabel = UILabel()
    private var childViews: [ReaderBlockView] = []
    private var prepared: ReaderPreparedUserNote?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemYellow.withAlphaComponent(0.16)
        layer.cornerRadius = 12
        layer.borderWidth = 1
        layer.borderColor = UIColor.systemOrange.withAlphaComponent(0.55).cgColor
        accessibilityIdentifier = "reader.usernote"

        kicker.text = "USER NOTE · READ-ONLY"
        kicker.font = .preferredFont(forTextStyle: .caption2)
        kicker.textColor = .systemOrange
        addSubview(kicker)

        queryLabel.numberOfLines = 0
        addSubview(queryLabel)

        targetLabel.numberOfLines = 0
        targetLabel.font = .preferredFont(forTextStyle: .caption1)
        targetLabel.textColor = .secondaryLabel
        addSubview(targetLabel)

        targetButton.titleLabel?.font = .preferredFont(forTextStyle: .caption1)
        targetButton.contentHorizontalAlignment = .leading
        targetButton.addTarget(self, action: #selector(jump), for: .touchUpInside)
        addSubview(targetButton)

        readOnlyLabel.text = "Notes cannot be created or deleted in this build."
        readOnlyLabel.font = .preferredFont(forTextStyle: .caption2)
        readOnlyLabel.textColor = .tertiaryLabel
        addSubview(readOnlyLabel)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        super.configure(prepared: prepared, context: context)
        guard case let .userNote(value) = prepared else { return }
        self.prepared = value
        queryLabel.attributedText = value.query
        if !value.targetDisplay.isEmpty {
            targetLabel.text = "Target: “\(value.targetDisplay)”"
        } else {
            targetLabel.text = nil
        }
        if value.anchorResolved, let anchor = value.anchorBlockID {
            targetButton.setTitle("Jump to target", for: .normal)
            targetButton.isHidden = false
            targetButton.accessibilityHint = "Scrolls to the paragraph this note refers to."
            targetButton.accessibilityValue = anchor
        } else {
            targetButton.isHidden = true
        }
        accessibilityLabel = "User note: \(value.query.string)"
        childViews.forEach { $0.removeFromSuperview() }
        childViews = value.children.map { child in
            let view = ReaderBlockViewFactory.make(prepared: child.block)
            var childContext = context
            childContext.isNested = true
            view.configure(prepared: child.block, context: childContext)
            addSubview(view)
            return view
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let prepared else { return }
        var y: CGFloat = 14
        kicker.frame = CGRect(x: 16, y: y, width: bounds.width - 32, height: 16)
        y += 22
        queryLabel.frame = CGRect(x: 16, y: y, width: bounds.width - 32, height: prepared.queryHeight)
        y += prepared.queryHeight + 4
        targetLabel.frame = CGRect(x: 16, y: y, width: bounds.width - 32, height: prepared.targetHeight)
        y += prepared.targetHeight + 4
        targetButton.frame = CGRect(x: 12, y: y, width: bounds.width - 24, height: 26)
        var childY = prepared.childrenOrigin
        for (index, view) in childViews.enumerated() {
            let height = prepared.children[index].block.height
            view.frame = CGRect(x: 16, y: childY, width: bounds.width - 32, height: height)
            childY += height + 8
        }
        readOnlyLabel.frame = CGRect(x: 16, y: bounds.height - 26, width: bounds.width - 32, height: 16)
    }

    @objc private func jump() {
        guard let prepared, let anchor = prepared.anchorBlockID else { return }
        context?.delegate?.readerBlock(self, jumpToBlock: anchor)
    }
}
