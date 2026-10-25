import XCTest
@testable import CourseDeckCore

final class PromptContextTests: XCTestCase {
    private struct LessonSpec {
        var unit: Int = 1
        var id: String
        var title: String = "Lesson"
        var body: String
        var summary: String?
        var cheatsheet: String?
        var test: String?
    }

    private func long(_ tag: String, _ count: Int = 400) -> String {
        var text = tag + " "
        while text.count < count {
            text += "\(tag) content sentence. "
        }
        return text
    }

    @discardableResult
    private func makeCourse(_ workspace: TestWorkspace, lessons: [LessonSpec]) throws -> CourseManifest {
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
        return manifest
    }

    private func service(_ workspace: TestWorkspace) -> PromptContextService {
        PromptContextService(repository: CourseRepository(root: workspace.dataRoot))
    }

    // MARK: - Canonical tokens

    func testCanonicalAttachmentTokensAreExact() {
        XCTAssertEqual(PromptContextAttachment.lessonLessons.rawValue, "lesson - lessons")
        XCTAssertEqual(PromptContextAttachment.lessonSummaries.rawValue, "lesson - summaries")
        XCTAssertEqual(PromptContextAttachment.lessonCheatsheets.rawValue, "lesson - cheatsheets")
        XCTAssertEqual(PromptContextAttachment.unitLessons.rawValue, "unit - lessons")
        XCTAssertEqual(PromptContextAttachment.unitSummaries.rawValue, "unit - summaries")
        XCTAssertEqual(PromptContextAttachment.unitCheatsheets.rawValue, "unit - cheatsheets")
        XCTAssertEqual(PromptContextAttachment.courseLessons.rawValue, "course - lessons")
        XCTAssertEqual(PromptContextAttachment.courseSummaries.rawValue, "course - summaries")
        XCTAssertEqual(PromptContextAttachment.courseCheatsheets.rawValue, "course - cheatsheets")
        XCTAssertEqual(PromptContextAttachment.allCases.count, 9)
        XCTAssertNil(PromptContextAttachment.canonical("lesson-lessons"))
        XCTAssertNil(PromptContextAttachment.canonical("Lesson - Lessons"))
    }

    // MARK: - Lesson payloads

    func testLessonPayloadStripsFrontmatterAndMedia() async throws {
        let workspace = try TestWorkspace()
        let body = """
        ---
        lessonNumber: 1
        preferences: {}
        ---
        # Lesson body

        ![diagram](assets/diagram.png)

        <img src="assets/photo.png" alt="x">

        This lesson explains the accounting equation and enough supporting detail to pass the gate.
        """
        try makeCourse(workspace, lessons: [LessonSpec(id: "01.01", body: body)])
        let payload = try await service(workspace).lessonPayload(
            courseId: "baf3m",
            lessonId: "01.01",
            attachment: .lessonLessons
        )
        XCTAssertFalse(payload.content.contains("lessonNumber"))
        XCTAssertFalse(payload.content.contains("assets/diagram.png"))
        XCTAssertFalse(payload.content.contains("<img"))
        XCTAssertTrue(payload.content.contains("accounting equation"))
    }

