import { apiFetch } from '$lib/api';
import {
  DEFAULT_PROGRESSION_FLAGS,
  emptyStudyState,
  type CheckpointKind,
  type ProgressionFlags,
  type StudyState
} from '$lib/studyStateTypes';

/**
 * Thin client for the per-course study-state API. Pure fetch wrappers with no
 * reactive state — the calling component owns the `$state` it stores results in.
 */

function courseUrl(courseId: string): string {
  return `/api/courses/${encodeURIComponent(courseId)}/study-state`;
}

interface StateResponse {
  success?: boolean;
  state?: StudyState;
  message?: string;
}

export interface MutationOutcome {
  ok: boolean;
  state?: StudyState;
  error?: string;
}

async function readState(res: Response): Promise<MutationOutcome> {
  let payload: StateResponse = {};
  try {
    payload = (await res.json()) as StateResponse;
  } catch {
    // fall through to the status-based result
  }
  if (!res.ok) return { ok: false, error: payload.message || `Request failed (${res.status})` };
  return { ok: true, state: payload.state };
}

export async function fetchStudyState(courseId: string): Promise<StudyState | null> {
  if (!courseId) return null;
  try {
    const res = await apiFetch(courseUrl(courseId));
    if (!res.ok) return null;
    const payload = (await res.json()) as StateResponse;
    return payload.state ?? emptyStudyState();
  } catch {
    return null;
  }
}

export async function putProgress(
  courseId: string,
  scope: string,
  progress: number,
  tab?: string
): Promise<StudyState | null> {
  if (!courseId || !scope) return null;
  try {
    const res = await apiFetch(`${courseUrl(courseId)}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tab ? { scope, tab, progress } : { scope, progress })
    });
    const outcome = await readState(res);
    return outcome.state ?? null;
  } catch {
    return null;
  }
}

export async function postCompletion(courseId: string, lessonId: string): Promise<StudyState | null> {
  if (!courseId || !lessonId) return null;
  try {
    const res = await apiFetch(`${courseUrl(courseId)}/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId })
    });
    const outcome = await readState(res);
    return outcome.state ?? null;
  } catch {
    return null;
  }
}

export async function createCheckpointRequest(
  courseId: string,
  input: { lessonId: string; kind: CheckpointKind; anchor?: string | null; label?: string; color?: string }
): Promise<MutationOutcome> {
  try {
    const res = await apiFetch(`${courseUrl(courseId)}/checkpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    return await readState(res);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to create checkpoint' };
  }
}

export async function updateCheckpointRequest(
  courseId: string,
  patch: { id?: string; label?: string; color?: string; currentLabel?: string }
): Promise<MutationOutcome> {
  try {
    const res = await apiFetch(`${courseUrl(courseId)}/checkpoints`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    return await readState(res);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to update checkpoint' };
  }
}

export async function deleteCheckpointRequest(courseId: string, id: string): Promise<MutationOutcome> {
  try {
    const res = await apiFetch(`${courseUrl(courseId)}/checkpoints?id=${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    return await readState(res);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to delete checkpoint' };
  }
}

export async function fetchProgression(): Promise<ProgressionFlags> {
  try {
    const res = await apiFetch('/api/settings/progression');
    if (!res.ok) return { ...DEFAULT_PROGRESSION_FLAGS };
    const payload = (await res.json()) as { progression?: Partial<ProgressionFlags> };
    return { ...DEFAULT_PROGRESSION_FLAGS, ...(payload.progression ?? {}) };
  } catch {
    return { ...DEFAULT_PROGRESSION_FLAGS };
  }
}

export async function saveProgression(flags: ProgressionFlags): Promise<ProgressionFlags | null> {
  try {
    const res = await apiFetch('/api/settings/progression', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progression: flags })
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { progression?: ProgressionFlags };
    return payload.progression ?? flags;
  } catch {
    return null;
  }
}
