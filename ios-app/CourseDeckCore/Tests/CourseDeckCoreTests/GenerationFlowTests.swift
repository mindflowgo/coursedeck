import XCTest
@testable import CourseDeckCore

final class GenerationFlowTests: XCTestCase {
    private struct FlowLesson {
        var unit: Int = 1
        var id: String
        var title: String = "Lesson"
        var body: String
        var summary: String?
        var cheatsheet: String?
        var test: String?
    }

    private struct FlowEnvironment {
        let workspace: TestWorkspace
        let repository: CourseRepository
        let prompts: PromptRepository
        let providers: LlmProviderStore
        let service: GenerationService
        let queue: GenerationQueue
        let server: MockSSEServer
    }

    private func long(_ tag: String, _ count: Int = 400) -> String {
        var text = tag + " "
        while text.count < count {
            text += "\(tag) content sentence. "
        }
        return text
    }

    private func summaryContent(_ tag: String = "SUMMARY") -> String {
        "# \(tag)\n\n" + String(repeating: "\(tag) key concept explanation. ", count: 8)
    }

    private func makeCourse(_ workspace: TestWorkspace, lessons: [FlowLesson]) throws {
        let grouped = Dictionary(grouping: lessons, by: \.unit)
        let units = grouped.keys.sorted().map { number -> CourseUnit in
            let specs = (grouped[number] ?? []).enumerated()
            return CourseUnit(
                number: number,
                title: "Unit \(number)",
                lessons: specs.map { index, spec in
                    CourseLesson(
                        id: spec.id,
                        code: spec.id,
                        title: spec.title,
                        unitNumber: number,
                        lessonNumber: index + 1,
                        type: .lesson,
                        hasFull: true,
                        hasSummary: spec.summary != nil,
                        hasCheatsheet: spec.cheatsheet != nil,
                        hasTest: spec.test != nil
                    )
                }
            )
        }
        let manifest = CourseManifest(
            id: "baf3m",
            title: "BAF3M",
            units: units,
            updatedAt: "2026-01-01T00:00:00.000Z"
        )
        try workspace.write(manifest.encoded(), to: "courses/baf3m/meta.json")
        for spec in lessons {
            try workspace.write(spec.body, to: "courses/baf3m/\(spec.id).lesson.md")
            if let summary = spec.summary {
                try workspace.write(summary, to: "courses/baf3m/\(spec.id).summary.md")
            }
            if let cheatsheet = spec.cheatsheet {
                try workspace.write(cheatsheet, to: "courses/baf3m/\(spec.id).cheatsheet.md")
            }
            if let test = spec.test {
                try workspace.write(test, to: "courses/baf3m/\(spec.id).test.md")
            }
        }
    }

    private func makeEnvironment(
        lessons: [FlowLesson],
        setKey: Bool = true,
        extraPrompts: [String: String] = [:],
        baseURLOverride: String? = nil,
        consent: Bool = true
    ) async throws -> FlowEnvironment {
        let workspace = try TestWorkspace()
        try makeCourse(workspace, lessons: lessons)
        let server = try MockSSEServer()

        let promptDirectory = workspace.baseURL.appendingPathComponent("Prompts", isDirectory: true)
        try FileManager.default.createDirectory(at: promptDirectory, withIntermediateDirectories: true)
        let promptIDs = [
            "summary", "cheatsheet", "test", "unit_test", "unit_assignments",
            "course_summary", "course_cheatsheet", "course_test", "popquiz",
        ]
        for id in promptIDs {
            let content = extraPrompts[id] ?? "# \(id) Prompt\n\nSystem instructions for \(id).\n"
            try Data(content.utf8).write(to: promptDirectory.appendingPathComponent("\(id).md"))
        }

        try workspace.write(
            """
            {
              "version": 2,
              "activeId": "card_test",
              "cards": [
                {
                  "id": "card_test",
                  "label": "DeepSeek",
                  "provider": "openai_compatible",
                  "baseUrl": "\(baseURLOverride ?? server.baseURL.absoluteString)",
                  "authHeaderType": "bearer",
                  "model": "deepseek-flash",
                  "temperature": 0.3,
                  "timeoutSeconds": 60,
                  "sendSessionId": false
                }
              ]
            }
            """,
            to: "llm_config.json"
        )

        let repository = CourseRepository(root: workspace.dataRoot)
        let prompts = PromptRepository(
            root: workspace.dataRoot,
            bundledDirectory: promptDirectory,
            provenance: PromptProvenanceStore(root: workspace.dataRoot)
        )
        let contexts = PromptContextService(repository: repository)
        let providers = LlmProviderStore(root: workspace.dataRoot, secretStore: InMemorySecretStore())
        _ = try await providers.load()
        if setKey {
            try await providers.setAPIKey("sk-test", for: "card_test")
        }
        let client = LlmClient(
            configuration: LlmClientConfiguration(
                retry: LlmRetryPolicy(maxAttempts: 1, baseDelay: 0, maximumDelay: 0, jitterFraction: 0)
            ),
            randomUnit: { 0 }
        )
        let service = GenerationService(
            root: workspace.dataRoot,
            repository: repository,
            prompts: prompts,
            contexts: contexts,
            providers: providers,
            client: client,
            consentProvider: { consent }
        )
        let queue = GenerationQueue(root: workspace.dataRoot) { job, context in
            try await service.execute(job: job, context: context)
        }
        return FlowEnvironment(
            workspace: workspace,
            repository: repository,
            prompts: prompts,
            providers: providers,
            service: service,
            queue: queue,
            server: server
        )
    }

