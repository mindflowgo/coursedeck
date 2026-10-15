import rrulePkg from 'rrule';
import type { SchedulePreferences } from './schedule';

// Handle CJS / ESM interop across Vite SSR, Node, and Bun
const rruleModule: any = (rrulePkg as any)?.default || rrulePkg;
const RRule: typeof import('rrule').RRule = rruleModule.RRule || rruleModule;
import type { CourseManifest } from './parser/courseIngest';
import { ScheduleParser } from './parser/scheduleParser';

export type SessionType =
  | 'study'
  | 'review'
  | 'practice'
  | 'assignment'
  | 'submit'
  | 'catchup';

export interface LessonEffort {
  lessonId: string;
  title: string;
  type: 'lesson' | 'assignment';
  wordCount: number;
  summaryDensity: 'low' | 'medium' | 'high';
  excerpt: string;
}

export interface PlannedSession {
  /** Deterministic unique session key: `${date}:${lessonId}:${type}` (or indexed) */
  sessionKey: string;
  date: string;          // YYYY-MM-DD
  dayLabel: string;      // Mon, Tue...
  weekNumber: number;
  type: SessionType;
  lessonId: string;      // e.g. "01.02", "01.05_assign1", or "catchup"
  section?: string;      // e.g. "summary", "test", "draft", "revise"
  title: string;         // Default title, can be enriched by LLM
  description?: string;  // Detailed retrieval task or focus
  durationMin: number;   // Minutes
}

export interface ScheduleSkeleton {
  title: string;
  summaryLine: string;
  markdown: string;
  sessions: PlannedSession[];
  overflowWarning?: string;
}

export interface SessionEnrichmentPatch {
  sessionKey: string;
  title?: string;
  description?: string;
}

const RRULE_WEEKDAY_MAP = [
  RRule.SU, // 0
  RRule.MO, // 1
  RRule.TU, // 2
  RRule.WE, // 3
  RRule.TH, // 4
  RRule.FR, // 5
  RRule.SA  // 6
];

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Builds an array of available study dates (YYYY-MM-DD) matching user study days
 * and strictly omitting any date in user-defined blackout ranges.
 *
 * NOTE: Anchored at noon UTC to prevent DST shifts from shifting calendar dates.
 * Uses a Set-based post-filter to guarantee blackout exclusion without timezone pitfalls.
 */
