import { parseFrontmatter } from './parser/frontmatter';

/** Scheduling preference questionnaire model + prompt composition. */

export type ReviewIntensity = 'light' | 'standard' | 'heavy';
export type PaceMode = 'steady' | 'target';

export interface BlackoutDateRange {
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate: string;
  /** Optional user label, e.g. "Winter Break", "March Break" */
  label?: string;
}

export interface SchedulePreferences {
  /** YYYY-MM-DD — first possible study day. */
  startDate: string;
  /** YYYY-MM-DD — calculated completion date. */
  calculatedEndDate?: string;
  /** Total calendar days between start and end date (inclusive). */
  totalCalendarDays?: number;
  /** JS getDay() values, 0=Sun … 6=Sat. */
  studyDays: number[];
  sessionLengthMin: number;
  sessionsPerDay: number;
  paceMode: PaceMode;
  /** Required when paceMode === 'target'. */
  targetEndDate?: string;
  /** When false, the prompt must not schedule Review or Practice entries at all. */
  includeReviews: boolean;
  reviewIntensity: ReviewIntensity;
  /** Date ranges excluded from scheduling (e.g. holidays, vacations). */
  blackoutDates: BlackoutDateRange[];
  /** Allocate ~1 catch-up buffer session per week (~15% of sessions). */
  includeCatchupDays: boolean;
  /** Free-form: away days, constraints, work/school conflicts. */
  notes?: string;
  /** Optional times of day (HH:MM) for each session on each study day. Key is getDay() 0..6. */
  dayTimes?: Record<number, string[]>;
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function defaultSchedulePreferences(today = new Date()): SchedulePreferences {
  const iso = today.toISOString().split('T')[0];
  return {
    startDate: iso,
    studyDays: [1, 3, 5],
    sessionLengthMin: 60,
    sessionsPerDay: 1,
    paceMode: 'steady',
    includeReviews: true,
    reviewIntensity: 'standard',
    blackoutDates: [],
    includeCatchupDays: true,
    dayTimes: {
      1: ['09:00'],
      3: ['09:00'],
      5: ['09:00']
    }
  };
}

export function validateSchedulePreferences(p: SchedulePreferences): string | null {
  if (!p.startDate) return 'Please choose a start date.';
  if (p.studyDays.length === 0) return 'Please pick at least one study day.';
  if (p.paceMode === 'target') {
    if (!p.targetEndDate) return 'Please choose an end date, or switch to End of Course.';
    if (p.targetEndDate <= p.startDate) return 'The end date must be after the start date.';
  }
  if (Array.isArray(p.blackoutDates)) {
    for (const b of p.blackoutDates) {
      if (b.startDate && b.endDate && b.endDate < b.startDate) {
        return `Invalid blackout range: "${b.label || 'Exclusion'}" end date must be on or after start date.`;
      }
    }
  }
  return null;
}

/**
 * Strips any previous `## STUDENT PREFERENCES (authoritative)` block from a prompt template string.
 */
export function stripStudentPreferencesBlock(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/(?:\r?\n)*##\s*STUDENT PREFERENCES\s*\(authoritative\)[\s\S]*?(?=(?:\r?\n)##\s+(?!STUDENT PREFERENCES)|$)/gi, (match, offset, full) => {
      const rest = full.slice(offset + match.length);
      return rest.trim() && offset > 0 ? '\n' : '';
    })
    .trimEnd();
}

/**
 * Appends the authoritative STUDENT PREFERENCES block the course_schedule
 * prompt template expects. Clears any previous preferences block first to prevent duplicates.
 */
