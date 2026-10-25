@testable import CourseDeck
import CourseDeckCore
import XCTest

final class ReaderDocumentProviderTests: XCTestCase {
    func testSampleWritesHiddenAssetsAndReturnsDocument() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("CourseDeckProvider-\(UUID().uuidString)", isDirectory: true)
        let documents = FileManager.default.temporaryDirectory
            .appendingPathComponent("CourseDeckDocuments-\(UUID().uuidString)", isDirectory: true)
        let root = DataRoot(rootURL: rootURL, documentsURL: documents)
        try root.prepare()
        let repository = CourseRepository(root: root)
        let provider = ReaderDocumentProvider(root: root, repository: repository)

        let document = await provider.loadSample()
        XCTAssertEqual(document.file, "sample.reader.md")
        XCTAssertFalse(document.markdown.isEmpty)
        XCTAssertFalse(document.supportsCheckpoints)

        let icon = document.courseDirectoryURL
            .appendingPathComponent("assets/icons/deck.svg")
        XCTAssertTrue(FileManager.default.fileExists(atPath: icon.path))
        let markdown = document.courseDirectoryURL.appendingPathComponent("sample.reader.md")
        XCTAssertTrue(FileManager.default.fileExists(atPath: markdown.path))
    }

    func testMissingCourseIsReported() async {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("CourseDeckMissing-\(UUID().uuidString)", isDirectory: true)
        let root = DataRoot(rootURL: rootURL)
        try? root.prepare()
        let provider = ReaderDocumentProvider(root: root, repository: CourseRepository(root: root))
        let target = ReaderTarget(courseId: "missing", scope: .lesson("01.01"), tab: "lesson")
        do {
            _ = try await provider.load(target)
            XCTFail("Expected a missing course error")
        } catch let error as ReaderDocumentError {
            XCTAssertEqual(error, .courseNotFound("missing"))
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testMissingGeneratedTabIsReportedAsNotGenerated() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("CourseDeckNotGenerated-\(UUID().uuidString)", isDirectory: true)
        let root = DataRoot(rootURL: rootURL)
        try root.prepare()
        let repository = CourseRepository(root: root)
        let manifest = CourseManifest(id: "test", title: "Test", units: [
            CourseUnit(number: 1, title: "Unit 1", lessons: [
                CourseLesson(id: "01.01", title: "Lesson 1", unitNumber: 1, lessonNumber: 1),
            ]),
        ])
        try await repository.saveManifest(manifest)
        let provider = ReaderDocumentProvider(root: root, repository: repository)
        let target = ReaderTarget(courseId: "test", scope: .lesson("01.01"), tab: "summary")
        do {
            _ = try await provider.load(target)
            XCTFail("Expected a not-generated error")
        } catch let error as ReaderDocumentError {
            if case let .notGenerated(title) = error {
                XCTAssertEqual(title, "Lesson 1")
            } else {
                XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testCourseScheduleIsPresentedAsReadOnlyMarkdown() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("CourseDeckSchedule-\(UUID().uuidString)", isDirectory: true)
        let root = DataRoot(rootURL: rootURL)
        try root.prepare()
        let repository = CourseRepository(root: root)
        let manifest = CourseManifest(id: "test", title: "Test Course", units: [])
        try await repository.saveManifest(manifest)
        try await repository.saveCourseDocument(
            courseId: "test",
            tab: "schedule",
            content: "# Schedule\n\n- [ ] Read chapter 1\n"
        )
        let provider = ReaderDocumentProvider(root: root, repository: repository)
        let document = try await provider.load(
            ReaderTarget(courseId: "test", scope: .course, tab: "schedule")
        )
        XCTAssertEqual(document.file, "course.schedule.md")
        XCTAssertTrue(document.isReadOnly)
        XCTAssertFalse(document.supportsCheckpoints)
        XCTAssertTrue(document.markdown.contains("Read chapter 1"))

        let docs = try await repository.discoverCourseDocs(courseId: "test")
        let tabs = NavigationRules.courseTabs(docs: docs)
        XCTAssertEqual(tabs.first(where: { $0.slug == "schedule" })?.kind, .readOnlyReader)
        XCTAssertTrue(NavigationRules.isReadOnly(scope: .course, tab: "schedule"))
        XCTAssertFalse(ReaderSavePolicy.canSave(document: document, isWritable: true))
    }

    func testCourseLessonReturnsVirtualNavigationPageEvenWithoutFile() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("CourseDeckNavigation-\(UUID().uuidString)", isDirectory: true)
        let root = DataRoot(rootURL: rootURL)
        try root.prepare()
        let repository = CourseRepository(root: root)
        let manifest = CourseManifest(
            id: "test",
            title: "Test Course",
            units: [
                CourseUnit(number: 1, title: "Unit One", lessons: [
                    CourseLesson(id: "01.01", code: "A1", title: "Intro Lesson", unitNumber: 1, lessonNumber: 1),
                ]),
                CourseUnit(number: 2, title: "Unit Two", lessons: [
                    CourseLesson(id: "02.01", code: "B1", title: "Second Lesson", unitNumber: 2, lessonNumber: 1),
                ]),
            ]
        )
        try await repository.saveManifest(manifest)
        let provider = ReaderDocumentProvider(root: root, repository: repository)
        let target = ReaderTarget(courseId: "test", scope: .course, tab: "lesson")

        let document = try await provider.load(target)
        XCTAssertEqual(document.file, "course.lesson.md")
        XCTAssertEqual(document.title, "Course Navigation")
        XCTAssertFalse(document.supportsCheckpoints)
        XCTAssertTrue(document.isReadOnly)
        XCTAssertTrue(document.markdown.contains("Intro Lesson"))
        XCTAssertTrue(document.markdown.contains("Second Lesson"))
        XCTAssertTrue(document.markdown.contains("Unit One"))

        // A stale course.lesson.md must not be served.
        try await repository.saveCourseDocument(
            courseId: "test",
            tab: "lesson",
            content: "STALE FILE CONTENT"
        )
        let again = try await provider.load(target)
        XCTAssertFalse(again.markdown.contains("STALE FILE CONTENT"))
    }
}

@MainActor
final class QuizDocumentFormattingTests: XCTestCase {
    func testGeneratedPopQuizGainsProvenanceFrontmatter() throws {
        let raw = """
        # Pop Quiz

        ## Questions
        01) [Knowledge] Question one?
        <Multiple-Choice>
        - [ ] Wrong
        - [x] Right

        ## Answers
        01) B - (explanation) Right.
        """
        let formatted = AppServices.popQuizDocument(
            content: raw,
            courseId: "baf3m",
            lessonId: "01.01",
            timestamp: "2026-10-25_03-00-00"
        )
        let document = try FrontmatterDocument(parsing: formatted)
        XCTAssertEqual(document.value(forKey: "type")?.stringValue, "popquiz")
        XCTAssertEqual(document.value(forKey: "course")?.stringValue, "BAF3M")
        XCTAssertEqual(document.value(forKey: "lesson")?.stringValue, "01.01")
        XCTAssertEqual(document.value(forKey: "timestamp")?.stringValue, "2026-10-25_03-00-00")
        XCTAssertNotNil(document.value(forKey: "createdAt")?.stringValue)

        let quiz = QuestionParser.parse(formatted)
        XCTAssertEqual(quiz.questions.count, 1)
        XCTAssertEqual(quiz.questions[0].correctAnswer, "B")
    }

    func testPopQuizDocumentPreservesExistingFrontmatterKeys() throws {
        let raw = """
        ---
        prompt: custom
        type: popquiz
        customKey: keep
        ---

        # Pop Quiz

        ## Questions
        01) [Fill-in-the-Blank] The answer is ______.

        ## Answers
        01) value
        """
        let formatted = AppServices.popQuizDocument(
            content: raw,
            courseId: "mcr3u",
            lessonId: "02.01",
            timestamp: "2026-10-25_03-00-00"
        )
        let document = try FrontmatterDocument(parsing: formatted)
        XCTAssertEqual(document.value(forKey: "prompt")?.stringValue, "custom")
        XCTAssertEqual(document.value(forKey: "customKey")?.stringValue, "keep")
        XCTAssertEqual(document.value(forKey: "course")?.stringValue, "MCR3U")
        XCTAssertEqual(QuestionParser.parse(formatted).questions.count, 1)
    }
}
