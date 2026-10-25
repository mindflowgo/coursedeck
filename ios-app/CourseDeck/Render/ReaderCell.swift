import UIKit

final class ReaderBlockCell: UITableViewCell {
    private(set) var blockView: ReaderBlockView?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        selectionStyle = .none
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(prepared: ReaderPreparedBlock, context: ReaderBlockContext) {
        let key = ReaderBlockViewFactory.key(for: prepared)
        if blockView?.kindKey != key {
            blockView?.removeFromSuperview()
            let newView = ReaderBlockViewFactory.make(prepared: prepared)
            contentView.addSubview(newView)
            blockView = newView
        }
        blockView?.configure(prepared: prepared, context: context)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        blockView?.frame = contentView.bounds
    }
}

final class ReaderLoadingCell: UITableViewCell {
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let label = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        selectionStyle = .none
        spinner.startAnimating()
        contentView.addSubview(spinner)
        label.text = "Preparing lesson content…"
        label.font = .preferredFont(forTextStyle: .footnote)
        label.textColor = .secondaryLabel
        label.adjustsFontForContentSizeCategory = true
        contentView.addSubview(label)
        isAccessibilityElement = true
        accessibilityLabel = "Preparing lesson content"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        spinner.frame = CGRect(x: 20, y: 14, width: 24, height: 24)
        label.frame = CGRect(x: 54, y: 16, width: bounds.width - 74, height: 22)
    }
}
