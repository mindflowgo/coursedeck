import XCTest

final class ReaderUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    override func tearDownWithError() throws {
        XCUIDevice.shared.orientation = .portrait
    }

    private func openSample(in app: XCUIApplication) {
        let sample = app.buttons["library.sample"].firstMatch
        if sample.waitForExistence(timeout: 8) {
            sample.tap()
        } else {
            let welcome = app.buttons["library.welcomeSample"].firstMatch
            XCTAssertTrue(welcome.waitForExistence(timeout: 5))
            welcome.tap()
        }
    }

    func testOpenSampleAndFullScreenTable() {
        let app = XCUIApplication()
        app.launch()
        openSample(in: app)

        let openTable = app.buttons["reader.table.open"].firstMatch
        XCTAssertTrue(openTable.waitForExistence(timeout: 15))
        openTable.tap()

        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        done.tap()
    }

    func testReaderShowsTaskListAfterScrolling() {
        let app = XCUIApplication()
        app.launch()
        openSample(in: app)

        let taskHeader = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'TASKS'")
        ).firstMatch
        var attempts = 0
        while !taskHeader.exists && attempts < 8 {
            app.swipeUp()
            attempts += 1
        }
        XCTAssertTrue(taskHeader.waitForExistence(timeout: 5))
    }

    func testReaderSurvivesRotation() {
        let app = XCUIApplication()
        app.launch()
        openSample(in: app)

        XCTAssertTrue(app.buttons["reader.table.open"].firstMatch.waitForExistence(timeout: 15))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.buttons["reader.table.open"].firstMatch.waitForExistence(timeout: 10))
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.buttons["reader.table.open"].firstMatch.waitForExistence(timeout: 10))
    }

    func testReaderAtAccessibilityXXXL() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityXXXL",
        ]
        app.launch()
        openSample(in: app)

        XCTAssertTrue(app.buttons["reader.table.open"].firstMatch.waitForExistence(timeout: 20))
    }

    func testPreparingLabelIsVisibleWhileLoading() {
        let app = XCUIApplication()
        app.launchEnvironment["COURSEDECK_UI_TEST_SLOW_READER_LOAD"] = "1"
        app.launch()
        openSample(in: app)

        let loading = app.staticTexts["reader.loading"].firstMatch
        XCTAssertTrue(loading.waitForExistence(timeout: 3), "Preparing lesson label must be visible while parsing")
        XCTAssertTrue(loading.label.contains("Preparing lesson"))
        XCTAssertTrue(app.buttons["reader.table.open"].firstMatch.waitForExistence(timeout: 20))
    }
}
