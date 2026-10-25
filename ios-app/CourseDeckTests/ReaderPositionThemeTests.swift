@testable import CourseDeck
import CourseDeckCore
import UIKit
import XCTest

final class ReaderPositionTests: XCTestCase {
    private let rows = [
        ReaderPositionCalculator.RowSlice(blockIDs: ["a"], height: 100),
        ReaderPositionCalculator.RowSlice(blockIDs: ["b"], height: 200),
        ReaderPositionCalculator.RowSlice(blockIDs: ["c"], height: 300),
    ]

    func testPositionInsideSecondRow() {
        let position = ReaderPositionCalculator.position(at: 150, rows: rows)
        XCTAssertEqual(position.verticalPosition, 150, accuracy: 0.01)
        XCTAssertEqual(position.anchorBlockID, "b")
        XCTAssertEqual(position.anchorFraction, 0.25, accuracy: 0.001)
    }

    func testPositionAfterLastRowClampsToLastRow() {
        let position = ReaderPositionCalculator.position(at: 9_000, rows: rows)
        XCTAssertEqual(position.anchorBlockID, "c")
        XCTAssertEqual(position.anchorFraction, 1, accuracy: 0.001)
        XCTAssertEqual(position.verticalPosition, 600, accuracy: 0.01)
    }

    func testOffsetRestoresAnchor() {
        let position = ReaderPosition(verticalPosition: 0, anchorBlockID: "b", anchorFraction: 0.5)
        let offset = ReaderPositionCalculator.offset(for: position, rows: rows)
        XCTAssertEqual(offset, 200, accuracy: 0.01)
    }

    func testOffsetFallsBackToPixelsWhenAnchorDisappears() {
        let position = ReaderPosition(verticalPosition: 420, anchorBlockID: "removed", anchorFraction: 0.2)
        let offset = ReaderPositionCalculator.offset(for: position, rows: rows)
        XCTAssertEqual(offset, 420, accuracy: 0.01)
    }

    func testEmptyDocumentPositionIsZero() {
        XCTAssertEqual(ReaderPositionCalculator.position(at: 100, rows: []), .zero)
        XCTAssertEqual(ReaderPositionCalculator.offset(for: .zero, rows: []), 0)
    }
}

final class ReaderThemeTests: XCTestCase {
    func testDynamicTypeScalesBodyAndHeadingFonts() {
        let normal = ReaderTestSupport.theme(category: .large)
        let large = ReaderTestSupport.theme(category: .accessibilityExtraExtraExtraLarge)
        XCTAssertGreaterThan(large.body.pointSize, normal.body.pointSize)
        XCTAssertGreaterThan(large.heading1.pointSize, normal.heading1.pointSize)
        XCTAssertGreaterThan(large.table.pointSize, normal.table.pointSize)
        XCTAssertGreaterThan(large.code.pointSize, normal.code.pointSize)
    }

    func testFontsMatchPreferredDescriptorsWithoutDoubleScaling() {
        for category in [UIContentSizeCategory.large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge] {
            let traits = ReaderTestSupport.traits(category: category)
            let theme = ReaderTestSupport.theme(category: category)
            XCTAssertEqual(
                theme.body.pointSize,
                UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize,
                accuracy: 0.01,
                "body size for \(category.rawValue)"
            )
            XCTAssertEqual(
                theme.heading1.pointSize,
                UIFont.preferredFont(forTextStyle: .largeTitle, compatibleWith: traits).pointSize,
                accuracy: 0.01,
                "largeTitle size for \(category.rawValue)"
            )
            XCTAssertEqual(
                theme.table.pointSize,
                UIFont.preferredFont(forTextStyle: .callout, compatibleWith: traits).pointSize,
                accuracy: 0.01,
                "callout size for \(category.rawValue)"
            )
            XCTAssertEqual(
                theme.caption.pointSize,
                UIFont.preferredFont(forTextStyle: .caption1, compatibleWith: traits).pointSize,
                accuracy: 0.01,
                "caption size for \(category.rawValue)"
            )
            XCTAssertEqual(theme.code.pointSize, theme.body.pointSize * 0.94, accuracy: 0.05)
        }
    }

    func testDisplayMathUsesLargerPointSize() {
        let theme = ReaderTestSupport.theme()
        XCTAssertGreaterThan(theme.mathPointSize(display: true), theme.mathPointSize(display: false))
    }

    func testDisplayScaleFallsBackToMainScreen() {
        let theme = ReaderTestSupport.theme()
        XCTAssertGreaterThan(theme.displayScale, 0)
    }
}

final class ReaderTargetTests: XCTestCase {
    func testLessonTargetFileNameRoundTrip() throws {
        let target = ReaderTarget(courseId: "baf3m", scope: .lesson("01.01"), tab: "summary")
        XCTAssertEqual(try target.fileName(), "01.01.summary.md")
        let restored = ReaderTarget.from(file: "01.01.summary.md", courseId: "baf3m")
        XCTAssertEqual(restored, target)
    }

    func testCourseTargetFileNameRoundTrip() throws {
        let target = ReaderTarget(courseId: "baf3m", scope: .course, tab: "cheatsheet")
        XCTAssertEqual(try target.fileName(), "course.cheatsheet.md")
        XCTAssertEqual(ReaderTarget.from(file: "course.cheatsheet.md", courseId: "baf3m"), target)
    }

    func testUnitTargetFileNameRoundTrip() throws {
        let target = ReaderTarget(courseId: "mcr3u", scope: .unit(3), tab: "assignments")
        XCTAssertEqual(try target.fileName(), "03.unit.assignments.md")
        XCTAssertEqual(ReaderTarget.from(file: "03.unit.assignments.md", courseId: "mcr3u"), target)
    }

    func testInvalidCheckpointFileDoesNotResolve() {
        XCTAssertNil(ReaderTarget.from(file: "../escape.md", courseId: "baf3m"))
        XCTAssertNil(ReaderTarget.from(file: "notes.txt", courseId: "baf3m"))
    }
}
