import Foundation
import XCTest
@testable import CourseDeckCore

final class QuizGradingTests: XCTestCase {
    private func quiz() -> ParsedQuiz {
        ParsedQuiz(
            title: "Unit Test",
            questions: [
                QuizQuestion(
                    id: "s0q01-0",
                    number: "01",
                    originalNumber: "01",
                    sectionIndex: 0,
                    type: .multipleChoice,
                    prompt: "What is 2 + 2?",
                    options: [
                        QuizOption(letter: "A", text: "3"),
                        QuizOption(letter: "B", text: "4"),
                    ],
                    correctAnswer: "B",
                    explanation: "Four."
                ),
                QuizQuestion(
                    id: "s0q02-1",
                    number: "02",
                    originalNumber: "02",
                    sectionIndex: 0,
                    type: .fillInTheBlank,
                    prompt: "The capital of Ontario is ______.",
                    correctAnswer: "Toronto",
                    explanation: "Toronto is the capital."
                ),
                QuizQuestion(
                    id: "s1q01-2",
                    number: "03",
                    originalNumber: "01",
                    sectionIndex: 1,
                    type: .shortAnswer,
                    prompt: "Explain two risks. a) risk one b) risk two",
                    correctAnswer: "Expected Criteria / Rubric",
                    explanation: "Rubric."
                ),
            ]
        )
    }

    func testDeterministicMultipleChoiceAndNormalizedFillIn() async {
        let result = await QuizGrader().grade(
            quiz: quiz(),
            answers: ["s0q01-0": "b", "s0q02-1": "  toronto! "],
            mode: .practice
        )
        XCTAssertEqual(result.total, 3)
        XCTAssertEqual(result.evaluations["s0q01-0"]?.score, 1)
        XCTAssertEqual(result.evaluations["s0q02-1"]?.score, 1)
        // Short answer fallback requires a substantial response.
        XCTAssertEqual(result.evaluations["s1q01-2"]?.score, 0)
        XCTAssertEqual(result.score, 2)
        XCTAssertEqual(result.percentage, 67)
        XCTAssertFalse(result.usedAI)
    }

    func testShortAnswerFallbackDetectsSubParts() async {
        let answer = "a) The first risk is unlimited liability for the owner. b) The second risk is cash flow."
        let result = await QuizGrader().grade(
            quiz: quiz(),
            answers: ["s1q01-2": answer],
            mode: .practice
        )
        let evaluation = result.evaluations["s1q01-2"]
        XCTAssertEqual(evaluation?.parts.count, 2)
        XCTAssertEqual(evaluation?.parts.filter(\.isCorrect).count, 2)
        XCTAssertEqual(evaluation?.score, 1)
    }

    func testAIPartialCreditFromParts() async throws {
        let grader = QuizGrader(aiGrader: FakeAiGrader { request in
            XCTAssertEqual(request.questions.count, 2)
            return [
                QuizAiQuestionEvaluation(number: "02", isCorrect: true, score: 1, feedback: "Correct."),
                QuizAiQuestionEvaluation(
                    number: "03",
                    isCorrect: false,
                    score: 0.5,
                    feedback: "One of two parts.",
                    parts: [
                        QuizPartEvaluation(part: "a", label: "Part a", isCorrect: true, feedback: "Risk identified."),
                        QuizPartEvaluation(part: "b", label: "Part b", isCorrect: false, feedback: "Missing."),
                    ]
                ),
            ]
        })
        let result = await grader.grade(
            quiz: quiz(),
            answers: [
                "s0q01-0": "B",
                "s0q02-1": "Toronto",
                "s1q01-2": "a) unlimited liability and cash flow issues",
            ],
            mode: .unitTest
        )
        XCTAssertTrue(result.usedAI)
        XCTAssertEqual(result.evaluations["s1q01-2"]?.score, 0.5)
        XCTAssertEqual(result.evaluations["s1q01-2"]?.isCorrect, false)
        XCTAssertEqual(result.evaluations["s1q01-2"]?.parts.count, 2)
        XCTAssertEqual(result.score, 2.5)
        XCTAssertEqual(result.percentage, 83)
        XCTAssertNil(result.aiError)
    }

    func testAITimeoutFallsBackToDeterministicGrading() async {
        let grader = QuizGrader(
            aiGrader: SlowAiGrader(),
            aiTimeout: 0.05
        )
        let result = await grader.grade(
            quiz: quiz(),
            answers: ["s0q02-1": "Toronto", "s1q01-2": "a) risk one b) risk two with enough detail here"],
            mode: .unitTest
        )
        XCTAssertFalse(result.usedAI)
        XCTAssertNotNil(result.aiError)
        XCTAssertEqual(result.evaluations["s0q02-1"]?.score, 1)
        XCTAssertEqual(result.evaluations["s1q01-2"]?.parts.count, 2)
    }

