import { describe, it, expect } from 'bun:test';
import {
  slugifyTabName,
  isTabSlug,
  isCustomTabSlug,
  isCourseTab,
  isUnitTab,
  isUnitScopeId,
  parseUnitNumber,
  formatUnitScopeId,
  unitDocFileName,
  customTabDisplayName,
  validateTabName,
  parsePageNumbers,
  parseStartPage,
  starterPromptForTab,
  tabFileName,
  courseDocFileName,
  docFileName,
  parseDocFileName,
  courseTabHref
} from './tabs';

describe('slugifyTabName', () => {
  it('lowercases and converts spaces to underscores', () => {
    expect(slugifyTabName('Assignment')).toBe('assignment');
    expect(slugifyTabName('Practice Questions')).toBe('practice_questions');
  });

  it('strips characters outside [a-z0-9_]', () => {
    expect(slugifyTabName('My Notes!')).toBe('my_notes');
    expect(slugifyTabName('  Draft #2 — final ')).toBe('draft_2_final');
  });

  it('collapses repeated whitespace', () => {
    expect(slugifyTabName('term   work')).toBe('term_work');
  });
});

describe('isTabSlug', () => {
  it('accepts lowercase slugs of letters, digits and underscores', () => {
    expect(isTabSlug('assignment')).toBe(true);
    expect(isTabSlug('practice_questions')).toBe(true);
    expect(isTabSlug('v2_draft')).toBe(true);
  });

  it('rejects empty, dashed, dotted, upper-case or over-long slugs', () => {
    expect(isTabSlug('')).toBe(false);
    expect(isTabSlug('test-2')).toBe(false);
    expect(isTabSlug('a.b')).toBe(false);
    expect(isTabSlug('Assignment')).toBe(false);
    expect(isTabSlug('_leading')).toBe(false);
    expect(isTabSlug('a'.repeat(33))).toBe(false);
  });
});

describe('isCustomTabSlug', () => {
  it('is false for built-in and reserved tabs', () => {
    expect(isCustomTabSlug('lesson')).toBe(false);
    expect(isCustomTabSlug('book')).toBe(false);
    expect(isCustomTabSlug('studysheet')).toBe(false);
    expect(isCustomTabSlug('test')).toBe(false);
    expect(isCustomTabSlug('schedule')).toBe(false);
    expect(isCustomTabSlug('course')).toBe(false);
    expect(isCustomTabSlug('notes')).toBe(false);
  });

  it('is true for other valid slugs, including summary', () => {
    expect(isCustomTabSlug('summary')).toBe(true);
    expect(isCustomTabSlug('assignment')).toBe(true);
    expect(isCustomTabSlug('research_notes')).toBe(true);
  });

  it('is false for invalid slugs', () => {
    expect(isCustomTabSlug('test-2')).toBe(false);
    expect(isCustomTabSlug('')).toBe(false);
  });
});

describe('isCourseTab', () => {
  it('is true for all valid course-level tabs', () => {
    expect(isCourseTab('lesson')).toBe(true);
    expect(isCourseTab('summary')).toBe(true);
    expect(isCourseTab('studysheet')).toBe(false);
    expect(isCourseTab('test')).toBe(true);
    expect(isCourseTab('schedule')).toBe(true);
    expect(isCourseTab('logs')).toBe(true);
  });

  it('is false for custom tabs and invalid slugs', () => {
    expect(isCourseTab('assignment')).toBe(false);
    expect(isCourseTab('boom')).toBe(false);
    expect(isCourseTab('practice_questions')).toBe(false);
    expect(isCourseTab('')).toBe(false);
    expect(isCourseTab('random')).toBe(false);
  });
});

describe('customTabDisplayName', () => {
  it('title-cases underscore-separated words', () => {
    expect(customTabDisplayName('assignment')).toBe('Assignment');
    expect(customTabDisplayName('practice_questions')).toBe('Practice Questions');
  });
});

describe('validateTabName', () => {
  const existing = ['lesson', 'summary', 'studysheet', 'test', 'assignment'];

  it('accepts a fresh name and returns its slug', () => {
    const result = validateTabName('Reading Log', existing);
    expect(result.ok).toBe(true);
    expect(result.ok && result.slug).toBe('reading_log');
  });

  it('rejects names that slugify to nothing', () => {
    const result = validateTabName('!!!', existing);
    expect(result.ok).toBe(false);
  });

  it('rejects reserved built-in names', () => {
    const result = validateTabName('Book', existing);
    expect(result.ok).toBe(false);
  });

  it('allows Summary when not already present in existing slugs', () => {
    const withoutSummary = ['lesson', 'studysheet'];
    const result = validateTabName('Summary', withoutSummary);
    expect(result.ok).toBe(true);
    expect(result.ok && result.slug).toBe('summary');
  });

  it('rejects tabs that already exist for the lesson', () => {
    const result = validateTabName('Assignment', existing);
    expect(result.ok).toBe(false);
  });
});

