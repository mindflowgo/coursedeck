import CourseDeckCore
import UIKit

/// A vertical range inside a prose run, keyed by the parser's stable block ID.
struct ReaderBlockAnchor: Equatable {
    var blockID: String
    var top: CGFloat
    var height: CGFloat
}

struct ReaderPreparedProse {
    var attributed: NSAttributedString
    var height: CGFloat
    var anchors: [ReaderBlockAnchor]
    /// Spoken representation used only when the run contains math or images,
    /// whose text attachments cannot expose a VoiceOver label.
    var spokenText: String?
}

struct ReaderPreparedTaskItem {
    var checked: Bool
    var text: String
    var attributed: NSAttributedString
    var height: CGFloat
}

struct ReaderPreparedTaskList {
    var items: [ReaderPreparedTaskItem]
    var height: CGFloat
}

struct ReaderPreparedCode {
    var attributed: NSAttributedString
    var language: String?
    var plainText: String
    var textHeight: CGFloat
    var viewportHeight: CGFloat
    var height: CGFloat
}

struct ReaderPreparedImage {
    var model: ImageModel
    var image: UIImage?
    var failure: String?
    var displaySize: CGSize
    var caption: String?
    var captionHeight: CGFloat
    var height: CGFloat
    var allowsRemoteLoad: Bool
}

struct ReaderPreparedMath {
    var expression: MathExpression
    var image: UIImage?
    var displaySize: CGSize
    var height: CGFloat
}

struct ReaderPreparedTable {
    var table: TableModel
    var metrics: TableGridMetrics
    var headerAttributed: [NSAttributedString]
    var bodyAttributed: [[NSAttributedString]]
    var totalHeight: CGFloat
}

/// A prepared child block plus its stable parser block ID. The ID is needed to
/// compute recursive offsets inside callouts, lists, details, and USERNOTE
/// cards.
struct ReaderPreparedNode {
    var blockID: String
    var block: ReaderPreparedBlock
    var height: CGFloat { block.height }
}

struct ReaderPreparedFallback {
    var text: String
    var warning: String
    var height: CGFloat
}

enum ReaderContainerKind: Equatable {
    case callout(CalloutKind)
    case quote
    case list
}

struct ReaderPreparedContainer {
    var kind: ReaderContainerKind
    var label: String
    var title: String?
    var children: [ReaderPreparedNode]
    var childrenOrigin: CGFloat
    var childSpacing: CGFloat
    var height: CGFloat
}

struct ReaderPreparedDetails {
    var blockID: String
    var summary: NSAttributedString
    var isOpen: Bool
    var children: [ReaderPreparedNode]
    var headerHeight: CGFloat
    var childrenOrigin: CGFloat
    var height: CGFloat
}

struct ReaderPreparedUserNote {
    var query: NSAttributedString
    var targetDisplay: String
    var anchorBlockID: String?
    var anchorResolved: Bool
    var children: [ReaderPreparedNode]
    var queryHeight: CGFloat
    var targetHeight: CGFloat
    var childrenOrigin: CGFloat
    var height: CGFloat
}

struct ReaderPreparedSeparator {
    var height: CGFloat
}

/// A fully measured block. The reader computes this off the main thread and
/// only builds views once the heights are known, so tables and prose never
/// reflow while scrolling.
indirect enum ReaderPreparedBlock {
    case prose(ReaderPreparedProse)
    case taskList(ReaderPreparedTaskList)
    case code(ReaderPreparedCode)
    case image(ReaderPreparedImage)
    case math(ReaderPreparedMath)
    case table(ReaderPreparedTable)
    case callout(ReaderPreparedContainer)
    case details(ReaderPreparedDetails)
    case userNote(ReaderPreparedUserNote)
    case separator(ReaderPreparedSeparator)
    case fallback(ReaderPreparedFallback)

    var height: CGFloat {
        switch self {
        case let .prose(value): return value.height
        case let .taskList(value): return value.height
        case let .code(value): return value.height
        case let .image(value): return value.height
        case let .math(value): return value.height
        case let .table(value): return value.totalHeight
        case let .callout(value): return value.height
        case let .details(value): return value.height
        case let .userNote(value): return value.height
        case let .separator(value): return value.height
        case let .fallback(value): return value.height
        }
    }
}

/// The measured result for one row plus a weak result cache key.
struct ReaderPreparedRow {
    var block: ReaderPreparedBlock
    var width: CGFloat
    var contentSizeCategory: UIContentSizeCategory
    var userInterfaceStyle: UIUserInterfaceStyle
}
