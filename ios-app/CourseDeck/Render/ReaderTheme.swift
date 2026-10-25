import UIKit

/// Type and colour scale for the reader. Every font is derived from the current
/// `UITraitCollection` so Dynamic Type categories are honoured without relying
/// on `adjustsFontForContentSizeCategory` (which does not scale attributed
/// strings). `ReaderViewController` rebuilds this object and re-measures rows
/// when the content-size category or display scale changes.
struct ReaderTheme {
    let contentSizeCategory: UIContentSizeCategory
    let userInterfaceStyle: UIUserInterfaceStyle
    let displayScale: CGFloat

    let body: UIFont
    let bodyLarge: UIFont
    let heading1: UIFont
    let heading2: UIFont
    let heading3: UIFont
    let heading4: UIFont
    let heading5: UIFont
    let heading6: UIFont
    let caption: UIFont
    let table: UIFont
    let tableHeader: UIFont
    let code: UIFont
    let codeSmall: UIFont

    let horizontalInset: CGFloat = 20
    let blockSpacing: CGFloat = 14

    init(traitCollection: UITraitCollection) {
        let traits = UITraitCollection(traitsFrom: [
            traitCollection,
            UITraitCollection(preferredContentSizeCategory: traitCollection.preferredContentSizeCategory),
        ])
        contentSizeCategory = traits.preferredContentSizeCategory
        userInterfaceStyle = traits.userInterfaceStyle == .unspecified ? .light : traits.userInterfaceStyle
        displayScale = traits.displayScale > 0 ? traits.displayScale : UIScreen.main.scale

        body = Self.font(style: .body, weight: .regular, traits: traits)
        bodyLarge = Self.font(style: .body, weight: .regular, traits: traits)
        heading1 = Self.font(style: .largeTitle, weight: .bold, traits: traits)
        heading2 = Self.font(style: .title1, weight: .bold, traits: traits)
        heading3 = Self.font(style: .title2, weight: .semibold, traits: traits)
        heading4 = Self.font(style: .title3, weight: .semibold, traits: traits)
        heading5 = Self.font(style: .headline, weight: .semibold, traits: traits)
        heading6 = Self.font(style: .subheadline, weight: .semibold, traits: traits)
        caption = Self.font(style: .caption1, weight: .regular, traits: traits)
        table = Self.font(style: .callout, weight: .regular, traits: traits)
        tableHeader = Self.font(style: .callout, weight: .semibold, traits: traits)
        code = UIFont.monospacedSystemFont(ofSize: body.pointSize * 0.94, weight: .regular)
        codeSmall = UIFont.monospacedSystemFont(ofSize: caption.pointSize * 1.05, weight: .regular)
    }

    static func make(for view: UIView) -> ReaderTheme {
        ReaderTheme(traitCollection: view.traitCollection)
    }

    var isDark: Bool { userInterfaceStyle == .dark }

    var bodyColor: UIColor { .label }
    var secondaryColor: UIColor { .secondaryLabel }
    var tertiaryColor: UIColor { .tertiaryLabel }
    var separatorColor: UIColor { .separator }
    var linkColor: UIColor { .tintColor }
    var codeBackground: UIColor { .secondarySystemBackground }
    var tableHeaderBackground: UIColor { .secondarySystemBackground }
    var tableAlternateRow: UIColor { .tertiarySystemBackground }
    var calloutBackground: UIColor { .secondarySystemBackground }
    var noteBackground: UIColor { .systemYellow.withAlphaComponent(0.16) }
    var noteBorder: UIColor { .systemOrange.withAlphaComponent(0.55) }
    var warningBackground: UIColor { .systemRed.withAlphaComponent(0.08) }

    var proseInsets: UIEdgeInsets {
        UIEdgeInsets(top: 8, left: horizontalInset, bottom: 8, right: horizontalInset)
    }

    func mathPointSize(display: Bool) -> CGFloat {
        display ? body.pointSize + 6 : max(body.pointSize * 1.02, 14)
    }

    func mathColor() -> UIColor {
        UIColor.label.resolvedColor(with: UITraitCollection(userInterfaceStyle: userInterfaceStyle))
    }

    private static func font(
        style: UIFont.TextStyle,
        weight: UIFont.Weight,
        traits: UITraitCollection
    ) -> UIFont {
        // The preferred descriptor is already scaled for `traits`. Applying
        // UIFontMetrics.scaledFont on top would double-scale the font.
        let descriptor = UIFontDescriptor.preferredFontDescriptor(withTextStyle: style, compatibleWith: traits)
        return UIFont.systemFont(ofSize: descriptor.pointSize, weight: weight)
    }
}
