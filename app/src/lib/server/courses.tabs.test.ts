import { describe, expect, it, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CourseService resolves its directories through getDataDir(), which honours
// DATA_DIR on every call — so pointing tests at a scratch dir needs no mocking.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ilc-tabs-'));
process.env.DATA_DIR = scratch;

import { CourseService } from './courses';

const courseId = 'tstvc';
const courseDir = path.join(scratch, 'courses', courseId);

describe('CourseService tab version helpers', () => {
  beforeAll(() => {
    fs.mkdirSync(courseDir, { recursive: true });
  });

  describe('latestVersionNumber', () => {
    it('returns 1 when no tab files exist', () => {
      expect(CourseService.latestVersionNumber(courseId, '01.99', 'summary')).toBe(1);
    });

    it('counts the base file as version 1', () => {
      fs.writeFileSync(path.join(courseDir, '02.01.cheatsheet.md'), 'x'.repeat(300));
      expect(CourseService.latestVersionNumber(courseId, '02.01', 'cheatsheet')).toBe(1);
    });

    it('returns the highest -N version across all versioned files', () => {
      fs.writeFileSync(path.join(courseDir, '02.02.summary.md'), 'x'.repeat(300));
      fs.writeFileSync(path.join(courseDir, '02.02.summary-2.md'), 'y'.repeat(300));
      fs.writeFileSync(path.join(courseDir, '02.02.summary-5.md'), 'z'.repeat(300));
      expect(CourseService.latestVersionNumber(courseId, '02.02', 'summary')).toBe(5);
    });

    it('ignores other lessons and other tabs', () => {
      fs.writeFileSync(path.join(courseDir, '02.03.test.md'), 'x'.repeat(300));
      expect(CourseService.latestVersionNumber(courseId, '02.02', 'summary')).toBe(5);
      expect(CourseService.latestVersionNumber(courseId, '02.03', 'summary')).toBe(1);
    });
  });

  describe('hasLessonTabContent', () => {
    it('treats versioned-only content as present', () => {
      // Lesson with only a -2 version file (the enqueueCourseMissing blind spot)
      fs.writeFileSync(path.join(courseDir, '03.01.test-2.md'), 'real generated content\n'.repeat(20));
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
      expect(CourseService.hasLessonTabContent(courseId, '03.04', 'cheatsheet')).toBe(false);
    });
  });

  describe('saveLessonTab', () => {
    it('writes the next version filename when asNewVersion', () => {
      fs.writeFileSync(path.join(courseDir, '04.01.summary.md'), 'x'.repeat(300));
      const result = CourseService.saveLessonTab(courseId, '04.01', 'summary', 'new content', {
        asNewVersion: true
      });
      expect(result.success).toBe(true);
      expect(result.versionId).toBe('summary-2');
      expect(fs.existsSync(path.join(courseDir, '04.01.summary-2.md'))).toBe(true);
    });

    it('overwrites the base file when not asNewVersion', () => {
      fs.writeFileSync(path.join(courseDir, '04.02.summary.md'), 'old');
      const result = CourseService.saveLessonTab(courseId, '04.02', 'summary', 'fresh', {});
      expect(result.success).toBe(true);
      expect(result.versionId).toBe('summary');
      expect(fs.readFileSync(path.join(courseDir, '04.02.summary.md'), 'utf8')).toBe('fresh');
      // No stray version files created
      expect(fs.existsSync(path.join(courseDir, '04.02.summary-2.md'))).toBe(false);
    });

    it('rejects course ids that try to escape the data dir', () => {
      expect(() =>
        CourseService.saveLessonTab('../evil', '01.01', 'summary', 'nope', {})
      ).toThrow();
    });
  });
});
