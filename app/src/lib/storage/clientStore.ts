// app/src/lib/storage/clientStore.ts
// Native Filesystem + IndexedDB fallback store for CourseDeck iPad offline mode.

import type { CourseManifest } from '$lib/parser/courseIngest';
import { derivePdfMarkupCheckpoints, type Checkpoint } from '$lib/checkpoint';
import { mergeStrokes } from '$lib/markup/render';
import { isMarkupStroke, type MarkupStroke } from '$lib/markup/types';
import { invoke } from '@tauri-apps/api/core';

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
const DB_VERSION = 4;

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
  'pending_push_documents',
  'pending_push_prompts',
  'pending_push_assets',
  'locker_docs',
  'pdf_assets'
] as const;

/** A locally-written course file waiting to be pushed to the desktop. `content: null` = deleted locally (tombstone). */
export interface PendingPushDocument {
  filename: string;
  content: string | null;
  date: string; // ISO timestamp of the local write
}

/** A locally-written prompt waiting to be pushed to the desktop. `content: null` = deleted locally (tombstone). */
export interface PendingPushPrompt {
  id: string;
  content: string | null;
  date: string;
}

/**
 * Fired on `window` whenever a local write lands in a pending-push queue, so
 * syncState can schedule a debounced background flush without a circular import.
 */
export const PUSH_QUEUED_EVENT = 'coursedeck:push-queued';

function notifyPushQueued(): void {
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(PUSH_QUEUED_EVENT));
    } catch {}
  }
}

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

async function deleteFromStore(store: typeof STORES[number], key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
      await invoke('save_course_doc', { courseId, filename: 'meta.json', content: json });
      await invoke('save_course_doc', { courseId, filename: 'manifest.json', content: json });
      console.log(`[NativeStore] saveCourseManifestLocally: wrote manifest for "${courseId}" directly to filesystem`);
    } catch (err) {
      console.warn('[NativeStore] saveCourseManifestLocally failed:', err);
    }
  }
  await put('courses', courseId.toLowerCase(), manifest);
  await queuePendingDocument(courseId, 'meta.json', json);
}

export async function deleteCourseLocally(courseId: string): Promise<void> {
  const id = courseId.toLowerCase();
  if (isTauri()) {
    try {
      await invoke('delete_course', { courseId: id });
      console.log(`[NativeStore] deleteCourseLocally: deleted course "${id}" from filesystem`);
    } catch (err) {
      console.warn('[NativeStore] Native delete_course failed:', err);
    }
  }

  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      ['courses', 'documents', 'checkpoints', 'annotations', 'pending_push', 'pending_push_annotations', 'pending_push_documents', 'pending_push_assets', 'locker_docs'],
      'readwrite'
    );
    tx.objectStore('courses').delete(id);
    tx.objectStore('checkpoints').delete(id);
    tx.objectStore('annotations').delete(id);
    tx.objectStore('pending_push').delete(id);
    tx.objectStore('pending_push_annotations').delete(id);
    tx.objectStore('pending_push_documents').delete(id);
    tx.objectStore('pending_push_assets').delete(id);

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

    const lockerStore = tx.objectStore('locker_docs');
    const lockerReq = lockerStore.openCursor();
    lockerReq.onsuccess = (e) => {
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
      await invoke('save_course_doc', { courseId, filename, content });
      console.log(`[NativeStore] saveDocumentLocally: wrote "${filename}" for "${courseId}" directly to filesystem`);
    } catch (err) {
      console.warn('[NativeStore] save_course_doc failed:', err);
    }
  }

  await put('documents', `${courseId.toLowerCase()}:${filename}`, content);
  await queuePendingDocument(courseId, filename, content);
}

export async function deleteDocumentLocally(courseId: string, filename: string): Promise<boolean> {
  let removed = false;
  if (isTauri()) {
    try {
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

  await queuePendingDocument(courseId, filename, null);
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
      await invoke('save_prompt', { id: cleanId, content });
    } catch (err) {
      console.warn('[NativeStore] save_prompt native call failed, saving to IDB fallback:', err);
      await put('prompts', cleanId, { id: cleanId, content });
    }
  } else {
    await put('prompts', cleanId, { id: cleanId, content });
  }

  await queuePendingPrompt(cleanId, content);
}

