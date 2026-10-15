import { describe, it, expect } from 'bun:test';
import { formatScheduleDateLabel, getScheduleEndDateLabel } from './schedule';

describe('formatScheduleDateLabel', () => {
  const ref2026 = new Date('2026-10-15T12:00:00');

  it('formats dates in a different year with the year included', () => {
    expect(formatScheduleDateLabel('2027-12-31', ref2026)).toBe('Dec 31, 2027');
    expect(formatScheduleDateLabel('2025-05-20', ref2026)).toBe('May 20, 2025');
  });

  it('formats dates in the current year without the year', () => {
    expect(formatScheduleDateLabel('2026-12-31', ref2026)).toBe('Dec 31');
    expect(formatScheduleDateLabel('2026-01-05', ref2026)).toBe('Jan 5');
  });

  it('handles invalid dates gracefully', () => {
    expect(formatScheduleDateLabel('invalid-date', ref2026)).toBeNull();
    expect(formatScheduleDateLabel('', ref2026)).toBeNull();
  });
});

describe('getScheduleEndDateLabel', () => {
  const ref2026 = new Date('2026-10-15T12:00:00');

  it('extracts latest date from events and formats it', () => {
    const events = [
      { date: '2027-10-10' },
      { date: '2027-12-31' },
      { date: '2027-11-05' }
    ];
    expect(getScheduleEndDateLabel(events, '', '', ref2026)).toBe('Dec 31, 2027');
  });

  it('omits year if the latest date is in current year', () => {
    const events = [
      { date: '2026-10-10' },
      { date: '2026-12-25' }
    ];
    expect(getScheduleEndDateLabel(events, '', '', ref2026)).toBe('Dec 25');
  });

  it('falls back to summaryLine when events have no dates', () => {
    const summary = '*2027-09-01 → 2027-12-31 · Mon/Wed · ~60m sessions*';
    expect(getScheduleEndDateLabel([], '', summary, ref2026)).toBe('Dec 31, 2027');
  });

  it('falls back to frontmatter targetEndDate when events and summaryLine have no dates', () => {
    const markdown = `---
type: course_schedule
preferences:
  targetEndDate: '2027-12-31'
---
# Study Schedule
`;
    expect(getScheduleEndDateLabel([], markdown, '', ref2026)).toBe('Dec 31, 2027');
  });

  it('returns null when no end date is found', () => {
    expect(getScheduleEndDateLabel([], '', '', ref2026)).toBeNull();
  });
});
