import XCTest
@testable import CourseDeckCore

final class NavigationRulesTests: XCTestCase {
    func testCourseTabsAlwaysExposeWellKnownGenerationSlots() {
        let tabs = NavigationRules.courseTabs(docs: CourseDocsFlags())
        XCTAssertEqual(tabs.map(\.slug), ["lesson", "summary", "cheatsheet", "test"])
        XCTAssertEqual(tabs.first?.kind, .courseNavigation)
        XCTAssertEqual(tabs[0].isVirtual, true)
        XCTAssertEqual(tabs.first(where: { $0.slug == "summary" })?.isAvailable, false)
        XCTAssertEqual(tabs.first(where: { $0.slug == "cheatsheet" })?.isAvailable, false)
        XCTAssertEqual(tabs.first(where: { $0.slug == "test" })?.isAvailable, false)
        XCTAssertNil(tabs.first(where: { $0.slug == "schedule" }))
    }

    func testCourseTabsExposeScheduleOnlyWhenPresentAndReadOnly() {
        let docs = CourseDocsFlags(
            summary: true,
            cheatsheet: true,
            test: true,
            schedule: true,
            custom: ["exam_review": true, "practice": true]
        )
        let tabs = NavigationRules.courseTabs(docs: docs)
        XCTAssertEqual(
            tabs.map(\.slug),
            ["lesson", "summary", "cheatsheet", "test", "schedule", "exam_review", "practice"]
        )
        XCTAssertEqual(tabs.first(where: { $0.slug == "schedule" })?.kind, .readOnlyReader)
        XCTAssertEqual(tabs.first(where: { $0.slug == "schedule" })?.isAvailable, true)
        XCTAssertEqual(NavigationRules.isReadOnly(scope: .course, tab: "schedule"), true)
        XCTAssertEqual(NavigationRules.isReadOnly(scope: .course, tab: "lesson"), true)
        XCTAssertEqual(NavigationRules.isReadOnly(scope: .course, tab: "summary"), false)
    }

    func testCourseUnknownTabFallsBackToVirtualNavigationPage() {
        let resolved = NavigationRules.resolvedTab(
            requested: "does_not_exist",
            scope: .course,
            docs: CourseDocsFlags(custom: ["real": true])
        )
        XCTAssertEqual(resolved?.slug, "lesson")
        XCTAssertEqual(resolved?.kind, .courseNavigation)
        XCTAssertEqual(resolved?.isVirtual, true)
    }

    func testUnitTabsAlwaysExposeAssignmentsAndTest() {
        let tabs = NavigationRules.unitTabs(discovered: [])
        XCTAssertEqual(tabs.map(\.slug), ["assignments", "test"])
        XCTAssertEqual(tabs[0].isAvailable, false)
        XCTAssertEqual(tabs[1].isAvailable, false)
        XCTAssertEqual(tabs[1].kind, .quiz)

        let discovered = NavigationRules.unitTabs(discovered: ["assignments", "test", "graph_lab", "popquiz"])
        XCTAssertEqual(discovered.map(\.slug), ["assignments", "test", "graph_lab"])
        XCTAssertEqual(discovered.last?.kind, .custom)

        XCTAssertEqual(
            NavigationRules.resolvedTab(requested: "missing", scope: .unit(1), availableTabs: [])?.slug,
            "assignments"
        )
    }

    func testLessonTabsAndMissingCustomTabFallback() {
        let tabs = NavigationRules.lessonTabs(
            availableTabs: ["summary", "vocab", "popquiz"],
            hasLesson: true
        )
        XCTAssertEqual(tabs.map(\.slug), ["lesson", "summary", "cheatsheet", "test", "vocab"])
        XCTAssertEqual(tabs.first(where: { $0.slug == "test" })?.kind, .quiz)
        XCTAssertEqual(tabs.first(where: { $0.slug == "cheatsheet" })?.isAvailable, false)
        XCTAssertEqual(tabs.first(where: { $0.slug == "vocab" })?.kind, .custom)
        XCTAssertNil(tabs.first(where: { $0.slug == "popquiz" }), "popquiz is a separate experience")

        let fallback = NavigationRules.resolvedTab(
            requested: "missing_custom",
            scope: .lesson("01.01"),
            availableTabs: ["summary", "vocab"],
            hasLesson: true
        )
        XCTAssertEqual(fallback?.slug, "lesson")
        XCTAssertEqual(fallback?.kind, .reader)

        let noLesson = NavigationRules.resolvedTab(
            requested: "missing_custom",
            scope: .lesson("01.01"),
            availableTabs: ["summary"],
            hasLesson: false
        )
        XCTAssertEqual(noLesson?.slug, "summary")
    }

    func testLessonTabsDoNotListSummaryWhenLessonIsMissingAndNoTabsExist() {
        let tabs = NavigationRules.lessonTabs(availableTabs: [], hasLesson: false)
        XCTAssertEqual(tabs.map(\.slug), ["summary", "cheatsheet", "test"])
    }

    func testCustomDetection() {
        XCTAssertTrue(NavigationRules.isCustom(scope: .lesson("01.01"), tab: "vocab", availableTabs: ["vocab"]))
        XCTAssertFalse(NavigationRules.isCustom(scope: .lesson("01.01"), tab: "test", availableTabs: ["test"]))
        XCTAssertTrue(NavigationRules.isCustom(scope: .unit(1), tab: "graph_lab", availableTabs: ["graph_lab"]))
        XCTAssertFalse(NavigationRules.isCustom(scope: .unit(1), tab: "assignments", availableTabs: []))
        XCTAssertTrue(NavigationRules.isCustom(scope: .course, tab: "exam_review", availableTabs: []))
        XCTAssertFalse(NavigationRules.isCustom(scope: .course, tab: "schedule", availableTabs: []))
    }
}
