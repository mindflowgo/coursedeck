/**
 * Shared shapes for per-course study state: reading progress (synced and
 * per-tab), practice-test completions, and checkpoints.
 *
 * Persisted server-side as `<dataDir>/lessonProgress/<courseId>.json` (see
 * server/studyState.ts). Everything here is pure and import-safe on both the
 * server (sidecar) and the client so validation cannot drift.
 */

export const STUDY_STATE_VERSION = 1;

/** Progress fractions below this are treated as "at the top" and dropped. */
export const PROGRESS_EPSILON = 0.01;

/** Tabs whose independent-progression flag is user-configurable. */
export const PROGRESS_TABS = ['lesson', 'summary', 'cheatsheet', 'test'] as const;
export type ProgressTab = (typeof PROGRESS_TABS)[number];

export interface ProgressionFlags {
  lesson: boolean;
  summary: boolean;
  cheatsheet: boolean;
  test: boolean;
}

/** Practice Test is independent out of the box; the others ride the shared group. */
export const DEFAULT_PROGRESSION_FLAGS: ProgressionFlags = {
  lesson: false,
  summary: false,
  cheatsheet: false,
  test: true
};

/** One scope's reading progress. Scope is a lesson id, or `course`. */
export interface ScopeProgress {
  /** Fraction (0..1) shared by every non-independent tab in this scope. */
  shared?: number;
  /** Fraction per independent tab slug. */
  tabs?: Record<string, number>;
}

export type CheckpointKind = 'lesson' | 'location';

export interface Checkpoint {
  id: string;
  lessonId: string;
  kind: CheckpointKind;
  /** Text snippet of the block this location checkpoint sits before (location only). */
  anchor: string | null;
  label: string;
  /** Palette colour id (see checkpoints.ts). */
  color: string;
  createdAt: string;
}

export interface StudyState {
  version: number;
  updatedAt: string;
  progress: Record<string, ScopeProgress>;
  /** lessonId → ISO timestamp of the submitted practice test. */
  completions: Record<string, string>;
  checkpoints: Checkpoint[];
  /** User-facing name of the auto "Current" checkpoint. */
  currentLabel: string;
}

/**
 * Light per-course summary attached to course listings (computed at read time,
 * never written to meta.json).
 */
export interface CourseStudySummary {
  currentLessonId: string | null;
  currentLabel: string;
  completedLessonIds: string[];
  checkpointCount: number;
}

export const DEFAULT_CURRENT_LABEL = 'Current';

export function emptyStudyState(): StudyState {
  return {
    version: STUDY_STATE_VERSION,
    updatedAt: new Date(0).toISOString(),
    progress: {},
    completions: {},
    checkpoints: [],
    currentLabel: DEFAULT_CURRENT_LABEL
  };
}

/** True when a tab keeps its own progress instead of riding the shared group. */
export function isIndependentTab(tab: string, flags: ProgressionFlags): boolean {
  if ((PROGRESS_TABS as readonly string[]).includes(tab)) {
    return flags[tab as ProgressTab] === true;
  }
  // Custom and course-only tabs (schedule) follow the shared synced group.
  return false;
}

/**
 * The lesson the "Current" checkpoint points at: the furthest-ordered lesson
 * whose practice test has been submitted. `orderedLessonIds` must be in course
 * order. Completing an earlier lesson's test never moves Current backwards.
 */
export function currentLessonId(state: StudyState | null, orderedLessonIds: string[]): string | null {
  if (!state) return null;
  let current: string | null = null;
  for (const id of orderedLessonIds) {
    if (state.completions[id]) current = id;
  }
  return current;
}

/** Clamps a fraction to 0..1, returning 0 for garbage. */
export function clampFraction(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

export function sharedProgress(state: StudyState | null, scope: string): number {
  return clampFraction(state?.progress?.[scope]?.shared ?? 0);
}

export function tabProgress(state: StudyState | null, scope: string, tab: string): number {
  return clampFraction(state?.progress?.[scope]?.tabs?.[tab] ?? 0);
}

export function checkpointsForLesson(state: StudyState | null, lessonId: string): Checkpoint[] {
  if (!state) return [];
  return state.checkpoints.filter((c) => c.lessonId === lessonId);
}

export function lessonColorFlags(state: StudyState | null, lessonId: string): string[] {
  return checkpointsForLesson(state, lessonId).map((c) => c.color);
}
