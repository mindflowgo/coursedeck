import { beforeEach, describe, expect, it } from 'bun:test';
import {
  getResumeLastPosition,
  setResumeLastPosition,
  getMostRecentPositionCheckpoint,
  resolveLastAccessedCourseRoute,
  getCourseLastLocation,
  setCourseLastLocation,
  buildCourseResumeUrl,
  RESUME_LAST_POSITION_STORAGE_KEY
} from './preferences';
import type { Checkpoint } from './checkpoint';

// Mock localStorage for test environment
class MockLocalStorage {
  private store: Record<string, string> = {};
  getItem(key: string): string | null {
    return this.store[key] ?? null;
  }
  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }
  removeItem(key: string): void {
    delete this.store[key];
  }
  clear(): void {
    this.store = {};
  }
}

describe('User Preferences - Course Position Resume', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MockLocalStorage();
  });

  it('defaults getResumeLastPosition to true when not set', () => {
    expect(getResumeLastPosition()).toBe(true);
  });

  it('persists and retrieves getResumeLastPosition', () => {
    setResumeLastPosition(false);
    expect(getResumeLastPosition()).toBe(false);
    expect(localStorage.getItem(RESUME_LAST_POSITION_STORAGE_KEY)).toBe('false');

    setResumeLastPosition(true);
    expect(getResumeLastPosition()).toBe(true);
    expect(localStorage.getItem(RESUME_LAST_POSITION_STORAGE_KEY)).toBe('true');
  });

  it('getMostRecentPositionCheckpoint returns null for empty or non-position checkpoints', () => {
    expect(getMostRecentPositionCheckpoint([])).toBeNull();

    const noteOnly: Checkpoint[] = [
      {
        id: 'cp_note_1',
        file: '01.01.lesson.md',
        verticalPosition: 200,
        type: 'note',
        date: '2026-10-16T12:00:00Z'
      }
    ];
    expect(getMostRecentPositionCheckpoint(noteOnly)).toBeNull();
  });

  it('getMostRecentPositionCheckpoint finds the newest position checkpoint by date', () => {
    const list: Checkpoint[] = [
      {
        id: 'pos_1',
        file: '01.01.lesson.md',
        verticalPosition: 100,
        type: 'position',
        date: '2026-10-16T10:00:00Z'
      },
      {
        id: 'note_1',
        file: '01.05.lesson.md',
        verticalPosition: 400,
        type: 'note',
        date: '2026-10-16T15:00:00Z'
      },
      {
        id: 'pos_2',
        file: '01.05.lesson.md',
        verticalPosition: 850,
        type: 'position',
        date: '2026-10-16T14:30:00Z'
      },
      {
        id: 'pos_3',
        file: '01.02.summary.md',
        verticalPosition: 250,
        type: 'position',
        date: '2026-10-16T11:00:00Z'
      }
    ];

    const result = getMostRecentPositionCheckpoint(list);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('pos_2');
    expect(result?.file).toBe('01.05.lesson.md');
    expect(result?.verticalPosition).toBe(850);
  });

  it('resolveLastAccessedCourseRoute resolves lesson route when lesson exists', () => {
    const checkpoints: Checkpoint[] = [
      {
        id: 'pos_1',
        file: '01.05.lesson.md',
        verticalPosition: 1240,
        type: 'position',
        date: '2026-10-16T18:00:00Z'
      }
    ];
    const lessons = [{ id: '01.01' }, { id: '01.05' }];

    const target = resolveLastAccessedCourseRoute('CLM3U', checkpoints, lessons);
    expect(target).not.toBeNull();
    expect(target?.isCourseScope).toBe(false);
    expect(target?.lessonId).toBe('01.05');
    expect(target?.tab).toBe('lesson');
    expect(target?.verticalPosition).toBe(1240);
    expect(target?.href).toBe('/courses/clm3u/01.05');
  });

  it('resolveLastAccessedCourseRoute resolves custom tab on lesson', () => {
    const checkpoints: Checkpoint[] = [
      {
        id: 'pos_1',
        file: '02.03.summary.md',
        verticalPosition: 300,
        type: 'position',
        date: '2026-10-16T18:00:00Z'
      }
    ];
    const lessons = [{ id: '02.03' }];

    const target = resolveLastAccessedCourseRoute('clm3u', checkpoints, lessons);
    expect(target).not.toBeNull();
    expect(target?.lessonId).toBe('02.03');
    expect(target?.tab).toBe('summary');
    expect(target?.href).toBe('/courses/clm3u/02.03/summary');
  });

  it('resolveLastAccessedCourseRoute resolves course practice test', () => {
    const checkpoints: Checkpoint[] = [
      {
        id: 'pos_1',
        file: 'course.test.md',
        verticalPosition: 500,
        type: 'position',
        date: '2026-10-16T19:00:00Z'
      }
    ];
    const lessons = [{ id: '01.01' }];

    const target = resolveLastAccessedCourseRoute('clm3u', checkpoints, lessons);
    expect(target).not.toBeNull();
    expect(target?.isCourseScope).toBe(true);
    expect(target?.tab).toBe('test');
    expect(target?.href).toBe('/courses/clm3u/course/test');
  });

  it('resolveLastAccessedCourseRoute ignores obsolete course summary/lesson checkpoints', () => {
    const checkpoints: Checkpoint[] = [
      {
        id: 'pos_1',
        file: 'course.summary.md',
        verticalPosition: 500,
        type: 'position',
        date: '2026-10-16T19:00:00Z'
      }
    ];
    const lessons = [{ id: '01.01' }];

    const target = resolveLastAccessedCourseRoute('clm3u', checkpoints, lessons);
    expect(target).toBeNull();
  });

  it('resolveLastAccessedCourseRoute returns null if referenced lesson is not in manifest', () => {
    const checkpoints: Checkpoint[] = [
      {
        id: 'pos_1',
        file: '99.99.lesson.md',
        verticalPosition: 100,
        type: 'position',
        date: '2026-10-16T19:00:00Z'
      }
    ];
    const lessons = [{ id: '01.01' }, { id: '01.02' }];

    const target = resolveLastAccessedCourseRoute('clm3u', checkpoints, lessons);
    expect(target).toBeNull();
  });

  it('persists and retrieves getCourseLastLocation', () => {
    expect(getCourseLastLocation('CLN4U')).toBeNull();

    setCourseLastLocation('CLN4U', {
      lessonId: '02.04',
      tab: 'notes',
      isCourseScope: false,
      isUnitScope: false
    });

    const loc = getCourseLastLocation('cln4u');
    expect(loc).not.toBeNull();
    expect(loc?.courseId).toBe('cln4u');
    expect(loc?.lessonId).toBe('02.04');
    expect(loc?.tab).toBe('notes');
    expect(loc?.isCourseScope).toBe(false);
    expect(loc?.pdfPage).toBeNull();
  });

  it('buildCourseResumeUrl constructs correct routes with tabs and pdfPage', () => {
    // Empty / default fallback
    expect(buildCourseResumeUrl('cln4u', null)).toBe('/courses/cln4u');

    // Standard lesson tab
    expect(
      buildCourseResumeUrl('cln4u', {
        courseId: 'cln4u',
        lessonId: '01.02',
        tab: 'summary',
        isCourseScope: false,
        isUnitScope: false,
        updatedAt: Date.now()
      })
    ).toBe('/courses/cln4u/01.02/summary');

    // Default lesson tab omits /lesson suffix
    expect(
      buildCourseResumeUrl('cln4u', {
        courseId: 'cln4u',
        lessonId: '01.02',
        tab: 'lesson',
        isCourseScope: false,
        isUnitScope: false,
        updatedAt: Date.now()
      })
    ).toBe('/courses/cln4u/01.02');

    // Unit scope
    expect(
      buildCourseResumeUrl('cln4u', {
        courseId: 'cln4u',
        lessonId: 'unit_2',
        tab: 'assignments',
        isCourseScope: false,
        isUnitScope: true,
        updatedAt: Date.now()
      })
    ).toBe('/courses/cln4u/unit_2/assignments');

    // Course scope book with exact PDF page
    expect(
      buildCourseResumeUrl('cln4u', {
        courseId: 'cln4u',
        lessonId: 'course',
        tab: 'book',
        isCourseScope: true,
        isUnitScope: false,
        pdfPage: 142,
        updatedAt: Date.now()
      })
    ).toBe('/courses/cln4u/course/book?page=142');
  });

  it('resolveLastAccessedCourseRoute prioritizes explicit last location over checkpoints', () => {
    const checkpoints: Checkpoint[] = [
      {
        id: 'pos_old',
        file: '01.01.lesson.md',
        verticalPosition: 200,
        type: 'position',
        date: '2026-10-16T10:00:00Z'
      }
    ];
    const lessons = [{ id: '01.01' }, { id: '02.05' }];

    // Set explicit location to book page 77
    setCourseLastLocation('CLN4U', {
      lessonId: 'course',
      tab: 'book',
      isCourseScope: true,
      isUnitScope: false,
      pdfPage: 77
    });

    const target = resolveLastAccessedCourseRoute('CLN4U', checkpoints, lessons);
    expect(target).not.toBeNull();
    expect(target?.isCourseScope).toBe(true);
    expect(target?.tab).toBe('book');
    expect(target?.pdfPage).toBe(77);
    expect(target?.href).toBe('/courses/cln4u/course/book?page=77');
  });
});
