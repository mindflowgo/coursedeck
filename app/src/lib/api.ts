import type { Checkpoint } from '$lib/checkpoint';

export const BACKEND_PORT = 3182;

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    '__TAURI_INTERNALS__' in window ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost'
  );
}

export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  // In dev (localhost:5173), Vite/SvelteKit handles /api itself
  if (window.location.port === '5173') return '';
  // In packaged desktop Tauri app, point to local Bun backend sidecar
  if (isTauriEnvironment()) {
    return `http://127.0.0.1:${BACKEND_PORT}`;
  }
  return '';
}

// Singleton reachability cache
let _serverReachable: boolean | null = null;
let _lastReachabilityCheck = 0;

export async function isServerReachable(forceCheck = false): Promise<boolean> {
  if (typeof window === 'undefined') return true;
  if (isTauriEnvironment()) return true;
  if (!navigator.onLine) {
    _serverReachable = false;
    return false;
  }

  const now = Date.now();
  if (!forceCheck && _serverReachable !== null && now - _lastReachabilityCheck < 10000) {
    return _serverReachable;
  }

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${getApiBaseUrl()}/health`, { signal: ctrl.signal });
    clearTimeout(timeout);
    _serverReachable = res.ok;
    _lastReachabilityCheck = now;
  } catch {
    _serverReachable = false;
    _lastReachabilityCheck = now;
  }
  return _serverReachable ?? false;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    _serverReachable = null;
    isServerReachable(true).catch(() => {});
  });
  window.addEventListener('offline', () => {
    _serverReachable = false;
  });
}

/**
 * Typed fetch for the backend API.
 *
 * In Tauri or dev: normal fetch against the backend.
 * On iPad / Web client:
 *   - If desktop server is reachable: fetches normally.
 *   - If offline or server unreachable: falls back to IndexedDB for reads
 *     and queues local changes (checkpoints) for later push.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase();

  // In Tauri desktop or SSR, bypass offline layer
  if (isTauriEnvironment() || typeof window === 'undefined') {
    return fetch(`${getApiBaseUrl()}${path}`, init);
  }

  const reachable = await isServerReachable();

  if (reachable) {
    try {
      const res = await fetch(`${getApiBaseUrl()}${path}`, init);
      // If server returned a 502/503/504 or dropped connection, re-evaluate
      if (!res.ok && res.status >= 502 && method === 'GET') {
        _serverReachable = false;
        return offlineFetch(path, method, init);
      }
      return res;
    } catch {
      _serverReachable = false;
    }
  }

  return offlineFetch(path, method, init);
}

// ── Offline IndexedDB Interception ──────────────────────────────────────────

async function offlineFetch(path: string, method: string, init?: RequestInit): Promise<Response> {
  const store = await import('./storage/clientStore');

  function jsonRes(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // GET /api/courses
  if (method === 'GET' && (path === '/api/courses' || path.startsWith('/api/courses?'))) {
    const courses = await store.listCachedCourses();
    return jsonRes({ courses });
  }

  // GET /api/courses/:id
  const courseGetMatch = path.match(/^\/api\/courses\/([^/?]+)$/);
  if (method === 'GET' && courseGetMatch) {
    const course = await store.getCachedCourse(courseGetMatch[1]);
    if (!course) return jsonRes({ message: 'Course not found in offline storage' }, 404);
    return jsonRes({ course });
  }

  // GET /api/courses/:id/:lessonId (lesson bundle)
  const lessonGetMatch = path.match(/^\/api\/courses\/([^/]+)\/([^/?]+)$/);
  if (method === 'GET' && lessonGetMatch) {
    const [, courseId, lessonId] = lessonGetMatch;
    const lessonMd = (await store.getDocument(courseId, `${lessonId}.lesson.md`)) ?? '';

    // Collect standard and known tabs from IndexedDB
    const tabs: Record<string, string> = {};
    const candidateTabs = [
      'summary',
      'cheatsheet',
      'test',
      'notes',
      'schedule',
      'assignments',
      'quiz',
      'popquiz'
    ];
    for (const tab of candidateTabs) {
      const md = await store.getDocument(courseId, `${lessonId}.${tab}.md`);
      if (md) tabs[tab] = md;
    }

    return jsonRes({ courseId, lessonId, lesson: lessonMd, tabs });
  }

  // GET /api/courses/:id/course-docs?type=xxx
  const courseDocMatch = path.match(/^\/api\/courses\/([^/]+)\/course-docs/);
  if (method === 'GET' && courseDocMatch) {
    const courseId = courseDocMatch[1];
    let type = 'summary';
    try {
      const url = new URL(path, 'http://localhost');
      type = url.searchParams.get('type') || 'summary';
    } catch {}
    const md = await store.getDocument(courseId, `course.${type}.md`);
    return jsonRes({ exists: Boolean(md), markdown: md || '' });
  }

  // GET /api/courses/:id/checkpoints
  const cpGetMatch = path.match(/^\/api\/courses\/([^/]+)\/checkpoints$/);
  if (method === 'GET' && cpGetMatch) {
    const checkpoints = await store.getCachedCheckpoints(cpGetMatch[1]);
    return jsonRes({ checkpoints });
  }

  // POST /api/courses/:id/checkpoints (create or update note)
  const cpPostMatch = path.match(/^\/api\/courses\/([^/]+)\/checkpoints$/);
  if (method === 'POST' && cpPostMatch) {
    const body = JSON.parse((init?.body as string) || '{}');
    const courseId = cpPostMatch[1];
    const cp: Checkpoint = {
      id: body.id || `cp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file: body.file,
      verticalPosition: body.verticalPosition ?? 0,
      type: body.type ?? 'note',
      color: body.color || 'yellow',
      noteText: body.noteText || '',
      date: new Date().toISOString()
    };
    await store.saveCheckpointLocally(courseId, cp);
    return jsonRes({ success: true, checkpoint: cp });
  }

  // POST /api/courses/:id/checkpoints/position (reading position)
  const posPostMatch = path.match(/^\/api\/courses\/([^/]+)\/checkpoints\/position$/);
  if (method === 'POST' && posPostMatch) {
    const body = JSON.parse((init?.body as string) || '{}');
    const courseId = posPostMatch[1];
    const cp: Checkpoint = {
      id: `cp_pos_${body.file.replace(/[^a-z0-9]/gi, '_')}`,
      file: body.file,
      verticalPosition: body.verticalPosition ?? 0,
      type: 'position',
      date: new Date().toISOString()
    };
    await store.saveCheckpointLocally(courseId, cp);
    return jsonRes({ success: true, checkpoint: cp });
  }

  // DELETE /api/courses/:id/checkpoints/:cpId
  const cpDelMatch = path.match(/^\/api\/courses\/([^/]+)\/checkpoints\/([^/]+)$/);
  if (method === 'DELETE' && cpDelMatch) {
    await store.deleteCheckpointLocally(cpDelMatch[1], cpDelMatch[2]);
    return jsonRes({ success: true });
  }

  // GET /api/prompts
  if (method === 'GET' && path === '/api/prompts') {
    const prompts = await store.listPrompts();
    return jsonRes({ prompts });
  }

  // GET /api/llm
  if (method === 'GET' && path === '/api/llm') {
    const llmStore = await store.getLlmStore();
    if (!llmStore) {
      return jsonRes({ hasConfig: false, activeId: null, cards: [], config: null });
    }
    const active = llmStore.cards.find((c) => c.id === llmStore.activeId) ?? null;
    return jsonRes({
      hasConfig: Boolean(active?.baseUrl),
      activeId: llmStore.activeId,
      cards: llmStore.cards.map(({ apiKey: _k, ...rest }) => ({
        ...rest,
        hasApiKey: Boolean(_k)
      })),
      config: active ? { ...active, hasApiKey: Boolean(active.apiKey) } : null
    });
  }

  // Fallback for unhandled offline actions
  return new Response(
    JSON.stringify({
      message: 'Offline: this action requires an active connection to your desktop.'
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}
