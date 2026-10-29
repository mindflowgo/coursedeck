import { browser } from '$app/environment';
import { apiFetch } from '$lib/api';
import { indexStrokesByFile } from './pdfMarkup';
import { mergeStrokes } from './render';
import { isMarkupStroke, type MarkupColor, type MarkupStroke, type MarkupTool } from './types';

/**
 * Reactive client store for free-hand markup strokes.
 *
 * Strokes live in a per-course cache keyed by doc file. Every mutation is
 * applied optimistically and queued as an upsert batch (debounced 300ms) to
 * `PUT /api/courses/:id/annotations`, which transparently resolves to the
 * desktop server or the Tauri offline store (see `$lib/api` routing).
 *
 * Undo/redo is session-local per course+file and works by upserting
 * tombstones / restored copies with fresh dates, so it survives the sync
 * merge (last-write-wins on `date`).
 */

type UndoOp =
  | { type: 'add'; strokes: MarkupStroke[] }
  | { type: 'erase'; prev: MarkupStroke[] };

const cache = $state<Record<string, MarkupStroke[]>>({});
// O(1) indexed lookup per course: courseId -> fileKey -> non-deleted strokes
const fileIndex = $state<Record<string, Record<string, MarkupStroke[]>>>({});
const undoStacks = $state<Record<string, UndoOp[]>>({});
const redoStacks = $state<Record<string, UndoOp[]>>({});
let revision = $state(0);

function rebuildFileIndex(courseId: string): void {
  const id = courseId.toLowerCase();
  fileIndex[id] = indexStrokesByFile(cache[id] ?? []);
}

const loadedCourses = new Set<string>();
const inflightLoads = new Map<string, Promise<void>>();
const pendingUpserts = new Map<string, Map<string, MarkupStroke>>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

const PENCIL_ONLY_KEY = 'markup_pencil_only_v2';
const SHOW_KEY = 'markup_show';

function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
}

/** Markup mode UI state shared by the top-bar menu and the overlay. */
export const markupUi = $state({
  mode: false,
  tool: 'marker' as MarkupTool,
  color: 'yellow' as MarkupColor,
  eraser: false,
  width: undefined as number | undefined,
  opacity: undefined as number | undefined,
  pencilOnly: browser ? readBoolPref(PENCIL_ONLY_KEY, false) : false,
  show: browser ? readBoolPref(SHOW_KEY, true) : true
});

export function setPencilOnly(value: boolean): void {
  markupUi.pencilOnly = value;
  try {
    localStorage.setItem(PENCIL_ONLY_KEY, String(value));
  } catch {}
}

/** Global markings visibility toggle (device-local preference). */
export function setShowMarkings(value: boolean): void {
  markupUi.show = value;
  try {
    localStorage.setItem(SHOW_KEY, String(value));
  } catch {}
}

export function enterMarkupMode(): void {
  markupUi.mode = true;
  markupUi.eraser = false;
  markupUi.show = true;
  try {
    localStorage.setItem(SHOW_KEY, 'true');
  } catch {}
}

export function exitMarkupMode(): void {
  markupUi.mode = false;
  markupUi.eraser = false;
}

function fileKey(courseId: string, file: string): string {
  return `${courseId.toLowerCase()}:${file}`;
}

/** All stored strokes for a course, including tombstones (needed for merges). */
export function courseStrokes(courseId: string): MarkupStroke[] {
  void revision;
  return cache[courseId.toLowerCase()] ?? [];
}

/** Visible (non-deleted) strokes for one document (O(1) indexed lookup). */
export function visibleStrokes(courseId: string, file: string): MarkupStroke[] {
  void revision;
  return fileIndex[courseId.toLowerCase()]?.[file] ?? [];
}

export function canUndo(courseId: string, file: string): boolean {
  void revision;
  return (undoStacks[fileKey(courseId, file)]?.length ?? 0) > 0;
}

export function canRedo(courseId: string, file: string): boolean {
  void revision;
  return (redoStacks[fileKey(courseId, file)]?.length ?? 0) > 0;
}

function applyLocalUpsert(courseId: string, upserts: MarkupStroke[]): void {
  const id = courseId.toLowerCase();
  const merged = mergeStrokes(cache[id] ?? [], upserts);
  cache[id] = merged.strokes;
  rebuildFileIndex(courseId);
  revision += 1;
}

function queueUpsert(courseId: string, upserts: MarkupStroke[]): void {
  const id = courseId.toLowerCase();
  let queue = pendingUpserts.get(id);
  if (!queue) {
    queue = new Map();
    pendingUpserts.set(id, queue);
  }
  for (const s of upserts) queue.set(s.id, s);
  scheduleFlush(courseId);
}

function scheduleFlush(courseId: string): void {
  const id = courseId.toLowerCase();
  const existing = flushTimers.get(id);
  if (existing) clearTimeout(existing);
  flushTimers.set(
    id,
    setTimeout(() => {
      flushTimers.delete(id);
      void flush(courseId);
    }, 300)
  );
}

