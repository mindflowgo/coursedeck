import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PROGRESSION_FLAGS,
  clampFraction,
  currentLessonId,
  emptyStudyState,
  isIndependentTab,
  sharedProgress,
  tabProgress,
  type StudyState
} from './studyStateTypes';
import { CHECKPOINT_COLORS, MAX_LESSON_CHECKPOINTS, getCheckpointColor, isValidCheckpointColor } from './checkpoints';

function state(partial: Partial<StudyState>): StudyState {
  return { ...emptyStudyState(), ...partial };
}

describe('isIndependentTab', () => {
  it('uses the configured flags for the four configurable tabs', () => {
    const flags = { lesson: false, summary: false, cheatsheet: false, test: true };
    expect(isIndependentTab('lesson', flags)).toBe(false);
    expect(isIndependentTab('summary', flags)).toBe(false);
    expect(isIndependentTab('cheatsheet', flags)).toBe(false);
    expect(isIndependentTab('test', flags)).toBe(true);
  });

  it('treats custom and schedule tabs as part of the shared group', () => {
    const flags = { lesson: true, summary: true, cheatsheet: true, test: true };
    expect(isIndependentTab('schedule', flags)).toBe(false);
    expect(isIndependentTab('assignment', flags)).toBe(false);
  });

  it('defaults Practice Test to independent and the rest to shared', () => {
    expect(DEFAULT_PROGRESSION_FLAGS).toEqual({ lesson: false, summary: false, cheatsheet: false, test: true });
  });
});

describe('currentLessonId', () => {
  const order = ['01.01', '01.02', '02.01', '02.02'];

  it('returns null with no completions', () => {
    expect(currentLessonId(state({}), order)).toBeNull();
    expect(currentLessonId(null, order)).toBeNull();
  });

  it('points at the furthest-ordered completed lesson', () => {
    expect(currentLessonId(state({ completions: { '01.02': 'a' } }), order)).toBe('01.02');
    expect(currentLessonId(state({ completions: { '01.02': 'a', '02.01': 'b' } }), order)).toBe('02.01');
  });

  it('never moves backwards when an earlier lesson is completed later', () => {
    const s = state({ completions: { '02.01': 'b', '01.01': 'c' } });
    expect(currentLessonId(s, order)).toBe('02.01');
  });

  it('ignores completions for lessons not in the course', () => {
    expect(currentLessonId(state({ completions: { '99.99': 'a' } }), order)).toBeNull();
  });
});

describe('clampFraction', () => {
  it('clamps and rejects garbage', () => {
    expect(clampFraction(0.5)).toBe(0.5);
    expect(clampFraction(-1)).toBe(0);
    expect(clampFraction(2)).toBe(1);
    expect(clampFraction('0.25')).toBe(0.25);
    expect(clampFraction('nope')).toBe(0);
    expect(clampFraction(Number.NaN)).toBe(0);
  });
});

describe('sharedProgress / tabProgress', () => {
  it('reads the shared and per-tab buckets', () => {
    const s = state({ progress: { '01.02': { shared: 0.5, tabs: { test: 0.2 } } } });
    expect(sharedProgress(s, '01.02')).toBe(0.5);
    expect(tabProgress(s, '01.02', 'test')).toBe(0.2);
  });

  it('returns 0 for unknown scopes and tabs', () => {
    expect(sharedProgress(state({}), '01.02')).toBe(0);
    expect(tabProgress(state({}), '01.02', 'test')).toBe(0);
    expect(sharedProgress(null, '01.02')).toBe(0);
  });
});

describe('checkpoint palette', () => {
  it('has unique, valid colour ids', () => {
    const ids = CHECKPOINT_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isValidCheckpointColor(id)).toBe(true);
    expect(isValidCheckpointColor('mauve')).toBe(false);
  });

  it('falls back to a neutral colour for unknown ids', () => {
    expect(getCheckpointColor('blue').id).toBe('blue');
    expect(getCheckpointColor('unknown').id).toBe('slate');
    expect(getCheckpointColor(null).id).toBe('slate');
  });

  it('caps whole-lesson checkpoints at three', () => {
    expect(MAX_LESSON_CHECKPOINTS).toBe(3);
  });
});