    func testAIErrorFallsBack() async {
        let grader = QuizGrader(aiGrader: ThrowingAiGrader())
        let result = await grader.grade(
            quiz: quiz(),
            answers: ["s0q02-1": "Toronto"],
            mode: .unitTest
        )
        XCTAssertFalse(result.usedAI)
        XCTAssertNotNil(result.aiError)
        XCTAssertEqual(result.evaluations["s0q02-1"]?.score, 1)
    }

    func testPopQuizNeverUsesAI() async {
        let grader = QuizGrader(aiGrader: FakeAiGrader { _ in
            XCTFail("pop quiz grading must be deterministic")
            return []
        })
        _ = await grader.grade(
            quiz: quiz(),
            answers: ["s0q01-0": "B", "s0q02-1": "Toronto"],
            mode: .popQuiz
        )
    }

    func testDeepSeekResponseParsingWithCodeFenceAndParts() throws {
        let response = """
        ```json
        [
          {"number": "9", "isCorrect": true, "score": 1, "feedback": "Correct."},
          {"number": "11", "isCorrect": false, "score": 0.5, "feedback": "Half.",
           "parts": [
             {"part": "a", "label": "Part a", "isCorrect": true, "feedback": "ok"},
             {"part": "b", "label": "Part b", "isCorrect": false, "feedback": "missing"}
           ]}
        ]
        ```
        """
        let parsed = try LlmQuizAiGrader.parseResponse(response)
        XCTAssertEqual(parsed.count, 2)
        XCTAssertEqual(parsed[0].number, "09")
        XCTAssertEqual(parsed[0].score, 1)
        XCTAssertEqual(parsed[1].number, "11")
        XCTAssertEqual(parsed[1].score, 0.5)
        XCTAssertFalse(parsed[1].isCorrect)
        XCTAssertEqual(parsed[1].parts.count, 2)
    }

    func testEmptyAIResponseSetsErrorAndUsesFallback() async {
        let grader = QuizGrader(aiGrader: FakeAiGrader { _ in [] })
        let result = await grader.grade(
            quiz: quiz(),
            answers: ["s0q02-1": "Toronto"],
            mode: .unitTest
        )
        XCTAssertFalse(result.usedAI)
        XCTAssertNotNil(result.aiError)
        XCTAssertEqual(result.evaluations["s0q02-1"]?.score, 1)
    }

    func testInvalidAIResponseThrows() {
        XCTAssertThrowsError(try LlmQuizAiGrader.parseResponse("not json"))
    }

    func testNumericJSONNumberIsNormalized() throws {
        let response = """
        [{"number": 9, "isCorrect": true, "score": 1, "feedback": "Numeric."}]
        """
        let parsed = try LlmQuizAiGrader.parseResponse(response)
        XCTAssertEqual(parsed.count, 1)
        XCTAssertEqual(parsed[0].number, "09")
    }

    func testPartialAIResponseSetsErrorAndFallsBackForMissingQuestion() async {
        let markdown = """
        # Partial

        ## Questions
        01) [Fill-in-the-Blank] First ______.
        02) [Fill-in-the-Blank] Second ______.
        03) [Fill-in-the-Blank] Third ______.

        ## Answers
        01) alpha
        02) beta
        03) gamma
        """
        let quiz = QuestionParser.parse(markdown)
        let grader = QuizGrader(aiGrader: FakeAiGrader { _ in
            [QuizAiQuestionEvaluation(number: "1", isCorrect: true, score: 1, feedback: "ok")]
        })
        let result = await grader.grade(
            quiz: quiz,
            answers: quiz.questions.reduce(into: [String: String]()) { result, question in
                result[question.id] = ["alpha", "beta", "gamma"][max(0, (Int(question.number) ?? 1) - 1)]
            },
            mode: .unitTest
        )
        XCTAssertTrue(result.usedAI)
        XCTAssertNotNil(result.aiError)
        XCTAssertTrue(result.aiError?.contains("02") == true || result.aiError?.contains("03") == true)
        // Missing questions used deterministic containment.
        XCTAssertEqual(result.evaluations[quiz.questions[1].id]?.score, 1)
        XCTAssertEqual(result.evaluations[quiz.questions[2].id]?.score, 1)
    }