export async function deletePromptLocally(id: string): Promise<void> {
  const cleanId = id.trim().replace(/\.md$/, '');

  if (isTauri()) {
    try {
      await invoke('delete_prompt', { id: cleanId });
    } catch (err) {
      console.warn('[NativeStore] delete_prompt native call failed, deleting from IDB fallback:', err);
      await deleteFromStore('prompts', cleanId);
    }
  } else {
    await deleteFromStore('prompts', cleanId);
  }

  await queuePendingPrompt(cleanId, null);
}

// ── Groups (offline groups.json storage) ────────────────────────────────────

export interface ClientGroupItem {
  id: string;
  name: string;
  type: string;
}

let _memoryGroupsJson = '[]';

function slugifyGroup(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `group-${Date.now().toString(36)}`
  );
}

export async function getAllGroupsLocally(): Promise<ClientGroupItem[]> {
  let raw = '';
  if (isTauri()) {
    try {
      raw = await invoke<string>('get_groups_json');
    } catch (err) {
      console.warn('[NativeStore] get_groups_json failed, falling back to local storage:', err);
    }
  }

  if (!raw) {
    if (typeof localStorage !== 'undefined') {
      raw = localStorage.getItem('coursedeck_groups_json') || '';
    } else {
      raw = _memoryGroupsJson;
    }
  }

  let items: ClientGroupItem[] = [];
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        items = parsed
          .filter((item) => item && typeof item === 'object' && typeof item.name === 'string')
          .map((item) => ({
            id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : slugifyGroup(item.name),
            name: String(item.name).trim(),
            type: typeof item.type === 'string' && item.type.trim() ? item.type.trim().toLowerCase() : 'course'
          }));
      }
    } catch (e) {
      console.warn('[ClientStore] Failed to parse groups.json:', e);
    }
  }

  // If no groups yet found, discover from cached courses
  if (items.length === 0) {
    try {
      const courses = await listCachedCourses();
      const discovered = new Set<string>();
      for (const c of courses) {
        if (c.group && c.group.trim()) {
          const gName = c.group.trim();
          if (!discovered.has(gName.toLowerCase())) {
            discovered.add(gName.toLowerCase());
            items.push({
              id: slugifyGroup(gName),
              name: gName,
              type: 'course'
            });
          }
        }
      }
      if (items.length > 0) {
        await saveGroupsLocally(items);
      }
    } catch {}
  }

  return items;
}

export async function saveGroupsLocally(groups: ClientGroupItem[]): Promise<void> {
  const json = JSON.stringify(groups, null, 2);
  if (isTauri()) {
    try {
      await invoke('save_groups_json', { content: json });
      console.log(`[NativeStore] saveGroupsLocally: saved ${groups.length} groups to filesystem`);
    } catch (err) {
      console.warn('[NativeStore] save_groups_json failed:', err);
    }
  }

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('coursedeck_groups_json', json);
  }
  _memoryGroupsJson = json;
}

export async function getGroupsLocally(type?: string): Promise<ClientGroupItem[]> {
  const all = await getAllGroupsLocally();
  if (!type) return all;
  const cleanType = type.toLowerCase().trim();
  return all.filter((g) => g.type.toLowerCase() === cleanType);
}

export async function getGroupNamesLocally(type?: string): Promise<string[]> {
  const groups = await getGroupsLocally(type);
  return groups.map((g) => g.name);
}

export async function addGroupLocally(
  type: string,
  name: string
): Promise<{ group: ClientGroupItem; groups: ClientGroupItem[] }> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Group name cannot be empty');
  }
  const cleanType = (type || 'course').toLowerCase().trim();
  const all = await getAllGroupsLocally();

  const existing = all.find(
    (g) => g.type.toLowerCase() === cleanType && g.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (existing) {
    return { group: existing, groups: all };
  }

  const newItem: ClientGroupItem = {
    id: slugifyGroup(trimmed),
    name: trimmed,
    type: cleanType
  };
  all.push(newItem);
  await saveGroupsLocally(all);
  return { group: newItem, groups: all };
}