async function flush(courseId: string): Promise<void> {
  const id = courseId.toLowerCase();
  const queue = pendingUpserts.get(id);
  if (!queue || queue.size === 0) return;
  const upserts = Array.from(queue.values());
  queue.clear();
  try {
    const res = await apiFetch(`/api/courses/${encodeURIComponent(id)}/annotations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upserts })
    });
    if (!res.ok) throw new Error(`annotations PUT ${res.status}`);
  } catch (err) {
    console.warn('[Markup] Failed to persist strokes:', err);
    // Re-queue so the next mutation (or undo) retries the batch.
    for (const s of upserts) {
      let requeue = pendingUpserts.get(id);
      if (!requeue) {
        requeue = new Map();
        pendingUpserts.set(id, requeue);
      }
      requeue.set(s.id, s);
    }
  }
}

/** Loads (once) the course's annotations from server or offline store. */
export async function loadAnnotations(courseId: string): Promise<void> {
  if (!browser) return;
  const id = courseId.toLowerCase();
  if (loadedCourses.has(id)) return;
  const inflight = inflightLoads.get(id);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const res = await apiFetch(`/api/courses/${encodeURIComponent(id)}/annotations`);
      if (res.ok) {
        const body = (await res.json()) as { strokes?: unknown[] };
        const incoming = Array.isArray(body.strokes) ? body.strokes.filter(isMarkupStroke) : [];
        applyLocalUpsert(id, incoming);
      }
      loadedCourses.add(id);
    } catch (err) {
      console.warn('[Markup] Failed to load annotations:', err);
    } finally {
      inflightLoads.delete(id);
    }
  })();
  inflightLoads.set(id, promise);
  return promise;
}

/** Re-reads annotations from the backend (used after a sync/push cycle). */
export async function reloadAnnotations(courseId: string): Promise<void> {
  if (!browser) return;
  const id = courseId.toLowerCase();
  loadedCourses.delete(id);
  await loadAnnotations(id);
}

function nextId(): string {
  return crypto.randomUUID?.() ?? `ms_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createStroke(
  courseId: string,
  file: string,
  tool: MarkupTool,
  color: MarkupColor,
  points: number[],
  authorWidth: number,
  width?: number,
  opacity?: number
): MarkupStroke {
  const stroke: MarkupStroke = {
    id: nextId(),
    file,
    tool,
    color,
    points,
    authorWidth,
    date: new Date().toISOString()
  };
  if (width !== undefined) stroke.width = width;
  if (opacity !== undefined) stroke.opacity = opacity;
  return stroke;
}

/** Commits a finished stroke (optimistic + queued upsert + undo entry). */
export function addStroke(courseId: string, stroke: MarkupStroke): void {
  addStrokes(courseId, [stroke]);
}

/**
 * Batched commit (native PencilKit bursts): one cache merge, one index
 * rebuild and one debounced persistence flush for the whole batch, while
 * each stroke keeps its own undo entry so undo still peels single strokes.
 */
export function addStrokes(courseId: string, newStrokes: MarkupStroke[]): void {
  if (newStrokes.length === 0) return;
  applyLocalUpsert(courseId, newStrokes);
  queueUpsert(courseId, newStrokes);
  for (const s of newStrokes) {
    const key = fileKey(courseId, s.file);
    undoStacks[key] = [...(undoStacks[key] ?? []), { type: 'add', strokes: [s] }];
    redoStacks[key] = [];
  }
}

/**
 * Erases every visible stroke of `file` hit by (x, y) in render coordinates.
 * Returns the erased count so the overlay can decide about feedback.
 */
export function eraseStrokesAt(
  courseId: string,
  file: string,
  hits: MarkupStroke[]
): number {
  if (hits.length === 0) return 0;
  const now = new Date().toISOString();
  const prev = hits.map((s) => ({ ...s }));
  const tombstones = hits.map((s) => ({ ...s, date: now, deleted: now }));
  applyLocalUpsert(courseId, tombstones);
  queueUpsert(courseId, tombstones);
  const key = fileKey(courseId, file);
  undoStacks[key] = [...(undoStacks[key] ?? []), { type: 'erase', prev }];
  redoStacks[key] = [];
  return hits.length;
}

export function clearFile(courseId: string, file: string): number {
  const visible = visibleStrokes(courseId, file);
  return eraseStrokesAt(courseId, file, visible);
}

function restoreCopy(stroke: MarkupStroke): MarkupStroke {
  const copy = { ...stroke, date: new Date().toISOString() };
  delete copy.deleted;
  return copy;
}

function tombstoneCopy(stroke: MarkupStroke): MarkupStroke {
  const now = new Date().toISOString();
  return { ...stroke, date: now, deleted: now };
}

export function undo(courseId: string, file: string): void {
  const key = fileKey(courseId, file);
  const stack = undoStacks[key] ?? [];
  const op = stack.pop();
  if (!op) return;
  undoStacks[key] = stack;

  if (op.type === 'add') {
    const tombstones = op.strokes.map(tombstoneCopy);
    applyLocalUpsert(courseId, tombstones);
    queueUpsert(courseId, tombstones);
  } else {
    const restored = op.prev.map(restoreCopy);
    applyLocalUpsert(courseId, restored);
    queueUpsert(courseId, restored);
  }
  redoStacks[key] = [...(redoStacks[key] ?? []), op];
}

export function redo(courseId: string, file: string): void {
  const key = fileKey(courseId, file);
  const stack = redoStacks[key] ?? [];
  const op = stack.pop();
  if (!op) return;
  redoStacks[key] = stack;

  if (op.type === 'add') {
    const restored = op.strokes.map(restoreCopy);
    applyLocalUpsert(courseId, restored);
    queueUpsert(courseId, restored);
  } else {
    const tombstones = op.prev.map(tombstoneCopy);
    applyLocalUpsert(courseId, tombstones);
    queueUpsert(courseId, tombstones);
  }
  undoStacks[key] = [...(undoStacks[key] ?? []), op];
}

/** Flushes any pending batches immediately (e.g. before navigating away). */
export function flushNow(): void {
  for (const id of Array.from(pendingUpserts.keys())) {
    const timer = flushTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      flushTimers.delete(id);
    }
    void flush(id);
  }
}
