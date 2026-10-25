import XCTest
@testable import CourseDeckCore

final class OutputValidationTests: XCTestCase {
    // MARK: - Fixtures

    private func lessonTest(mc: Int = 6, fib: Int = 4, answers: Int = 10, options: Int = 4) -> String {
        var lines = ["# Lesson Test", "", "## Questions"]
        var number = 1
        for _ in 0..<mc {
            lines.append(String(format: "%02d) [Knowledge & Understanding] Question %d", number, number))
            lines.append("<Multiple-Choice>")
            for option in 0..<options {
                lines.append("- [ ] Option \(Character(UnicodeScalar(65 + option)!)) for \(number)")
            }
            lines += ["", "--", ""]
            number += 1
        }
        for _ in 0..<fib {
            lines.append(String(format: "%02d) [Fill-in-the-Blank] Sentence %d has a _______ blank.", number, number))
            lines += ["", "--", ""]
            number += 1
        }
        lines.append("## Answers")
        for index in 1...answers {
            lines.append(String(format: "%02d) B - Because concept %d is correct.", index, index))
        }
        return lines.joined(separator: "\n")
    }

    private func unitTest(mc: Int = 8, fib: Int = 2, sa: Int = 2) -> String {
        var lines = ["# Unit Practice Exam", "", "## Questions"]
        var number = 1
        for _ in 0..<mc {
            lines.append(String(format: "%02d) [Application] Unit question %d", number, number))
            lines.append("<Multiple-Choice>")
            lines += ["- [ ] A", "- [ ] B", "- [ ] C", "- [ ] D", "", "--", ""]
            number += 1
        }
        for _ in 0..<fib {
            lines.append(String(format: "%02d) [Fill-in-the-Blank] Unit blank %d _______.", number, number))
            lines += ["", "--", ""]
            number += 1
        }
        lines.append("## Short Answer / Application Problems")
        for _ in 0..<sa {
            lines.append(String(format: "%02d) [Application] Short answer %d", number, number))
            lines += ["", "--", ""]
            number += 1
        }
        lines.append("## Answers & Explanations")
        for index in 1...(mc + fib + sa) {
            lines.append(String(format: "%02d) B - Rationale %d.", index, index))
        }
        return lines.joined(separator: "\n")
    }

