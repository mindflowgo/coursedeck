import { describe, expect, it, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'popquiz-test-'));
process.env.DATA_DIR = scratch;

import { handleApiRequest } from './api';
import { CourseService } from './courses';

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
              hasCheatsheet: false,
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
              hasCheatsheet: false,
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
});
