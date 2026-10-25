import Foundation
import XCTest
@testable import CourseDeckCore

final class QuestionParserTests: XCTestCase {
    private func fixture(_ path: String) throws -> String {
        let url = FixtureCodec.fixturesURL.appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - Ported desktop cases

    func testParsesStandardMultipleChoiceQuiz() throws {
        let markdown = """
        # Lesson 1.1: Foundations

        ## Questions
        01) [Knowledge & Understanding] What is a primary colour?
        <Multiple-Choice>
        - [ ] Red
        - [ ] Green
        - [ ] Orange
        - [ ] Purple

        --

        02) [Thinking & Investigation] Which colour results from mixing red and yellow?
        <Multiple-Choice>
        - [ ] Green
        - [ ] Purple
        - [ ] Orange
        - [ ] Blue

        --

        ## Answers
        01) A - (explanation) Red is a primary colour.
        02) C - (explanation) Orange is produced by mixing red and yellow.
        """
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.title, "Lesson 1.1: Foundations")
        XCTAssertEqual(quiz.questions.count, 2)
        XCTAssertEqual(quiz.questions[0].number, "01")
        XCTAssertEqual(quiz.questions[0].category, "Knowledge & Understanding")
        XCTAssertEqual(quiz.questions[0].correctAnswer, "A")
        XCTAssertEqual(quiz.questions[0].explanation, "Red is a primary colour.")
        XCTAssertEqual(quiz.questions[0].options.count, 4)
        XCTAssertEqual(quiz.questions[0].options[0].text, "Red")
        XCTAssertEqual(quiz.questions[1].correctAnswer, "C")
        XCTAssertEqual(quiz.questions[1].explanation, "Orange is produced by mixing red and yellow.")
    }