    func testLessonPayloadMinimumGate() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace, lessons: [LessonSpec(id: "01.01", body: "tiny")])
        do {
            _ = try await service(workspace).lessonPayload(
                courseId: "baf3m",
                lessonId: "01.01",
                attachment: .lessonLessons
            )
            XCTFail("Expected payload gate")
        } catch let error as PromptContextError {
            XCTAssertEqual(error, .payloadTooShort(actual: 4, minimum: 50))
        }
    }

    // MARK: - Unit budgets

    func testUnitLessonsAreBudgetedPerLesson() async throws {
        let workspace = try TestWorkspace()
        let specs = (1...4).map { index in
            LessonSpec(id: "01.0\(index)", title: "Lesson \(index)", body: long("LESSON\(index)", 4_000))
        }
        try makeCourse(workspace, lessons: specs)

        let payload = try await service(workspace).unitPayload(
            courseId: "baf3m",
            unitNumber: 1,
            attachment: .unitLessons
        )
        XCTAssertEqual(payload.lessonsIncluded, 4)
        XCTAssertEqual(payload.truncatedLessonIDs.count, 4)
        XCTAssertTrue(payload.content.contains("## 01.01 — Lesson 1"))
        XCTAssertTrue(payload.content.contains("[… truncated …]"))
        XCTAssertLessThanOrEqual(payload.content.count, 80_000)
    }

    func testUnitTotalBudgetIsEnforced() async throws {
        let workspace = try TestWorkspace()
        let specs = (1...30).map { index in
            LessonSpec(
                id: String(format: "01.%02d", index),
                title: "Lesson \(index)",
                body: long("L\(index)", 3_500)
            )
        }
        try makeCourse(workspace, lessons: specs)

        let payload = try await service(workspace).unitPayload(
            courseId: "baf3m",
            unitNumber: 1,
            attachment: .unitLessons
        )
        XCTAssertLessThanOrEqual(payload.content.count, 80_000)
        XCTAssertLessThan(payload.lessonsIncluded, 30)
        XCTAssertFalse(payload.truncatedLessonIDs.isEmpty)
    }

    func testUnitSummaryAndCheatsheetFallBackToRaw() async throws {
        let workspace = try TestWorkspace()
        let specs = [
            LessonSpec(id: "01.01", body: long("RAW1"), summary: long("SUMMARY1")),
            LessonSpec(id: "01.02", body: long("RAW2")),
            LessonSpec(id: "01.03", body: long("RAW3"), summary: long("SUMMARY3"), cheatsheet: long("CHEATSHEET3")),
        ]
        try makeCourse(workspace, lessons: specs)

        let summaries = try await service(workspace).unitPayload(
            courseId: "baf3m",
            unitNumber: 1,
            attachment: .unitSummaries
        )
        XCTAssertTrue(summaries.content.contains("SUMMARY1"))
        XCTAssertTrue(summaries.content.contains("RAW2"))
        XCTAssertEqual(summaries.fallbackLessonIDs, ["01.02"])

        let cheatsheets = try await service(workspace).unitPayload(
            courseId: "baf3m",
            unitNumber: 1,
            attachment: .unitCheatsheets
        )
        XCTAssertTrue(cheatsheets.content.contains("CHEATSHEET3"))
        XCTAssertTrue(cheatsheets.content.contains("SUMMARY1"))
        XCTAssertTrue(cheatsheets.content.contains("RAW2"))
        XCTAssertEqual(Set(cheatsheets.fallbackLessonIDs), Set(["01.01", "01.02"]))
    }

    func testUnitLessonsIncludeShortRawLessons() async throws {
        let workspace = try TestWorkspace()
        let shortBody = "SHORTLESSON " + String(repeating: "brief. ", count: 25)
        XCTAssertGreaterThan(shortBody.count, 50)
        XCTAssertLessThan(shortBody.count, 250)
        try makeCourse(workspace, lessons: [
            LessonSpec(id: "01.01", title: "Short", body: shortBody),
            LessonSpec(id: "01.02", title: "Long", body: long("LONGLESSON", 4_000)),
        ])

        let payload = try await service(workspace).unitPayload(
            courseId: "baf3m",
            unitNumber: 1,
            attachment: .unitLessons
        )
        XCTAssertEqual(payload.lessonsIncluded, 2)
        XCTAssertTrue(payload.content.contains("SHORTLESSON"))
        XCTAssertTrue(payload.content.contains("LONGLESSON"))
        // Only the 4,000-character lesson is truncated; the short one is kept
        // in full even though it is under the 250-character stub threshold.
        XCTAssertEqual(payload.truncatedLessonIDs, ["01.02"])
    }

    // MARK: - Course-doc matrix

    func testCourseSummaryUsesSummaryThenCheatsheet() async throws {
        let workspace = try TestWorkspace()
        let specs = [
            LessonSpec(id: "01.01", body: long("RAW1"), summary: long("SUMMARY1")),
            LessonSpec(id: "01.02", body: long("RAW2"), cheatsheet: long("CHEATSHEET2")),
            LessonSpec(id: "01.03", body: long("RAW3"), summary: long("SUMMARY3"), cheatsheet: long("CHEATSHEET3")),
        ]
        try makeCourse(workspace, lessons: specs)
        let payload = try await service(workspace).buildAggregatedPayload(courseId: "baf3m", kind: .summary)
        XCTAssertEqual(payload.attachment, .courseSummaries)
        XCTAssertEqual(payload.curatedCoveredLessons, 3)
        XCTAssertTrue(payload.content.contains("SUMMARY1"))
        XCTAssertTrue(payload.content.contains("CHEATSHEET2"))
        XCTAssertTrue(payload.content.contains("SUMMARY3"))
        XCTAssertFalse(payload.content.contains("RAW2"))
        XCTAssertEqual(payload.fallbackLessonIDs, ["01.02"])
    }

    func testCourseCheatsheetUsesCheatsheetThenSummaryWith2500Budget() async throws {
        let workspace = try TestWorkspace()
        let specs = [
            LessonSpec(id: "01.01", body: long("RAW1"), summary: long("SUMMARY1"), cheatsheet: long("CHEATSHEET1", 5_000)),
            LessonSpec(id: "01.02", body: long("RAW2"), summary: long("SUMMARY2")),
        ]
        try makeCourse(workspace, lessons: specs)
        let payload = try await service(workspace).buildAggregatedPayload(courseId: "baf3m", kind: .cheatsheet)
        XCTAssertEqual(payload.attachment, .courseCheatsheets)
        XCTAssertTrue(payload.content.contains("CHEATSHEET1"))
        XCTAssertTrue(payload.content.contains("SUMMARY2"))
        XCTAssertEqual(payload.truncatedLessonIDs, ["01.01"])
        XCTAssertTrue(payload.content.contains("[… truncated …]"))
    }

    func testCourseTestAppendsLimitedQuestionCoverage() async throws {
        let workspace = try TestWorkspace()
        let testDocument = questionDocument(count: 12, continuation: 9)
        let specs = [
            LessonSpec(id: "01.01", body: long("RAW1"), summary: long("SUMMARY1"), test: testDocument),
            LessonSpec(id: "01.02", body: long("RAW2"), summary: long("SUMMARY2")),
        ]
        try makeCourse(workspace, lessons: specs)
        let payload = try await service(workspace).buildAggregatedPayload(courseId: "baf3m", kind: .test)
        XCTAssertTrue(payload.content.contains("Existing question coverage"))
        XCTAssertTrue(payload.content.contains("Question 01"))
        XCTAssertFalse(payload.content.contains("Question 11"))
        XCTAssertFalse(payload.content.contains("L01i"))
    }

    func testCourseTestQuestionCoverageFallback() {
        let coverage = PromptContextService.questionCoverage(
            from: "No numbered questions here, just prose that should be used as a fallback.",
            maxQuestions: 10,
            maxLinesPerQuestion: 8,
            fallbackCharacters: 20
        )
        XCTAssertEqual(coverage, "No numbered question")
    }

    func testFreshCourseWithoutCuratedContentThrows() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace, lessons: [
            LessonSpec(id: "01.01", body: long("RAW1")),
            LessonSpec(id: "01.02", body: long("RAW2")),
        ])
        do {
            _ = try await service(workspace).buildAggregatedPayload(courseId: "baf3m", kind: .summary)
            XCTFail("Expected insufficient curated coverage")
        } catch let error as PromptContextError {
            XCTAssertEqual(
                error,
                .insufficientCuratedCoverage(courseId: "baf3m", covered: 0, total: 2, minimum: 0.5)
            )
        }
    }

    func testCoverageBelowThresholdThrows() async throws {
        let workspace = try TestWorkspace()
        let specs = (1...4).map { index in
            LessonSpec(
                id: String(format: "01.%02d", index),
                body: long("RAW\(index)"),
                summary: index == 1 ? long("SUMMARY1") : nil
            )
        }
        try makeCourse(workspace, lessons: specs)
        do {
            _ = try await service(workspace).buildAggregatedPayload(courseId: "baf3m", kind: .summary)
            XCTFail("Expected coverage failure")
        } catch let error as PromptContextError {
            guard case let .insufficientCuratedCoverage(_, covered, total, _) = error else {
                return XCTFail("wrong error \(error)")
            }
            XCTAssertEqual(covered, 1)
            XCTAssertEqual(total, 4)
        }
    }

    func testCourseLessonsRemainAvailableThroughPromptContextButNotCourseDocs() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace, lessons: [
            LessonSpec(id: "01.01", body: long("RAW1")),
            LessonSpec(id: "01.02", body: long("RAW2")),
        ])
        let payload = try await service(workspace).getPromptContext(
            courseId: "baf3m",
            lessonId: "01.01",
            attachment: "course - lessons"
        )
        XCTAssertEqual(payload.attachment, .courseLessons)
        XCTAssertTrue(payload.content.contains("RAW1"))
        XCTAssertTrue(payload.content.contains("RAW2"))
        XCTAssertFalse(CourseDocKind.allCases.map(\.attachment).contains(.courseLessons))
    }

    func testGetPromptContextRejectsUnknownToken() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace, lessons: [LessonSpec(id: "01.01", body: long("RAW1"))])
        do {
            _ = try await service(workspace).getPromptContext(
                courseId: "baf3m",
                lessonId: "01.01",
                attachment: "lesson-summaries"
            )
            XCTFail("Expected rejection")
        } catch let error as PromptContextError {
            XCTAssertEqual(error, .unsupportedAttachment("lesson-summaries"))
        }
    }

    // MARK: - Helpers

    private func questionDocument(count: Int, continuation: Int) -> String {
        var lines = ["# Practice Test", "", "## Questions"]
        for index in 1...count {
            lines.append(String(format: "%02d) Question %02d", index, index))
            for offset in 0..<continuation {
                let letter = Character(UnicodeScalar(97 + offset)!)
                lines.append(String(format: "L%02d%@ continuation text", index, String(letter)))
            }
            lines.append("")
        }
        lines.append("## Answers")
        for index in 1...count {
            lines.append(String(format: "%02d) B - rationale", index))
        }
        return lines.joined(separator: "\n")
    }
}
