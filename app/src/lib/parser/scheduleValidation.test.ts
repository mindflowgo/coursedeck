import { describe, it, expect } from 'bun:test';
import { validateScheduleMarkdown } from './scheduleValidation';
import type { CourseManifest } from './courseIngest';

const lesson = (id: string, title: string, type: 'lesson' | 'assignment' = 'lesson') => ({
  id,
  code: id,
  title,
  unitNumber: 1,
  lessonNumber: 1,
  type,
  hasFull: true,
  hasSummary: false,
  hasCheatsheet: false,
  hasTest: false
});

const manifest: CourseManifest = {
  id: 'tst01',
  title: 'Test Course',
  grade: '11',
  level: 'U',
  description: '',
  updatedAt: '2026-10-13',
  units: [
    {
      number: 1,
      title: 'Unit 1',
      lessons: [
        lesson('01.01', 'Intro'),
        lesson('01.02', 'Second'),
        lesson('01.03', 'Third'),
        lesson('01.06_assign1', 'Assignment 1', 'assignment')
      ]
    }
  ]
};

const GOOD = `# Test Study Schedule

*plan*

### 2026-10-13 · Tue
- [ ] **Study** 01.01 — Intro (60m)
- [ ] **Study** 01.02 — Second (60m)

### 2026-10-15 · Thu
- [ ] **Study** 01.03 — Third (60m)
- [ ] **Submit** 01.06_assign1 — Assignment 1 due
`;

describe('validateScheduleMarkdown', () => {
  it('accepts a well-formed schedule covering all lessons and assignments', () => {
    const result = validateScheduleMarkdown(GOOD, manifest);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('fails when nothing parses', () => {
    const result = validateScheduleMarkdown('# just a title\n\nno entries\n', manifest);
    expect(result.ok).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('warns about references to unknown lesson ids', () => {
    const md = GOOD.replace('01.03 — Third', '99.99 — Mystery');
    const result = validateScheduleMarkdown(md, manifest);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('99.99'))).toBe(true);
  });

  it('warns about content lessons that are never scheduled', () => {
    const md = GOOD.replace('- [ ] **Study** 01.03 — Third (60m)\n', '');
    const result = validateScheduleMarkdown(md, manifest);
    expect(result.warnings.some((w) => w.includes('01.03'))).toBe(true);
  });

  it('warns about assignments without a Submit entry', () => {
    const md = GOOD.replace('- [ ] **Submit** 01.06_assign1 — Assignment 1 due\n', '');
    const result = validateScheduleMarkdown(md, manifest);
    expect(result.warnings.some((w) => w.includes('01.06_assign1'))).toBe(true);
  });

  it('warns about invalid or out-of-order dates', () => {
    const md = GOOD.replace('### 2026-10-15 · Thu', '### 2026-10-08 · Thu');
    const result = validateScheduleMarkdown(md, manifest);
    expect(result.warnings.some((w) => /order/i.test(w))).toBe(true);

    const badDate = GOOD.replace('### 2026-10-15 · Thu', '### 2026-13-45 · Thu');
    const bad = validateScheduleMarkdown(badDate, manifest);
    expect(bad.warnings.some((w) => /invalid date/i.test(w))).toBe(true);
  });

  it('accepts catchup pseudo-lessons without flagging them as unknown', () => {
    const withCatchup = GOOD + '\n### 2026-10-20 · Tue\n- [ ] **Catchup** catchup — Weekly catch-up buffer (60m)\n';
    const result = validateScheduleMarkdown(withCatchup, manifest);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('returns a warning instead of throwing when the manifest is missing', () => {
    const result = validateScheduleMarkdown(GOOD, null);
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBe(1);
  });
});
