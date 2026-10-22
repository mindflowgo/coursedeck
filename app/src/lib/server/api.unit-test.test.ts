import { describe, expect, it, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { handleApiRequest } from './api';
import { CourseService } from './courses';
import { parseFrontmatter } from '../parser/frontmatter';

describe('Unit Test Evaluation API', () => {
  const courseId = 'unittest_eval_course';
  const unitId = '01.unit';

  const sampleTestMarkdown = `---
prompt: "Test prompt"
---
# Unit 1 Practice Exam

## Questions
01) [Knowledge & Understanding] What is a primary colour?
<Multiple-Choice>
- [ ] Red
- [ ] Green
- [ ] Orange
- [ ] Purple

--

02) [Fill-in-the-Blank] The powerhouse of the cell is the ___________.

--

## Short Answer / Application Problems
03) [Application] Explain Newton's third law of motion and give a real-world example.

--

## Answers & Explanations
01) A - (explanation) Red is a primary colour.
02) Mitochondria - (explanation) Mitochondria produces ATP.
03) Rubric: Every action has an equal and opposite reaction. Example: rocket propulsion. - (explanation) Newton's third law details.
`;

  beforeEach(() => {
    const courseDir = path.join(CourseService.getCoursesDir(), courseId);
    fs.mkdirSync(courseDir, { recursive: true });
    const manifest = {
      id: courseId,
      title: 'Unit Test Course',
      description: 'Unit test evaluation spec',
      updatedAt: new Date().toISOString(),
      units: [
        {
          number: 1,
          title: 'Unit 1',
          lessons: []
        }
      ]
    };
    fs.writeFileSync(path.join(courseDir, 'meta.json'), JSON.stringify(manifest), 'utf8');
    CourseService.saveLessonTab(courseId, unitId, 'test', sampleTestMarkdown);
  });

  it('evaluates unit test submissions and updates frontmatter without storing user answers', async () => {
    const payload = {
      unitId,
      testMarkdown: sampleTestMarkdown,
      answers: {
        '01': 'A',
        '02': 'mitochondria',
        '03': 'Newton third law states that for every action there is an equal and opposite reaction. For instance rocket thrust pushes exhaust down and rocket moves up.'
      }
    };

    const req = new Request(`http://localhost:5173/api/courses/${courseId}/unit-test/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.total).toBe(3);
    expect(data.score).toBeGreaterThanOrEqual(2);
    expect(data.percentage).toBeGreaterThan(0);
    expect(typeof data.lastAttemptDate).toBe('string');
    expect(data.evaluations).toBeDefined();
    expect(data.evaluations['01'].isCorrect).toBe(true);
    expect(data.evaluations['02'].isCorrect).toBe(true);

    // Verify disk content & frontmatter
    const saved = CourseService.getLessonContent(courseId, unitId)?.tabs['test'] || '';
    expect(saved.length).toBeGreaterThan(0);

    const parsed = parseFrontmatter(saved);
    expect(parsed.frontmatter.lastAttemptDate).toBe(data.lastAttemptDate);
    expect(parsed.frontmatter.score).toBe(data.score);
    expect(parsed.frontmatter.totalQuestions).toBe(3);
    expect(parsed.frontmatter.percentage).toBe(data.percentage);

    // CRITICAL: Verify that student answers are NEVER saved in frontmatter
    expect(parsed.frontmatter.answers).toBeUndefined();
    expect(parsed.frontmatter.userAnswers).toBeUndefined();
    expect(parsed.frontmatter.studentAnswers).toBeUndefined();
  });

  it('correctly calculates partial credit and evaluates multi-part written answers logically', async () => {
    const multiPartMarkdown = `---
type: test
---
# Unit Practice Exam

## Questions
01) [KU] Capital of Canada?
<Multiple-Choice>
- [ ] Ottawa
- [ ] Toronto
- [ ] Montreal
- [ ] Vancouver

--

02) [KU] Currency of Canada?
<Multiple-Choice>
- [ ] USD
- [ ] CAD
- [ ] EUR
- [ ] GBP

--

03) [Fill-in-the-Blank] The Canadian flag features a red __________ leaf.

--

04) [Application] Complete this 4-part problem:
a) Calculate owner equity given Assets of $100 and Liabilities of $40.
b) State the fundamental accounting equation.
c) List two disadvantages of a sole proprietorship.
d) Recommend a computer software strategy.

--

## Answers & Explanations
01) A - Ottawa is the capital.
02) B - CAD is Canadian Dollar.
03) Maple - The flag has a red maple leaf.
04) Expected Criteria / Rubric -
- **Calculation (1 mark):** $60
- **Equation (1 mark):** Assets - Liabilities = Owner Equity
- **Disadvantages (1 mark):** Unlimited liability
- **Strategy (1 mark):** Cloud accounting software
`;

    CourseService.saveLessonTab(courseId, '02.unit', 'test', multiPartMarkdown);

    // Student gets:
    // Q01: wrong (B instead of A) -> 0
    // Q02: correct (B) -> 1
    // Q03: wrong ("oak" instead of "maple") -> 0
    // Q04: answers only a) and b), misses c) and d) -> 2 of 4 parts correct = 0.5!
    // Total should be: 0 + 1 + 0 + 0.5 = 1.5 out of 4 (38%)
    const payload = {
      unitId: '02.unit',
      testMarkdown: multiPartMarkdown,
      answers: {
        '01': 'B', // Incorrect
        '02': 'B', // Correct
        '03': 'oak', // Incorrect
        '04': 'a) Owner equity is $100 - $40 = $60. b) The equation is Assets - Liabilities = Equity.' // Only a and b addressed
      }
    };

    const req = new Request(`http://localhost:5173/api/courses/${courseId}/unit-test/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.total).toBe(4);
    expect(data.evaluations['01'].isCorrect).toBe(false);
    expect(data.evaluations['01'].score).toBe(0);
    expect(data.evaluations['02'].isCorrect).toBe(true);
    expect(data.evaluations['02'].score).toBe(1);
    expect(data.evaluations['03'].isCorrect).toBe(false);
    expect(data.evaluations['03'].score).toBe(0);

    // Q04 should have parts breakdown and partial score = 0.5
    expect(data.evaluations['04'].parts).toBeDefined();
    expect(data.evaluations['04'].parts.length).toBe(4);
    expect(data.evaluations['04'].score).toBe(0.5);
    expect(data.evaluations['04'].isCorrect).toBe(false);

    // Total score is strictly and logically 1.5 / 4 = 38%
    expect(data.score).toBe(1.5);
    expect(data.percentage).toBe(38);
  });
});