    private func courseTest(mc: Int = 12, sa: Int = 4) -> String {
        var lines = ["# Comprehensive Final Course Practice Exam", "", "## Questions"]
        for index in 1...mc {
            lines.append(String(format: "%02d) [Knowledge] Course question %d", index, index))
            lines.append("<Multiple-Choice>")
            lines += ["- [ ] A", "- [ ] B", "- [ ] C", "- [ ] D", "", "--", ""]
        }
        lines.append("## Comprehensive Short Answer / Case Problems")
        for index in 1...sa {
            lines.append(String(format: "%02d) Multi-unit problem %d", index, index))
        }
        lines.append("## Answers & Detailed Solutions")
        for index in 1...mc {
            lines.append(String(format: "%02d) B - Course rationale %d.", index, index))
        }
        lines.append("### Comprehensive Short Answer / Case Problem Solutions")
        for index in 1...sa {
            lines.append(String(format: "%02d) Rubric for problem %d.", index, index))
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - Test validation

    func testValidLessonTestPasses() {
        let result = OutputValidator.validate(lessonTest(), kind: .lessonTest)
        XCTAssertTrue(result.isValid, "issues: \(result.issues)")
        XCTAssertEqual(result.questionCount, 10)
        XCTAssertEqual(result.multipleChoiceCount, 6)
        XCTAssertEqual(result.fillInTheBlankCount, 4)
        XCTAssertEqual(result.answerCount, 10)
        XCTAssertEqual(result.optionCounts, Array(repeating: 4, count: 6))
    }

    func testValidUnitAndCourseTestsPass() {
        let unit = OutputValidator.validate(unitTest(), kind: .unitTest)
        XCTAssertTrue(unit.isValid, "issues: \(unit.issues)")
        XCTAssertEqual(unit.questionCount, 12)
        XCTAssertEqual(unit.multipleChoiceCount, 8)
        XCTAssertEqual(unit.fillInTheBlankCount, 2)
        XCTAssertEqual(unit.shortAnswerCount, 2)

        let course = OutputValidator.validate(courseTest(), kind: .courseTest)
        XCTAssertTrue(course.isValid, "issues: \(course.issues)")
        XCTAssertEqual(course.questionCount, 16)
        XCTAssertEqual(course.multipleChoiceCount, 12)
        XCTAssertEqual(course.shortAnswerCount, 4)
        XCTAssertEqual(course.answerCount, 16)
    }

    func testMissingAnswerSectionFails() {
        let broken = lessonTest().components(separatedBy: "## Answers").first ?? ""
        let result = OutputValidator.validate(broken, kind: .lessonTest)
        XCTAssertFalse(result.isValid)
        XCTAssertTrue(result.issues.contains { $0.code == "missingAnswersSection" })
    }

    func testWrongQuestionCountsFail() {
        let truncated = lessonTest(mc: 5, fib: 4, answers: 9)
        let result = OutputValidator.validate(truncated, kind: .lessonTest)
        XCTAssertFalse(result.isValid)
        XCTAssertTrue(result.issues.contains { $0.code == "questionCount" })
        XCTAssertTrue(result.issues.contains { $0.code == "multipleChoiceCount" })
        XCTAssertTrue(result.issues.contains { $0.code == "answerCoverage" })
    }

    func testMultipleChoiceWithOneOptionFails() {
        let broken = lessonTest(options: 1)
        let result = OutputValidator.validate(broken, kind: .lessonTest)
        XCTAssertFalse(result.isValid)
        XCTAssertTrue(result.issues.contains { $0.code == "optionCount" })
    }

    func testSchemaPlaceholderIsRejected() {
        let placeholder = "# Lesson Test\n\n## Questions\n\n01) <Question prompt>\n<Multiple-Choice>\n- [ ] <Option A>\n- [ ] B\n\n## Answers\n01) B"
        let result = OutputValidator.validate(placeholder, kind: .lessonTest)
        XCTAssertFalse(result.isValid)
        XCTAssertTrue(result.issues.contains { $0.code == "placeholder" })
    }

    func testOuterCodeFenceIsStrippedOnce() {
        let fenced = "```markdown\n" + lessonTest() + "\n```"
        let result = OutputValidator.validate(fenced, kind: .lessonTest)
        XCTAssertTrue(result.isValid, "issues: \(result.issues)")
        XCTAssertFalse(result.normalizedContent.hasPrefix("```"))
        XCTAssertTrue(result.normalizedContent.contains("# Lesson Test"))
    }

    func testTwoCodeBlocksAreRejected() {
        let twoBlocks = """
        ```
        # First block
        ```

        ```
        # Second block
        ```
        """
        let result = OutputValidator.validate(twoBlocks, kind: .summary)
        XCTAssertFalse(result.isValid)
        XCTAssertTrue(result.issues.contains { $0.code == "multipleFences" })
    }

    func testUnclosedFenceIsRejected() {
        let unclosed = "```markdown\n# Summary\n\n" + String(repeating: "Detail. ", count: 30)
        let result = OutputValidator.validate(unclosed, kind: .summary)
        XCTAssertFalse(result.isValid)
        XCTAssertTrue(result.issues.contains { $0.code == "unclosedFence" })
    }

    func testTrailingTextAfterFenceIsRejected() {
        let trailing = "```\n# Summary\n\nText.\n```\nExtra text after the fence."
        let result = OutputValidator.validate(trailing, kind: .summary)
        XCTAssertFalse(result.isValid)
        XCTAssertTrue(result.issues.contains { $0.code == "trailingText" })
    }

    func testWrappedDocumentWithOneOuterFenceIsStripped() {
        let wrapped = "```markdown\n" + lessonTest() + "\n```"
        let result = OutputValidator.validate(wrapped, kind: .lessonTest)
        XCTAssertTrue(result.isValid, "issues: \(result.issues)")
        XCTAssertFalse(result.normalizedContent.hasPrefix("```"))
    }

    // MARK: - Prose validation

    func testSummaryAndCheatsheetValidation() {
        let short = "# Summary\n\nToo short."
        XCTAssertFalse(OutputValidator.validate(short, kind: .summary).isValid)

        let valid = "# Summary\n\n" + String(repeating: "Detailed explanation. ", count: 10)
        XCTAssertTrue(OutputValidator.validate(valid, kind: .summary).isValid)

        // Prose prompts accept tables and bullets without a heading.
        let noHeading = String(repeating: "Just prose. ", count: 30)
        XCTAssertTrue(OutputValidator.validate(noHeading, kind: .cheatsheet).isValid)

        let custom = String(repeating: "Custom tab content. ", count: 10)
        XCTAssertTrue(OutputValidator.validate(custom, kind: .custom("review")).isValid)
    }

    func testPromptRealisticProseWithTableAndBulletsPasses() {
        let prose = """
        | Term | Definition |
        | --- | --- |
        | Asset | A resource owned by the business. |
        | Liability | A debt owed by the business. |

        - Record every transaction.
        - Reconcile the ledger monthly.
        - Keep source documents.
        """
        let result = OutputValidator.validate(prose, kind: .summary)
        XCTAssertTrue(result.isValid, "issues: \(result.issues)")
    }

    func testAnswerKeyHeadingIsAccepted() {
        var document = lessonTest()
        document = document.replacingOccurrences(of: "## Answers", with: "## Answer Key")
        let result = OutputValidator.validate(document, kind: .lessonTest)
        XCTAssertTrue(result.isValid, "issues: \(result.issues)")
        XCTAssertEqual(result.answerCount, 10)
    }

    func testSuggestedAnswersHeadingIsAccepted() {
        let document = lessonTest().replacingOccurrences(of: "## Answers", with: "## Suggested Answers")
        let result = OutputValidator.validate(document, kind: .lessonTest)
        XCTAssertTrue(result.isValid, "issues: \(result.issues)")
        XCTAssertEqual(result.answerCount, 10)
    }

    func testShortAnswerHeadingIsNotMistakenForTheAnswerKey() {
        let result = OutputValidator.validate(courseTest(), kind: .courseTest)
        XCTAssertTrue(result.isValid, "issues: \(result.issues)")
        // 12 MC + 4 short-answer questions remain in the question region.
        XCTAssertEqual(result.questionCount, 16)
    }

    func testEmptyOutputFails() {
        let result = OutputValidator.validate("   \n", kind: .summary)
        XCTAssertFalse(result.isValid)
        XCTAssertTrue(result.issues.contains { $0.code == "empty" })
    }

    // MARK: - Frontmatter composition

    func testComposerPreservesScoredFieldsAndUnknownKeys() throws {
        let existing = """
        ---
        prompt: test
        contextAttachment: unit - lessons
        lastAttemptDate: 2026-01-01
        score: 9
        totalQuestions: 12
        percentage: 75
        customKey: keep
        ---

        OLD BODY
        """
        let generated = """
        ---
        prompt: ignored
        score: 0
        title: New Title
        ---

        # New Body

        Generated content.
        """
        let metadata = GeneratedDocumentMetadata(
            courseId: "baf3m",
            scopeId: "04.unit",
            tab: "test",
            promptID: "unit_test",
            contextAttachment: "unit - lessons",
            unitNumber: 4
        )
        let composed = try GeneratedDocumentComposer.compose(
            generated: generated,
            metadata: metadata,
            existing: existing
        )
        let document = try FrontmatterDocument(parsing: composed)
        XCTAssertEqual(document.value(forKey: "prompt")?.stringValue, "unit_test")
        XCTAssertEqual(document.value(forKey: "contextAttachment")?.stringValue, "unit - lessons")
        XCTAssertEqual(document.value(forKey: "score")?.intValue, 9)
        XCTAssertEqual(document.value(forKey: "totalQuestions")?.intValue, 12)
        XCTAssertEqual(document.value(forKey: "percentage")?.intValue, 75)
        XCTAssertEqual(document.value(forKey: "lastAttemptDate")?.stringValue, "2026-01-01")
        XCTAssertEqual(document.value(forKey: "customKey")?.stringValue, "keep")
        XCTAssertEqual(document.value(forKey: "title")?.stringValue, "New Title")
        XCTAssertEqual(document.value(forKey: "unitNumber")?.intValue, 4)
        XCTAssertTrue(document.body.contains("# New Body"))
        XCTAssertFalse(document.body.contains("OLD BODY"))
    }

    func testComposerTreatsMalformedFrontmatterAsBodyAndAddsMetadata() throws {
        let generated = """
        ---
        not: [valid
        ---

        # New Body

        Content.
        """
        let metadata = GeneratedDocumentMetadata(
            courseId: "baf3m",
            scopeId: "01.01",
            tab: "summary",
            promptID: "summary",
            contextAttachment: "lesson - lessons",
            unitNumber: 1,
            lessonNumber: 1
        )
        let composed = try GeneratedDocumentComposer.compose(
            generated: generated,
            metadata: metadata,
            existing: nil
        )
        XCTAssertTrue(composed.hasPrefix("---\n"))
        XCTAssertTrue(composed.contains("prompt: summary"))
        XCTAssertTrue(composed.contains("not: [valid"))
        XCTAssertTrue(composed.contains("# New Body"))
    }

    func testComposerRefusesCorruptExistingFrontmatter() {
        let existing = """
        ---
        score: [broken
        ---

        OLD BODY
        """
        let metadata = GeneratedDocumentMetadata(
            courseId: "baf3m",
            scopeId: "01.01",
            tab: "summary",
            promptID: "summary",
            contextAttachment: "lesson - lessons"
        )
        XCTAssertThrowsError(try GeneratedDocumentComposer.compose(
            generated: "# New\n\nContent.",
            metadata: metadata,
            existing: existing
        )) { error in
            XCTAssertEqual(error as? GeneratedDocumentComposerError, .corruptExistingFrontmatter)
        }
    }

    // MARK: - USERNOTE

    func testUserNotesAreSplitMergedAndDeduplicated() throws {
        let fixture = FixtureCodec.fixturesURL.appendingPathComponent("Live/baf3m_01.01.lesson.md")
        let content = try String(contentsOf: fixture, encoding: .utf8)
        let split = UserNoteProtector.split(content)
        XCTAssertEqual(split.notes.count, 1)
        XCTAssertFalse(split.content.contains("[!USERNOTE]"))
        let note = try XCTUnwrap(split.notes.first)
        let target = try XCTUnwrap(note.target)

        let generated = "Intro paragraph.\n\n\(target)\n\nAfter paragraph."
        let merged = UserNoteProtector.merge(split.notes, into: generated)
        XCTAssertEqual(merged.inserted, 1)
        XCTAssertEqual(merged.appended, 0)
        XCTAssertTrue(merged.content.contains("[!USERNOTE]"))
        XCTAssertTrue(merged.content.contains(note.query))
        let noteIndex = try XCTUnwrap(merged.content.range(of: "[!USERNOTE]")).lowerBound
        let afterIndex = try XCTUnwrap(merged.content.range(of: "After paragraph.")).lowerBound
        XCTAssertLessThan(noteIndex, afterIndex)

        let second = UserNoteProtector.merge(split.notes, into: merged.content)
        XCTAssertEqual(second.inserted + second.appended, 0)
        XCTAssertEqual(
            UserNoteProtector.split(second.content).notes.count,
            1
        )
    }

    func testUserNoteIsAppendedWhenTargetIsGone() {
        let note = UserNoteBlock(
            query: "explain",
            target: "a paragraph that no longer exists",
            lines: ["> [!USERNOTE] explain", "> <!-- target: \"a paragraph that no longer exists\" -->", "> The answer."]
        )
        let merged = UserNoteProtector.merge([note], into: "# Replacement\n\nNew content only.")
        XCTAssertEqual(merged.appended, 1)
        XCTAssertTrue(merged.content.contains("The answer."))
    }

    // MARK: - Snapshot

    func testSnapshotWritesPreviousFileToBak() throws {
        let workspace = try TestWorkspace()
        let target = workspace.url("courses/baf3m/01.01.summary.md")
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("OLD CONTENT".utf8).write(to: target)

        let backup = try GenerationSnapshot.snapshot(existing: "OLD CONTENT", to: target)
        XCTAssertNotNil(backup)
        XCTAssertEqual(try String(contentsOf: try XCTUnwrap(backup), encoding: .utf8), "OLD CONTENT")
        XCTAssertNil(try GenerationSnapshot.snapshot(existing: "   ", to: target))
    }
}