    private func requestBody(_ environment: FlowEnvironment, at index: Int = 0) throws -> JSONValue {
        let requests = environment.server.requests
        return try XCTUnwrap(requests[safe: index]?.jsonBody)
    }

    // MARK: - Lesson flow

    func testLessonSummaryGenerationSavesFrontmatterAndStripsMedia() async throws {
        let body = """
        ---
        lessonNumber: 1
        ---
        # Accounting Lesson

        ![diagram](assets/diagram.png)

        This lesson explains the accounting equation and how transactions are recorded.
        """
        let environment = try await makeEnvironment(lessons: [FlowLesson(id: "01.01", body: body)])
        defer { environment.server.stop() }
        environment.server.route("/v1/chat/completions", [.successfulCompletion(summaryContent())])

        let job = try await environment.service.prepareLessonJob(
            LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary", force: true)
        )
        _ = try await environment.queue.enqueue(job)
        await environment.queue.drain()

        let stored = await environment.queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .succeeded)
        let content = try environment.workspace.readString("courses/baf3m/01.01.summary.md")
        let document = try FrontmatterDocument(parsing: content)
        XCTAssertEqual(document.value(forKey: "prompt")?.stringValue, "summary")
        XCTAssertEqual(document.value(forKey: "contextAttachment")?.stringValue, "lesson - lessons")
        XCTAssertEqual(document.value(forKey: "courseId")?.stringValue, "baf3m")
        XCTAssertEqual(document.value(forKey: "lesson")?.stringValue, "01.01")
        XCTAssertEqual(document.value(forKey: "unitNumber")?.intValue, 1)
        XCTAssertTrue(document.body.contains("# SUMMARY"))

