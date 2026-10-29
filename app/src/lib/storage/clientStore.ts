// app/src/lib/storage/clientStore.ts
// Native Filesystem + IndexedDB fallback store for CourseDeck iPad offline mode.

import type { CourseManifest } from '$lib/parser/courseIngest';
import { derivePdfMarkupCheckpoints, type Checkpoint } from '$lib/checkpoint';
import { mergeStrokes } from '$lib/markup/render';
import { isMarkupStroke, type MarkupStroke } from '$lib/markup/types';

export interface ClientLlmModelCard {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  apiKey?: string;
  authHeaderType?: 'bearer' | 'api_key' | 'both';
  model?: string;
  temperature?: number;
  timeoutSeconds?: number;
  sendSessionId?: boolean;
}

export interface ClientLlmStore {
  version: number;
  activeId: string | null;
  cards: ClientLlmModelCard[];
}

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    '__TAURI_INTERNALS__' in window ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost'
  );
}

/** Result of the iPad's native zip sync (`sync_fetch_bundle_zip`). */
export interface SyncZipSummary {
  generatedAt: string;
  courses: Array<{ course_id: string; files: number; assets: number }>;
  llmConfig?: ClientLlmStore;
}

export async function saveLlmConfigLocally(config: ClientLlmStore): Promise<void> {
  await put('llm_config', 'store', config);
}

const DB_NAME = 'coursedeck_v1';
const DB_VERSION = 3;

const STORES = [
  'meta',
  'courses',
  'documents',
  'prompts',
  'llm_config',
  'checkpoints',
  'annotations',
  'pending_push',
  'pending_push_annotations',
  'pdf_assets'
] as const;

let _db: IDBDatabase | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('IndexedDB is only available in browser context'));
  }
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function get<T>(store: typeof STORES[number], key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function put(store: typeof STORES[number], key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getAll<T>(store: typeof STORES[number]): Promise<{ key: string; value: T }[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const results: { key: string; value: T }[] = [];
    os.openCursor().onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        results.push({ key: String(cursor.key), value: cursor.value as T });
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function putMany(store: typeof STORES[number], entries: [string, unknown][]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const [key, value] of entries) {
      os.put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ── Public Metadata API ────────────────────────────────────────────────────────

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return get<T>('meta', key);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  return put('meta', key, value);
}

export async function getLastSyncedAt(): Promise<string | undefined> {
  return getMeta<string>('last_synced_at');
}

export async function getDesktopUrl(): Promise<string | undefined> {
  return getMeta<string>('desktop_url');
}

// ── PDF Asset Cache (offline course books) ─────────────────────────────────────

export async function getCachedPdfAsset(key: string): Promise<ArrayBuffer | undefined> {
  try {
    const hit = await get<ArrayBuffer>('pdf_assets', key);
    return hit instanceof ArrayBuffer ? hit : undefined;
  } catch (err) {
    console.warn('[PdfAssetCache] read failed:', err);
    return undefined;
  }
}

export async function putCachedPdfAsset(key: string, buffer: ArrayBuffer): Promise<void> {
  try {
    await put('pdf_assets', key, buffer);
  } catch (err) {
    // Best-effort cache: quota errors must never block viewing the document.
    console.warn('[PdfAssetCache] write failed (ignored):', err);
  }
}

export async function deleteCachedPdfAsset(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pdf_assets', 'readwrite');
      tx.objectStore('pdf_assets').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[PdfAssetCache] delete failed:', err);
  }
}

// ── Course & Content Readers ───────────────────────────────────────────────────

export async function listCachedCourses(): Promise<CourseManifest[]> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const courses = await invoke<CourseManifest[]>('list_cached_courses');
      if (Array.isArray(courses)) {
        console.log(`[NativeStore] listCachedCourses: retrieved ${courses.length} courses from filesystem`);
        return courses;
      }
    } catch (err) {
      console.warn('[NativeStore] list_cached_courses failed, falling back to IDB:', err);
    }
  }

  const rows = await getAll<CourseManifest>('courses');
  return rows.map((r) => r.value);
}

export async function getCachedCourse(courseId: string): Promise<CourseManifest | undefined> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const course = await invoke<CourseManifest | null>('get_cached_course', { courseId });
      if (course) {
        console.log(`[NativeStore] getCachedCourse: retrieved manifest for "${courseId}" from filesystem`);
        return course;
      }
    } catch (err) {
      console.warn('[NativeStore] get_cached_course failed, falling back to IDB:', err);
    }
  }

  return get<CourseManifest>('courses', courseId.toLowerCase());
}