    func testFivePartFixtureRequiresAllParts() async {
        let markdown = """
        # Five Parts

        ## Questions
        01) [Application] Answer all parts. a) one b) two c) three d) four e) five

        ## Answers
        01) Rubric: five parts.
        """
        let quiz = QuestionParser.parse(markdown)
        XCTAssertEqual(QuizGrader.detectParts(in: quiz.questions[0].prompt), ["a", "b", "c", "d", "e"])

        let answer = "a) first b) second c) third d) fourth e) fifth"
        let fallback = await QuizGrader().grade(
            quiz: quiz,
            answers: [quiz.questions[0].id: answer],
            mode: .practice
        )
        XCTAssertEqual(fallback.evaluations[quiz.questions[0].id]?.parts.count, 5)
        XCTAssertEqual(fallback.evaluations[quiz.questions[0].id]?.score, 1)

        let grader = QuizGrader(aiGrader: FakeAiGrader { _ in
            [
                QuizAiQuestionEvaluation(
                    number: "01",
                    isCorrect: false,
                    score: 0.75,
                    parts: [
                        QuizPartEvaluation(part: "a", isCorrect: true),
                        QuizPartEvaluation(part: "b", isCorrect: true),
                        QuizPartEvaluation(part: "c", isCorrect: true),
                        QuizPartEvaluation(part: "d", isCorrect: true),
                    ]
                ),
            ]
        })
        let partial = await grader.grade(
            quiz: quiz,
            answers: [quiz.questions[0].id: answer],
            mode: .unitTest
        )
        XCTAssertEqual(partial.evaluations[quiz.questions[0].id]?.parts.count, 5)
        XCTAssertEqual(partial.evaluations[quiz.questions[0].id]?.score, 0.8)
        XCTAssertNotNil(partial.aiError)
    }

    func testNumberedSubPartsWhenNoLetters() {
        let parts = QuizGrader.detectParts(in: "Complete these: 1) first 2) second 3) third")
        XCTAssertEqual(parts, ["1", "2", "3"])
    }

    func testScoreWriterPreservesUnknownKeysAndDropsRawAnswers() throws {
        let markdown = """
        ---
        prompt: unit_test
        lastAttemptDate: 2025-01-01
        score: 1
        totalQuestions: 3
        percentage: 33
        userAnswers: '{"01":"A"}'
        customKey: keep-me
        ---

        # Unit Test

        ## Questions
        01) Question
        """
        let result = QuizGradeResult(
            score: 2.5,
            total: 3,
            percentage: 83,
            evaluations: [:]
        )
        let updated = try UnitTestScoreWriter.applying(
            result: result,
            to: markdown,
            date: Date(timeIntervalSince1970: 1_700_000_000)
        )
        XCTAssertTrue(updated.contains("customKey: keep-me"))
        XCTAssertTrue(updated.contains("lastAttemptDate: 2023-11-14"))
        XCTAssertTrue(updated.contains("score: 2.5"))
        XCTAssertTrue(updated.contains("totalQuestions: 3"))
        XCTAssertTrue(updated.contains("percentage: 83"))
        XCTAssertFalse(updated.contains("userAnswers"))
        XCTAssertTrue(updated.contains("# Unit Test"))

        // The score fields parse through the same frontmatter reader the UI uses.
        let metadata = QuizDocumentMetadata.read(from: updated)
        XCTAssertEqual(metadata.score, 2.5)
        XCTAssertEqual(metadata.percentage, 83)
        XCTAssertEqual(metadata.totalQuestions, 3)
    }
}

// MARK: - Fakes

private struct FakeAiGrader: QuizAiGrading {
    let handler: @Sendable (QuizAiGradingRequest) -> [QuizAiQuestionEvaluation]

    init(_ handler: @escaping @Sendable (QuizAiGradingRequest) -> [QuizAiQuestionEvaluation]) {
        self.handler = handler
    }

    func grade(_ request: QuizAiGradingRequest) async throws -> [QuizAiQuestionEvaluation] {
        handler(request)
    }
}

private struct SlowAiGrader: QuizAiGrading {
    func grade(_ request: QuizAiGradingRequest) async throws -> [QuizAiQuestionEvaluation] {
        try await Task.sleep(nanoseconds: 2_000_000_000)
        return []
    }
}

private struct ThrowingAiGrader: QuizAiGrading {
    func grade(_ request: QuizAiGradingRequest) async throws -> [QuizAiQuestionEvaluation] {
        throw QuizGradingError.invalidAIResponse("test")
    }
}