export async function renameGroupLocally(
  type: string,
  oldName: string,
  newName: string
): Promise<{ groups: ClientGroupItem[]; updatedCount: number }> {
  const trimmedOld = oldName.trim();
  const trimmedNew = newName.trim();
  if (!trimmedOld || !trimmedNew) {
    throw new Error('Both oldName and newName are required');
  }
  const cleanType = (type || 'course').toLowerCase().trim();
  const all = await getAllGroupsLocally();

  const target = all.find(
    (g) => g.type.toLowerCase() === cleanType && g.name.toLowerCase() === trimmedOld.toLowerCase()
  );
  if (target) {
    target.name = trimmedNew;
  } else {
    all.push({
      id: slugifyGroup(trimmedNew),
      name: trimmedNew,
      type: cleanType
    });
  }

  await saveGroupsLocally(all);

  let updatedCount = 0;
  if (cleanType === 'course') {
    try {
      const courses = await listCachedCourses();
      for (const c of courses) {
        if (c.group && c.group.trim().toLowerCase() === trimmedOld.toLowerCase()) {
          c.group = trimmedNew;
          await saveCourseManifestLocally(c.id, c);
          updatedCount++;
        }
      }
    } catch (err) {
      console.warn('[ClientStore] Failed to update course manifests after group rename:', err);
    }
  }

  return { groups: all, updatedCount };
}

export async function deleteGroupLocally(
  type: string,
  name: string,
  clearEntities = true
): Promise<{ groups: ClientGroupItem[]; updatedCount: number }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Group name cannot be empty');
  const cleanType = (type || 'course').toLowerCase().trim();
  const all = await getAllGroupsLocally();

  const filtered = all.filter(
    (g) => !(g.type.toLowerCase() === cleanType && g.name.toLowerCase() === trimmed.toLowerCase())
  );
  await saveGroupsLocally(filtered);

  let updatedCount = 0;
  if (cleanType === 'course' && clearEntities) {
    try {
      const courses = await listCachedCourses();
      for (const c of courses) {
        if (c.group && c.group.trim().toLowerCase() === trimmed.toLowerCase()) {
          delete c.group;
          await saveCourseManifestLocally(c.id, c);
          updatedCount++;
        }
      }
    } catch (err) {
      console.warn('[ClientStore] Failed to clear group in course manifests after deletion:', err);
    }
  }

  return { groups: filtered, updatedCount };
}

export async function reorderGroupsLocally(type: string, names: string[]): Promise<string[]> {
  const cleanType = (type || 'course').toLowerCase().trim();
  const all = await getAllGroupsLocally();

  const otherGroups = all.filter((g) => g.type.toLowerCase() !== cleanType);
  const currentTyped = all.filter((g) => g.type.toLowerCase() === cleanType);

  const reordered: ClientGroupItem[] = [];
  const seen = new Set<string>();

  for (const n of names) {
    const trimmed = typeof n === 'string' ? n.trim() : '';
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    const existing = currentTyped.find((g) => g.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      reordered.push(existing);
    } else {
      reordered.push({
        id: slugifyGroup(trimmed),
        name: trimmed,
        type: cleanType
      });
    }
  }

  for (const g of currentTyped) {
    if (!seen.has(g.name.toLowerCase())) {
      reordered.push(g);
    }
  }

  const finalGroups = [...reordered, ...otherGroups];
  await saveGroupsLocally(finalGroups);
  return reordered.map((g) => g.name);
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
  notifyPushQueued();
}

