import XCTest
@testable import CourseDeckCore

final class CourseDeckCoreTests: XCTestCase {
    func testVersionAndBundleIdentifier() {
        XCTAssertEqual(CourseDeckCore.version, "0.1.0")
        XCTAssertEqual(CourseDeckCore.bundleIdentifier, "com.ilc.coursedeck")
    }
}
