import Foundation
import XCTest
@testable import CourseDeck
import CourseDeckCore

final class DeepLinkRouterTests: XCTestCase {
    private var workspace: URL!
    private var root: DataRoot!
    private var repository: CourseRepository!

    override func setUpWithError() throws {
        try super.setUpWithError()
        workspace = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeepLink-\(UUID().uuidString)", isDirectory: true)
        let rootURL = workspace.appendingPathComponent("Library/Application Support/CourseDeck", isDirectory: true)
        root = DataRoot(rootURL: rootURL)
        try root.prepare()
        repository = CourseRepository(root: root)
        let manifest = CourseManifest(
            id: "baf3m",
            title: "BAF3M",
            units: [
                CourseUnit(number: 1, title: "Unit 1", lessons: [
                    CourseLesson(id: "01.01", title: "Lesson One", unitNumber: 1, lessonNumber: 1),
                ]),
            ]
        )
        try write(manifest.encoded(), to: "courses/baf3m/meta.json")
        try write("# Lesson\n\nBody.", to: "courses/baf3m/01.01.lesson.md")
        try write("# Summary", to: "courses/baf3m/01.01.summary.md")
        try write("# Test", to: "courses/baf3m/01.01.test.md")
        try write("# Custom", to: "courses/baf3m/01.01.vocab.md")
        try write("# Unit", to: "courses/baf3m/01.unit.assignments.md")
        try write("# Course summary", to: "courses/baf3m/course.summary.md")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspace)
        try super.tearDownWithError()
    }

    private func write(_ data: Data, to relative: String) throws {
        let url = root.rootURL.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    private func write(_ string: String, to relative: String) throws {
        try write(Data(string.utf8), to: relative)
    }

    func testParsesCourseLessonAndUnitLinks() throws {
        XCTAssertEqual(
            try CourseDeckDeepLink.parse(URL(string: "coursedeck://course/baf3m")!).get(),
            .course(courseId: "baf3m")
        )
        XCTAssertEqual(
            try CourseDeckDeepLink.parse(URL(string: "coursedeck://course/baf3m/summary")!).get(),
            .courseTab(courseId: "baf3m", tab: "summary")
        )
        XCTAssertEqual(
            try CourseDeckDeepLink.parse(URL(string: "coursedeck://lesson/baf3m/01.01/test")!).get(),
            .lesson(courseId: "baf3m", lessonId: "01.01", tab: "test")
        )
        XCTAssertEqual(
            try CourseDeckDeepLink.parse(URL(string: "coursedeck://unit/baf3m/1")!).get(),
            .unit(courseId: "baf3m", unitNumber: 1, tab: "assignments")
        )
    }

    func testRejectsTraversalAndInvalidIDs() {
        let traversal = URL(string: "coursedeck://lesson/baf3m/..%2F..%2Fetc/test")!
        XCTAssertThrowsError(try CourseDeckDeepLink.parse(traversal).get())
        XCTAssertThrowsError(
            try CourseDeckDeepLink.parse(URL(string: "coursedeck://lesson/baf3m/01.01/Not-A-Tab")!).get()
        )
        XCTAssertThrowsError(
            try CourseDeckDeepLink.parse(URL(string: "coursedeck://course/bad%2Fid")!).get()
        )
        XCTAssertThrowsError(
            try CourseDeckDeepLink.parse(URL(string: "https://example.com/course/baf3m")!).get()
        )
    }

    func testReaderLinkResolverReturnsDeepLinkOutcome() throws {
        let url = URL(string: "coursedeck://lesson/baf3m/01.01/test")!
        let outcome = ReaderLinkResolver.resolve(url, courseDirectoryURL: workspace)
        XCTAssertEqual(
            outcome,
            .deepLink(.lesson(courseId: "baf3m", lessonId: "01.01", tab: "test"))
        )
        let invalid = URL(string: "coursedeck://bogus/baf3m")!
        if case .unsupported = ReaderLinkResolver.resolve(invalid, courseDirectoryURL: workspace) {
            // expected
        } else {
            XCTFail("invalid deep link should be unsupported")
        }
    }

    func testColdAndWarmResolutionToReaderAndQuiz() async {
        let resolver = DeepLinkResolver(dataSource: repository)

        let course = await resolver.resolve(.course(courseId: "baf3m"), allowAutoCreate: false)
        XCTAssertEqual(course, .course(courseId: "baf3m"))

        let summary = await resolver.resolve(
            .courseTab(courseId: "baf3m", tab: "summary"),
            allowAutoCreate: false
        )
        XCTAssertEqual(
            summary,
            .reader(ReaderTarget(courseId: "baf3m", scope: .course, tab: "summary"))
        )

        let lessonQuiz = await resolver.resolve(
            .lesson(courseId: "baf3m", lessonId: "01.01", tab: "test"),
            allowAutoCreate: false
        )
        XCTAssertEqual(
            lessonQuiz,
            .quiz(.lessonTest(courseId: "baf3m", lessonId: "01.01", lessonTitle: "Lesson One"))
        )

        let unitQuiz = await resolver.resolve(
            .unit(courseId: "baf3m", unitNumber: 1, tab: "test"),
            allowAutoCreate: false
        )
        XCTAssertEqual(
            unitQuiz,
            .quiz(.unitTest(courseId: "baf3m", unitNumber: 1, unitTitle: "Unit 1"))
        )
    }

    func testMissingCustomTabRequiresConfirmationAndFallsBack() async {
        let resolver = DeepLinkResolver(dataSource: repository)
        let route = CourseDeckDeepLinkRoute.lesson(
            courseId: "baf3m",
            lessonId: "01.01",
            tab: "brand_new"
        )
        let cold = await resolver.resolve(route, allowAutoCreate: false)
        guard case let .needsAutoCreate(request) = cold else {
            return XCTFail("expected confirmation, got \(cold)")
        }
        XCTAssertEqual(request.tab, "brand_new")
        XCTAssertEqual(
            request.fallback,
            ReaderTarget(courseId: "baf3m", scope: .lesson("01.01"), tab: "lesson")
        )
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: root.rootURL.appendingPathComponent(
                "courses/baf3m/01.01.brand_new.md"
            ).path)
        )

        let warm = await resolver.resolve(route, allowAutoCreate: true)
        XCTAssertEqual(
            warm,
            .reader(ReaderTarget(courseId: "baf3m", scope: .lesson("01.01"), tab: "brand_new"))
        )
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: root.rootURL.appendingPathComponent(
                "courses/baf3m/01.01.brand_new.md"
            ).path)
        )
    }

    func testExistingCustomTabRoutesWithoutCreation() async {
        let resolver = DeepLinkResolver(dataSource: repository)
        let resolved = await resolver.resolve(
            .lesson(courseId: "baf3m", lessonId: "01.01", tab: "vocab"),
            allowAutoCreate: false
        )
        XCTAssertEqual(
            resolved,
            .reader(ReaderTarget(courseId: "baf3m", scope: .lesson("01.01"), tab: "vocab"))
        )
    }

    func testMissingCourseOrLessonIsInvalid() async {
        let resolver = DeepLinkResolver(dataSource: repository)
        let course = await resolver.resolve(.course(courseId: "missing"), allowAutoCreate: false)
        guard case .invalid = course else { return XCTFail("expected invalid course") }
        let lesson = await resolver.resolve(
            .lesson(courseId: "baf3m", lessonId: "99.99", tab: "lesson"),
            allowAutoCreate: false
        )
        guard case .invalid = lesson else { return XCTFail("expected invalid lesson") }
    }

    func testMissingBaseTabUsesNavigationFallback() async {
        let resolver = DeepLinkResolver(dataSource: repository)
        // cheatsheet has no file but is always a valid course tab.
        let resolved = await resolver.resolve(
            .courseTab(courseId: "baf3m", tab: "cheatsheet"),
            allowAutoCreate: false
        )
        XCTAssertEqual(
            resolved,
            .reader(ReaderTarget(courseId: "baf3m", scope: .course, tab: "cheatsheet"))
        )
    }

    func testAutoCreateFailureOnReadOnlyRootIsReported() async {
        let resolver = DeepLinkResolver(dataSource: repository)
        root.writeGate.block(reason: "read-only")
        defer { root.writeGate.unblock() }
        let resolved = await resolver.resolve(
            .lesson(courseId: "baf3m", lessonId: "01.01", tab: "new_tab"),
            allowAutoCreate: true
        )
        guard case .invalid = resolved else {
            return XCTFail("expected a visible auto-create failure, got \(resolved)")
        }
    }
}
