/**
 * Per-page scroll memory for the course workspace.
 *
 * The workspace scrolls inside a nested container, so the browser does not
 * restore offsets between tabs. We remember each course/lesson/tab page's
 * offset in browser storage instead: a first visit lands at the top, later
 * visits land where the reader stopped. Positions are per-browser view state
 * — they never touch the server or the course files.
 */

/** Storage-key prefix; also used to sweep stale entries. */
export const SCROLL_KEY_PREFIX = 'tab_scroll:';

/** Offsets below this are treated as "at the top" and forgotten. */
const AT_TOP_PX = 8;

/** The subset of `Storage` this module needs (localStorage satisfies it). */
export interface ScrollStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

function defaultStorage(): ScrollStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** `tab_scroll:<courseId>:<lessonId|course>:<tab>` — all lowercased. */
export function scrollMemoryKey(courseId: string, scope: string, tab: string): string {
  return `${SCROLL_KEY_PREFIX}${courseId}:${scope}:${tab}`.toLowerCase();
}

/** The remembered offset for a page, or 0 when none is stored/readable. */
export function recallScroll(key: string, storage: ScrollStorage | null = defaultStorage()): number {
  if (!storage) return 0;
  try {
    const raw = storage.getItem(key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Stores the offset for a page. Near-top offsets remove the key instead, so
 * "at the top" and "never visited" behave identically on the next visit.
 */
export function rememberScroll(
  key: string,
  top: number,
  storage: ScrollStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    if (!Number.isFinite(top) || top < AT_TOP_PX) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, String(Math.floor(top)));
    }
  } catch {
    // Storage unavailable (private mode, quota) — scroll memory is optional.
  }
}

/** Every `tab_scroll:` key currently in storage (collected before removal). */
function storedScrollKeys(storage: ScrollStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(SCROLL_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Drops every remembered offset for one course (archived or deleted). */
export function forgetCourseScroll(
  courseId: string,
  storage: ScrollStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    const prefix = `${SCROLL_KEY_PREFIX}${courseId.toLowerCase()}:`;
    for (const key of storedScrollKeys(storage)) {
      if (key.toLowerCase().startsWith(prefix)) storage.removeItem(key);
    }
  } catch {}
}

/**
 * Drops offsets whose course is no longer on disk. `keepCourseIds` should be
 * every course the server reported (archived ones included). Keys outside the
 * `tab_scroll:` namespace are never touched.
 */
export function pruneScrollMemory(
  keepCourseIds: Iterable<string>,
  storage: ScrollStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    const keep = new Set<string>();
    for (const id of keepCourseIds) keep.add(id.toLowerCase());
    for (const key of storedScrollKeys(storage)) {
      const courseId = key.slice(SCROLL_KEY_PREFIX.length).split(':')[0].toLowerCase();
      if (!keep.has(courseId)) storage.removeItem(key);
    }
  } catch {}
}