export async function deleteCheckpointLocally(courseId: string, checkpointId: string): Promise<void> {
  const id = courseId.toLowerCase();

  if (isTauri()) {
    try {
      await invoke('delete_checkpoint', { courseId: id, checkpointId });
    } catch (err) {
      console.warn('[NativeStore] Native delete_checkpoint failed:', err);
    }
  }

  const existing = await getCachedCheckpoints(id);
  await put('checkpoints', id, existing.filter((c) => c.id !== checkpointId));

  // Queue a tombstone so the delete propagates to the desktop on the next
  // push (a plain queue-filter would silently resurrect the checkpoint).
  const tombstone: Checkpoint = {
    id: checkpointId,
    file: '',
    verticalPosition: 0,
    type: 'note',
    date: new Date().toISOString(),
    deleted: true
  };
  const pending = (await get<Checkpoint[]>('pending_push', id)) ?? [];
  const pi = pending.findIndex((c) => c.id === checkpointId);
  if (pi !== -1) {
    pending[pi] = tombstone;
  } else {
    pending.push(tombstone);
  }
  await put('pending_push', id, pending);
  notifyPushQueued();
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

// ── Document & prompt push queues (local writes → desktop) ───────────────────

async function queuePendingDocument(courseId: string, filename: string, content: string | null): Promise<void> {
  const id = courseId.toLowerCase();
  const entry: PendingPushDocument = { filename, content, date: new Date().toISOString() };
  const pending = (await get<PendingPushDocument[]>('pending_push_documents', id)) ?? [];
  const i = pending.findIndex((d) => d.filename === filename);
  if (i !== -1) {
    pending[i] = entry;
  } else {
    pending.push(entry);
  }
  await put('pending_push_documents', id, pending);
  notifyPushQueued();
}

async function queuePendingPrompt(id: string, content: string | null): Promise<void> {
  const entry: PendingPushPrompt = { id, content, date: new Date().toISOString() };
  const pending = (await get<PendingPushPrompt[]>('pending_push_prompts', 'prompts')) ?? [];
  const i = pending.findIndex((p) => p.id === id);
  if (i !== -1) {
    pending[i] = entry;
  } else {
    pending.push(entry);
  }
  await put('pending_push_prompts', 'prompts', pending);
  notifyPushQueued();
}

export async function getPendingPushDocuments(): Promise<Record<string, PendingPushDocument[]>> {
  try {
    const rows = await getAll<PendingPushDocument[]>('pending_push_documents');
    const result: Record<string, PendingPushDocument[]> = {};
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

export async function getPendingPushPrompts(): Promise<PendingPushPrompt[]> {
  try {
    return (await get<PendingPushPrompt[]>('pending_push_prompts', 'prompts')) ?? [];
  } catch {
    return [];
  }
}

// ── Locker docs (course assets/locker_docs — always local) ───────────────────

/** Same shape the server returns for GET /api/courses/:id/locker-docs. */
export interface LockerDocItem {
  filename: string;
  size: number;
  updatedAt: string;
  url: string;
  ext: string;
}

/** A locally-uploaded locker doc waiting to be pushed to the desktop. `base64: null` = tombstone. */
export interface PendingPushAsset {
  filename: string;
  base64: string | null;
  size: number;
  date: string;
}

/** Assets above this size are kept local-only (a textbook PDF has no business in the JSON push). */
const MAX_PUSH_ASSET_BYTES = 25 * 1024 * 1024;

function lockerDocItem(courseId: string, filename: string, size: number, updatedAtMs: number): LockerDocItem {
  const dot = filename.lastIndexOf('.');
  return {
    filename,
    size,
    updatedAt: new Date(updatedAtMs || Date.now()).toISOString(),
    url: `/api/courses/${courseId}/assets/locker_docs/${encodeURIComponent(filename)}`,
    ext: dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function listLockerDocsLocally(courseId: string): Promise<LockerDocItem[]> {
  if (isTauri()) {
    try {
      const entries = await invoke<Array<{ filename: string; size: number; mtime_ms: number }>>(
        'list_locker_docs',
        { courseId }
      );
      if (Array.isArray(entries)) {
        return entries.map((e) => lockerDocItem(courseId, e.filename, e.size, e.mtime_ms));
      }
    } catch (err) {
      console.warn('[NativeStore] list_locker_docs failed, falling back to IDB:', err);
    }
  }

  const prefix = `${courseId.toLowerCase()}:`;
  const rows = await getAll<{ filename: string; size: number; savedAt: number }>('locker_docs');
  return rows
    .filter((r) => r.key.startsWith(prefix))
    .map((r) => lockerDocItem(courseId, r.value.filename, r.value.size, r.value.savedAt))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function saveLockerDocLocally(
  courseId: string,
  filename: string,
  bytes: ArrayBuffer
): Promise<LockerDocItem> {
  const safeName = filename.split('/').pop() || filename;
  let item = lockerDocItem(courseId, safeName, bytes.byteLength, Date.now());

  if (isTauri()) {
    try {
      const entry = await invoke<{ filename: string; size: number; mtime_ms: number }>(
        'save_locker_doc',
        { courseId, filename: safeName, base64Data: arrayBufferToBase64(bytes) }
      );
      item = lockerDocItem(courseId, entry.filename, entry.size, entry.mtime_ms);
    } catch (err) {
      console.warn('[NativeStore] save_locker_doc failed:', err);
    }
  }

  await put('locker_docs', `${courseId.toLowerCase()}:${item.filename}`, {
    filename: item.filename,
    size: item.size,
    savedAt: Date.now(),
    buffer: bytes
  });

  // Queue for push to desktop (tombstones included); oversized files stay local-only.
  const id = courseId.toLowerCase();
  const pending = (await get<PendingPushAsset[]>('pending_push_assets', id)) ?? [];
  const pi = pending.findIndex((a) => a.filename === item.filename);
  if (item.size > MAX_PUSH_ASSET_BYTES) {
    console.warn(`[NativeStore] locker doc "${item.filename}" (${item.size} bytes) exceeds push limit — kept local-only`);
    if (pi !== -1) pending.splice(pi, 1);
  } else {
    const entry: PendingPushAsset = {
      filename: item.filename,
      base64: arrayBufferToBase64(bytes),
      size: item.size,
      date: new Date().toISOString()
    };
    if (pi !== -1) pending[pi] = entry;
    else pending.push(entry);
  }
  await put('pending_push_assets', id, pending);
  notifyPushQueued();
  return item;
}

export async function deleteLockerDocLocally(courseId: string, filename: string): Promise<boolean> {
  const safeName = filename.split('/').pop() || filename;
  let removed = false;
  if (isTauri()) {
    try {
      removed = await invoke<boolean>('delete_locker_doc', { courseId, filename: safeName });
    } catch (err) {
      console.warn('[NativeStore] delete_locker_doc failed:', err);
    }
  }

  await deleteFromStore('locker_docs', `${courseId.toLowerCase()}:${safeName}`);

  const id = courseId.toLowerCase();
  const pending = (await get<PendingPushAsset[]>('pending_push_assets', id)) ?? [];
  const pi = pending.findIndex((a) => a.filename === safeName);
  const tombstone: PendingPushAsset = { filename: safeName, base64: null, size: 0, date: new Date().toISOString() };
  if (pi !== -1) pending[pi] = tombstone;
  else pending.push(tombstone);
  await put('pending_push_assets', id, pending);
  notifyPushQueued();
  return removed;
}

export async function getPendingPushAssets(): Promise<Record<string, PendingPushAsset[]>> {
  try {
    const rows = await getAll<PendingPushAsset[]>('pending_push_assets');
    const result: Record<string, PendingPushAsset[]> = {};
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
    const tx = db.transaction(
      ['pending_push', 'pending_push_annotations', 'pending_push_documents', 'pending_push_prompts', 'pending_push_assets'],
      'readwrite'
    );
    tx.objectStore('pending_push').clear();
    tx.objectStore('pending_push_annotations').clear();
    tx.objectStore('pending_push_documents').clear();
    tx.objectStore('pending_push_prompts').clear();
    tx.objectStore('pending_push_assets').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Markup annotations (iPad-local, queued for push) ─────────────────────────

async function writeAnnotationsNative(courseId: string, strokes: MarkupStroke[]): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('save_annotations', { courseId, strokesJson: JSON.stringify(strokes) });
  } catch (err) {
    console.warn('[NativeStore] Native save_annotations failed:', err);
  }
}

export async function getAnnotationsLocally(courseId: string): Promise<MarkupStroke[]> {
  const id = courseId.toLowerCase();
  if (isTauri()) {
    try {
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
  notifyPushQueued();
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
