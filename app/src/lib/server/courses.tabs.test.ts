import { describe, expect, it, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CourseService resolves its directories through getDataDir(), which honours
// DATA_DIR on every call — so pointing tests at a scratch dir needs no mocking.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'app-tabs-'));
process.env.DATA_DIR = scratch;

import { CourseService } from './courses';

const courseId = 'tstvc';
const courseDir = path.join(scratch, 'courses', courseId);

describe('CourseService tab file helpers', () => {
  beforeAll(() => {
    fs.mkdirSync(courseDir, { recursive: true });
  });

  describe('getLessonContent', () => {
    it('discovers built-in and custom tabs keyed by slug, ignoring other lessons and files', () => {
      fs.writeFileSync(path.join(courseDir, '01.01.lesson.md'), '# Lesson body');
      fs.writeFileSync(path.join(courseDir, '01.01.summary.md'), '# Summary');
      fs.writeFileSync(path.join(courseDir, '01.01.assignment.md'), '# Assignment');
      fs.writeFileSync(path.join(courseDir, '01.02.summary.md'), '# Other lesson summary');
      fs.writeFileSync(path.join(courseDir, 'meta.json'), '{}');
      const bundle = CourseService.getLessonContent(courseId, '01.01');
      expect(bundle?.lesson).toBe('# Lesson body');
      expect(bundle?.tabs['summary']).toBe('# Summary');
      expect(bundle?.tabs['assignment']).toBe('# Assignment');
      expect(Object.keys(bundle?.tabs || {})).not.toContain('lesson');
    });
  });

  describe('hasLessonTabContent', () => {
    it('treats real generated base files as present', () => {
      fs.writeFileSync(path.join(courseDir, '03.01.test.md'), 'real generated content\n'.repeat(20));
      expect(CourseService.hasLessonTabContent(courseId, '03.01', 'test')).toBe(true);
    });

    it('treats placeholder base files as missing', () => {
      fs.writeFileSync(
        path.join(courseDir, '03.02.test.md'),
        '---\ntype: test\n---\n\n*Not yet generated.*\n'
      );
      expect(CourseService.hasLessonTabContent(courseId, '03.02', 'test')).toBe(false);
    });

    it('treats stub-length content as missing', () => {
      fs.writeFileSync(path.join(courseDir, '03.03.summary.md'), 'too short');
      expect(CourseService.hasLessonTabContent(courseId, '03.03', 'summary')).toBe(false);
    });

    it('returns false when nothing exists', () => {
      expect(CourseService.hasLessonTabContent(courseId, '03.04', 'notes')).toBe(false);
    });
  });

  describe('saveLessonTab', () => {
    it('always writes the base file, including for custom tabs', () => {
      fs.writeFileSync(path.join(courseDir, '04.02.summary.md'), 'old');
      const result = CourseService.saveLessonTab(courseId, '04.02', 'summary', 'fresh');
      expect(result.success).toBe(true);
      expect(result.filename).toBe('04.02.summary.md');
      expect(fs.readFileSync(path.join(courseDir, '04.02.summary.md'), 'utf8')).toBe('fresh');
      expect(fs.existsSync(path.join(courseDir, '04.02.summary-2.md'))).toBe(false);

      const custom = CourseService.saveLessonTab(courseId, '04.02', 'assignment', 'work');
      expect(custom.success).toBe(true);
      expect(fs.readFileSync(path.join(courseDir, '04.02.assignment.md'), 'utf8')).toBe('work');
    });

    it('rejects course ids that try to escape the data dir', () => {
      expect(() => CourseService.saveLessonTab('../evil', '01.01', 'summary', 'nope')).toThrow();
    });
  });

  describe('deleteLessonTab', () => {
    it('removes the tab file and reports false when absent', () => {
      fs.writeFileSync(path.join(courseDir, '05.01.assignment.md'), 'bye');
      expect(CourseService.deleteLessonTab(courseId, '05.01', 'assignment')).toBe(true);
      expect(fs.existsSync(path.join(courseDir, '05.01.assignment.md'))).toBe(false);
      expect(CourseService.deleteLessonTab(courseId, '05.01', 'assignment')).toBe(false);
    });

    it('leaves sibling tabs untouched', () => {
      fs.writeFileSync(path.join(courseDir, '05.02.summary.md'), 'keep');
      fs.writeFileSync(path.join(courseDir, '05.02.assignment.md'), 'delete me');
      CourseService.deleteLessonTab(courseId, '05.02', 'assignment');
      expect(fs.existsSync(path.join(courseDir, '05.02.summary.md'))).toBe(true);
    });
  });

  describe('buildSchedulePayload', () => {
    const schedCourse = 'tstsch';
    const schedDir = path.join(scratch, 'courses', schedCourse);

    const entry = (id: string, title: string, type: 'lesson' | 'assignment') => ({
      id,
      code: id,
      title,
      unitNumber: 1,
      lessonNumber: 1,
      type,
      hasFull: true,
      hasSummary: false,
      hasNotes: false,
      hasTest: false
    });

    beforeAll(() => {
      fs.mkdirSync(schedDir, { recursive: true });
      fs.writeFileSync(
        path.join(schedDir, 'meta.json'),
        JSON.stringify({
          id: schedCourse,
          title: 'Schedule Fixture Course',
          grade: '11',
          level: 'U',
          description: 'fixture',
          updatedAt: '2026-10-13',
          units: [
            {
              number: 1,
              title: 'Unit One',
              lessons: [
                entry('01.01', 'Plain intro lesson', 'lesson'),
                entry('01.02', 'Dense formula lesson', 'lesson'),
                entry('01.05_assign1', 'Assignment one', 'assignment')
              ]
            }
          ]
        })
      );
      fs.writeFileSync(
        path.join(schedDir, '01.01.lesson.md'),
        `# Intro\n\n${'plain narrative text about history and context here. '.repeat(12)}`
      );
      fs.writeFileSync(
        path.join(schedDir, '01.02.lesson.md'),
        `# Dense\n\n${'formula heavy content with worked examples and steps. '.repeat(20)}`
      );
      // High-density summary: bullets + math + bold terms in few words.
      fs.writeFileSync(
        path.join(schedDir, '01.02.summary.md'),
        '## Formulas\n\n- $x^2$ first item\n- $\\\\frac{a}{b}$ second item\n- third item\n- fourth item\n\n**Term one** and **term two** matter.'
      );
    });

    it('emits course statistics and full lesson inventory including assignments', () => {
      const payload = CourseService.buildSchedulePayload(schedCourse);
      expect(payload).toContain('Course Statistics');
      expect(payload).toContain('Lesson 01.01 (LESSON)');
      expect(payload).toContain('Lesson 01.02 (LESSON)');
      expect(payload).toContain('Lesson 01.05_assign1 (ASSIGNMENT)');
      expect(payload).toMatch(/Total lesson content/i);
    });

    it('reports per-lesson content size and summary density for pacing', () => {
      const payload = CourseService.buildSchedulePayload(schedCourse);
      expect(payload).toMatch(/Content: \d[\d,]* words/);
      // The dense summary fixture must be rated high with its signal counts.
      expect(payload).toContain('Summary density: high');
      expect(payload).toMatch(/4 list items/);
      expect(payload).toMatch(/2 key terms/);
    });

    it('fills an optional stats collector for API debug logging with itemized details', () => {
      const stats: any = {
        lessons: 0,
        assignments: 0,
        totalWords: 0,
        density: {}
      };
      CourseService.buildSchedulePayload(schedCourse, stats);
      expect(stats.lessons).toBe(2);
      expect(stats.assignments).toBe(1);
      expect(stats.totalWords).toBeGreaterThan(100);
      expect(stats.density['high']).toBe(1);
      expect(stats.items).toBeDefined();
      expect(stats.items.length).toBe(3);
      expect(stats.items[0].lessonId).toBe('01.01');
      expect(stats.items[0].type).toBe('lesson');
      expect(stats.payloadChars).toBeGreaterThan(0);
      expect(stats.estimatedTokens).toBeGreaterThan(0);
    });
  });

  describe('Course document helpers', () => {
    it('discovers custom and built-in course docs from disk', () => {
      fs.writeFileSync(path.join(courseDir, 'course.summary.md'), '# Course Summary');
      fs.writeFileSync(path.join(courseDir, 'course.resources.md'), '# Extra Resources');

      const flags = CourseService.discoverCourseDocs(courseDir);
      expect(flags.summary).toBe(true);
      expect(flags.notes).toBe(false);
      expect(flags['resources']).toBe(true);
    });

    it('saves and reads custom course documents', () => {
      expect(CourseService.hasCourseDocument(courseId, 'glossary')).toBe(false);

      const saved = CourseService.saveCourseDocument(courseId, 'glossary', '# Course Glossary\nKey terms here');
      expect(saved).toBe(true);
      expect(CourseService.hasCourseDocument(courseId, 'glossary')).toBe(true);

      const content = CourseService.getCourseDocument(courseId, 'glossary');
      expect(content).toContain('Key terms here');
    });
  });

  describe('getPromptContext', () => {
    const pcCourse = 'tstpc';
    const pcDir = path.join(scratch, 'courses', pcCourse);

    beforeAll(() => {
      fs.mkdirSync(pcDir, { recursive: true });
      fs.writeFileSync(
        path.join(pcDir, 'meta.json'),
        JSON.stringify({
          id: pcCourse,
          title: 'Prompt Context Test Course',
          units: [
            {
              id: 'unit-1',
              title: 'Unit 1 Title',
              lessons: [
                { id: '01.01', title: 'Lesson 1.1' },
                { id: '01.02', title: 'Lesson 1.2' }
              ]
            },
            {
              id: 'unit-2',
              title: 'Unit 2 Title',
              lessons: [{ id: '02.01', title: 'Lesson 2.1' }]
            }
          ]
        })
      );
      fs.writeFileSync(
        path.join(pcDir, '01.01.lesson.md'),
        '---\ntitle: Internal Lesson Title\norder: 1\n---\nLesson 1.1 content here'
      );
      fs.writeFileSync(path.join(pcDir, '01.01.summary.md'), '---\ntype: summary\n---\nSummary 1.1 content');
      fs.writeFileSync(path.join(pcDir, '01.01.notes.md'), '---\ntype: notes\n---\nNotes 1.1 content');
      fs.writeFileSync(path.join(pcDir, '01.02.lesson.md'), 'Lesson 1.2 content here');
      fs.writeFileSync(path.join(pcDir, '02.01.lesson.md'), 'Lesson 2.1 content here');
      fs.writeFileSync(path.join(pcDir, '02.01.summary.md'), '---\ntype: summary\n---\nSummary 2.1 content');
      fs.writeFileSync(path.join(pcDir, '02.01.notes.md'), '---\ntype: notes\n---\nNotes 2.1 content');
    });

    it('resolves lesson - lessons', async () => {
      const res = await CourseService.getPromptContext(pcCourse, 'lesson - lessons', '01.01');
      expect(res).toBe('Lesson 1.1 content here');
    });

    it('resolves lesson - summaries', async () => {
      const res = await CourseService.getPromptContext(pcCourse, 'lesson - summaries', '01.01');
      expect(res).toBe('Summary 1.1 content');
    });

    it('resolves lesson - notes', async () => {
      const res = await CourseService.getPromptContext(pcCourse, 'lesson - notes', '01.01');
      expect(res).toBe('Notes 1.1 content');
    });

    it('resolves legacy alias lesson - studysheets', async () => {
      const res = await CourseService.getPromptContext(pcCourse, 'lesson - studysheets', '01.01');
      expect(res).toBe('Notes 1.1 content');
    });

    it('resolves unit - lessons for the unit containing the lesson', async () => {
      const res = await CourseService.getPromptContext(pcCourse, 'unit - lessons', '01.01');
      expect(res).toContain('Lesson 01.01 - Lesson 1.1');
      expect(res).toContain('Lesson 1.1 content here');
      expect(res).toContain('Lesson 01.02 - Lesson 1.2');
      expect(res).toContain('Lesson 1.2 content here');
      expect(res).not.toContain('Lesson 2.1');
    });

    it('resolves course - lessons across all units', async () => {
      const res = await CourseService.getPromptContext(pcCourse, 'course - lessons');
      expect(res).toContain('Lesson 1.1 content here');
      expect(res).toContain('Lesson 1.2 content here');
      expect(res).toContain('Lesson 2.1 content here');
    });

    it('resolves course - summaries across all units', async () => {
      const res = await CourseService.getPromptContext(pcCourse, 'course - summaries');
      expect(res).toContain('Summary 1.1 content');
      expect(res).toContain('Summary 2.1 content');
    });

    it('resolves course - notes across all units', async () => {
      const res = await CourseService.getPromptContext(pcCourse, 'course - notes');
      expect(res).toContain('Notes 1.1 content');
      expect(res).toContain('Notes 2.1 content');
    });

    it('resolves legacy alias course - studysheets across all units', async () => {
      const res = await CourseService.getPromptContext(pcCourse, 'course - studysheets');
      expect(res).toContain('Notes 1.1 content');
      expect(res).toContain('Notes 2.1 content');
    });

    it('resolves locker - <filename>', async () => {
      const lockerDir = path.join(pcDir, 'assets', 'locker_docs');
      fs.mkdirSync(lockerDir, { recursive: true });
      fs.writeFileSync(path.join(lockerDir, 'notes.txt'), 'Locker notes content');
      const res = await CourseService.getPromptContext(pcCourse, 'locker - notes.txt');
      expect(res).toBe('Locker notes content');
    });

    it('saves image files to assets/locker_docs and resolves their asset path', () => {
      const filename = '01.01_m7xyz12.jpg';
      const fakeBuffer = Buffer.from('fake-jpeg-data');
      const saved = CourseService.saveLockerDoc(pcCourse, filename, fakeBuffer);

      expect(saved.filename).toBe(filename);
      expect(saved.ext).toBe('jpg');
      expect(saved.url).toBe(`/api/courses/${pcCourse}/assets/locker_docs/${filename}`);

      const diskPath = path.join(pcDir, 'assets', 'locker_docs', filename);
      expect(fs.existsSync(diskPath)).toBe(true);

      const resolved = CourseService.resolveAssetPath(pcCourse, `locker_docs/${filename}`);
      expect(resolved).toBe(diskPath);
    });
  });
});
