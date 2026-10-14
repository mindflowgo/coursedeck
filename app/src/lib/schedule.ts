/** Scheduling preference questionnaire model + prompt composition. */

export type ReviewIntensity = 'light' | 'standard' | 'heavy';
export type PaceMode = 'steady' | 'target';

export interface SchedulePreferences {
  /** YYYY-MM-DD — first possible study day. */
  startDate: string;
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
  /** Free-form: away days, constraints, work/school conflicts. */
  notes?: string;
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
    reviewIntensity: 'standard'
  };
}

export function validateSchedulePreferences(p: SchedulePreferences): string | null {
  if (!p.startDate) return 'Please choose a start date.';
  if (p.studyDays.length === 0) return 'Please pick at least one study day.';
  if (p.paceMode === 'target') {
    if (!p.targetEndDate) return 'Please choose a target end date, or switch to a steady pace.';
    if (p.targetEndDate <= p.startDate) return 'The target end date must be after the start date.';
  }
  return null;
}

/**
 * Appends the authoritative STUDENT PREFERENCES block the course_schedule
 * prompt template expects. The combined string becomes the system prompt and
 * is persisted in the schedule's frontmatter for re-generation.
 */
export function buildSchedulePrompt(template: string, prefs: SchedulePreferences): string {

  const days = [...prefs.studyDays].sort().map((d) => WEEKDAY_LABELS[d]).join('/');
  const lines: string[] = [
    '',
    '## STUDENT PREFERENCES (authoritative):',
    `- Start date: ${prefs.startDate}`,
    `- Study days: ${days}`,
    `- Session length: ${prefs.sessionLengthMin} minutes`,
    `- Max sessions per study day: ${prefs.sessionsPerDay}`
  ];
  if (prefs.paceMode === 'target' && prefs.targetEndDate) {
    lines.push(`- Target end date: ${prefs.targetEndDate} (finish before it, with buffer)`);
    try {
      const start = new Date(`${prefs.startDate}T00:00:00`);
      const end = new Date(`${prefs.targetEndDate}T00:00:00`);
      let studySlots = 0;
      const cur = new Date(start);
      while (cur <= end) {
        if (prefs.studyDays.includes(cur.getDay())) {
          studySlots += prefs.sessionsPerDay;
        }
        cur.setDate(cur.getDate() + 1);
      }
      lines.push(
        `- Schedule capacity: ~${studySlots} total session slots available across preferred study days. Adjust lesson grouping and review frequency so all course inventory is scheduled comfortably within this window.`
      );
    } catch {}
  } else {
    lines.push('- Pace: no fixed deadline — choose a steady, sustainable pace');
  }
  if (!prefs.includeReviews) {
    lines.push(
      '- Review sessions: OFF — do NOT schedule Review or Practice entries; use study sessions and assignment phases only'
    );
  } else {
    const intensity =
      prefs.reviewIntensity === 'light'
        ? 'light — short recall checks only'
        : prefs.reviewIntensity === 'heavy'
          ? 'heavy — frequent reviews plus weekly unit recaps'
          : 'standard — a review 2–3 days after each lesson';
    lines.push(`- Review intensity: ${intensity}`);
  }
  if (prefs.notes?.trim()) {
    lines.push(`- Additional notes from the student: ${prefs.notes.trim()}`);
  }
  return `${template.trimEnd()}\n\n${lines.join('\n')}\n`;
}

const STORAGE_KEY = 'ilc_schedule_prefs';

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
    // Migration for prefs stored before includeReviews existed (default: on).
    if (typeof parsed.includeReviews !== 'boolean') parsed.includeReviews = true;
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
