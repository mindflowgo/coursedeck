import { describe, it, expect } from 'bun:test';
import {
  generateStudyCalendarDays,
  buildScheduleSkeleton,
  applyEnrichmentPatches,
  verifyStructuralEquivalence,
  type LessonEffort,
  type SessionEnrichmentPatch
} from './scheduleGenerator';
import { defaultSchedulePreferences, type SchedulePreferences } from './schedule';
import type { CourseManifest } from './parser/courseIngest';
import { ScheduleParser } from './parser/scheduleParser';
import { validateScheduleMarkdown } from './parser/scheduleValidation';

const mockManifest: CourseManifest = {
  id: 'gwl3o',
  title: 'Designing Your Future',
  grade: '11',
  level: 'O',
  description: 'Career studies',
  updatedAt: '2026-10-15',
  units: [
    {
      number: 1,
      title: 'Unit 1: Self-Discovery',
      lessons: [
        {
          id: '01.01',
          code: '01.01',
          title: 'Personal Management Skills',
          unitNumber: 1,
          lessonNumber: 1,
          type: 'lesson',
          hasFull: true,
          hasSummary: true,
          hasCheatsheet: false,
          hasTest: true
        },
        {
          id: '01.02',
          code: '01.02',
          title: 'Learning Styles and Pathways',
          unitNumber: 1,
          lessonNumber: 2,
          type: 'lesson',
          hasFull: true,
          hasSummary: true,
          hasCheatsheet: false,
          hasTest: true
        },
        {
          id: '01.05_assign1',
          code: '01.05_assign1',
          title: 'Unit 1 Culminating Project',
          unitNumber: 1,
          lessonNumber: 5,
          type: 'assignment',
          hasFull: true,
          hasSummary: false,
          hasCheatsheet: false,
          hasTest: false
        }
      ]
    },
    {
      number: 2,
      title: 'Unit 2: Exploration',
      lessons: [
        {
          id: '02.01',
          code: '02.01',
          title: 'Trends in the Workplace',
          unitNumber: 2,
          lessonNumber: 1,
          type: 'lesson',
          hasFull: true,
          hasSummary: true,
          hasCheatsheet: false,
          hasTest: true
        }
      ]
    }
  ]
};

describe('generateStudyCalendarDays', () => {
  it('generates strictly monotonic dates matching preferred study days', () => {
    const prefs: SchedulePreferences = {
      ...defaultSchedulePreferences(),
      startDate: '2026-10-19', // Monday
      studyDays: [1, 3, 5] // Mon, Wed, Fri
    };

    const days = generateStudyCalendarDays(prefs, 6);
    expect(days).toEqual([
      '2026-10-19', // Mon
      '2026-10-21', // Wed
      '2026-10-23', // Fri
      '2026-10-26', // Mon
      '2026-10-28', // Wed
      '2026-10-30'  // Fri
    ]);

    // Check weekday invariant
    for (const d of days) {
      const dt = new Date(`${d}T12:00:00Z`);
      expect(prefs.studyDays).toContain(dt.getUTCDay());
    }
  });

  it('advances to the first valid study day if startDate falls on a non-study day', () => {
    const prefs: SchedulePreferences = {
      ...defaultSchedulePreferences(),
      startDate: '2026-10-18', // Sunday
      studyDays: [1, 3, 5] // Mon, Wed, Fri
    };

    const days = generateStudyCalendarDays(prefs, 3);
    expect(days[0]).toBe('2026-10-19'); // Advances to Monday
  });

  it('strictly excludes dates within single or multi-day blackout ranges', () => {
    const prefs: SchedulePreferences = {
      ...defaultSchedulePreferences(),
      startDate: '2026-10-19', // Mon
      studyDays: [1, 3, 5],
      blackoutDates: [
        { startDate: '2026-10-21', endDate: '2026-10-21', label: 'Dentist' }, // Skips Wed Oct 21
        { startDate: '2026-10-25', endDate: '2026-10-31', label: 'Trip' } // Skips whole next week (Oct 26, 28, 30)
      ]
    };

    const days = generateStudyCalendarDays(prefs, 4);
    expect(days).toEqual([
      '2026-10-19', // Mon
      '2026-10-23', // Fri (Oct 21 skipped)
      '2026-11-02', // Mon (Oct 26, 28, 30 skipped)
      '2026-11-04'  // Wed
    ]);
  });

  it('handles blackout ranges spanning the New Year boundary seamlessly', () => {
    const prefs: SchedulePreferences = {
      ...defaultSchedulePreferences(),
      startDate: '2026-12-21', // Monday
      studyDays: [1, 3, 5],
      blackoutDates: [
        { startDate: '2026-12-23', endDate: '2027-01-03', label: 'Winter Holidays' }
      ]
    };

    const days = generateStudyCalendarDays(prefs, 3);
    expect(days).toEqual([
      '2026-12-21', // Mon before break
      '2027-01-04', // First Mon after break
      '2027-01-06'  // First Wed after break
    ]);
  });

  it('handles single study day per week (e.g. Sunday only)', () => {
    const prefs: SchedulePreferences = {
      ...defaultSchedulePreferences(),
      startDate: '2026-10-18', // Sun
      studyDays: [0] // Sun only
    };

    const days = generateStudyCalendarDays(prefs, 3);
    expect(days).toEqual(['2026-10-18', '2026-10-25', '2026-11-01']);
  });
});

