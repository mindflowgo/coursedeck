import fs from 'node:fs';
import path from 'node:path';
import { getLessonProgressDir, normalizeCourseId, safeJoin } from './paths';
import { MAX_LESSON_CHECKPOINTS } from '../checkpoints';
import {
  DEFAULT_CURRENT_LABEL,
  PROGRESS_EPSILON,
  STUDY_STATE_VERSION,
  clampFraction,
  currentLessonId,
  emptyStudyState,
  type Checkpoint,
  type CheckpointKind,
  type CourseStudySummary,
  type ScopeProgress,
  type StudyState
} from '../studyStateTypes';

/**
 * Per-course study state on disk: reading progress, practice-test completions
 * and checkpoints. One JSON file per course under `<dataDir>/lessonProgress/`.
 *
 * The whole file is read-modify-written per mutation — it is tiny (a handful of
 * numbers and checkpoint records) so there is no reason to complicate it.
 */

const LESSON_REF = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const TAB_SLUG = /^[a-z0-9][a-z0-9_]{0,31}$/;
const COLOR_ID = /^[a-z]{3,20}$/;
/** Checkpoint ids reach the client DOM as data attributes; keep them tame. */
const CHECKPOINT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABEL = 60;
const MAX_ANCHOR = 200;

export type StudyMutationResult =
  | { ok: true; state: StudyState }
  | { ok: false; error: string };

function statePath(courseId: string): string {
  return safeJoin(getLessonProgressDir(), `${normalizeCourseId(courseId)}.json`);
}

function isLessonScope(scope: string): boolean {
  return scope === 'course' || LESSON_REF.test(scope);
}

function clampText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Coerces arbitrary parsed JSON into a valid StudyState, dropping junk. */
export function normalizeStudyState(raw: unknown): StudyState {
  const state = emptyStudyState();
  if (!raw || typeof raw !== 'object') return state;
  const source = raw as Record<string, unknown>;

  if (source.progress && typeof source.progress === 'object') {
    for (const [scope, value] of Object.entries(source.progress as Record<string, unknown>)) {
      if (!isLessonScope(scope) || !value || typeof value !== 'object') continue;
      const entry: ScopeProgress = {};
      const rawEntry = value as Record<string, unknown>;
      const shared = clampFraction(rawEntry.shared);
      if (shared >= PROGRESS_EPSILON) entry.shared = shared;
      if (rawEntry.tabs && typeof rawEntry.tabs === 'object') {
        const tabs: Record<string, number> = {};
        for (const [tab, fraction] of Object.entries(rawEntry.tabs as Record<string, unknown>)) {
          if (!TAB_SLUG.test(tab)) continue;
          const value = clampFraction(fraction);
          if (value >= PROGRESS_EPSILON) tabs[tab] = value;
        }
        if (Object.keys(tabs).length > 0) entry.tabs = tabs;
      }
      if (entry.shared !== undefined || entry.tabs) state.progress[scope] = entry;
    }
  }

  if (source.completions && typeof source.completions === 'object') {
    for (const [lessonId, at] of Object.entries(source.completions as Record<string, unknown>)) {
      if (!LESSON_REF.test(lessonId)) continue;
      if (typeof at === 'string' && at.trim()) state.completions[lessonId] = at;
    }
  }

  if (Array.isArray(source.checkpoints)) {
    const seen = new Set<string>();
    for (const item of source.checkpoints) {
      const checkpoint = normalizeCheckpoint(item);
      if (!checkpoint || seen.has(checkpoint.id)) continue;
      seen.add(checkpoint.id);
      state.checkpoints.push(checkpoint);
    }
  }

  const label = clampText(source.currentLabel, MAX_LABEL);
  state.currentLabel = label || DEFAULT_CURRENT_LABEL;
  return state;
}

function normalizeCheckpoint(item: unknown): Checkpoint | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as Record<string, unknown>;
  const lessonId = typeof raw.lessonId === 'string' ? raw.lessonId.trim() : '';
  if (!LESSON_REF.test(lessonId)) return null;
  const kind: CheckpointKind = raw.kind === 'location' ? 'location' : 'lesson';
  const color = typeof raw.color === 'string' && COLOR_ID.test(raw.color) ? raw.color : 'blue';
  const label = clampText(raw.label, MAX_LABEL) || `Checkpoint ${lessonId}`;
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const id = CHECKPOINT_ID.test(rawId) ? rawId : `cp_${crypto.randomUUID()}`;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt : new Date().toISOString();
  const anchor = kind === 'location' ? clampText(raw.anchor, MAX_ANCHOR) || null : null;
  return { id, lessonId, kind, anchor, label, color, createdAt };
}

function isEmpty(state: StudyState): boolean {
  return (
    Object.keys(state.progress).length === 0 &&
    Object.keys(state.completions).length === 0 &&
    state.checkpoints.length === 0 &&
    state.currentLabel === DEFAULT_CURRENT_LABEL
  );
}

export function readStudyState(courseId: string): StudyState {
  const file = statePath(courseId);
  try {
    if (!fs.existsSync(file)) return emptyStudyState();
    return normalizeStudyState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    console.warn(`[studyState] Failed to read ${file}:`, e);
    return emptyStudyState();
  }
}

/**
 * Persists the state, deleting the file when nothing is left to remember — so
 * untouched courses never grow a `lessonProgress` entry. Throws when a write
 * fails so the caller can surface an error instead of a false success.
 */