export async function saveCourseManifestLocally(courseId: string, manifest: CourseManifest): Promise<void> {
  const json = JSON.stringify(manifest, null, 2);
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_course_doc', { courseId, filename: 'meta.json', content: json });
      await invoke('save_course_doc', { courseId, filename: 'manifest.json', content: json });
      console.log(`[NativeStore] saveCourseManifestLocally: wrote manifest for "${courseId}" directly to filesystem`);
    } catch (err) {
      console.warn('[NativeStore] saveCourseManifestLocally failed:', err);
    }
  }
  await put('courses', courseId.toLowerCase(), manifest);
}

export async function deleteCourseLocally(courseId: string): Promise<void> {
  const id = courseId.toLowerCase();
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_course', { courseId: id });
      console.log(`[NativeStore] deleteCourseLocally: deleted course "${id}" from filesystem`);
    } catch (err) {
      console.warn('[NativeStore] Native delete_course failed:', err);
    }
  }

  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      ['courses', 'documents', 'checkpoints', 'annotations', 'pending_push', 'pending_push_annotations'],
      'readwrite'
    );
    tx.objectStore('courses').delete(id);
    tx.objectStore('checkpoints').delete(id);
    tx.objectStore('annotations').delete(id);
    tx.objectStore('pending_push').delete(id);
    tx.objectStore('pending_push_annotations').delete(id);

    const docStore = tx.objectStore('documents');
    const docReq = docStore.openCursor();
    docReq.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        if (typeof cursor.key === 'string' && cursor.key.startsWith(`${id}:`)) {
          cursor.delete();
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getDocument(courseId: string, filename: string): Promise<string | undefined> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const doc = await invoke<string | null>('read_course_doc', { courseId, filename });
      if (doc !== null && doc !== undefined) {
        console.log(`[NativeStore] getDocument: read "${filename}" for "${courseId}" from filesystem (${doc.length} chars)`);
        return doc;
      }
    } catch (err) {
      console.warn('[NativeStore] read_course_doc failed, falling back to IDB:', err);
    }
  }

  return get<string>('documents', `${courseId.toLowerCase()}:${filename}`);
}

export async function saveDocumentLocally(courseId: string, filename: string, content: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_course_doc', { courseId, filename, content });
      console.log(`[NativeStore] saveDocumentLocally: wrote "${filename}" for "${courseId}" directly to filesystem`);
    } catch (err) {
      console.warn('[NativeStore] save_course_doc failed:', err);
    }
  }

  return put('documents', `${courseId.toLowerCase()}:${filename}`, content);
}

