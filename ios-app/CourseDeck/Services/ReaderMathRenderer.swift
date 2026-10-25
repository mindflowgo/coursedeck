import CourseDeckCore
import Foundation
import SwiftMath
import UIKit

/// Renders TeX with SwiftMath on a serial background queue and caches the
/// result by TeX, font size, display mode, and interface style.
///
/// SwiftMath 1.7.3's `MTMathImage.asImage()` returns `(NSError?, UIImage?)`
/// only; it does not expose `LayoutInfo` ascent/descent (that type is on the
/// newer `MathImage` API). Inline attachments therefore use a documented
/// fallback descent of 24% of the font size for baseline alignment.
final class ReaderMathRenderer {
    static let shared = ReaderMathRenderer()

    private let cache = NSCache<NSString, UIImage>()
    private let queue = DispatchQueue(label: "com.ilc.coursedeck.reader.math", qos: .userInitiated)

    private init() {
        cache.countLimit = 240
        cache.totalCostLimit = 48 * 1024 * 1024
    }

    func image(
        tex: String,
        display: Bool,
        pointSize: CGFloat,
        color: UIColor
    ) async -> UIImage? {
        let clean = tex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        let colorKey = readerColorKey(color)
        let key = "\(clean)|\(Int(pointSize * 10))|\(display)|\(colorKey)" as NSString
        if let cached = cache.object(forKey: key) { return cached }

        return await withCheckedContinuation { continuation in
            queue.async {
                let renderer = MTMathImage(
                    latex: clean,
                    fontSize: pointSize,
                    textColor: color,
                    labelMode: display ? .display : .text,
                    textAlignment: display ? .center : .left
                )
                let (error, image) = renderer.asImage()
                guard error == nil, let image else {
                    continuation.resume(returning: nil)
                    return
                }
                self.cache.setObject(image, forKey: key)
                continuation.resume(returning: image)
            }
        }
    }

    /// Baseline offset for an inline attachment. See the type comment.
    static func inlineBaselineOffset(pointSize: CGFloat) -> CGFloat {
        -(pointSize * 0.24)
    }

    private func readerColorKey(_ color: UIColor) -> String {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return "dynamic"
        }
        return String(format: "%.2f-%.2f-%.2f-%.2f", red, green, blue, alpha)
    }
}
