import CoreGraphics
import CourseDeckCore
import UIKit

/// Resolves the Markdown image spec (named presets, `|50%`, `|300x200`,
/// `width=`/`height=`) into a display size. Icons are capped at 32 pt; other
/// images default to a 480 pt maximum height (PLAN §4.5).
enum ReaderImageSizing {
    static let defaultMaxHeight: CGFloat = ImageSpecParser.defaultMaxHeight
    static let iconMaxHeight: CGFloat = ImageSpecParser.iconMaxHeight
    static let defaultPlaceholderAspect: CGFloat = 4.0 / 3.0

    static func isIcon(_ model: ImageModel) -> Bool {
        ImageSpecParser.isIcon(
            destination: model.destination,
            alt: model.spec.alt,
            isCustom: model.spec.isCustom
        )
    }

    static func displaySize(
        model: ImageModel,
        naturalSize: CGSize?,
        availableWidth: CGFloat
    ) -> CGSize {
        let isIcon = isIcon(model)
        let maxHeight = isIcon ? iconMaxHeight : defaultMaxHeight
        let widthLimit = max(availableWidth, 1)
        let aspect = aspectRatio(naturalSize: naturalSize)

        var width: CGFloat?
        var height: CGFloat?

        if let dimension = model.spec.width {
            switch dimension.unit {
            case .percent:
                width = widthLimit * (dimension.value / 100)
            case .px:
                width = dimension.value
            case .rem:
                width = dimension.value * 16
            }
        }
        if let dimension = model.spec.height {
            switch dimension.unit {
            case .percent:
                height = maxHeight * (dimension.value / 100)
            case .px:
                height = dimension.value
            case .rem:
                height = dimension.value * 16
            }
        }

        if width == nil && height == nil {
            if let naturalSize, naturalSize.height > 0 {
                height = naturalSize.height / max(naturalSize.width, 1) * min(naturalSize.width, widthLimit)
                if isIcon { height = min(height ?? 0, iconMaxHeight) }
            } else {
                width = widthLimit
            }
        }

        if let width, height == nil {
            height = width / aspect
        } else if let height, width == nil {
            width = height * aspect
        }

        var resolvedWidth = min(max(width ?? widthLimit, 1), widthLimit)
        var resolvedHeight = max(height ?? resolvedWidth / aspect, 1)

        if resolvedHeight > maxHeight {
            let scale = maxHeight / resolvedHeight
            resolvedHeight = maxHeight
            resolvedWidth = min(resolvedWidth * scale, widthLimit)
        }
        if isIcon {
            resolvedHeight = min(resolvedHeight, iconMaxHeight)
        }
        return CGSize(width: resolvedWidth.rounded(), height: resolvedHeight.rounded())
    }

    static func aspectRatio(naturalSize: CGSize?) -> CGFloat {
        guard let naturalSize, naturalSize.width > 0, naturalSize.height > 0 else {
            return defaultPlaceholderAspect
        }
        return naturalSize.width / naturalSize.height
    }
}
