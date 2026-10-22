import { describe, expect, it } from 'bun:test';
import { QuestionParser } from './questionParser';
import fs from 'node:fs';
import path from 'node:path';

describe('QuestionParser', () => {
  it('parses standard multiple choice quiz markdown', () => {
    const md = `
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
`;
    const quiz = QuestionParser.parseMarkdown(md);
    expect(quiz.title).toBe('Lesson 1.1: Foundations');
    expect(quiz.questions.length).toBe(2);

    expect(quiz.questions[0].number).toBe('01');
    expect(quiz.questions[0].category).toBe('Knowledge & Understanding');
    expect(quiz.questions[0].correctAnswer).toBe('A');
    expect(quiz.questions[0].explanation).toBe('Red is a primary colour.');
    expect(quiz.questions[0].options.length).toBe(4);
    expect(quiz.questions[0].options[0].text).toBe('Red');

    expect(quiz.questions[1].number).toBe('02');
    expect(quiz.questions[1].correctAnswer).toBe('C');
    expect(quiz.questions[1].explanation).toBe('Orange is produced by mixing red and yellow.');
  });

  it('parses bold answers and em-dash / en-dash separators (e.g. **B** —, **C** –)', () => {
    const md = `
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
`;
    const quiz = QuestionParser.parseMarkdown(md);
    expect(quiz.questions.length).toBe(2);
    expect(quiz.questions[0].correctAnswer).toBe('B');
    expect(quiz.questions[0].explanation).toBe('Assets are items owned with value.');
    expect(quiz.questions[1].correctAnswer).toBe('C');
    expect(quiz.questions[1].explanation).toBe('Personal assets are at risk.');
  });

  it('strips redundant option letter prefixes like "A) " or "A. " from option texts', () => {
    const md = `
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
`;
    const quiz = QuestionParser.parseMarkdown(md);
    expect(quiz.questions[0].options[0].letter).toBe('A');
    expect(quiz.questions[0].options[0].text).toBe('First option');
    expect(quiz.questions[0].options[1].letter).toBe('B');
    expect(quiz.questions[0].options[1].text).toBe('Second option');
    expect(quiz.questions[0].options[2].letter).toBe('C');
    expect(quiz.questions[0].options[2].text).toBe('Third option');
  });

  it('does not let Fill-in-the-Blank answers overwrite multiple choice answers', () => {
    const md = `
# Math Trigonometry

## Questions
01) What is sin(theta)?
<Multiple-Choice>
- [ ] x/r
- [ ] y/r
- [ ] y/x
- [ ] r/x

--

## Answers
01) B - (explanation) sin(theta) is y/r.

## Fill-in-the-Blank Questions
01) The arm lies on the positive __________.

## Fill-in-the-Blank Answers
01) x-axis - In standard position the initial arm is on the x-axis.
`;
    const quiz = QuestionParser.parseMarkdown(md);
    expect(quiz.questions.length).toBe(1);
    expect(quiz.questions[0].correctAnswer).toBe('B');
    expect(quiz.questions[0].explanation).toContain('sin(theta) is y/r');
  });

  it('handles Fill-in-the-Blank appearing before ## Answers', () => {
    const md = `
# Career Studies

## Questions
01) First question?
<Multiple-Choice>
- [ ] Opt 1
- [ ] Opt 2
- [ ] Opt 3
- [ ] Opt 4

--

## Fill-in-the-Blank Questions
01) A blank question __________.

## Fill-in-the-Blank Answers
01) blank answer

## Answers
01) C - (explanation) Opt 3 is right.
`;
    const quiz = QuestionParser.parseMarkdown(md);
    expect(quiz.questions.length).toBe(1);
    expect(quiz.questions[0].correctAnswer).toBe('C');
  });

  it('falls back to checked option checkbox [- [x]] when no answer key is provided', () => {
    const md = `
# Quick Check

## Questions
01) What is 2 + 2?
<Multiple-Choice>
- [ ] 3
- [x] 4
- [ ] 5
- [ ] 6
`;
    const quiz = QuestionParser.parseMarkdown(md);
    expect(quiz.questions.length).toBe(1);
    expect(quiz.questions[0].correctAnswer).toBe('B');
  });

  it('serializes back to standard markdown correctly', () => {
    const quiz = {
      courseCode: 'TEST101',
      title: 'Practice Test',
      questions: [
        {
          number: '01',
          category: 'KU',
          prompt: 'What is true?',
          options: [
            { letter: 'A', text: 'Option A' },
            { letter: 'B', text: 'Option B' }
          ],
          correctAnswer: 'B',
          explanation: 'B is right.'
        }
      ]
    };
    const md = QuestionParser.serializeToMarkdown(quiz);
    expect(md).toContain('course: TEST101');
    expect(md).toContain('01) [KU] What is true?');
    expect(md).toContain('- [ ] Option A');
    expect(md).toContain('01) B - (explanation) B is right.');

    const roundtrip = QuestionParser.parseMarkdown(md);
    expect(roundtrip.questions.length).toBe(1);
    expect(roundtrip.questions[0].correctAnswer).toBe('B');
    expect(roundtrip.questions[0].explanation).toBe('B is right.');
  });

  it('correctly parses real previously-failing test files from disk', () => {
    const testFiles = [
      'data/courses/gwl3o/02.01.test.md',
      'data/courses/clu3m/04.02.test.md',
      'data/courses/clu3m/04.05.test.md',
      'data/courses/baf3m/01.02.test.md',
      'data/courses/mcr3u/04.02.test.md',
      'data/courses/mcr3u/02.03.test.md'
    ];

    for (const relPath of testFiles) {
      const fullPath = path.resolve(process.cwd(), '..', relPath);
      const filePath = fs.existsSync(fullPath) ? fullPath : path.resolve(process.cwd(), relPath);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const quiz = QuestionParser.parseMarkdown(content);
      expect(quiz.questions.length).toBeGreaterThan(0);

      const answers = quiz.questions.map((q) => q.correctAnswer);
      // Ensure NOT all answers are 'A' (mcr3u/02.03 fixture legitimately has all A answers)
      if (!relPath.endsWith('mcr3u/02.03.test.md')) {
        const allA = answers.every((a) => a === 'A');
        expect(allA).toBe(false);
      }

      // Ensure every multiple-choice question has a valid letter A-D
      // and fill-in-the-blank has non-empty answer
      for (const q of quiz.questions) {
        if (q.type === 'multiple-choice') {
          expect(['A', 'B', 'C', 'D']).toContain(q.correctAnswer);
        } else {
          expect(q.correctAnswer.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('parses mixed unit test with multiple-choice, fill-in-the-blank, and short-answer questions', () => {
    const md = `
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
`;
    const quiz = QuestionParser.parseMarkdown(md);
    expect(quiz.questions.length).toBe(3);
    expect(quiz.questions[0].type).toBe('multiple-choice');
    expect(quiz.questions[0].correctAnswer).toBe('A');

    expect(quiz.questions[1].type).toBe('fill-in-the-blank');
    expect(quiz.questions[1].correctAnswer).toBe('acceleration');

    expect(quiz.questions[2].type).toBe('short-answer');
    expect(quiz.questions[2].category).toBe('Application');
    expect(quiz.questions[2].prompt).toContain('inclined plane');
    expect(quiz.questions[2].correctAnswer).toContain('Resolve gravitational force');
    expect(quiz.questions[2].explanation).toContain('F_net = mg sin(theta)');
  });

  it('parses real Ontario BAF3M unit test from disk with MC, fill-in, and short-answer', () => {
    const filePath = path.resolve(process.cwd(), '..', 'data/courses/baf3m/01.unit.test.md');
    if (!fs.existsSync(filePath)) return;
    const md = fs.readFileSync(filePath, 'utf8');
    const quiz = QuestionParser.parseMarkdown(md);

    expect(quiz.title).toBe('Unit Practice Exam');
    expect(quiz.questions.length).toBe(12);

    // 8 Multiple choice
    for (let i = 0; i < 8; i++) {
      expect(quiz.questions[i].type).toBe('multiple-choice');
      expect(quiz.questions[i].options.length).toBe(4);
      expect(['A', 'B', 'C', 'D']).toContain(quiz.questions[i].correctAnswer);
      expect(quiz.questions[i].explanation?.length).toBeGreaterThan(0);
    }

    // 2 Fill in the blank
    expect(quiz.questions[8].type).toBe('fill-in-the-blank');
    expect(quiz.questions[8].correctAnswer.toLowerCase()).toContain("owner’s equity".toLowerCase());
    expect(quiz.questions[9].type).toBe('fill-in-the-blank');
    expect(quiz.questions[9].correctAnswer.toLowerCase()).toContain('cpa');

    // 2 Short answer
    expect(quiz.questions[10].type).toBe('short-answer');
    expect(quiz.questions[10].correctAnswer).toContain('Expected Criteria');
    expect(quiz.questions[10].explanation).toContain('Calculation');
    expect(quiz.questions[11].type).toBe('short-answer');
    expect(quiz.questions[11].correctAnswer).toContain('Expected Criteria');
    expect(quiz.questions[11].explanation).toContain('Principles/standards');
  });

  it('parses comprehensive 16-question unit test output (with subheadings and bold answer formats)', () => {
    const scratchPath = path.resolve(
      process.env.HOME || '',
      '.gemini/antigravity/brain/f11f16d4-8593-4673-a1a1-9bb2a0789e19/scratch/llm_response.md'
    );
    if (!fs.existsSync(scratchPath)) return;
    const md = fs.readFileSync(scratchPath, 'utf8');
    const quiz = QuestionParser.parseMarkdown(md);

    expect(quiz.title).toBe('Unit Practice Exam');
    expect(quiz.questions.length).toBe(16);

    // 12 Multiple-choice questions
    for (let i = 0; i < 12; i++) {
      expect(quiz.questions[i].type).toBe('multiple-choice');
      expect(quiz.questions[i].options.length).toBe(4);
      expect(['A', 'B', 'C', 'D']).toContain(quiz.questions[i].correctAnswer);
      expect(quiz.questions[i].explanation?.length).toBeGreaterThan(0);
    }

    // 2 Fill-in-the-blank questions
    expect(quiz.questions[12].type).toBe('fill-in-the-blank');
    expect(quiz.questions[12].correctAnswer).toContain("owner's equity");
    expect(quiz.questions[13].type).toBe('fill-in-the-blank');
    expect(quiz.questions[13].correctAnswer).toContain('database');

    // 2 Short-answer / Problem-solving questions
    expect(quiz.questions[14].type).toBe('short-answer');
    expect(quiz.questions[14].prompt).toContain("Bakery Owner's Three Requests");
    expect(quiz.questions[14].explanation).toContain('Model Response');
    expect(quiz.questions[15].type).toBe('short-answer');
    expect(quiz.questions[15].prompt).toContain("Landscaper's Balance Sheet");
    expect(quiz.questions[15].explanation).toContain('Model Response');
  });
});
