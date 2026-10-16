import { describe, it, expect } from 'bun:test';
import {
  formatScheduleDateLabel,
  getScheduleEndDateLabel,
  stripStudentPreferencesBlock,
  buildSchedulePrompt,
  defaultSchedulePreferences
} from './schedule';

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

describe('stripStudentPreferencesBlock', () => {
  it('strips student preferences block when at the end of the text', () => {
    const text = `# Custom Schedule Prompt
Generate an active-recall study schedule.

## STUDENT PREFERENCES (authoritative):
- Start date: 2026-10-01
- Study days: Mon/Wed/Fri
- Session length: 60 minutes
`;
    const stripped = stripStudentPreferencesBlock(text);
    expect(stripped).toBe(`# Custom Schedule Prompt
Generate an active-recall study schedule.`);
  });

  it('strips student preferences block when followed by another heading', () => {
    const text = `# Custom Schedule Prompt
## STUDENT PREFERENCES (authoritative):
- Start date: 2026-10-01
- Study days: Mon/Wed/Fri

## OUTPUT INSTRUCTIONS
Please return markdown.`;
    const stripped = stripStudentPreferencesBlock(text);
    expect(stripped).toBe(`# Custom Schedule Prompt

## OUTPUT INSTRUCTIONS
Please return markdown.`);
  });

  it('handles null, undefined, or empty string gracefully', () => {
    expect(stripStudentPreferencesBlock(null)).toBe('');
    expect(stripStudentPreferencesBlock(undefined)).toBe('');
    expect(stripStudentPreferencesBlock('')).toBe('');
  });
});

describe('buildSchedulePrompt', () => {
  it('clears previous student preferences block before appending new ones', () => {
    const templateWithOldPrefs = `# Course Schedule Generator

## STUDENT PREFERENCES (authoritative):
- Start date: 2025-01-01
- Study days: Mon
- Session length: 30 minutes
- Max sessions per study day: 1
- Pace: no fixed deadline
- Review intensity: standard
- Additional notes from the student: old notes
`;

    const newPrefs = defaultSchedulePreferences(new Date('2026-10-15T12:00:00'));
    newPrefs.startDate = '2026-11-01';
    newPrefs.studyDays = [2, 4]; // Tue/Thu
    newPrefs.sessionLengthMin = 90;
    newPrefs.sessionsPerDay = 2;
    newPrefs.notes = 'new focus notes';

    const result = buildSchedulePrompt(templateWithOldPrefs, newPrefs);

    // Should only have ONE ## STUDENT PREFERENCES (authoritative) block
    const matches = result.match(/##\s*STUDENT PREFERENCES\s*\(authoritative\)/gi);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(1);

    // Old values should be gone
    expect(result).not.toContain('2025-01-01');
    expect(result).not.toContain('old notes');

    // New values should be present
    expect(result).toContain('- Start date: 2026-11-01');
    expect(result).toContain('- Session length: 90 minutes; 2 sessions/day');
    expect(result).toContain('- Additional notes: new focus notes');
  });

  it('formats daily session times when dayTimes are provided', () => {
    const prefs = defaultSchedulePreferences(new Date('2026-10-15T12:00:00'));
    prefs.studyDays = [1, 3];
    prefs.sessionsPerDay = 2;
    prefs.dayTimes = {
      1: ['09:00', '14:00'],
      3: ['10:00', '15:30']
    };

    const result = buildSchedulePrompt('# Template', prefs);
    expect(result).toContain('- Daily session times: Mon: 09:00, 14:00; Wed: 10:00, 15:30');
  });

  it('formats student preferences in the concise modern format with end date and total calendar days', () => {
    const prefs = defaultSchedulePreferences(new Date('2026-10-15T12:00:00'));
    prefs.startDate = '2026-10-15';
    prefs.calculatedEndDate = '2026-11-08';
    prefs.sessionLengthMin = 90;
    prefs.sessionsPerDay = 1;
    prefs.studyDays = [1, 3, 5];
    prefs.dayTimes = {
      1: ['09:00'],
      3: ['09:00'],
      5: ['09:00']
    };

    const result = buildSchedulePrompt('# Template', prefs);
    expect(result).toContain('- Start date: 2026-10-15; end date: 2026-11-08');
    expect(result).toContain('- Session length: 90 minutes; 1 session/day');
    expect(result).toContain('- Daily session times: Mon: 09:00; Wed: 09:00; Fri: 09:00');
    expect(result).toContain('- Total calendar days: 25');
  });
});


