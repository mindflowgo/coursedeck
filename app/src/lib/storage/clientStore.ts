// app/src/lib/storage/clientStore.ts
// Native Filesystem + IndexedDB fallback store for CourseDeck iPad offline mode.

import type { CourseManifest } from '$lib/parser/courseIngest';
import { derivePdfMarkupCheckpoints, type Checkpoint } from '$lib/checkpoint';
import { mergeStrokes } from '$lib/markup/render';
import { isMarkupStroke, type MarkupStroke } from '$lib/markup/types';
import { invoke } from '@tauri-apps/api/core';
import { AnnotationSourceConflictError, annotationSourceFile, assertAnnotationAnchorIds, instrumentMarkdownAnchors, validateAnnotationSourceFile, type AnnotationRenderer } from '../checkpoint/sourceAnchors';
import { instrumentHtmlAnchors, stripHtmlAnchorMetadata } from '../checkpoint/htmlSourceAnchors';

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
const DB_VERSION = 5;

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
  'locker_docs'
] as const;

/** A locally-written course file waiting to be pushed to the desktop. `content: null` = deleted locally (tombstone). */
export interface PendingPushDocument {
  filename: string;
  content: string | null;
  date: string; // ISO timestamp of the local write
  /** HTML migration may add anchors, never overwrite changed instructional content. */
  annotationSourceBase?: string;
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
      // v5: IndexedDB keeps metadata/sync-tracking only — never file content.
      // Purge the legacy caches that used to hold bytes (pdf_assets blobs,
      // locker_docs buffers, base64 push payloads).
      if (e.oldVersion > 0 && e.oldVersion < 5) {
        for (const stale of ['pdf_assets', 'locker_docs', 'pending_push_assets']) {
          if (db.objectStoreNames.contains(stale)) {
            db.deleteObjectStore(stale);
          }
        }
      }
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
      await invoke('save_course_doc', { courseId, filename: '.manifest.json', content: json });
      console.log(`[NativeStore] saveCourseManifestLocally: wrote manifest for "${courseId}" directly to filesystem`);
    } catch (err) {
      console.warn('[NativeStore] saveCourseManifestLocally failed:', err);
    }
  }
  await put('courses', courseId.toLowerCase(), manifest);
  await queuePendingDocument(courseId, '.manifest.json', json);
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

export interface AnnotationSourceDocument {
  sourceFile: string;
  content: string;
  renderer: AnnotationRenderer;
}