export function writeStudyState(courseId: string, state: StudyState): StudyState {
  const file = statePath(courseId);
  const updated: StudyState = { ...state, version: STUDY_STATE_VERSION, updatedAt: new Date().toISOString() };
  try {
    if (isEmpty(updated)) {
      if (fs.existsSync(file)) fs.rmSync(file);
      return updated;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  } catch (e) {
    console.warn(`[studyState] Failed to write ${file}:`, e);
    throw new Error(`Failed to save study state for course '${courseId}'`);
  }
}

export function recordProgress(
  courseId: string,
  scope: string,
  progress: unknown,
  tab?: string
): StudyMutationResult {
  if (!isLessonScope(scope)) return { ok: false, error: `Invalid scope '${scope}'` };
  if (tab !== undefined && !TAB_SLUG.test(tab)) return { ok: false, error: `Invalid tab '${tab}'` };

  const state = readStudyState(courseId);
  const value = clampFraction(progress);
  const entry: ScopeProgress = state.progress[scope] ?? {};

  if (tab) {
    const tabs = entry.tabs ?? {};
    if (value < PROGRESS_EPSILON) delete tabs[tab];
    else tabs[tab] = value;
    if (Object.keys(tabs).length > 0) entry.tabs = tabs;
    else delete entry.tabs;
  } else if (value < PROGRESS_EPSILON) {
    delete entry.shared;
  } else {
    entry.shared = value;
  }

  if (entry.shared === undefined && !entry.tabs) delete state.progress[scope];
  else state.progress[scope] = entry;

  return { ok: true, state: writeStudyState(courseId, state) };
}

export function recordCompletion(courseId: string, lessonId: string): StudyMutationResult {
  if (!LESSON_REF.test(lessonId)) return { ok: false, error: `Invalid lesson '${lessonId}'` };
  const state = readStudyState(courseId);
  state.completions[lessonId] = new Date().toISOString();
  return { ok: true, state: writeStudyState(courseId, state) };
}

export interface NewCheckpointInput {
  lessonId: string;
  kind: CheckpointKind;
  anchor?: string | null;
  label?: string;
  color?: string;
}

export function createCheckpoint(courseId: string, input: NewCheckpointInput): StudyMutationResult {
  if (!LESSON_REF.test(input.lessonId)) return { ok: false, error: `Invalid lesson '${input.lessonId}'` };
  const kind: CheckpointKind = input.kind === 'location' ? 'location' : 'lesson';
  const color = typeof input.color === 'string' && COLOR_ID.test(input.color) ? input.color : 'blue';

  const state = readStudyState(courseId);
  if (kind === 'lesson') {
    const lessonCount = state.checkpoints.filter(
      (c) => c.lessonId === input.lessonId && c.kind === 'lesson'
    ).length;
    if (lessonCount >= MAX_LESSON_CHECKPOINTS) {
      return { ok: false, error: `This lesson already has the maximum of ${MAX_LESSON_CHECKPOINTS} checkpoints.` };
    }
  }

  const anchor = kind === 'location' ? clampText(input.anchor, MAX_ANCHOR) || null : null;
  if (kind === 'location' && !anchor) {
    return { ok: false, error: 'Could not determine the current location in this lesson.' };
  }

  const checkpoint: Checkpoint = {
    id: `cp_${crypto.randomUUID()}`,
    lessonId: input.lessonId,
    kind,
    anchor,
    label: clampText(input.label, MAX_LABEL) || `Checkpoint ${input.lessonId}`,
    color,
    createdAt: new Date().toISOString()
  };
  state.checkpoints.push(checkpoint);
  return { ok: true, state: writeStudyState(courseId, state) };
}

export function updateCheckpoint(
  courseId: string,
  id: string,
  patch: { label?: string; color?: string }
): StudyMutationResult {
  const state = readStudyState(courseId);
  const checkpoint = state.checkpoints.find((c) => c.id === id);
  if (!checkpoint) return { ok: false, error: `Checkpoint '${id}' not found` };
  if (patch.label !== undefined) {
    const label = clampText(patch.label, MAX_LABEL);
    if (!label) return { ok: false, error: 'Checkpoint name cannot be empty' };
    checkpoint.label = label;
  }
  if (patch.color !== undefined) {
    if (!COLOR_ID.test(patch.color)) return { ok: false, error: `Invalid colour '${patch.color}'` };
    checkpoint.color = patch.color;
  }
  return { ok: true, state: writeStudyState(courseId, state) };
}

export function deleteCheckpoint(courseId: string, id: string): StudyMutationResult {
  const state = readStudyState(courseId);
  const before = state.checkpoints.length;
  state.checkpoints = state.checkpoints.filter((c) => c.id !== id);
  if (state.checkpoints.length === before) return { ok: false, error: `Checkpoint '${id}' not found` };
  return { ok: true, state: writeStudyState(courseId, state) };
}

export function setCurrentLabel(courseId: string, label: string): StudyMutationResult {
  const clean = clampText(label, MAX_LABEL);
  if (!clean) return { ok: false, error: 'Checkpoint name cannot be empty' };
  const state = readStudyState(courseId);
  state.currentLabel = clean;
  return { ok: true, state: writeStudyState(courseId, state) };
}

/** Light summary attached to course listings (never written to meta.json). */
export function summarizeStudyState(state: StudyState, orderedLessonIds: string[]): CourseStudySummary {
  return {
    currentLessonId: currentLessonId(state, orderedLessonIds),
    currentLabel: state.currentLabel,
    completedLessonIds: Object.keys(state.completions),
    checkpointCount: state.checkpoints.length
  };
}