describe('page range parsing helpers', () => {
  it('parses hyphenated and comma ranges', () => {
    expect(parsePageNumbers('14-28')).toEqual([14, 28]);
    expect(parsePageNumbers('14, 22-25, 30')).toEqual([14, 22, 25, 30]);
    expect(parsePageNumbers('pp. 45-50')).toEqual([45, 50]);
  });

  it('returns empty array for invalid or empty inputs', () => {
    expect(parsePageNumbers('')).toEqual([]);
    expect(parsePageNumbers(null)).toEqual([]);
    expect(parsePageNumbers('no numbers here')).toEqual([]);
  });

  it('extracts start page', () => {
    expect(parseStartPage('14-28')).toBe(14);
    expect(parseStartPage('Page 42')).toBe(42);
    expect(parseStartPage(null)).toBeNull();
  });
});

describe('starterPromptForTab', () => {
  it('mentions the display name and starts with a heading', () => {
    const prompt = starterPromptForTab('Assignment');
    expect(prompt.startsWith('# Assignment Prompt')).toBe(true);
    expect(prompt).toContain('"Assignment"');
  });
});

describe('tab and document filenames', () => {
  it('formats tabFileName for lessons', () => {
    expect(tabFileName('01.01', 'lesson')).toBe('01.01.lesson.md');
    expect(tabFileName('02.03', 'Assignment')).toBe('02.03.assignment.md');
  });

  it('formats courseDocFileName for course docs', () => {
    expect(courseDocFileName('summary')).toBe('course.summary.md');
    expect(courseDocFileName('Schedule')).toBe('course.schedule.md');
    expect(courseDocFileName('logs')).toBe('logs.md');
    expect(courseDocFileName('Logs')).toBe('logs.md');
  });

  it('formats unitDocFileName for unit docs', () => {
    expect(unitDocFileName('01.unit', 'test')).toBe('01.unit.test.md');
    expect(unitDocFileName(1, 'assignments')).toBe('01.unit.assignments.md');
    expect(unitDocFileName('02', 'test')).toBe('02.unit.test.md');
  });

  it('formats docFileName based on scope', () => {
    expect(docFileName('01.01', 'lesson')).toBe('01.01.lesson.md');
    expect(docFileName('01.unit', 'test')).toBe('01.unit.test.md');
    expect(docFileName('course', 'summary')).toBe('course.summary.md');
    expect(docFileName('01.01', 'summary', true)).toBe('course.summary.md');
  });

  it('parses valid document filenames', () => {
    expect(parseDocFileName('01.01.lesson.md')).toEqual({
      isCourseScope: false,
      isUnitScope: false,
      lessonId: '01.01',
      tab: 'lesson'
    });
    expect(parseDocFileName('01.unit.test.md')).toEqual({
      isCourseScope: false,
      isUnitScope: true,
      unitNumber: 1,
      lessonId: '01.unit',
      tab: 'test'
    });
    expect(parseDocFileName('02.unit.assignments.md')).toEqual({
      isCourseScope: false,
      isUnitScope: true,
      unitNumber: 2,
      lessonId: '02.unit',
      tab: 'assignments'
    });
    expect(parseDocFileName('01.06_assign1.test.md')).toEqual({
      isCourseScope: false,
      isUnitScope: false,
      lessonId: '01.06_assign1',
      tab: 'test'
    });
    expect(parseDocFileName('course.summary.md')).toEqual({
      isCourseScope: true,
      isUnitScope: false,
      lessonId: 'course',
      tab: 'summary'
    });
    expect(parseDocFileName('logs.md')).toEqual({
      isCourseScope: true,
      isUnitScope: false,
      lessonId: 'course',
      tab: 'logs'
    });
    expect(parseDocFileName('invalid_file.txt')).toBeNull();
  });

  it('handles unit scope helpers', () => {
    expect(isUnitScopeId('01.unit')).toBe(true);
    expect(isUnitScopeId('01.02')).toBe(false);
    expect(isUnitScopeId('course')).toBe(false);
    expect(formatUnitScopeId(1)).toBe('01.unit');
    expect(formatUnitScopeId('02')).toBe('02.unit');
    expect(parseUnitNumber('01.unit')).toBe(1);
    expect(parseUnitNumber('02.03')).toBe(2);
    expect(isUnitTab('assignments')).toBe(true);
    expect(isUnitTab('test')).toBe(true);
    expect(isUnitTab('summary')).toBe(false);
  });

  it('builds courseTabHref paths', () => {
    expect(courseTabHref('baf3m', '01.01', 'lesson')).toBe('/courses/baf3m/01.01/lesson');
    expect(courseTabHref('baf3m', 'course', 'summary')).toBe('/courses/baf3m/course/summary');
    expect(courseTabHref('baf3m', 'any', 'schedule', true)).toBe('/courses/baf3m/course/schedule');
  });
});