    func testParsesBoldAnswersAndDashSeparators() throws {
        let markdown = """
        # Accounting Fundamentals

        ## Questions
        01) [KU] What is an asset?
        <Multiple-Choice>
        - [ ] Owed amount
        - [ ] Owned item with dollar value
        - [ ] Owner equity
        - [ ] Net income

        --

        02) [TI] What does unlimited liability imply?
        <Multiple-Choice>
        - [ ] Personal assets at risk
        - [ ] Corporate shelter
        - [ ] No taxes
        - [ ] Shared shares

        --

        ## Answers
        01) **B** — (explanation) Assets are items owned with value.
        02) C – (explanation) Personal assets are at risk.
        """
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 2)
        XCTAssertEqual(quiz.questions[0].correctAnswer, "B")
        XCTAssertEqual(quiz.questions[0].explanation, "Assets are items owned with value.")
        XCTAssertEqual(quiz.questions[1].correctAnswer, "C")
        XCTAssertEqual(quiz.questions[1].explanation, "Personal assets are at risk.")
    }

    func testStripsDuplicateOptionLetterPrefixes() throws {
        let markdown = """
        # Quiz

        ## Questions
        01) Prompt
        <Multiple-Choice>
        - [ ] A) First option
        - [ ] B. Second option
        - [ ] C: Third option
        - [ ] D Fourth option

        --

        ## Answers
        01) B - (explanation) Correct.
        """
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 1)
        XCTAssertEqual(quiz.questions[0].options.map(\.text), [
            "First option", "Second option", "Third option", "D Fourth option",
        ])
    }

    func testCheckedOptionFallback() throws {
        let markdown = """
        # Quick Check

        ## Questions
        01) What is 2 + 2?
        <Multiple-Choice>
        - [ ] 3
        - [x] 4
        - [ ] 5
        - [ ] 6
        """
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 1)
        XCTAssertEqual(quiz.questions[0].correctAnswer, "B")
    }

    func testExpandsMultipleChoiceLettersBeyondD() throws {
        let markdown = """
        # Quiz

        ## Questions
        01) Pick the best answer
        <Multiple-Choice>
        - [ ] A
        - [ ] B
        - [ ] C
        - [ ] D
        - [ ] E
        - [x] F

        ## Answers
        01) **F** - (explanation) F is correct.
        """
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions[0].options.map(\.letter), ["A", "B", "C", "D", "E", "F"])
        XCTAssertEqual(quiz.questions[0].correctAnswer, "F")
    }

    func testSerializationRoundTrip() throws {
        let quiz = ParsedQuiz(
            courseCode: "TEST101",
            title: "Practice Test",
            questions: [
                QuizQuestion(
                    id: "s0q01-0",
                    number: "01",
                    originalNumber: "01",
                    sectionIndex: 0,
                    category: "KU",
                    type: .multipleChoice,
                    prompt: "What is true?",
                    options: [
                        QuizOption(letter: "A", text: "Option A"),
                        QuizOption(letter: "B", text: "Option B"),
                    ],
                    correctAnswer: "B",
                    explanation: "B is right."
                ),
            ]
        )
        let markdown = QuestionParser.serialize(quiz)
        XCTAssertTrue(markdown.contains("course: TEST101"))
        XCTAssertTrue(markdown.contains("01) [KU] What is true?"))
        XCTAssertTrue(markdown.contains("- [ ] Option A"))
        XCTAssertTrue(markdown.contains("01) B - (explanation) B is right."))

        let roundTrip = QuestionParser.parse(markdown)
        XCTAssertEqual(roundTrip.questions.count, 1)
        XCTAssertEqual(roundTrip.questions[0].correctAnswer, "B")
        XCTAssertEqual(roundTrip.questions[0].explanation, "B is right.")
    }

    func testMixedUnitTestMultipleChoiceFillInAndShortAnswer() throws {
        let markdown = """
        # Unit 1 Practice Exam

        ## Questions
        01) [Knowledge & Understanding] What is velocity?
        <Multiple-Choice>
        - [ ] Rate of change of position
        - [ ] Scalar speed
        - [ ] Total distance
        - [ ] Acceleration

        --

        02) [Fill-in-the-Blank] The rate of change of velocity is known as ___________.

        --

        ## Short Answer / Application Problems
        03) [Application] Describe how to calculate net force on an inclined plane.

        --

        ## Answers & Explanations
        01) A - (explanation) Velocity is vector displacement over time.
        02) acceleration - (explanation) Acceleration is dv/dt.
        03) Rubric: Resolve gravitational force into parallel and perpendicular components, subtract friction - (explanation) F_net = mg sin(theta) - f_k.
        """
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 3)
        XCTAssertEqual(quiz.questions[0].type, .multipleChoice)
        XCTAssertEqual(quiz.questions[0].correctAnswer, "A")
        XCTAssertEqual(quiz.questions[1].type, .fillInTheBlank)
        XCTAssertEqual(quiz.questions[1].correctAnswer, "acceleration")
        XCTAssertEqual(quiz.questions[2].type, .shortAnswer)
        XCTAssertEqual(quiz.questions[2].category, "Application")
        XCTAssertTrue(quiz.questions[2].prompt.contains("inclined plane"))
        XCTAssertTrue(quiz.questions[2].correctAnswer.contains("Resolve gravitational force"))
        XCTAssertTrue(quiz.questions[2].explanation?.contains("F_net = mg sin(theta)") == true)
    }

    func testSerializationRoundTripMixedTypes() throws {
        let quiz = ParsedQuiz(
            title: "Mixed",
            questions: [
                QuizQuestion(
                    id: "a",
                    number: "01",
                    originalNumber: "01",
                    sectionIndex: 0,
                    type: .multipleChoice,
                    prompt: "Pick one",
                    options: [QuizOption(letter: "A", text: "No"), QuizOption(letter: "B", text: "Yes")],
                    correctAnswer: "B"
                ),
                QuizQuestion(
                    id: "b",
                    number: "02",
                    originalNumber: "02",
                    sectionIndex: 1,
                    type: .fillInTheBlank,
                    prompt: "The capital is ______.",
                    correctAnswer: "Toronto"
                ),
                QuizQuestion(
                    id: "c",
                    number: "03",
                    originalNumber: "03",
                    sectionIndex: 2,
                    type: .shortAnswer,
                    prompt: "Explain two things.",
                    correctAnswer: "Expected Criteria / Rubric",
                    explanation: "Two valid points."
                ),
            ]
        )
        let roundTrip = QuestionParser.parse(QuestionParser.serialize(quiz))
        XCTAssertEqual(roundTrip.questions.count, 3)
        XCTAssertEqual(roundTrip.questions.map(\.type), [.multipleChoice, .fillInTheBlank, .shortAnswer])
        XCTAssertEqual(roundTrip.questions[1].correctAnswer, "Toronto")
        XCTAssertEqual(roundTrip.questions[2].correctAnswer, "Expected Criteria / Rubric")
    }

    func testGenericSuggestedAnswersHeadingDoesNotLeakMCKeys() throws {
        let markdown = try fixture("Quizzes/custom_suggested_answers.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 4, "\(quiz.issues)")
        let multipleChoice = quiz.questions.filter { $0.type == .multipleChoice }
        let shortAnswer = quiz.questions.filter { $0.type == .shortAnswer }
        XCTAssertEqual(multipleChoice.map(\.correctAnswer), ["B", "C"])
        XCTAssertEqual(shortAnswer.count, 2)
        for question in shortAnswer {
            XCTAssertGreaterThan(question.correctAnswer.count, 1, "short answer picked up an MC letter: \(question.correctAnswer)")
            XCTAssertTrue(question.correctAnswer.contains("Rubric"), question.correctAnswer)
        }
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    func testSingleMixedQuestionSectionUsesSplitAnswerSections() throws {
        let markdown = try fixture("Quizzes/custom_mixed_split_answers.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 4, "\(quiz.issues)")
        XCTAssertEqual(quiz.questions[0].type, .multipleChoice)
        XCTAssertEqual(quiz.questions[0].correctAnswer, "B")
        XCTAssertEqual(quiz.questions[1].type, .fillInTheBlank)
        XCTAssertEqual(quiz.questions[1].correctAnswer, "Toronto")
        XCTAssertFalse(quiz.questions[1].correctAnswer.contains("A -"))
        XCTAssertEqual(quiz.questions[2].type, .multipleChoice)
        XCTAssertEqual(quiz.questions[2].correctAnswer, "C")
        XCTAssertEqual(quiz.questions[3].type, .fillInTheBlank)
        XCTAssertTrue(quiz.questions[3].correctAnswer.lowercased().contains("owner"))
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    func testTwoSameKindQuestionSectionsUseTheirOwnAnswerSections() throws {
        let markdown = try fixture("Quizzes/custom_two_same_kind_sections.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 4, "\(quiz.issues)")
        XCTAssertEqual(quiz.questions.map(\.correctAnswer), ["B", "C", "C", "A"])
        XCTAssertEqual(quiz.questions.map(\.sectionIndex), [0, 0, 2, 2])
        XCTAssertEqual(quiz.questions.map(\.number), ["01", "02", "03", "04"])
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    func testTextMultipleChoiceAnswerKeyMapsToOptionLetters() throws {
        let markdown = try fixture("Quizzes/custom_text_mc_answers.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 2)
        XCTAssertEqual(quiz.questions[0].correctAnswer, "B")
        XCTAssertEqual(quiz.questions[1].correctAnswer, "C")
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    func testSuggestedAnswersRubricStartingWithPartLabelIsText() throws {
        let markdown = try fixture("Quizzes/custom_suggested_answers_a_prefix.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 3, "\(quiz.issues)")
        let short = quiz.questions.last!
        XCTAssertEqual(short.type, .shortAnswer)
        XCTAssertNotEqual(short.correctAnswer, "A")
        XCTAssertTrue(short.correctAnswer.lowercased().contains("unlimited liability"), short.correctAnswer)
        XCTAssertTrue(short.correctAnswer.lowercased().contains("a)"), short.correctAnswer)
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    func testNumberedLinesInsideAnswerBodyStayInTheBody() throws {
        let markdown = try fixture("Quizzes/custom_numbered_rubric.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 2, "\(quiz.issues)")
        let short = quiz.questions[1]
        XCTAssertEqual(short.type, .shortAnswer)
        XCTAssertTrue(short.correctAnswer.contains("Rubric"), short.correctAnswer)
        let explanation = short.explanation ?? ""
        XCTAssertTrue(explanation.contains("Unlimited liability"), explanation)
        XCTAssertTrue(explanation.contains("shared decision-making"), explanation)
        XCTAssertTrue(explanation.contains("owner bears all losses"), explanation)
        XCTAssertFalse(quiz.questions.contains { $0.originalNumber == "02" && $0.sectionIndex == 1 })
    }

    func testH3InsideAnswerPreservesContentAndNextAnswer() throws {
        let markdown = try fixture("Quizzes/custom_h3_inside_answer.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 2, "\(quiz.issues)")
        XCTAssertEqual(quiz.questions[0].correctAnswer, "B")
        XCTAssertTrue(quiz.questions[0].explanation?.contains("primary colours") == true)
        XCTAssertTrue(quiz.questions[0].explanation?.contains("not produced by mixing") == true)
        XCTAssertEqual(quiz.questions[1].correctAnswer, "C")
        XCTAssertTrue(quiz.questions[1].explanation?.contains("liability") == true)
    }

    // MARK: - Legacy fill-in sections

    func testLegacyFillInAfterAnswersUsesSectionIndexedKeys() throws {
        let markdown = try fixture("Quizzes/mcr3u_01.01.test.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 10, "6 MC + 4 FIB after ## Answers")
        XCTAssertEqual(quiz.questions.filter { $0.type == .multipleChoice }.count, 6)
        XCTAssertEqual(quiz.questions.filter { $0.type == .fillInTheBlank }.count, 4)

        // FIB numbering restarts at 01; display numbers are renumbered after
        // the duplicates, and answers still resolve within the FIB section.
        XCTAssertEqual(quiz.questions[6].originalNumber, "01")
        XCTAssertEqual(quiz.questions[6].number, "07")
        XCTAssertTrue(quiz.questions[6].correctAnswer.lowercased().contains("relation"))
        XCTAssertTrue(quiz.questions[7].correctAnswer.lowercased().contains("one"))
        XCTAssertTrue(quiz.questions[8].correctAnswer.lowercased().contains("domain"))
        XCTAssertTrue(quiz.questions[9].correctAnswer.lowercased().contains("f(x)"))
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
        XCTAssertEqual(Set(quiz.questions.map(\.number)).count, quiz.questions.count)
    }

    func testLegacyFillInWithNumericListNumberingAndBoldAnswers() throws {
        let markdown = try fixture("Quizzes/gwl3o_02.01.test.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 10)
        XCTAssertEqual(quiz.questions.filter { $0.type == .multipleChoice }.count, 6)
        XCTAssertEqual(quiz.questions.filter { $0.type == .fillInTheBlank }.count, 4)
        XCTAssertEqual(quiz.questions[6].originalNumber, "01")
        XCTAssertTrue(quiz.questions[6].correctAnswer.lowercased().contains("listening"))
        XCTAssertTrue(quiz.questions[7].correctAnswer.lowercased().contains("integrity"))
        XCTAssertTrue(quiz.questions[8].correctAnswer.lowercased().contains("others"))
        XCTAssertTrue(quiz.questions[9].correctAnswer.lowercased().contains("interpersonal"))
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    func testInlineAnswerInFillInSection() throws {
        let markdown = try fixture("Quizzes/clu3m_01.05.test.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 11, "7 MC + 4 inline-answer FIB")
        let fillIn = quiz.questions.filter { $0.type == .fillInTheBlank }
        XCTAssertEqual(fillIn.count, 4)
        XCTAssertEqual(fillIn.map(\.correctAnswer), ["judicial", "Committee", "jurisdiction", "interrelationships"])
        XCTAssertTrue(fillIn.allSatisfy { !$0.prompt.contains("Answer:") })
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    func testFillInBeforeGenericAnswers() throws {
        let markdown = try fixture("Quizzes/baf3m_03.05.test.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 10, "6 MC + 4 FIB")
        XCTAssertEqual(quiz.questions.filter { $0.type == .fillInTheBlank }.count, 4)
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    // MARK: - Multiple answer sections

    func testCourseTestWithTwoAnswerSectionsKeepsShortAnswerScoped() throws {
        let markdown = try fixture("Quizzes/baf3m_course.test.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 28, "24 MC + 4 short-answer")
        XCTAssertEqual(quiz.questions.filter { $0.type == .multipleChoice }.count, 24)
        XCTAssertEqual(quiz.questions.filter { $0.type == .shortAnswer }.count, 4)
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")

        // The multiple-choice answer section must not leak into the short
        // answers, and vice versa.
        for question in quiz.questions.prefix(24) {
            XCTAssertTrue(("A"..."Z").contains(question.correctAnswer), "\(question.number)=\(question.correctAnswer)")
        }
        XCTAssertEqual(quiz.questions[24].originalNumber, "01")
        XCTAssertTrue(quiz.questions[24].correctAnswer.contains("Maria"))
        XCTAssertTrue(quiz.questions[25].correctAnswer.contains("LR Law Firm"))
        XCTAssertTrue(quiz.questions[26].correctAnswer.contains("Fresh Mart"))
        XCTAssertTrue(quiz.questions[27].correctAnswer.contains("R. Johnson"))
    }

    func testTwelvePlusFourCourseTests() throws {
        for path in ["Quizzes/gwl3o_course.test.md", "Quizzes/mcr3u_course.test.md"] {
            let quiz = QuestionParser.parse(try fixture(path))
            XCTAssertEqual(quiz.questions.count, 16, path)
            XCTAssertEqual(quiz.questions.filter { $0.type == .multipleChoice }.count, 12, path)
            XCTAssertEqual(quiz.questions.filter { $0.type == .shortAnswer }.count, 4, path)
            XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(path): \(quiz.issues)")
            for question in quiz.questions.prefix(12) {
                XCTAssertTrue(("A"..."Z").contains(question.correctAnswer), "\(path) \(question.number)")
            }
            for question in quiz.questions.suffix(4) {
                XCTAssertFalse(question.correctAnswer.isEmpty, "\(path) \(question.number)")
            }
        }
    }

    func testMixedAnswersInOneSection() throws {
        let markdown = try fixture("Quizzes/clu3m_course.test.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 10, "6 MC + 4 FIB in one Questions section")
        XCTAssertEqual(quiz.questions.filter { $0.type == .multipleChoice }.count, 6)
        XCTAssertEqual(quiz.questions.filter { $0.type == .fillInTheBlank }.count, 4)
        XCTAssertEqual(quiz.questions[6].correctAnswer, "government")
        XCTAssertEqual(quiz.questions[7].correctAnswer, "safe")
        XCTAssertEqual(quiz.questions[8].correctAnswer, "everyone")
        XCTAssertEqual(quiz.questions[9].correctAnswer, "above")
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    func testUnitTestEightTwoTwo() throws {
        let markdown = try fixture("Quizzes/baf3m_01.unit.test.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 12)
        XCTAssertEqual(quiz.questions.filter { $0.type == .multipleChoice }.count, 8)
        XCTAssertEqual(quiz.questions.filter { $0.type == .fillInTheBlank }.count, 2)
        XCTAssertEqual(quiz.questions.filter { $0.type == .shortAnswer }.count, 2)
        XCTAssertTrue(quiz.questions[8].correctAnswer.lowercased().contains("owner"))
        XCTAssertTrue(quiz.questions[9].correctAnswer.lowercased().contains("cpa"))
        XCTAssertTrue(quiz.questions[10].correctAnswer.contains("Expected Criteria"))
        XCTAssertTrue(quiz.questions[11].correctAnswer.contains("Expected Criteria"))
        XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(quiz.issues)")
    }

    func testEightMultipleChoiceVariant() throws {
        let markdown = try fixture("Quizzes/baf3m_01.01.test.md")
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(quiz.questions.count, 8)
        XCTAssertTrue(quiz.questions.allSatisfy { $0.type == .multipleChoice })
        XCTAssertTrue(quiz.questions.allSatisfy { $0.options.count == 4 })
        XCTAssertTrue(quiz.questions.allSatisfy { $0.hasAnswer })
    }

    // MARK: - Pop quizzes

    func testEveryLivePopQuizParsesOrIsIdentifiedAsCorrupt() throws {
        let directory = FixtureCodec.fixturesURL.appendingPathComponent("Quizzes/PopQuizzes")
        let files = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ).filter { $0.pathExtension == "md" }
        XCTAssertEqual(files.count, 13)

        var parsed = 0
        var corrupt = 0
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let markdown = try String(contentsOf: file, encoding: .utf8)
            let quiz = QuestionParser.parse(markdown)
            if file.lastPathComponent.contains("2026-10-20_12-27-16") {
                XCTAssertEqual(quiz.questions.count, 0, "table output must parse to a corrupt quiz")
                XCTAssertTrue(quiz.issues.contains(.noQuestions))
                corrupt += 1
                continue
            }
            parsed += 1
            XCTAssertEqual(quiz.questions.count, 6, file.lastPathComponent)
            XCTAssertEqual(quiz.questions.filter { $0.type == .multipleChoice }.count, 4)
            XCTAssertEqual(quiz.questions.filter { $0.type == .fillInTheBlank }.count, 2)
            XCTAssertTrue(quiz.missingAnswers.isEmpty, "\(file.lastPathComponent): \(quiz.issues)")
            XCTAssertTrue(quiz.questions.allSatisfy { !$0.correctAnswer.isEmpty })
        }
        XCTAssertEqual(parsed, 12)
        XCTAssertEqual(corrupt, 1)
    }

    func testEmptyDocumentReportsNoQuestions() {
        let quiz = QuestionParser.parse("# Empty\n\nNo quiz here.")
        XCTAssertTrue(quiz.questions.isEmpty)
        XCTAssertTrue(quiz.issues.contains(.noQuestions))
    }
}
