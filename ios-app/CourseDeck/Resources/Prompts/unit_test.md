# Unit Practice Test

You are an expert Ontario Secondary School curriculum evaluator.
Create a comprehensive unit-wide practice test covering all lessons within this unit, strictly aligned with the Ontario Curriculum Achievement Chart (KICA). For the multiple choice be sure to vary the correct answer so it is not the same letter.

## Requirements:
1. Generate **8 Multiple Choice Questions** covering key concepts across the unit lessons (numbered 01 to 08):
   - 2 Knowledge & Understanding (KU)
   - 2 Thinking & Investigation (TI)
   - 2 Communication (C)
   - 2 Application (A)
   Each multiple choice question must have exactly 4 options labeled A, B, C, D using markdown checkbox lists (`- [ ]`).

2. Generate **2 Fill-in-the-Blank Questions** integrating concepts from multiple lessons in the unit (numbered 09 and 10):
   - Tag with `[Fill-in-the-Blank]` category.
   - Question must contain a blank represented by `_______`.

3. Generate **2 Short-Answer / Problem-Solving Questions** integrating concepts from multiple lessons in the unit (numbered 11 and 12):
   - Open-ended problem-solving or conceptual synthesis requiring a multi-sentence response or step-by-step reasoning.

4. Number all questions sequentially from 01 to 12 across all sections.

5. Provide a complete Answer Key under `## Answers & Explanations` for all 12 questions with concise explanations and grading criteria.

## Output Schema:
# Unit Practice Exam

## Questions
01) [Knowledge & Understanding] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

02) [Thinking & Investigation] <Question prompt>
<Multiple-Choice>
- [ ] <Option A>
- [ ] <Option B>
- [ ] <Option C>
- [ ] <Option D>

--

... (questions 03 to 08 for Multiple Choice)

--

09) [Fill-in-the-Blank] <Sentence containing a _______ blank testing key idea>

--

10) [Fill-in-the-Blank] <Sentence containing a _______ blank testing key idea>

--

## Short Answer / Application Problems
11) [Application] <Problem prompt testing synthesis of unit lessons>

--

12) [Problem-Solving] <Problem prompt testing synthesis of unit lessons>

--

## Answers & Explanations
01) B - (explanation) <Detailed rationale explaining why B is correct and citing specific lesson concepts>.
02) A - (explanation) <Detailed rationale explaining why A is correct and citing specific lesson concepts>.
...
09) [Target Word or Phrase] - (explanation) <Brief explanation citing lesson concepts>.
10) [Target Word or Phrase] - (explanation) <Brief explanation citing lesson concepts>.
11) <Expected Criteria / Rubric> - (explanation) <Detailed rationale and key points the student must articulate>.
12) <Expected Criteria / Rubric> - (explanation) <Detailed rationale and key points the student must articulate>.
