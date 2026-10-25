import XCTest

final class GenerationUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launchAccepted(_ app: XCUIApplication) {
        app.launchArguments += ["-CourseDeckAcceptAIConsentForUITests"]
        app.launch()
    }

    private func ensureSidebarVisible(_ app: XCUIApplication) {
        if !app.buttons["library.settings"].exists {
            let toggle = app.buttons["ToggleSidebar"].firstMatch
            if toggle.waitForExistence(timeout: 3) {
                toggle.tap()
            }
        }
    }

    private func openSettings(_ app: XCUIApplication) {
        ensureSidebarVisible(app)
        let settings = app.buttons["library.settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 12))
        settings.tap()
        XCTAssertTrue(app.collectionViews["settings.root"].waitForExistence(timeout: 12))
    }

    private func revealInSettings(_ app: XCUIApplication, _ identifier: String) {
        let button = app.buttons[identifier]
        let list = app.collectionViews["settings.root"]
        var attempts = 0
        while !button.exists && attempts < 8 {
            list.swipeUp()
            attempts += 1
        }
        XCTAssertTrue(button.waitForExistence(timeout: 4), "Missing \(identifier)")
    }

    func testConsentDisclosureAppearsAndCanBeDeclined() {
        let app = XCUIApplication()
        app.launchArguments += ["-CourseDeckResetAIConsentForUITests"]
        app.launch()

        XCTAssertTrue(app.buttons["aiConsent.accept"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'DeepSeek'")
        ).firstMatch.exists)
        app.buttons["aiConsent.notNow"].tap()
        ensureSidebarVisible(app)
        XCTAssertTrue(app.buttons["library.settings"].waitForExistence(timeout: 8))
    }

    func testSettingsShowsModelPromptGenerationAndBackupSections() {
        let app = XCUIApplication()
        launchAccepted(app)
        openSettings(app)

        revealInSettings(app, "settings.addCard")
        // Card editor exposes a secure key field and never a plaintext field.
        app.buttons["settings.addCard"].tap()
        XCTAssertTrue(app.secureTextFields["modelCard.apiKey"].waitForExistence(timeout: 8))
        app.buttons["Cancel"].firstMatch.tap()

        revealInSettings(app, "settings.prompts")
        revealInSettings(app, "settings.jobs")
        revealInSettings(app, "settings.missingWork")
        revealInSettings(app, "settings.importBackup")

        app.buttons["settings.done"].tap()
        ensureSidebarVisible(app)
        XCTAssertTrue(app.buttons["library.settings"].waitForExistence(timeout: 8))
    }

    func testGenerationJobsSheetOpensAndCloses() {
        let app = XCUIApplication()
        launchAccepted(app)
        ensureSidebarVisible(app)

        let jobs = app.buttons["library.jobs"].firstMatch
        XCTAssertTrue(jobs.waitForExistence(timeout: 12))
        jobs.tap()
        XCTAssertTrue(app.navigationBars["Generation jobs"].waitForExistence(timeout: 10))
        app.buttons["generationJobs.done"].tap()
        ensureSidebarVisible(app)
        XCTAssertTrue(app.buttons["library.jobs"].waitForExistence(timeout: 8))
    }

    func testPromptManagerAndMissingWorkAreReachable() {
        let app = XCUIApplication()
        launchAccepted(app)
        openSettings(app)

        revealInSettings(app, "settings.prompts")
        app.buttons["settings.prompts"].tap()
        XCTAssertTrue(app.navigationBars["Prompts"].waitForExistence(timeout: 10))
        app.navigationBars["Prompts"].buttons.firstMatch.tap()

        // Scrolling position is preserved; re-reveal the lower section.
        revealInSettings(app, "settings.missingWork")
        app.buttons["settings.missingWork"].tap()
        XCTAssertTrue(app.navigationBars["Missing work"].waitForExistence(timeout: 10))
    }

    func testCourseUnitAndLessonGenerationNavigation() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-CourseDeckAcceptAIConsentForUITests",
            "-CourseDeckSeedUITestCourseForUITests",
        ]
        app.launch()
        ensureSidebarVisible(app)

        let course = app.staticTexts["UITest Course"].firstMatch
        XCTAssertTrue(course.waitForExistence(timeout: 12))
        course.tap()

        // Virtual course.lesson navigation page.
        let courseNavigation = app.buttons["Course navigation"].firstMatch
        XCTAssertTrue(courseNavigation.waitForExistence(timeout: 10))
        courseNavigation.tap()
        XCTAssertTrue(app.navigationBars["Course Navigation"].waitForExistence(timeout: 10))
        app.buttons["reader.back"].tap()

        // A missing course document offers the generation CTA.
        app.buttons["Summary"].firstMatch.tap()
        XCTAssertTrue(app.buttons["reader.generateMissing"].waitForExistence(timeout: 10))
        app.buttons["reader.generateMissing"].tap()
        XCTAssertTrue(app.buttons["generation.queue"].waitForExistence(timeout: 10))
        app.buttons["Cancel"].firstMatch.tap()
        app.buttons["reader.back"].tap()

        // Lesson tab generation.
        app.staticTexts["Lesson One"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Lesson One"].waitForExistence(timeout: 10))
        let generateSummary = app.buttons["Generate Summary"].firstMatch
        XCTAssertTrue(generateSummary.waitForExistence(timeout: 10))
        generateSummary.tap()
        XCTAssertTrue(app.buttons["generation.queue"].waitForExistence(timeout: 10))
        app.buttons["Cancel"].firstMatch.tap()
        app.buttons["lessonDocuments.back"].tap()

        // Unit documents and unit-test generation.
        let unitDocs = app.buttons["Unit documents & generation"].firstMatch
        XCTAssertTrue(unitDocs.waitForExistence(timeout: 10))
        unitDocs.tap()
        XCTAssertTrue(app.navigationBars["Unit 1"].waitForExistence(timeout: 10))
        let generateUnitTest = app.buttons["Generate Unit test"].firstMatch
        XCTAssertTrue(generateUnitTest.waitForExistence(timeout: 10))
        generateUnitTest.tap()
        XCTAssertTrue(app.buttons["generation.queue"].waitForExistence(timeout: 10))
        app.buttons["Cancel"].firstMatch.tap()
    }
}