export function generateStudyCalendarDays(
  prefs: SchedulePreferences,
  totalDaysNeeded: number
): string[] {
  if (totalDaysNeeded <= 0) return [];
  if (!prefs.studyDays || prefs.studyDays.length === 0) return [];

  const [startYear, startMonth, startDay] = prefs.startDate.split('-').map(Number);
  const dtstart = new Date(Date.UTC(startYear, startMonth - 1, startDay, 12, 0, 0));

  // Build the Set of blacklisted ISO dates
  const blackoutSet = new Set<string>();
  for (const range of prefs.blackoutDates || []) {
    if (!range.startDate || !range.endDate) continue;
    const [by, bm, bd] = range.startDate.split('-').map(Number);
    const [ey, em, ed] = range.endDate.split('-').map(Number);
    const cur = new Date(Date.UTC(by, bm - 1, bd, 12, 0, 0));
    const end = new Date(Date.UTC(ey, em - 1, ed, 12, 0, 0));

    while (cur <= end) {
      blackoutSet.add(cur.toISOString().split('T')[0]);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  const byweekday = prefs.studyDays.map((d) => RRULE_WEEKDAY_MAP[d]).filter(Boolean);
  if (byweekday.length === 0) return [];

  const rule = new RRule({
    freq: RRule.WEEKLY,
    byweekday,
    dtstart
  });

  // Overfetch occurrences to accommodate blackout filtering
  const maxFetch = Math.max(totalDaysNeeded * 4, 365);
  const rawOccurrences = rule.all((_, i) => i < maxFetch);

  const validDates: string[] = [];
  for (const dateObj of rawOccurrences) {
    const iso = dateObj.toISOString().split('T')[0];
    if (!blackoutSet.has(iso)) {
      validDates.push(iso);
      if (validDates.length >= totalDaysNeeded) break;
    }
  }

  return validDates;
}

/**
 * Formats structured planned sessions into Markdown strictly adhering
 * to ScheduleParser and validateScheduleMarkdown syntax.
 */
export function formatScheduleMarkdown(
  courseCodeOrTitle: string,
  sessions: PlannedSession[],
  summaryLineOverride?: string,
  overflowWarning?: string
): string {
  const code = courseCodeOrTitle.trim().toUpperCase();
  const title = code.includes('SCHEDULE') ? code : `${code} Study Schedule`;

  let summaryLine = summaryLineOverride;
  if (!summaryLine && sessions.length > 0) {
    const firstDate = sessions[0].date;
    const lastDate = sessions[sessions.length - 1].date;
    const avgDuration = Math.round(
      sessions.reduce((acc, s) => acc + s.durationMin, 0) / sessions.length
    );
    summaryLine = `*${firstDate} → ${lastDate} · ~${avgDuration}m sessions*`;
  }

  const lines: string[] = [];
  lines.push(`# ${title}`);
  if (summaryLine) {
    lines.push('');
    lines.push(summaryLine);
  }

  if (overflowWarning) {
    lines.push('');
    lines.push(`> [!WARNING] ${overflowWarning}`);
  }

  let currentWeek = -1;
  let currentDate = '';

  for (const s of sessions) {
    if (s.weekNumber !== currentWeek) {
      currentWeek = s.weekNumber;
      lines.push('');
      lines.push(`## Week ${currentWeek}`);
    }

    if (s.date !== currentDate) {
      currentDate = s.date;
      lines.push('');
      lines.push(`### ${s.date} · ${s.dayLabel}`);
    }

    // Capitalize type for display: Study, Review, Practice, Assignment, Submit, Catchup
    const capitalizedType = s.type.charAt(0).toUpperCase() + s.type.slice(1);
    const ref = s.section ? `${s.lessonId}/${s.section}` : s.lessonId;
    const dur = s.durationMin ? ` (${s.durationMin}m)` : '';

    lines.push(`- [ ] **${capitalizedType}** ${ref} — ${s.title}${dur}`);
    if (s.description && s.description.trim()) {
      lines.push(`  ${s.description.trim()}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Deterministically generates a schedule skeleton for a course and user preferences.
 */
export function buildScheduleSkeleton(
  course: CourseManifest,
  prefs: SchedulePreferences,
  efforts: LessonEffort[] = []
): ScheduleSkeleton {
  const effortMap = new Map(efforts.map((e) => [e.lessonId, e]));

  // 1. Compile required sessions list
  type BaseSession = Omit<PlannedSession, 'date' | 'dayLabel' | 'weekNumber' | 'sessionKey'>;
  const plannedSessions: BaseSession[] = [];

  const allLessons = course.units.flatMap((u) => u.lessons);

  for (let uIdx = 0; uIdx < course.units.length; uIdx++) {
    const unit = course.units[uIdx];

    for (const lesson of unit.lessons) {
      const effort = effortMap.get(lesson.id);
      const isHighDensity = effort?.summaryDensity === 'high' || (effort?.wordCount || 0) > 3000;

      if (lesson.type === 'lesson') {
        if (isHighDensity && prefs.sessionLengthMin >= 60) {
          // Split conceptually dense lessons into two study sessions
          plannedSessions.push({
            type: 'study',
            lessonId: lesson.id,
            title: `${lesson.title} (Part 1)`,
            durationMin: Math.round(prefs.sessionLengthMin * 0.75)
          });
          plannedSessions.push({
            type: 'study',
            lessonId: lesson.id,
            title: `${lesson.title} (Part 2)`,
            durationMin: Math.round(prefs.sessionLengthMin * 0.75)
          });
        } else {
          plannedSessions.push({
            type: 'study',
            lessonId: lesson.id,
            title: lesson.title,
            durationMin: prefs.sessionLengthMin
          });
        }

        // Add spaced review if reviews are enabled
        if (prefs.includeReviews) {
          const revDuration =
            prefs.reviewIntensity === 'light'
              ? Math.max(15, Math.round(prefs.sessionLengthMin * 0.25))
              : prefs.reviewIntensity === 'heavy'
                ? Math.max(30, Math.round(prefs.sessionLengthMin * 0.45))
                : Math.max(20, Math.round(prefs.sessionLengthMin * 0.35));

          plannedSessions.push({
            type: 'review',
            lessonId: lesson.id,
            section: 'summary',
            title: `${lesson.title} — Active Recall`,
            durationMin: revDuration
          });
        }
      } else if (lesson.type === 'assignment') {
        // Assignment backward planning: research -> draft -> submit
        plannedSessions.push({
          type: 'assignment',
          lessonId: lesson.id,
          section: 'research',
          title: `${lesson.title} — Research & Planning`,
          durationMin: prefs.sessionLengthMin
        });
        plannedSessions.push({
          type: 'assignment',
          lessonId: lesson.id,
          section: 'draft',
          title: `${lesson.title} — Drafting & Refinement`,
          durationMin: prefs.sessionLengthMin
        });
        plannedSessions.push({
          type: 'submit',
          lessonId: lesson.id,
          title: `${lesson.title} Due`,
          durationMin: 30
        });
      }

      // Interleave catch-up buffer session every ~6 sessions if enabled
      if (prefs.includeCatchupDays && plannedSessions.length > 0 && plannedSessions.length % 6 === 0) {
        plannedSessions.push({
          type: 'catchup',
          lessonId: 'catchup',
          title: 'Weekly Catch-up Buffer',
          description: 'Buffer session for reviewing difficult concepts or absorbing unexpected schedule delays.',
          durationMin: prefs.sessionLengthMin
        });
      }
    }
  }

  // 2. Capacity calculation & Study dates generation
  const sessionsPerDay = Math.max(1, prefs.sessionsPerDay || 1);
  const totalDaysNeeded = Math.ceil(plannedSessions.length / sessionsPerDay);
  const studyDates = generateStudyCalendarDays(prefs, totalDaysNeeded);

  let overflowWarning: string | undefined;
  if (prefs.paceMode === 'target' && prefs.targetEndDate && studyDates.length > 0) {
    const lastDate = studyDates[studyDates.length - 1];
    if (lastDate > prefs.targetEndDate) {
      overflowWarning = `Target date ${prefs.targetEndDate} exceeded: ${plannedSessions.length} sessions require scheduling through ${lastDate} at ${sessionsPerDay} session(s)/day.`;
    }
  }

  // 3. Assign calendar slots to sessions
  const [startYear, startMonth, startDay] = prefs.startDate.split('-').map(Number);
  const startEpoch = Date.UTC(startYear, startMonth - 1, startDay);

  const finalizedSessions: PlannedSession[] = [];
  let sessionIndex = 0;

  for (let dayIdx = 0; dayIdx < studyDates.length && sessionIndex < plannedSessions.length; dayIdx++) {
    const dateStr = studyDates[dayIdx];
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const dayLabel = WEEKDAY_NAMES[dateObj.getUTCDay()];
    const daysSinceStart = Math.floor((dateObj.getTime() - startEpoch) / (86400 * 1000));
    const weekNumber = Math.max(1, Math.floor(daysSinceStart / 7) + 1);

    for (let slot = 0; slot < sessionsPerDay && sessionIndex < plannedSessions.length; slot++) {
      const base = plannedSessions[sessionIndex++];
      const sessionKey = `${dateStr}:${base.lessonId}:${base.type}${base.section ? `:${base.section}` : ''}`;

      finalizedSessions.push({
        ...base,
        sessionKey,
        date: dateStr,
        dayLabel,
        weekNumber
      });
    }
  }

  const daysLabel = [...prefs.studyDays].sort().map((d) => WEEKDAY_NAMES[d]).join('/');
  const firstDate = finalizedSessions[0]?.date || prefs.startDate;
  const lastDate = finalizedSessions[finalizedSessions.length - 1]?.date || prefs.startDate;
  const summaryLine = `*${firstDate} → ${lastDate} · ${daysLabel} · ~${prefs.sessionLengthMin}m sessions*`;

  const markdown = formatScheduleMarkdown(
    course.id,
    finalizedSessions,
    summaryLine,
    overflowWarning
  );

  return {
    title: `${course.id.toUpperCase()} Study Schedule`,
    summaryLine,
    markdown,
    sessions: finalizedSessions,
    overflowWarning
  };
}

/**
 * Merges LLM enrichment patches into the deterministic skeleton.
 */
export function applyEnrichmentPatches(
  skeleton: ScheduleSkeleton,
  patches: SessionEnrichmentPatch[]
): string {
  const patchMap = new Map<string, SessionEnrichmentPatch>();
  for (const p of patches) {
    if (p.sessionKey) {
      patchMap.set(p.sessionKey, p);
    }
  }

  const enrichedSessions: PlannedSession[] = skeleton.sessions.map((session) => {
    const patch = patchMap.get(session.sessionKey);
    if (!patch) return session;

    return {
      ...session,
      title: patch.title && patch.title.trim() ? patch.title.trim() : session.title,
      description: patch.description && patch.description.trim() ? patch.description.trim() : session.description
    };
  });

  return formatScheduleMarkdown(
    skeleton.title,
    enrichedSessions,
    skeleton.summaryLine,
    skeleton.overflowWarning
  );
}

/**
 * Structural equivalence gate verifying that an enriched markdown document
 * preserves 100% of the skeleton's dates, activity types, and lesson references.
 */
export function verifyStructuralEquivalence(
  originalSkeleton: ScheduleSkeleton,
  enrichedMarkdown: string
): boolean {
  let enrichedParsed;
  try {
    enrichedParsed = ScheduleParser.parseMarkdown(enrichedMarkdown);
  } catch {
    return false;
  }

  // Event count must match exactly
  if (enrichedParsed.events.length !== originalSkeleton.sessions.length) {
    return false;
  }

  // Date, type, and lessonId must match in 1:1 order
  for (let i = 0; i < enrichedParsed.events.length; i++) {
    const enriched = enrichedParsed.events[i];
    const original = originalSkeleton.sessions[i];

    if (
      enriched.date !== original.date ||
      enriched.type.toLowerCase() !== original.type.toLowerCase() ||
      enriched.lessonId !== original.lessonId
    ) {
      return false;
    }
  }

  return true;
}
