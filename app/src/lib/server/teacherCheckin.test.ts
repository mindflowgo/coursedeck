import { describe, expect, it, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'popquiz-test-'));
process.env.DATA_DIR = scratch;

import { handleApiRequest } from './api';
import { CourseService } from './courses';
import { cleanImageReferences, parseRecipientEmails } from './services/teacherCheckin.service';

const courseId = 'testcourse';
const courseDir = path.join(scratch, 'courses', courseId);

describe('Pop Quiz Accountability & Schedule Mark-Done API', () => {
  beforeAll(() => {
    fs.mkdirSync(courseDir, { recursive: true });
    // Setup manifest with 2 lessons
    const manifest = {
      id: courseId,
      title: 'Test Course',
      grade: '11',
      level: 'U',
      description: 'Test course description',
      updatedAt: new Date().toISOString(),
      units: [
        {
          number: 1,
          title: 'Unit 1',
          lessons: [
            {
              id: '01.01',
              code: 'tc_u1l1',
              title: 'First Lesson',
              unitNumber: 1,
              lessonNumber: 1,
              type: 'lesson',
              hasFull: true,
              hasSummary: true,
              hasNotes: false,
              hasTest: true
            },
            {
              id: '01.02',
              code: 'tc_u1l2',
              title: 'Second Lesson',
              unitNumber: 1,
              lessonNumber: 2,
              type: 'lesson',
              hasFull: true,
              hasSummary: false,
              hasNotes: false,
              hasTest: false
            }
          ]
        }
      ]
    };
    fs.writeFileSync(path.join(courseDir, 'meta.json'), JSON.stringify(manifest, null, 2));

    // Setup initial schedule markdown with undone checkboxes
    const initialSchedule = `# Test Course Schedule\n\n### 2026-10-20 · Tue\n- [ ] **Study** 01.01 — Introduction to the first lesson (60m)\n- [ ] **Study** 01.02 — Introduction to the second lesson (60m)\n`;
    fs.writeFileSync(path.join(courseDir, 'course.schedule.md'), initialSchedule);
  });

  it('GET and POST /api/settings/emailserver works with safe config', async () => {
    const postReq = new Request('http://127.0.0.1:3182/api/settings/emailserver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'teacher@school.edu',
        sender: 'gmail',
        loginEmail: 'student@gmail.com',
        loginPassword: 'abcd efgh ijkl mnop'
      })
    });
    const postRes = await handleApiRequest(postReq, new URL('http://127.0.0.1:3182/api/settings/emailserver'));
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.success).toBe(true);

    const getReq = new Request('http://127.0.0.1:3182/api/settings/emailserver', { method: 'GET' });
    const getRes = await handleApiRequest(getReq, new URL('http://127.0.0.1:3182/api/settings/emailserver'));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.email).toBe('teacher@school.edu');
    expect(getBody.sender).toBe('gmail');
    expect(getBody.loginEmail).toBe('student@gmail.com');
    expect(getBody.hasPassword).toBe(true);
  });

  it('GET and POST /api/settings/emailserver supports multiple comma-separated emails', async () => {
    const postReq = new Request('http://127.0.0.1:3182/api/settings/emailserver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'teacher1@school.edu, teacher2@school.edu,parent@home.org',
        sender: 'gmail',
        loginEmail: 'student@gmail.com',
        loginPassword: 'abcd efgh ijkl mnop'
      })
    });
    const postRes = await handleApiRequest(postReq, new URL('http://127.0.0.1:3182/api/settings/emailserver'));
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.success).toBe(true);
    expect(postBody.email).toBe('teacher1@school.edu, teacher2@school.edu, parent@home.org');

    const getReq = new Request('http://127.0.0.1:3182/api/settings/emailserver', { method: 'GET' });
    const getRes = await handleApiRequest(getReq, new URL('http://127.0.0.1:3182/api/settings/emailserver'));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.email).toBe('teacher1@school.edu, teacher2@school.edu, parent@home.org');
  });

  describe('parseRecipientEmails', () => {
    it('parses single email', () => {
      expect(parseRecipientEmails('name@email.com')).toEqual(['name@email.com']);
    });

    it('parses multiple comma-separated emails with or without spaces ("," and ", ")', () => {
      expect(parseRecipientEmails('name1@email.com,name2@email.com')).toEqual([
        'name1@email.com',
        'name2@email.com'
      ]);
      expect(parseRecipientEmails('name1@email.com, name2@email.com')).toEqual([
        'name1@email.com',
        'name2@email.com'
      ]);
      expect(parseRecipientEmails('  name1@email.com ,  name2@email.com , name3@email.com  ')).toEqual([
        'name1@email.com',
        'name2@email.com',
        'name3@email.com'
      ]);
    });

    it('ignores empty entries and extra commas', () => {
      expect(parseRecipientEmails(',name1@email.com, , name2@email.com,')).toEqual([
        'name1@email.com',
        'name2@email.com'
      ]);
    });

    it('handles empty, null, undefined, and whitespace-only strings', () => {
      expect(parseRecipientEmails('')).toEqual([]);
      expect(parseRecipientEmails(null)).toEqual([]);
      expect(parseRecipientEmails(undefined)).toEqual([]);
      expect(parseRecipientEmails('   ')).toEqual([]);
    });
  });

  it('POST /api/courses/:course_id/schedule/mark-lesson-done toggles schedule checkbox and returns nextLessonId', async () => {
    const req = new Request(`http://127.0.0.1:3182/api/courses/${courseId}/schedule/mark-lesson-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: '01.01' })
    });
    const res = await handleApiRequest(req, new URL(`http://127.0.0.1:3182/api/courses/${courseId}/schedule/mark-lesson-done`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.toggled).toBe(true);
    expect(body.lessonId).toBe('01.01');
    expect(body.nextLessonId).toBe('01.02');
    expect(body.isLastLesson).toBe(false);

    // Verify schedule file on disk was updated
    const updatedContent = fs.readFileSync(path.join(courseDir, 'course.schedule.md'), 'utf8');
    expect(updatedContent).toContain('- [x] **Study** 01.01 — Introduction to the first lesson (60m)');
    expect(updatedContent).toContain('- [ ] **Study** 01.02 — Introduction to the second lesson (60m)');
  });

  it('POST /api/courses/:course_id/schedule/mark-lesson-done detects last lesson in course', async () => {
    const req = new Request(`http://127.0.0.1:3182/api/courses/${courseId}/schedule/mark-lesson-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: '01.02' })
    });
    const res = await handleApiRequest(req, new URL(`http://127.0.0.1:3182/api/courses/${courseId}/schedule/mark-lesson-done`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.toggled).toBe(true);
    expect(body.nextLessonId).toBeNull();
    expect(body.isLastLesson).toBe(true);

    const updatedContent = fs.readFileSync(path.join(courseDir, 'course.schedule.md'), 'utf8');
    expect(updatedContent).toContain('- [x] **Study** 01.02 — Introduction to the second lesson (60m)');
  });

  describe('cleanImageReferences', () => {
    it('strips standalone markdown image references', () => {
      const input = '![Minds On|50%](./assets/img/baf3m_01.02_mindsOn.jpg)';
      expect(cleanImageReferences(input)).toBe('');
    });

    it('strips markdown images embedded in titles with heading hash and separators', () => {
      const input = '# ![Minds On|50%](./assets/img/baf3m_01.02_mindsOn.jpg) The Accounting Equation';
      expect(cleanImageReferences(input)).toBe('The Accounting Equation');

      const inputWithDash = '# ![Minds On|50%](./assets/img/baf3m_01.02_mindsOn.jpg) - The Accounting Equation';
      expect(cleanImageReferences(inputWithDash)).toBe('The Accounting Equation');

      const inputTrailingDash = 'The Accounting Equation - ![icon](./assets/img/icon.png)';
      expect(cleanImageReferences(inputTrailingDash)).toBe('The Accounting Equation');
    });

    it('strips HTML picture and img tags', () => {
      const input = '<picture><source srcset="test.webp"><img src="./assets/img/baf3m.jpg" alt="test"></picture> Balance Sheet';
      expect(cleanImageReferences(input)).toBe('Balance Sheet');
    });

    it('handles null, undefined, and empty string', () => {
      expect(cleanImageReferences(null)).toBe('');
      expect(cleanImageReferences(undefined)).toBe('');
      expect(cleanImageReferences('')).toBe('');
    });
  });

  it('POST /api/pop-quiz/submit sanitizes image references from lessonTitle and falls back to manifest', async () => {
    const rawMarkdown = `---
type: popquiz
course: ${courseId.toUpperCase()}
lesson: 01.01
---
# ![Minds On|50%](./assets/img/baf3m_01.02_mindsOn.jpg)

## Questions
01) [KU] What is an asset?
<Multiple-Choice>
- [ ] An economic resource
- [ ] A debt
- [ ] An expense
- [ ] None

## Answers
01) A - (explanation) Assets are resources owned by the business.
`;

    const req = new Request('http://127.0.0.1:3182/api/pop-quiz/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId,
        lessonId: '01.01',
        lessonTitle: '![Minds On|50%](./assets/img/baf3m_01.02_mindsOn.jpg)',
        testMarkdown: rawMarkdown,
        answers: { '1': 'A' },
        timeSpentSeconds: 45
      })
    });

    const res = await handleApiRequest(req, new URL('http://127.0.0.1:3182/api/pop-quiz/submit'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.score).toBe(1);
    expect(body.total).toBe(1);
    expect(body.percentage).toBe(100);
    expect(body.supervisorMessage).toBe('Updated course supervisor, thank you!');
  });

  it('POST /api/courses/:course_id/unit-test/submit evaluates test, records frontmatter, and dispatches to supervisor', async () => {
    const unitTestMarkdown = `---
type: test
course: ${courseId.toUpperCase()}
lesson: 01.unit
---
# Unit Practice Exam

## Questions

01) [Knowledge & Understanding] What is owner's equity?
<Multiple-Choice>
- [ ] A. Claims of creditors
- [ ] B. Residual claim of owners
- [ ] C. Total assets
- [ ] D. Net loss

02) [Thinking & Investigation] Complete the formula: Assets = Liabilities + [___]
<Fill-in-the-Blank>
Expected: Owner's Equity

## Answers

01) B - Owner's equity is the owner's remaining claim on assets.
02) Owner's Equity - (explanation) The fundamental accounting equation.
`;

    // Save unit test file
    fs.writeFileSync(path.join(courseDir, '01.unit.test.md'), unitTestMarkdown);

    const req = new Request(`http://127.0.0.1:3182/api/courses/${courseId}/unit-test/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unitId: '01.unit',
        testMarkdown: unitTestMarkdown,
        answers: {
          '01': 'B',
          '02': "Owner's Equity"
        }
      })
    });

    const res = await handleApiRequest(req, new URL(`http://127.0.0.1:3182/api/courses/${courseId}/unit-test/submit`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.score).toBe(2);
    expect(body.total).toBe(2);
    expect(body.percentage).toBe(100);
    expect(body.supervisorMessage).toBe('Updated course supervisor, thank you!');
    expect(body.lastAttemptDate).toBeDefined();

    // Verify frontmatter was updated without storing student answers
    const savedDoc = fs.readFileSync(path.join(courseDir, '01.unit.test.md'), 'utf8');
    expect(savedDoc).toContain('score: 2');
    expect(savedDoc).toContain('totalQuestions: 2');
    expect(savedDoc).toContain('percentage: 100');
    expect(savedDoc).not.toContain('answers:');
  });
});
