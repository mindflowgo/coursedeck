import { describe, expect, it, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'app-logs-'));
process.env.DATA_DIR = scratch;

import { CourseService, formatLogDate } from './courses';

const courseId = 'mcr3u';
const courseDir = path.join(scratch, 'courses', courseId);

describe('CourseService accountability and audit logging (logs.md)', () => {
  beforeAll(() => {
    fs.mkdirSync(courseDir, { recursive: true });
    fs.writeFileSync(path.join(courseDir, 'meta.json'), JSON.stringify({ id: courseId, title: 'Math G11', units: [] }));
  });

  it('formatLogDate formats as YYYY-MM-DD H:mm', () => {
    const fixedDate = new Date(2026, 2, 3, 9, 14, 0); // Month 2 is March
    expect(formatLogDate(fixedDate)).toBe('2026-03-03 9:14');
  });

  it('records log entry and initializes logs.md with 4-column table header', () => {
    const testDate = new Date(2026, 2, 3, 9, 14, 0);
    CourseService.recordLog({
      courseId,
      type: 'llm',
      lessonDoc: '01.02.studysheet.md',
      chars: 1035,
      tokens: 7247,
      date: testDate
    });

    const logsPath = CourseService.getLogsPath(courseId);
    expect(fs.existsSync(logsPath)).toBe(true);

    const content = CourseService.getLogs(courseId) || '';
    expect(content).toContain('| Date | Type | Lesson | Tokens |');
    expect(content).toContain('| :--- | :--- | :--- | :--- |');
    expect(content).toContain('| 2026-03-03 9:14 | llm | MCR3U: 01.02.studysheet.md (1035 chars) | 7247 |');
  });

  it('appends subsequent log entries with types sequentially', () => {
    const secondDate = new Date(2026, 2, 3, 10, 30, 0);
    CourseService.recordLog({
      courseId,
      type: 'llm',
      lessonDoc: '01.03.summary.md',
      chars: 2450,
      tokens: 3120,
      date: secondDate
    });

    const thirdDate = new Date(2026, 2, 3, 11, 0, 0);
    CourseService.recordLog({
      courseId,
      type: 'edit',
      lessonDoc: '01.03.lesson.md',
      chars: 3100,
      date: thirdDate
    });

    const content = CourseService.getLogs(courseId) || '';
    const lines = content.trim().split('\n');
    expect(lines).toContain('| 2026-03-03 9:14 | llm | MCR3U: 01.02.studysheet.md (1035 chars) | 7247 |');
    expect(lines).toContain('| 2026-03-03 10:30 | llm | MCR3U: 01.03.summary.md (2450 chars) | 3120 |');
    expect(lines).toContain('| 2026-03-03 11:00 | edit | MCR3U: 01.03.lesson.md (3100 chars) | - |');
  });

  it('handles course-level documents properly without doubling prefix', () => {
    const fourthDate = new Date(2026, 2, 4, 14, 5, 0);
    CourseService.recordLog({
      courseId,
      lessonDoc: 'MCR3U: course.schedule.md',
      chars: 5800,
      tokens: 8900,
      date: fourthDate
    });

    const content = CourseService.getLogs(courseId) || '';
    expect(content).toContain('| 2026-03-04 14:05 | llm | MCR3U: course.schedule.md (5800 chars) | 8900 |');
    expect(content).not.toContain('MCR3U: MCR3U:');
  });

  it('getCourseDocument and hasCourseDocument recognize logs type', () => {
    expect(CourseService.hasCourseDocument(courseId, 'logs')).toBe(true);
    const doc = CourseService.getCourseDocument(courseId, 'logs');
    expect(doc).toBeTruthy();
    expect(doc).toContain('01.02.studysheet.md');
  });

  it('discoverCourseDocs flags logs as true when logs.md exists', () => {
    const flags = CourseService.discoverCourseDocs(courseDir);
    expect(flags.logs).toBe(true);
  });
});