describe('buildScheduleSkeleton', () => {
  it('generates a 100% valid schedule skeleton compliant with validateScheduleMarkdown', () => {
    const prefs: SchedulePreferences = {
      ...defaultSchedulePreferences(),
      startDate: '2026-10-19',
      studyDays: [1, 3, 5],
      includeReviews: true,
      includeCatchupDays: true
    };

    const skeleton = buildScheduleSkeleton(mockManifest, prefs);
    expect(skeleton.markdown).toContain('# GWL3O Study Schedule');
    expect(skeleton.markdown).toContain('## Week 1');
    expect(skeleton.markdown).toContain('### 2026-10-19 · Mon');
    expect(skeleton.sessions.length).toBeGreaterThan(0);

    // Validate with parser and validator
    const parsed = ScheduleParser.parseMarkdown(skeleton.markdown);
    expect(parsed.events.length).toBe(skeleton.sessions.length);

    const validation = validateScheduleMarkdown(skeleton.markdown, mockManifest);
    expect(validation.ok).toBe(true);
    expect(validation.warnings).toEqual([]);
  });

  it('splits high density lessons when effort signals indicate high density', () => {
    const prefs: SchedulePreferences = {
      ...defaultSchedulePreferences(),
      startDate: '2026-10-19',
      studyDays: [1, 3, 5],
      sessionLengthMin: 60
    };

    const efforts: LessonEffort[] = [
      {
        lessonId: '01.01',
        title: 'Personal Management Skills',
        type: 'lesson',
        wordCount: 3500,
        summaryDensity: 'high',
        excerpt: 'Decision models and goal setting'
      }
    ];

    const skeleton = buildScheduleSkeleton(mockManifest, prefs, efforts);
    const lesson1Sessions = skeleton.sessions.filter(
      (s) => s.lessonId === '01.01' && s.type === 'study'
    );
    expect(lesson1Sessions.length).toBe(2);
    expect(lesson1Sessions[0].title).toContain('Part 1');
    expect(lesson1Sessions[1].title).toContain('Part 2');
  });

  it('omits review entries when includeReviews is false', () => {
    const prefs: SchedulePreferences = {
      ...defaultSchedulePreferences(),
      includeReviews: false
    };

    const skeleton = buildScheduleSkeleton(mockManifest, prefs);
    const reviews = skeleton.sessions.filter((s) => s.type === 'review');
    expect(reviews.length).toBe(0);
  });

  it('emits overflow warning when targetEndDate cannot fit all required sessions', () => {
    const prefs: SchedulePreferences = {
      ...defaultSchedulePreferences(),
      startDate: '2026-10-19',
      studyDays: [1], // Only 1 day per week (Mon)
      sessionsPerDay: 1,
      paceMode: 'target',
      targetEndDate: '2026-10-26' // Only 2 study days available, but manifest requires ~8 sessions
    };

    const skeleton = buildScheduleSkeleton(mockManifest, prefs);
    expect(skeleton.overflowWarning).toBeDefined();
    expect(skeleton.overflowWarning).toContain('Target date 2026-10-26 exceeded');
    expect(skeleton.markdown).toContain('> [!WARNING]');

    // Invariant 1 still holds: all lessons were scheduled
    const validation = validateScheduleMarkdown(skeleton.markdown, mockManifest);
    expect(validation.ok).toBe(true);
    const uncovered = validation.warnings.filter((w) => w.includes('never scheduled'));
    expect(uncovered.length).toBe(0);
  });
});

describe('applyEnrichmentPatches & verifyStructuralEquivalence', () => {
  it('splices title and description patches into the skeleton while keeping dates intact', () => {
    const prefs = defaultSchedulePreferences();
    const skeleton = buildScheduleSkeleton(mockManifest, prefs);

    const firstSession = skeleton.sessions[0];
    const patches: SessionEnrichmentPatch[] = [
      {
        sessionKey: firstSession.sessionKey,
        title: 'Mastering SMART Goal Frameworks',
        description: 'Cover /summary and recite the 5 criteria from memory.'
      }
    ];

    const enrichedMd = applyEnrichmentPatches(skeleton, patches);
    expect(enrichedMd).toContain('Mastering SMART Goal Frameworks');
    expect(enrichedMd).toContain('Cover /summary and recite the 5 criteria from memory.');

    // Structural equivalence must pass
    const isEquivalent = verifyStructuralEquivalence(skeleton, enrichedMd);
    expect(isEquivalent).toBe(true);

    const parsed = ScheduleParser.parseMarkdown(enrichedMd);
    expect(parsed.events[0].title).toBe('Mastering SMART Goal Frameworks');
    expect(parsed.events[0].description).toBe(
      'Cover /summary and recite the 5 criteria from memory.'
    );
  });

  it('rejects structurally corrupted markdown', () => {
    const prefs = defaultSchedulePreferences();
    const skeleton = buildScheduleSkeleton(mockManifest, prefs);

    // Corrupt markdown by dropping a date header
    const corruptedMd = skeleton.markdown.replace(/### \d{4}-\d{2}-\d{2} · \w{3}/, '');
    const isEquivalent = verifyStructuralEquivalence(skeleton, corruptedMd);
    expect(isEquivalent).toBe(false);
  });
});
