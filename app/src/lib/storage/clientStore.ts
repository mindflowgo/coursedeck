// app/src/lib/storage/clientStore.ts
// IndexedDB adapter for CourseDeck iPad offline storage.
// Runs only in browser context.

import type { CourseManifest } from '$lib/parser/courseIngest';
import type { Checkpoint } from '$lib/checkpoint';

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

export interface SyncBundle {
  version: 1;
  generatedAt: string;
  courses: Array<{
    manifest: CourseManifest;
    files: Record<string, string>;
    checkpoints: Checkpoint[];
  }>;
  prompts: Array<{ id: string; content: string }>;
  llmConfig?: ClientLlmStore;
}

const DB_NAME = 'coursedeck_v1';
const DB_VERSION = 1;

const STORES = [
  'meta',
  'courses',
  'documents',
  'prompts',
  'llm_config',
  'checkpoints',
  'pending_push'
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
    const keys: string[] = [];
    const values: T[] = [];
    os.openKeyCursor().onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursor>).result;
      if (cursor) {
        keys.push(cursor.key as string);
        cursor.continue();
      }
    };
    os.openCursor().onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        values.push(cursor.value);
        cursor.continue();
      } else {
        resolve(keys.map((k, i) => ({ key: k, value: values[i] })));
      }
    };
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
  const rows = await getAll<CourseManifest>('courses');
  return rows.map((r) => r.value);
}

export async function getCachedCourse(courseId: string): Promise<CourseManifest | undefined> {
  return get<CourseManifest>('courses', courseId.toLowerCase());
}

export async function getDocument(courseId: string, filename: string): Promise<string | undefined> {
  return get<string>('documents', `${courseId.toLowerCase()}:${filename}`);
}

export async function getCachedCheckpoints(courseId: string): Promise<Checkpoint[]> {
  return (await get<Checkpoint[]>('checkpoints', courseId.toLowerCase())) ?? [];
}

export async function getLlmStore(): Promise<ClientLlmStore | undefined> {
  return get<ClientLlmStore>('llm_config', 'store');
}

export async function listPrompts(): Promise<{ id: string; content: string }[]> {
  const rows = await getAll<{ id: string; content: string }>('prompts');
  return rows.map((r) => r.value);
}

export async function hasCachedData(): Promise<boolean> {
  try {
    const courses = await listCachedCourses();
    return courses.length > 0;
  } catch {
    return false;
  }
}

// ── Bundle Import ──────────────────────────────────────────────────────────────

export async function importBundle(bundle: SyncBundle, desktopUrl: string): Promise<void> {
  for (const course of bundle.courses) {
    const courseId = course.manifest.id.toLowerCase();
    await put('courses', courseId, course.manifest);

    for (const [filename, markdown] of Object.entries(course.files)) {
      await put('documents', `${courseId}:${filename}`, markdown);
    }

    if (Array.isArray(course.checkpoints)) {
      await put('checkpoints', courseId, course.checkpoints);
    }
  }

  if (Array.isArray(bundle.prompts)) {
    for (const prompt of bundle.prompts) {
      await put('prompts', prompt.id, prompt);
    }
  }

  if (bundle.llmConfig) {
    await put('llm_config', 'store', bundle.llmConfig);
  }

  await setMeta('last_synced_at', bundle.generatedAt);
  await setMeta('desktop_url', desktopUrl);
}

// ── Checkpoint writes (iPad-local, queued for push) ──────────────────────────

export async function saveCheckpointLocally(courseId: string, checkpoint: Checkpoint): Promise<void> {
  const id = courseId.toLowerCase();
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
    const tx = db.transaction('pending_push', 'readwrite');
    const req = tx.objectStore('pending_push').clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