export async function deleteDocumentLocally(courseId: string, filename: string): Promise<boolean> {
  let removed = false;
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      removed = await invoke<boolean>('delete_course_doc', { courseId, filename });
      console.log(`[NativeStore] deleteDocumentLocally: deleted "${filename}" for "${courseId}" directly from filesystem: ${removed}`);
    } catch (err) {
      console.warn('[NativeStore] delete_course_doc failed:', err);
    }
  }

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite');
    tx.objectStore('documents').delete(`${courseId.toLowerCase()}:${filename}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return removed;
}

export async function listAllCheckpointsLocally(): Promise<Array<Checkpoint & { courseId: string; courseTitle: string }>> {
  const courses = (await listCachedCourses()).filter((c) => !c.archived);
  const all: Array<Checkpoint & { courseId: string; courseTitle: string }> = [];
  for (const c of courses) {
    const courseTitle = c.title || c.id.toUpperCase();
    const cps = await getCachedCheckpoints(c.id);
    for (const cp of cps) {
      if (cp.type === 'note') {
        all.push({
          ...cp,
          courseId: c.id,
          courseTitle
        });
      }
    }
    const annotations = await getAnnotationsLocally(c.id);
    if (annotations.length > 0) {
      const markupCps = derivePdfMarkupCheckpoints(c.id, courseTitle, annotations);
      all.push(...markupCps);
    }
  }
  return all.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
}

export async function getLessonBundleLocally(
  courseId: string,
  lessonId: string
): Promise<{ lesson: string; tabs: Record<string, string> }> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      console.log(`[NativeStore] getLessonBundleLocally: reading "${courseId}/${lessonId}" from native filesystem...`);
      const res = await invoke<{
        course_id: string;
        lesson_id: string;
        lesson: string;
        tabs: Record<string, string>;
      }>('get_lesson_bundle', { courseId, lessonId });

      console.log(
        `[NativeStore] getLessonBundleLocally from filesystem: hasLesson=${Boolean(res.lesson)}, lessonLen=${res.lesson?.length || 0}, tabs=[${Object.keys(res.tabs || {}).join(', ')}]`
      );

      if (res.lesson || Object.keys(res.tabs || {}).length > 0) {
        return { lesson: res.lesson || '', tabs: res.tabs || {} };
      }
    } catch (err) {
      console.warn('[NativeStore] Native get_lesson_bundle failed, falling back to IDB:', err);
    }
  }

  // Fallback: IndexedDB search
  const cid = courseId.toLowerCase();
  const allDocs = await getAll<string>('documents');
  const prefix = `${cid}:`;

  const norm = (s: string) => {
    const m = s.toLowerCase().match(/^(\d+)\.(\d+)(.*)$/);
    return m ? `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}${m[3]}` : s.toLowerCase();
  };
  const targetNorm = norm(lessonId);
  const targetRaw = lessonId.toLowerCase();

  let lessonMd = '';
  const tabs: Record<string, string> = {};
  const matchedFiles: string[] = [];

  for (const { key, value } of allDocs) {
    if (!key.startsWith(prefix)) continue;
    const filename = key.slice(prefix.length);
    const m = filename.match(/^(.+)\.([^.]+)\.md$/i);
    if (!m) continue;
    const [, fileLessonId, fileTab] = m;
    const fileNorm = norm(fileLessonId);
    const fileRaw = fileLessonId.toLowerCase();

    if (fileNorm === targetNorm || fileRaw === targetRaw) {
      matchedFiles.push(filename);
      if (fileTab === 'lesson') {
        lessonMd = value;
      } else {
        tabs[fileTab] = value;
      }
    }
  }

  console.log(
    `[ClientStore] IDB fallback for "${courseId}/${lessonId}" (norm="${targetNorm}") -> matched ${matchedFiles.length} file(s) [${matchedFiles.join(', ')}], hasLesson=${Boolean(lessonMd)}, tabs=[${Object.keys(tabs).join(', ')}]`
  );

  return { lesson: lessonMd, tabs };
}

export async function getCachedCheckpoints(courseId: string): Promise<Checkpoint[]> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const list = await invoke<Checkpoint[]>('get_cached_checkpoints', { courseId });
      if (list && list.length > 0) return list;
    } catch (err) {
      console.warn('[NativeStore] get_cached_checkpoints failed:', err);
    }
  }

  return (await get<Checkpoint[]>('checkpoints', courseId.toLowerCase())) ?? [];
}

export async function getLlmStore(): Promise<ClientLlmStore | undefined> {
  return get<ClientLlmStore>('llm_config', 'store');
}

export async function listPrompts(): Promise<{ id: string; content: string }[]> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const list = await invoke<{ id: string; title: string; filename: string; content: string }[]>('list_prompts');
      if (list && list.length > 0) {
        console.log(`[NativeStore] listPrompts: read ${list.length} prompts from filesystem`);
        return list;
      }
    } catch (err) {
      console.warn('[NativeStore] list_prompts native call failed, falling back to IDB:', err);
    }
  }

  const rows = await getAll<{ id: string; content: string }>('prompts');
  return rows.map((r) => r.value);
}

export async function savePromptLocally(id: string, content: string): Promise<void> {
  const cleanId = id.trim().replace(/\.md$/, '');

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_prompt', { id: cleanId, content });
      return;
    } catch (err) {
      console.warn('[NativeStore] save_prompt native call failed, saving to IDB fallback:', err);
    }
  }

  await put('prompts', cleanId, { id: cleanId, content });
}

export async function deletePromptLocally(id: string): Promise<void> {
  const cleanId = id.trim().replace(/\.md$/, '');

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_prompt', { id: cleanId });
      return;
    } catch (err) {
      console.warn('[NativeStore] delete_prompt native call failed, deleting from IDB fallback:', err);
    }
  }

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('prompts', 'readwrite');
    tx.objectStore('prompts').delete(cleanId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function hasCachedData(): Promise<boolean> {
  try {
    const courses = await listCachedCourses();
    return courses.length > 0;
  } catch {
    return false;
  }
}

// ── Checkpoint writes (iPad-local, queued for push) ──────────────────────────

export async function saveCheckpointLocally(courseId: string, checkpoint: Checkpoint): Promise<void> {
  const id = courseId.toLowerCase();

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_checkpoint', { courseId: id, checkpoint });
      console.log(`[NativeStore] saveCheckpointLocally: saved checkpoint ${checkpoint.id} to filesystem`);
    } catch (err) {
      console.warn('[NativeStore] Native save_checkpoint failed:', err);
    }
  }

  const existing = await getCachedCheckpoints(id);
  const idx = existing.findIndex((c) => c.id === checkpoint.id);
  if (idx !== -1) {
    existing[idx] = checkpoint;
  } else {
    existing.push(checkpoint);
  }
  await put('checkpoints', id, existing);

  // Also add/update in pending_push queue
  const pending = (await get<Checkpoint[]>('pending_push', id)) ?? [];
  const pi = pending.findIndex((c) => c.id === checkpoint.id);
  if (pi !== -1) {
    pending[pi] = checkpoint;
  } else {
    pending.push(checkpoint);
  }
  await put('pending_push', id, pending);
}

export async function deleteCheckpointLocally(courseId: string, checkpointId: string): Promise<void> {
  const id = courseId.toLowerCase();

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_checkpoint', { courseId: id, checkpointId });
    } catch (err) {
      console.warn('[NativeStore] Native delete_checkpoint failed:', err);
    }
  }

  const existing = await getCachedCheckpoints(id);
  await put('checkpoints', id, existing.filter((c) => c.id !== checkpointId));

  const pending = (await get<Checkpoint[]>('pending_push', id)) ?? [];
  await put('pending_push', id, pending.filter((c) => c.id !== checkpointId));
}

export async function getPendingPushPayload(): Promise<Record<string, Checkpoint[]>> {
  try {
    const rows = await getAll<Checkpoint[]>('pending_push');
    const result: Record<string, Checkpoint[]> = {};
    for (const { key, value } of rows) {
      if (value && value.length > 0) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function clearPendingPush(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_push', 'pending_push_annotations'], 'readwrite');
    tx.objectStore('pending_push').clear();
    tx.objectStore('pending_push_annotations').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Markup annotations (iPad-local, queued for push) ─────────────────────────

async function writeAnnotationsNative(courseId: string, strokes: MarkupStroke[]): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_annotations', { courseId, strokesJson: JSON.stringify(strokes) });
  } catch (err) {
    console.warn('[NativeStore] Native save_annotations failed:', err);
  }
}

export async function getAnnotationsLocally(courseId: string): Promise<MarkupStroke[]> {
  const id = courseId.toLowerCase();
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const json = await invoke<string | null>('get_annotations', { courseId: id });
      if (json) {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) return parsed.filter(isMarkupStroke);
      }
      return [];
    } catch (err) {
      console.warn('[NativeStore] get_annotations failed:', err);
    }
  }
  return (await get<MarkupStroke[]>('annotations', id)) ?? [];
}

export async function saveAnnotationsLocally(courseId: string, upserts: MarkupStroke[]): Promise<void> {
  const id = courseId.toLowerCase();
  const valid = upserts.filter(isMarkupStroke);
  if (valid.length === 0) return;

  const existing = await getAnnotationsLocally(id);
  const merged = mergeStrokes(existing, valid).strokes;

  await writeAnnotationsNative(id, merged);
  await put('annotations', id, merged);

  // Queue the upserts for the next push to desktop (tombstones included)
  const pending = (await get<MarkupStroke[]>('pending_push_annotations', id)) ?? [];
  for (const s of valid) {
    const i = pending.findIndex((p) => p.id === s.id);
    if (i !== -1) pending[i] = s;
    else pending.push(s);
  }
  await put('pending_push_annotations', id, pending);
}

export async function getPendingPushAnnotations(): Promise<Record<string, MarkupStroke[]>> {
  try {
    const rows = await getAll<MarkupStroke[]>('pending_push_annotations');
    const result: Record<string, MarkupStroke[]> = {};
    for (const { key, value } of rows) {
      if (value && value.length > 0) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}