        let request = try requestBody(environment)
        XCTAssertEqual(request["model"]?.stringValue, "deepseek-flash")
        XCTAssertEqual(request["max_tokens"]?.intValue, 24_576)
        let system = request["messages"]?.arrayValue?.first?["content"]?.stringValue
        XCTAssertEqual(system, "# summary Prompt\n\nSystem instructions for summary.\n")
        let user = request["messages"]?.arrayValue?.last?["content"]?.stringValue
        XCTAssertTrue(user?.contains("accounting equation") ?? false)
        XCTAssertFalse(user?.contains("assets/diagram.png") ?? true)
        XCTAssertFalse(user?.contains("lessonNumber") ?? true)
    }

    func testExistingNonEmptyFileRequiresConfirmation() async throws {
        let environment = try await makeEnvironment(lessons: [
            FlowLesson(id: "01.01", body: long("BODY"), summary: summaryContent("OLD")),
        ])
        defer { environment.server.stop() }

        do {
            _ = try await environment.service.prepareLessonJob(
                LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary")
            )
            XCTFail("Expected confirmation")
        } catch let error as GenerationError {
            guard case let .confirmationRequired(target, characters) = error else {
                return XCTFail("Wrong error \(error)")
            }
            XCTAssertEqual(target, "01.01.summary.md")
            XCTAssertGreaterThan(characters, 0)
        }
    }

    func testMissingActiveKeyFailsAtEnqueue() async throws {
        let environment = try await makeEnvironment(
            lessons: [FlowLesson(id: "01.01", body: long("BODY"))],
            setKey: false,
            baseURLOverride: "https://api.deepseek.com"
        )
        defer { environment.server.stop() }

        do {
            _ = try await environment.service.prepareLessonJob(
                LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary", force: true)
            )
            XCTFail("Expected missing key")
        } catch let error as GenerationError {
            XCTAssertEqual(error, .missingAPIKey("DeepSeek"))
        }
    }

    func testDeletingPinnedCardFailsQueuedJob() async throws {
        let environment = try await makeEnvironment(lessons: [FlowLesson(id: "01.01", body: long("BODY"))])
        defer { environment.server.stop() }
        environment.server.route("/v1/chat/completions", [.successfulCompletion(summaryContent())])

        let job = try await environment.service.prepareLessonJob(
            LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary", force: true)
        )
        _ = try await environment.queue.enqueue(job)
        _ = try await environment.providers.deleteCard(id: "card_test")
        await environment.queue.drain()

        let stored = await environment.queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .failed)
        XCTAssertTrue(stored?.lastError?.contains("no longer exists") ?? false)
        XCTAssertTrue(environment.server.requests.isEmpty)
        XCTAssertFalse(environment.workspace.exists("courses/baf3m/01.01.summary.md"))
    }

    func testGenerationRefusedWhenRootIsReadOnly() async throws {
        let environment = try await makeEnvironment(lessons: [FlowLesson(id: "01.01", body: long("BODY"))])
        defer { environment.server.stop() }
        environment.workspace.dataRoot.writeGate.block(reason: "newer data version")

        do {
            _ = try await environment.service.prepareLessonJob(
                LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary", force: true)
            )
            XCTFail("Expected write-blocked error")
        } catch let error as WriteBlockedError {
            XCTAssertTrue(error.reason.contains("newer"))
        }
        XCTAssertTrue(environment.server.requests.isEmpty)
    }

    func testGenerationRequiresConsent() async throws {
        let environment = try await makeEnvironment(
            lessons: [FlowLesson(id: "01.01", body: long("BODY"))],
            consent: false
        )
        defer { environment.server.stop() }

        do {
            _ = try await environment.service.prepareLessonJob(
                LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary", force: true)
            )
            XCTFail("Expected consent error")
        } catch let error as GenerationError {
            XCTAssertEqual(error, .consentRequired)
        }

        let job = GenerationJob(
            id: GenerationJob.identifier(courseId: "baf3m", lessonId: "01.01", tab: "summary"),
            courseId: "baf3m",
            lessonId: "01.01",
            lessonTitle: "Lesson",
            tab: "summary",
            activeCardId: "card_test",
            activeCardPolicy: "pinned"
        )
        do {
            _ = try await environment.service.execute(job: job)
            XCTFail("Expected consent error")
        } catch let error as GenerationError {
            XCTAssertEqual(error, .consentRequired)
        }
        XCTAssertTrue(environment.server.requests.isEmpty)
    }

    func testLengthTruncationRetriesWithLargerBudget() async throws {
        let environment = try await makeEnvironment(lessons: [FlowLesson(id: "01.01", body: long("BODY"))])
        defer { environment.server.stop() }
        environment.server.route("/v1/chat/completions", [
            .successfulCompletion(summaryContent("FIRST"), finishReason: "length"),
            .successfulCompletion(summaryContent("SECOND")),
        ])

        let job = try await environment.service.prepareLessonJob(
            LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary", force: true)
        )
        _ = try await environment.queue.enqueue(job)
        await environment.queue.drain()

        let stored = await environment.queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .succeeded)
        XCTAssertEqual(environment.server.requests.count, 2)
        let first = try requestBody(environment, at: 0)
        let second = try requestBody(environment, at: 1)
        XCTAssertEqual(first["max_tokens"]?.intValue, 24_576)
        XCTAssertEqual(second["max_tokens"]?.intValue, 49_152)
        let content = try environment.workspace.readString("courses/baf3m/01.01.summary.md")
        XCTAssertTrue(content.contains("SECOND"))
        XCTAssertFalse(content.contains("FIRST"))
    }

    func testTruncatedStreamNeverOverwritesGoodFile() async throws {
        let environment = try await makeEnvironment(lessons: [
            FlowLesson(id: "01.01", body: long("BODY"), summary: "GOOD EXISTING CONTENT"),
        ])
        defer { environment.server.stop() }
        environment.server.route("/v1/chat/completions", [.truncated("partial answer")])

        let job = try await environment.service.prepareLessonJob(
            LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary", force: true)
        )
        _ = try await environment.queue.enqueue(job)
        await environment.queue.drain()

        let stored = await environment.queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .failed)
        XCTAssertTrue(stored?.lastError?.contains("ended before completion") ?? false)
        XCTAssertEqual(
            try environment.workspace.readString("courses/baf3m/01.01.summary.md"),
            "GOOD EXISTING CONTENT"
        )
    }

    func testCorruptExistingFrontmatterFailsAfterSnapshot() async throws {
        let existing = """
        ---
        score: [broken
        ---

        OLD BODY
        """
        let environment = try await makeEnvironment(lessons: [
            FlowLesson(id: "01.01", body: long("BODY"), summary: existing),
        ])
        defer { environment.server.stop() }
        environment.server.route("/v1/chat/completions", [.successfulCompletion(summaryContent("NEW"))])

        let job = try await environment.service.prepareLessonJob(
            LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary", force: true)
        )
        _ = try await environment.queue.enqueue(job)
        await environment.queue.drain()

        let stored = await environment.queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .failed)
        XCTAssertTrue(stored?.lastError?.contains("unreadable frontmatter") ?? false)
        XCTAssertEqual(
            try environment.workspace.readString("courses/baf3m/01.01.summary.md"),
            existing
        )
        XCTAssertEqual(
            try environment.workspace.readString("courses/baf3m/01.01.summary.md.bak"),
            existing
        )
    }

    func testOverwriteMergesUserNotesAndSnapshotsPreviousFile() async throws {
        let noteTarget = "The passage identifies the core purpose of accounting: recording financial transactions."
        let existing = """
        # Old Summary

        \(noteTarget)

        > [!USERNOTE] explain this
        > <!-- target: "\(noteTarget)" -->
        > The answer is here.
        """
        let environment = try await makeEnvironment(lessons: [
            FlowLesson(id: "01.01", body: long("BODY"), summary: existing),
        ])
        defer { environment.server.stop() }
        let generated = "# New Summary\n\n\(noteTarget)\n\n" + String(repeating: "New detail. ", count: 20)
        environment.server.route("/v1/chat/completions", [.successfulCompletion(generated)])

        let job = try await environment.service.prepareLessonJob(
            LessonGenerationInput(courseId: "baf3m", lessonId: "01.01", tab: "summary", force: true)
        )
        _ = try await environment.queue.enqueue(job)
        await environment.queue.drain()

        let stored = await environment.queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .succeeded)
        let saved = try environment.workspace.readString("courses/baf3m/01.01.summary.md")
        XCTAssertTrue(saved.contains("[!USERNOTE] explain this"))
        XCTAssertTrue(saved.contains("The answer is here."))
        XCTAssertEqual(
            try environment.workspace.readString("courses/baf3m/01.01.summary.md.bak"),
            existing
        )
    }

    // MARK: - Unit flow

    func testUnitTestGenerationUsesUnitPromptAndAggregatesAllLessons() async throws {
        let environment = try await makeEnvironment(lessons: [
            FlowLesson(id: "01.01", title: "One", body: long("UNITONE")),
            FlowLesson(id: "01.02", title: "Two", body: long("UNITTWO")),
        ])
        defer { environment.server.stop() }
        environment.server.route("/v1/chat/completions", [.successfulCompletion(validUnitTest())])

        let job = try await environment.service.prepareUnitJob(
            UnitGenerationInput(courseId: "baf3m", unitNumber: 1, tab: "test", force: true)
        )
        _ = try await environment.queue.enqueue(job)
        await environment.queue.drain()

        let stored = await environment.queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .succeeded)
        let content = try environment.workspace.readString("courses/baf3m/01.unit.test.md")
        let document = try FrontmatterDocument(parsing: content)
        XCTAssertEqual(document.value(forKey: "prompt")?.stringValue, "unit_test")
        XCTAssertEqual(document.value(forKey: "contextAttachment")?.stringValue, "unit - lessons")
        XCTAssertEqual(document.value(forKey: "lesson")?.stringValue, "01.unit")

        let request = try requestBody(environment)
        let system = request["messages"]?.arrayValue?.first?["content"]?.stringValue
        XCTAssertEqual(system, "# unit_test Prompt\n\nSystem instructions for unit_test.\n")
        let user = request["messages"]?.arrayValue?.last?["content"]?.stringValue
        XCTAssertTrue(user?.contains("## 01.01 — One") ?? false)
        XCTAssertTrue(user?.contains("## 01.02 — Two") ?? false)
        XCTAssertTrue(user?.contains("UNITONE") ?? false)
        XCTAssertTrue(user?.contains("UNITTWO") ?? false)
    }

    // MARK: - Course-doc flows

    func testCourseSummaryUsesCuratedAggregation() async throws {
        let environment = try await makeEnvironment(lessons: [
            FlowLesson(id: "01.01", body: long("RAWMARKER1"), summary: long("SUMMARY1")),
            FlowLesson(id: "01.02", body: long("RAWMARKER2"), summary: long("SUMMARY2")),
        ])
        defer { environment.server.stop() }
        environment.server.route("/v1/chat/completions", [.successfulCompletion(summaryContent("COURSE"))])

        let job = try await environment.service.prepareCourseDocJob(
            CourseDocGenerationInput(courseId: "baf3m", kind: .summary, force: true)
        )
        _ = try await environment.queue.enqueue(job)
        await environment.queue.drain()

        let stored = await environment.queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .succeeded)
        let content = try environment.workspace.readString("courses/baf3m/course.summary.md")
        let document = try FrontmatterDocument(parsing: content)
        XCTAssertEqual(document.value(forKey: "prompt")?.stringValue, "course_summary")
        XCTAssertEqual(document.value(forKey: "contextAttachment")?.stringValue, "course - summaries")
        XCTAssertEqual(document.value(forKey: "lesson")?.stringValue, "course")

        let request = try requestBody(environment)
        let system = request["messages"]?.arrayValue?.first?["content"]?.stringValue
        XCTAssertEqual(system, "# course_summary Prompt\n\nSystem instructions for course_summary.\n")
        let user = request["messages"]?.arrayValue?.last?["content"]?.stringValue
        XCTAssertTrue(user?.contains("SUMMARY1") ?? false)
        XCTAssertTrue(user?.contains("SUMMARY2") ?? false)
        XCTAssertFalse(user?.contains("RAWMARKER1") ?? true)
    }

    func testCourseTestIncludesQuestionCoverage() async throws {
        let environment = try await makeEnvironment(lessons: [
            FlowLesson(
                id: "01.01",
                body: long("RAWMARKER1"),
                summary: long("SUMMARY1"),
                test: validLessonTest()
            ),
            FlowLesson(id: "01.02", body: long("RAWMARKER2"), summary: long("SUMMARY2")),
        ])
        defer { environment.server.stop() }
        environment.server.route("/v1/chat/completions", [.successfulCompletion(validCourseTest())])

        let job = try await environment.service.prepareCourseDocJob(
            CourseDocGenerationInput(courseId: "baf3m", kind: .test, force: true)
        )
        _ = try await environment.queue.enqueue(job)
        await environment.queue.drain()

        let stored = await environment.queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .succeeded)
        let content = try environment.workspace.readString("courses/baf3m/course.test.md")
        XCTAssertTrue(content.contains("prompt: course_test"))
        let request = try requestBody(environment)
        let user = request["messages"]?.arrayValue?.last?["content"]?.stringValue
        XCTAssertTrue(user?.contains("Existing question coverage") ?? false)
        XCTAssertTrue(user?.contains("Question 1") ?? false)
        XCTAssertTrue(user?.contains("SUMMARY1") ?? false)
    }

    func testFreshCourseWithoutCuratedContentFailsBeforeGeneration() async throws {
        let environment = try await makeEnvironment(lessons: [
            FlowLesson(id: "01.01", body: long("RAW1")),
            FlowLesson(id: "01.02", body: long("RAW2")),
        ])
        defer { environment.server.stop() }

        do {
            _ = try await environment.service.prepareCourseDocJob(
                CourseDocGenerationInput(courseId: "baf3m", kind: .summary, force: true)
            )
            XCTFail("Expected curated-coverage error")
        } catch let error as PromptContextError {
            guard case let .insufficientCuratedCoverage(_, covered, total, _) = error else {
                return XCTFail("Wrong error \(error)")
            }
            XCTAssertEqual(covered, 0)
            XCTAssertEqual(total, 2)
        }
        XCTAssertTrue(environment.server.requests.isEmpty)
    }

    // MARK: - Missing-work scan

    func testMissingWorkScanUsesStubRulesAndRejectsTestTab() async throws {
        let environment = try await makeEnvironment(lessons: [
            FlowLesson(id: "01.01", body: long("BODY1"), summary: "Not yet generated."),
            FlowLesson(id: "01.02", body: long("BODY2"), summary: long("GOOD SUMMARY"), cheatsheet: long("GOOD CHEAT")),
        ])
        defer { environment.server.stop() }
        let scanner = MissingWorkScanner(repository: environment.repository)

        let items = try await scanner.scan(courseId: "baf3m")
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.first?.lessonId, "01.01")
        XCTAssertEqual(items.first?.tabs, ["summary", "cheatsheet"])

        do {
            _ = try await scanner.scan(courseId: "baf3m", tabs: ["test"])
            XCTFail("Expected unsupported bulk tab")
        } catch let error as GenerationError {
            XCTAssertEqual(error, .unsupportedTab("test"))
        }
    }

    // MARK: - Document fixtures

    private func validLessonTest() -> String {
        var lines = ["# Lesson Test", "", "## Questions"]
        var number = 1
        for _ in 0..<6 {
            lines.append(String(format: "%02d) [Knowledge] Question %d", number, number))
            lines.append("<Multiple-Choice>")
            lines += ["- [ ] A", "- [ ] B", "- [ ] C", "- [ ] D", "", "--", ""]
            number += 1
        }
        for _ in 0..<4 {
            lines.append(String(format: "%02d) [Fill-in-the-Blank] Blank %d _______.", number, number))
            lines += ["", "--", ""]
            number += 1
        }
        lines.append("## Answers")
        for index in 1...10 {
            lines.append(String(format: "%02d) B - Rationale %d.", index, index))
        }
        return lines.joined(separator: "\n")
    }

    private func validUnitTest() -> String {
        var lines = ["# Unit Practice Exam", "", "## Questions"]
        var number = 1
        for _ in 0..<8 {
            lines.append(String(format: "%02d) [Application] Unit question %d", number, number))
            lines.append("<Multiple-Choice>")
            lines += ["- [ ] A", "- [ ] B", "- [ ] C", "- [ ] D", "", "--", ""]
            number += 1
        }
        for _ in 0..<2 {
            lines.append(String(format: "%02d) [Fill-in-the-Blank] Blank %d _______.", number, number))
            lines += ["", "--", ""]
            number += 1
        }
        lines.append("## Short Answer / Application Problems")
        for _ in 0..<2 {
            lines.append(String(format: "%02d) [Application] Short answer %d", number, number))
            lines += ["", "--", ""]
            number += 1
        }
        lines.append("## Answers & Explanations")
        for index in 1...12 {
            lines.append(String(format: "%02d) B - Rationale %d.", index, index))
        }
        return lines.joined(separator: "\n")
    }

    private func validCourseTest() -> String {
        var lines = ["# Comprehensive Final Course Practice Exam", "", "## Questions"]
        for index in 1...12 {
            lines.append(String(format: "%02d) [Knowledge] Course question %d", index, index))
            lines.append("<Multiple-Choice>")
            lines += ["- [ ] A", "- [ ] B", "- [ ] C", "- [ ] D", "", "--", ""]
        }
        lines.append("## Comprehensive Short Answer / Case Problems")
        for index in 1...4 {
            lines.append(String(format: "%02d) Multi-unit problem %d", index, index))
        }
        lines.append("## Answers & Detailed Solutions")
        for index in 1...12 {
            lines.append(String(format: "%02d) B - Course rationale %d.", index, index))
        }
        lines.append("### Comprehensive Short Answer / Case Problem Solutions")
        for index in 1...4 {
            lines.append(String(format: "%02d) Rubric for problem %d.", index, index))
        }
        return lines.joined(separator: "\n")
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
