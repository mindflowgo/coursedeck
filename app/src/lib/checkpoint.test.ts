import { describe, expect, it } from 'bun:test';
import {
  CHECKPOINT_COLORS,
  DEFAULT_CHECKPOINT_COLOR,
  formatCheckpointDate,
  getCheckpointColor,
  getCheckpointHref,
  resolveFileFromRoute,
  resolveRouteFromFile,
  type Checkpoint
} from './checkpoint';

describe('Checkpoint Palette & Models', () => {
  it('defines 10 distinct colors grouped into Set 1 (pastel) and Set 2 (vibrant)', () => {
    expect(CHECKPOINT_COLORS.length).toBe(10);
    const ids = new Set(CHECKPOINT_COLORS.map((c) => c.id));
    expect(ids.size).toBe(10);

    const set1 = CHECKPOINT_COLORS.filter((c) => c.set === 1);
    const set2 = CHECKPOINT_COLORS.filter((c) => c.set === 2);
    expect(set1.length).toBe(5);
    expect(set2.length).toBe(5);

    // Verify first 5 are Set 1 and next 5 are Set 2 in array order
    expect(CHECKPOINT_COLORS.slice(0, 5).every((c) => c.set === 1)).toBe(true);
    expect(CHECKPOINT_COLORS.slice(5, 10).every((c) => c.set === 2)).toBe(true);

    // Verify exact hex codes from user swatches
    expect(set1.map((c) => c.dot)).toEqual(['#a7f8ef', '#f7fa6d', '#d5b3ff', '#ffd000', '#f086be']);
    expect(set2.map((c) => c.dot)).toEqual(['#ffa417', '#0055ff', '#ff5a3c', '#3ce1ff', '#48ff40']);

    for (const color of CHECKPOINT_COLORS) {
      expect(color.dot).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(color.bgLight).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(color.bgDark).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(color.borderLight).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(color.borderDark).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(color.textLight).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(color.textDark).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('getCheckpointColor returns correct color or fallback, supporting legacy aliases', () => {
    expect(getCheckpointColor('coral').id).toBe('coral');
    expect(getCheckpointColor('coral').dot).toBe('#ff5a3c');
    expect(getCheckpointColor('blue').dot).toBe('#0055ff');
    expect(getCheckpointColor('yellow').dot).toBe('#f7fa6d');
    expect(getCheckpointColor('aqua').dot).toBe('#a7f8ef');

    // Legacy aliases
    expect(getCheckpointColor('mint').id).toBe('aqua');
    expect(getCheckpointColor('amber').id).toBe('gold');
    expect(getCheckpointColor('lime').id).toBe('green');
    expect(getCheckpointColor('purple').id).toBe('lavender');

    // Fallbacks
    expect(getCheckpointColor('unknown').id).toBe(DEFAULT_CHECKPOINT_COLOR);
    expect(getCheckpointColor(undefined).id).toBe(DEFAULT_CHECKPOINT_COLOR);
  });

  it('resolves filename from route', () => {
    expect(resolveFileFromRoute('01.01', 'lesson', false)).toBe('01.01.lesson.md');
    expect(resolveFileFromRoute('02.04', 'summary', false)).toBe('02.04.summary.md');
    expect(resolveFileFromRoute('course', 'summary', true)).toBe('course.summary.md');
    expect(resolveFileFromRoute('course', 'cheatsheet', false)).toBe('course.cheatsheet.md');
  });

  it('resolves route from filename', () => {
    expect(resolveRouteFromFile('01.01.lesson.md')).toEqual({
      isCourseScope: false,
      lessonId: '01.01',
      tab: 'lesson'
    });
    expect(resolveRouteFromFile('course.summary.md')).toEqual({
      isCourseScope: true,
      lessonId: 'course',
      tab: 'summary'
    });
  });

  it('builds checkpoint href', () => {
    const cp: Checkpoint = {
      id: 'cp_123',
      file: '01.01.lesson.md',
      verticalPosition: 450,
      type: 'note',
      color: 'blue',
      date: '2026-10-16T12:00:00Z'
    };
    expect(getCheckpointHref('BAF3M', cp)).toBe('/courses/baf3m/01.01/lesson?checkpoint=cp_123');

    const courseCp: Checkpoint = {
      id: 'cp_course_1',
      file: 'course.summary.md',
      verticalPosition: 120,
      type: 'note',
      color: 'yellow',
      date: '2026-10-16T12:00:00Z'
    };
    expect(getCheckpointHref('hhs4u', courseCp)).toBe('/courses/hhs4u/course/summary?checkpoint=cp_course_1');
  });

  it('formats dates cleanly', () => {
    expect(formatCheckpointDate('')).toBe('');
    expect(formatCheckpointDate('invalid')).toBe('');
    expect(formatCheckpointDate('2026-10-16T14:30:00Z')).toContain('Oct 16');
  });
});