export function buildSchedulePrompt(template: string, prefs: SchedulePreferences): string {
  const cleanTemplate = stripStudentPreferencesBlock(template);

  const endDate = prefs.calculatedEndDate || prefs.targetEndDate;
  let totalDays = prefs.totalCalendarDays;
  if (totalDays === undefined && prefs.startDate && endDate) {
    try {
      const start = new Date(`${prefs.startDate}T00:00:00`);
      const end = new Date(`${endDate}T00:00:00`);
      const diffMs = end.getTime() - start.getTime();
      if (!isNaN(diffMs)) {
        totalDays = Math.max(1, Math.round(diffMs / (86400 * 1000)) + 1);
      }
    } catch {}
  }

  // 1. Start date & End date
  const dateLine = endDate
    ? `- Start date: ${prefs.startDate}; end date: ${endDate}`
    : `- Start date: ${prefs.startDate}`;

  // 2. Session length & sessions/day
  const perDayLabel = `${prefs.sessionsPerDay} session${prefs.sessionsPerDay > 1 ? 's' : ''}/day`;
  const sessionLine = `- Session length: ${prefs.sessionLengthMin} minutes; ${perDayLabel}`;

  // 3. Daily session times
  let timesLine: string;
  if (prefs.dayTimes && Object.keys(prefs.dayTimes).length > 0) {
    const formattedTimes: string[] = [];
    for (const d of [...prefs.studyDays].sort()) {
      const times = prefs.dayTimes[d]?.slice(0, prefs.sessionsPerDay).filter(Boolean);
      if (times && times.length > 0) {
        formattedTimes.push(`${WEEKDAY_LABELS[d]}: ${times.join(', ')}`);
      } else {
        formattedTimes.push(WEEKDAY_LABELS[d]);
      }
    }
    timesLine = `- Daily session times: ${formattedTimes.join('; ')}`;
  } else {
    const days = [...prefs.studyDays].sort().map((d) => WEEKDAY_LABELS[d]).join('/');
    timesLine = `- Daily session times: ${days}`;
  }

  const lines: string[] = [
    '',
    '## STUDENT PREFERENCES (authoritative):',
    dateLine,
    sessionLine,
    timesLine
  ];

  // 4. Total calendar days
  if (totalDays !== undefined && totalDays > 0) {
    lines.push(`- Total calendar days: ${totalDays}`);
  }

  if (!prefs.includeReviews) {
    lines.push('- Review sessions: OFF');
  }

  if (prefs.notes?.trim()) {
    lines.push(`- Additional notes: ${prefs.notes.trim()}`);
  }

  return `${cleanTemplate}\n\n${lines.join('\n')}\n`;
}

const STORAGE_KEY = 'app_schedule_prefs';

/** Tailwind classes for a schedule activity-type badge. */
const TYPE_CLASSES: Record<string, string> = {
  study: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
  review: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900',
  practice: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900',
  assignment: 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-900',
  submit: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
  exam: 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900'
};

export function scheduleTypeClasses(type: string): string {
  return (
    TYPE_CLASSES[type] ||
    'bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-700'
  );
}

/** Last-used preferences, so re-opening the questionnaire pre-fills sensibly. */
export function loadStoredSchedulePreferences(): SchedulePreferences | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SchedulePreferences;
    if (!parsed.startDate || !Array.isArray(parsed.studyDays)) return null;
    parsed.studyDays = parsed.studyDays.map((d) => Number(d)).filter((n) => !isNaN(n));
    // Migration for prefs stored before includeReviews existed (default: on).
    if (typeof parsed.includeReviews !== 'boolean') parsed.includeReviews = true;
    if (!Array.isArray(parsed.blackoutDates)) parsed.blackoutDates = [];
    if (typeof parsed.includeCatchupDays !== 'boolean') parsed.includeCatchupDays = true;
    if (!parsed.dayTimes || typeof parsed.dayTimes !== 'object') {
      parsed.dayTimes = {};
    }
    return parsed;
  } catch {
    return null;
  }
}

export function storeSchedulePreferences(prefs: SchedulePreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
}

/**
 * Formats a schedule's ISO date string (YYYY-MM-DD) for display:
 * e.g. "Dec 31, 2027" (year included when not in current year)
 * or "Dec 31" (year omitted when in current year).
 */
export function formatScheduleDateLabel(dateIso: string, referenceDate = new Date()): string | null {
  try {
    const trimmed = dateIso.trim();
    const date = new Date(`${trimmed}T00:00:00`);
    if (isNaN(date.getTime())) return null;
    const currentYear = referenceDate.getFullYear();
    const eventYear = date.getFullYear();

    if (eventYear === currentYear) {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  } catch {
    return null;
  }
}

/**
 * Extracts and formats the end-date label for a course schedule:
 * e.g. "Dec 31, 2027" or "Dec 31" (if in current year).
 * Checks dated events first, then summary line, then frontmatter preferences.targetEndDate.
 */
export function getScheduleEndDateLabel(
  events: Array<{ date?: string }>,
  markdown?: string,
  summaryLine?: string,
  referenceDate = new Date()
): string | null {
  let latest = '';
  for (const e of events) {
    if (e.date && (!latest || e.date > latest)) {
      latest = e.date;
    }
  }

  if (!latest && summaryLine) {
    const match = summaryLine.match(/→\s*(\d{4}-\d{2}-\d{2})/);
    if (match) latest = match[1];
  }

  if (!latest && markdown) {
    try {
      const { frontmatter } = parseFrontmatter(markdown);
      if (frontmatter?.preferences?.targetEndDate) {
        latest = frontmatter.preferences.targetEndDate;
      }
    } catch {}

    if (!latest) {
      const match = markdown.match(/targetEndDate:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?/);
      if (match) latest = match[1];
    }
  }

  if (!latest) return null;
  return formatScheduleDateLabel(latest, referenceDate);
}

