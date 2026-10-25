import CoreGraphics
import Foundation

/// A checkpoint-compatible reader position.
///
/// `verticalPosition` is the cumulative measured height of every preceding row
/// plus `anchorFraction × anchorRowHeight`, matching the desktop's pixel field.
/// `anchorBlockID`/`anchorFraction` are the re-layout-stable fields the iPad
/// restores from after rotation or a Dynamic Type change.
struct ReaderPosition: Equatable, Sendable {
    var verticalPosition: Double
    var anchorBlockID: String?
    var anchorFraction: Double

    static let zero = ReaderPosition(verticalPosition: 0, anchorBlockID: nil, anchorFraction: 0)
}

/// Pure position math, separated from the view controller so it is testable
/// without a simulator.
enum ReaderPositionCalculator {
    struct RowSlice: Equatable {
        var blockIDs: [String]
        var height: CGFloat
    }

    /// Returns the position at a content offset. `offset` is measured from the
    /// top of the first row (row 0).
    static func position(at offset: CGFloat, rows: [RowSlice]) -> ReaderPosition {
        guard !rows.isEmpty else { return .zero }
        let clamped = max(0, offset)
        var cumulative: CGFloat = 0
        var best = ReaderPosition(
            verticalPosition: Double(clamped),
            anchorBlockID: rows[0].blockIDs.first,
            anchorFraction: 0
        )
        for row in rows {
            let height = max(row.height, 1)
            if clamped < cumulative + height {
                let fraction = min(max((clamped - cumulative) / height, 0), 1)
                best = ReaderPosition(
                    verticalPosition: Double(cumulative + fraction * height),
                    anchorBlockID: row.blockIDs.first,
                    anchorFraction: Double(fraction)
                )
                return best
            }
            cumulative += height
        }
        // Past the end: clamp to the end of the last row instead of returning
        // a zero fraction on the last block.
        if let last = rows.last {
            best = ReaderPosition(
                verticalPosition: Double(cumulative),
                anchorBlockID: last.blockIDs.first,
                anchorFraction: 1
            )
        }
        return best
    }

    /// Returns the content offset for a stored position. When the block is no
    /// longer present, the raw pixel position is used as a fallback.
    static func offset(for position: ReaderPosition, rows: [RowSlice], additionalRowsTop: Bool = true) -> CGFloat {
        guard !rows.isEmpty else { return CGFloat(max(0, position.verticalPosition)) }
        if let anchor = position.anchorBlockID,
           let index = rows.firstIndex(where: { $0.blockIDs.contains(anchor) }) {
            let preceding = rows[..<index].reduce(CGFloat(0)) { $0 + max($1.height, 1) }
            let height = max(rows[index].height, 1)
            let fraction = min(max(position.anchorFraction, 0), 1)
            return preceding + CGFloat(fraction) * height
        }
        return CGFloat(max(0, position.verticalPosition))
    }
}