/** A failed native migration is an error, never an IDB-only success. */
export async function prepareAnnotationSourceLocally(courseId: string, file: string, renderer: AnnotationRenderer, requiredIds: string[] = []): Promise<AnnotationSourceDocument | null> {
  validateAnnotationSourceFile(file);
  if (!/^[A-Za-z0-9_-]+$/.test(courseId)) throw new Error('Invalid course identifier');
  let source: AnnotationSourceDocument | null;
  const native = isTauri();
  if (native) {
    source = await invoke<AnnotationSourceDocument | null>('read_annotation_source', { courseId, file, renderer });
  } else {
    const stem = file.replace(/\.lesson\.(?:md|html)$/, '');
    const prefix = `${courseId.toLowerCase()}:`;
    const hasOriginal = (await get('documents', `${prefix}${stem}.lesson.html`)) !== undefined || (await get('documents', `${prefix}${stem}.lesson.pdf`)) !== undefined;
    const sourceFile = annotationSourceFile(file, renderer, hasOriginal);
    const content = await get<string>('documents', `${prefix}${sourceFile}`);
    source = content === undefined ? null : { sourceFile, content, renderer };
  }
  if (!source) return null;
  const content = renderer === 'html' ? instrumentHtmlAnchors(source.content) : instrumentMarkdownAnchors(source.content);
  assertAnnotationAnchorIds(content, renderer, requiredIds);
  if (native) {
    try {
      await invoke('save_annotation_source', { courseId, sourceFile: source.sourceFile, expectedContent: source.content, content });
    } catch (err) {
      if (String(err).includes('Annotation source changed')) throw new AnnotationSourceConflictError(String(err));
      throw err;
    }
  }
  const db = await openDb();
  const id = courseId.toLowerCase();
  const key = `${id}:${source.sourceFile}`;
  // Store the migrated source and its sync record in one transaction. Check
  // the browser's source again while holding its read/write transaction.
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['documents', 'pending_push_documents'], 'readwrite');
    const documents = tx.objectStore('documents');
    const current = documents.get(key);
    current.onsuccess = () => {
      if (!native && current.result !== source.content) { tx.abort(); return; }
      const pendingStore = tx.objectStore('pending_push_documents');
      const pendingRequest = pendingStore.get(id);
      pendingRequest.onsuccess = () => {
        const pending: PendingPushDocument[] = pendingRequest.result || [];
        // A previous native save may have succeeded before this transaction
        // failed. Recreate its queue entry whenever IDB still has old content.
        const previous = pending.find((item) => item.filename === source.sourceFile);
        if (current.result === content && (renderer !== 'html' || (previous?.content === content && previous.annotationSourceBase !== undefined))) return;
        documents.put(content, key);
        const updated = pending.filter((item) => item.filename !== source.sourceFile);
        updated.push({ filename: source.sourceFile, content, date: new Date().toISOString(), ...(renderer === 'html' ? { annotationSourceBase: previous?.annotationSourceBase ?? stripHtmlAnchorMetadata(source.content) } : {}) });
        pendingStore.put(updated, id);
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new AnnotationSourceConflictError('Annotation source changed; retry the annotation'));
  });
  notifyPushQueued();
  return { ...source, content };
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
      if (cp.type === 'note' || cp.type === 'highlight' || cp.type === 'ai') {
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
): Promise<{
  lesson: string;
  tabs: Record<string, string>;
  format?: 'markdown' | 'html' | 'pdf' | 'video';
  hasCompanion?: boolean;
}> {
  if (isTauri()) {
    try {
      console.log(`[NativeStore] getLessonBundleLocally: reading "${courseId}/${lessonId}" from native filesystem...`);
      const res = await invoke<{
        course_id: string;
        lesson_id: string;
        lesson: string;
        tabs: Record<string, string>;
        format?: string;
        has_companion?: boolean;
      }>('get_lesson_bundle', { courseId, lessonId });

      console.log(
        `[NativeStore] getLessonBundleLocally from filesystem: hasLesson=${Boolean(res.lesson)}, lessonLen=${res.lesson?.length || 0}, format=${res.format}, tabs=[${Object.keys(res.tabs || {}).join(', ')}]`
      );

      if (res.lesson || Object.keys(res.tabs || {}).length > 0 || res.format) {
        return {
          lesson: res.lesson || '',
          tabs: res.tabs || {},
          format: (res.format as any) || 'markdown',
          hasCompanion: Boolean(res.has_companion)
        };
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

  return { lesson: lessonMd, tabs, format: 'markdown', hasCompanion: false };
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
  } else if (cleanType === 'library') {
    try {
      const manifest = await getLibraryManifestLocally();
      let changed = false;
      for (const d of manifest.documents) {
        if (d.group && d.group.trim().toLowerCase() === trimmedOld.toLowerCase()) {
          d.group = trimmedNew;
          changed = true;
          updatedCount++;
        }
      }
      if (changed) {
        await saveLibraryManifestLocally(manifest);
      }
    } catch (err) {
      console.warn('[ClientStore] Failed to update library manifest after group rename:', err);
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
  } else if (cleanType === 'library' && clearEntities) {
    try {
      const manifest = await getLibraryManifestLocally();
      let changed = false;
      for (const d of manifest.documents) {
        if (d.group && d.group.trim().toLowerCase() === trimmed.toLowerCase()) {
          delete d.group;
          changed = true;
          updatedCount++;
        }
      }
      if (changed) {
        await saveLibraryManifestLocally(manifest);
      }
    } catch (err) {
      console.warn('[ClientStore] Failed to clear group in library manifest after deletion:', err);
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

/**
 * A locally-uploaded locker doc waiting to be pushed to the desktop.
 * Tracking metadata only — the bytes stay on disk and are read at push time
 * (readLockerDocBytes). `deleted: true` = tombstone.
 */
export interface PendingPushAsset {
  filename: string;
  deleted?: boolean;
  size: number;
  date: string;
}

/** Assets above this size are kept local-only (a textbook PDF has no business in the push). */
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

/**
 * Writes a locker doc straight to the device's own filesystem. The bytes are
 * sent as the raw IPC body — no base64 inflation — with `course-id` and the
 * percent-encoded `filename` as headers. IndexedDB keeps only the tracking
 * entry (no file content).
 */
export async function saveLockerDocLocally(
  courseId: string,
  filename: string,
  bytes: ArrayBuffer
): Promise<LockerDocItem> {
  const safeName = filename.split('/').pop() || filename;
  const entry = await invoke<{ filename: string; size: number; mtime_ms: number }>(
    'save_locker_doc',
    bytes,
    { headers: { 'course-id': courseId.toLowerCase(), filename: encodeURIComponent(safeName) } }
  );
  const item = lockerDocItem(courseId, entry.filename, entry.size, entry.mtime_ms);

  await put('locker_docs', `${courseId.toLowerCase()}:${item.filename}`, {
    filename: item.filename,
    size: item.size,
    savedAt: Date.now()
  });

  // Queue for push to desktop (tombstones included); oversized files stay local-only.
  const id = courseId.toLowerCase();
  const pending = (await get<PendingPushAsset[]>('pending_push_assets', id)) ?? [];
  const pi = pending.findIndex((a) => a.filename === item.filename);
  if (item.size > MAX_PUSH_ASSET_BYTES) {
    console.warn(`[NativeStore] locker doc "${item.filename}" (${item.size} bytes) exceeds push limit — kept local-only`);
    if (pi !== -1) pending.splice(pi, 1);
  } else {
    const tracking: PendingPushAsset = {
      filename: item.filename,
      size: item.size,
      date: new Date().toISOString()
    };
    if (pi !== -1) pending[pi] = tracking;
    else pending.push(tracking);
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
  const tombstone: PendingPushAsset = { filename: safeName, deleted: true, size: 0, date: new Date().toISOString() };
  if (pi !== -1) pending[pi] = tombstone;
  else pending.push(tombstone);
  await put('pending_push_assets', id, pending);
  notifyPushQueued();
  return removed;
}

/** Raw bytes of a locally stored locker doc — read from disk at push time. */
export async function readLockerDocBytes(courseId: string, filename: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('read_locker_doc', { courseId, filename });
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

/** Clears text entity pending push queues after successful batch push (checkpoints, annotations, docs, prompts). */
export async function clearPendingPushText(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['pending_push', 'pending_push_annotations', 'pending_push_documents', 'pending_push_prompts'],
      'readwrite'
    );
    tx.objectStore('pending_push').clear();
    tx.objectStore('pending_push_annotations').clear();
    tx.objectStore('pending_push_documents').clear();
    tx.objectStore('pending_push_prompts').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Removes an individual asset entry from the pending push queue upon successful upload/delete. */
export async function removePendingPushAsset(courseId: string, filename: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_push_assets', 'readwrite');
    const store = tx.objectStore('pending_push_assets');
    const key = courseId.toLowerCase();
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const list = (getReq.result as PendingPushAsset[]) || [];
      const updated = list.filter((e) => e.filename.toLowerCase() !== filename.toLowerCase());
      if (updated.length > 0) {
        store.put(updated, key);
      } else {
        store.delete(key);
      }
    };
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

// ── Library (offline /library storage) ──────────────────────────────────────

export interface ClientLibraryDocument {
  id: string;
  filename: string;
  format: 'pdf' | 'epub' | 'mobi';
  title: string;
  description: string;
  additionDate: string;
  thumbnail?: string;
  pages?: number;
  lastPage?: number;
  fileSize?: number;
  position: number;
  group?: string;
}

export interface ClientLibraryManifest {
  version: number;
  documents: ClientLibraryDocument[];
}

export async function getLibraryManifestLocally(): Promise<ClientLibraryManifest> {
  if (isTauri()) {
    try {
      const raw = await invoke<string>('get_library_manifest');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return { version: 1, documents: parsed };
        }
        if (parsed && Array.isArray(parsed.documents)) {
          return { version: parsed.version || 1, documents: parsed.documents };
        }
      }
    } catch (err) {
      console.warn('[NativeStore] get_library_manifest failed, falling back to IDB:', err);
    }
  }

  const cached = await get<ClientLibraryManifest>('meta', 'library_manifest');
  return cached ?? { version: 1, documents: [] };
}

export async function saveLibraryManifestLocally(manifest: ClientLibraryManifest): Promise<void> {
  const json = JSON.stringify(manifest, null, 2);
  if (isTauri()) {
    try {
      await invoke('save_library_manifest', { content: json });
    } catch (err) {
      console.warn('[NativeStore] save_library_manifest failed:', err);
    }
  }
  await put('meta', 'library_manifest', manifest);
}

export async function getLibraryAnnotationsLocally(): Promise<MarkupStroke[]> {
  if (isTauri()) {
    try {
      const raw = await invoke<string | null>('get_library_annotations');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(isMarkupStroke);
      }
      return [];
    } catch (err) {
      console.warn('[NativeStore] get_library_annotations failed, falling back to IDB:', err);
    }
  }
  return (await get<MarkupStroke[]>('annotations', '__library__')) ?? [];
}

export async function saveLibraryAnnotationsLocally(strokes: MarkupStroke[]): Promise<void> {
  const json = JSON.stringify(strokes, null, 2);
  if (isTauri()) {
    try {
      await invoke('save_library_annotations', { content: json });
    } catch (err) {
      console.warn('[NativeStore] save_library_annotations failed:', err);
    }
  }
  await put('annotations', '__library__', strokes);
}

export async function getLibraryCheckpointsLocally(): Promise<Checkpoint[]> {
  if (isTauri()) {
    try {
      const raw = await invoke<string>('get_library_checkpoints');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.warn('[NativeStore] get_library_checkpoints failed, falling back to IDB:', err);
    }
  }
  return (await get<Checkpoint[]>('checkpoints', '__library__')) ?? [];
}

export async function saveLibraryCheckpointsLocally(checkpoints: Checkpoint[]): Promise<void> {
  const json = JSON.stringify(checkpoints, null, 2);
  if (isTauri()) {
    try {
      await invoke('save_library_checkpoints', { content: json });
    } catch (err) {
      console.warn('[NativeStore] save_library_checkpoints failed:', err);
    }
  }
  await put('checkpoints', '__library__', checkpoints);
}

export interface LibraryDocEntry {
  filename: string;
  size: number;
  mtime_ms: number;
}

/**
 * Writes an uploaded library document straight to the device's own /library
 * directory. The bytes are sent as the raw IPC body — no base64 inflation —
 * and the filename travels percent-encoded in a header (header values are
 * ASCII-only).
 */
export async function saveLibraryDocLocally(
  filename: string,
  bytes: ArrayBuffer
): Promise<LibraryDocEntry> {
  const safeName = filename.split('/').pop() || filename;
  return invoke<LibraryDocEntry>('save_library_doc', bytes, {
    headers: { filename: encodeURIComponent(safeName) }
  });
}

/**
 * Raw /library directory listing so callers can reconcile the manifest with
 * disk. Returns null when no listing is available — never an empty array on
 * failure — so callers never mistake "command failed" for "directory is
 * empty" and prune a healthy manifest.
 */
export async function listLibraryDocsOnDisk(): Promise<LibraryDocEntry[] | null> {
  try {
    const entries = await invoke<LibraryDocEntry[]>('list_library_docs');
    return Array.isArray(entries) ? entries : null;
  } catch (err) {
    console.warn('[NativeStore] list_library_docs failed:', err);
    return null;
  }
}

export async function deleteLibraryDocLocally(filename: string): Promise<boolean> {
  const safeName = filename.split('/').pop() || filename;
  return invoke<boolean>('delete_library_doc', { filename: safeName });
}
