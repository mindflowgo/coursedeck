import CoreGraphics
import Foundation
import UIKit

struct ProseMeasurement {
    var height: CGFloat
    var anchors: [ReaderBlockAnchor]
}

/// Measures an attributed prose run with TextKit 2. TextKit 2 can lay out on a
/// background queue as long as the content storage/layout manager are confined
/// to that queue; the reader calls this from its preparation queue, never on
/// the main thread while scrolling.
enum ProseTextMeasurer {
    static func measure(
        attributed: NSAttributedString,
        width: CGFloat,
        blockRanges: [(id: String, range: NSRange)]
    ) -> ProseMeasurement {
        guard attributed.length > 0, width > 1 else {
            return ProseMeasurement(height: 0, anchors: [])
        }

        let storage = NSTextStorage(attributedString: attributed)
        let contentStorage = NSTextContentStorage()
        contentStorage.textStorage = storage

        let layoutManager = NSTextLayoutManager()
        contentStorage.addTextLayoutManager(layoutManager)

        let container = NSTextContainer(
            size: CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = 0
        container.widthTracksTextView = false
        layoutManager.textContainer = container
        layoutManager.ensureLayout(for: contentStorage.documentRange)

        var height = ceil(layoutManager.usageBoundsForTextContainer.height)
        if height <= 0 {
            height = ceil(attributed.boundingRect(
                with: CGSize(width: width, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                context: nil
            ).height)
        }

        var fragments: [(range: NSRange, frame: CGRect)] = []
        let documentStart = contentStorage.documentRange.location
        layoutManager.enumerateTextLayoutFragments(
            from: nil,
            options: [.ensuresLayout]
        ) { fragment in
            let range = fragment.rangeInElement
            let start = contentStorage.offset(from: documentStart, to: range.location)
            let end = contentStorage.offset(from: documentStart, to: range.endLocation)
            if start != NSNotFound, end != NSNotFound, end >= start {
                fragments.append((
                    NSRange(location: start, length: end - start),
                    fragment.layoutFragmentFrame
                ))
            }
            return true
        }

        var anchors: [ReaderBlockAnchor] = []
        for block in blockRanges {
            guard block.range.location != NSNotFound, block.range.length >= 0 else { continue }
            var minY: CGFloat?
            var maxY: CGFloat?
            for fragment in fragments {
                let fragmentMax = fragment.range.location + fragment.range.length
                let blockMax = block.range.location + block.range.length
                guard fragment.range.location < blockMax, block.range.location < fragmentMax else {
                    continue
                }
                minY = min(minY ?? fragment.frame.minY, fragment.frame.minY)
                maxY = max(maxY ?? fragment.frame.maxY, fragment.frame.maxY)
            }
            guard let top = minY, let bottom = maxY, bottom > top else { continue }
            anchors.append(
                ReaderBlockAnchor(blockID: block.id, top: top, height: bottom - top)
            )
        }

        // A block whose range produced no fragments (for example an empty
        // paragraph) still gets a deterministic anchor at the end of the run.
        let covered = Set(anchors.map(\.blockID))
        for block in blockRanges where !covered.contains(block.id) {
            anchors.append(
                ReaderBlockAnchor(blockID: block.id, top: height, height: 1)
            )
        }

        return ProseMeasurement(height: height, anchors: anchors.sorted { $0.top < $1.top })
    }
}
