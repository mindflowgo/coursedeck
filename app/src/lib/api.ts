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

export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod|Android/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isTauriDesktop(): boolean {
  return isTauriEnvironment() && !isMobileDevice();
}

export function isTauriMobile(): boolean {
  return isTauriEnvironment() && isMobileDevice();
}

/**
 * Universal fetch that routes through Tauri's native Rust HTTP client
 * when running in Tauri (bypassing all WebKit/Safari CORS & mixed-content restrictions),
 * and standard window.fetch in standard browser environments.
 */
export async function smartFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauriEnvironment()) {
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
      return await tauriFetch(url, init);
    } catch (e) {
      console.warn('[smartFetch] tauri-plugin-http fetch error:', e);
      try {
        return await fetch(url, init);
      } catch (windowErr) {
        throw new Error(
          `Connection failed. Native: ${e instanceof Error ? e.message : e} | Web: ${windowErr instanceof Error ? windowErr.message : windowErr}`
        );
      }
    }
  }
  return fetch(url, init);
}

export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  // In desktop Tauri app (Mac/Windows/Linux), point to local Bun backend sidecar
  if (isTauriDesktop()) {
    return `http://127.0.0.1:${BACKEND_PORT}`;
  }
  // In iPad Tauri or mobile client, use saved desktop URL
  const custom = localStorage.getItem('desktop_url');
  if (custom) return custom.replace(/\/+$/, '');

  // In desktop browser dev (localhost:5173), Vite/SvelteKit handles /api itself
  if (window.location.port === '5173') return '';

  return '';
}

/**
 * Base URL for course asset references in rendered markdown.
 *
 * iPad app: assets are synced onto the device's own filesystem and served
 * through the `courseasset://` protocol registered in tauripad, so lesson
 * images display offline. Everywhere else (desktop app, paired browser)
 * they come from the backend HTTP route.
 */
export function courseAssetBase(courseId: string): string {
  if (typeof window !== 'undefined' && isTauriMobile()) {
    return `courseasset://localhost/${encodeURIComponent(courseId.toLowerCase())}`;
  }
  return `${getApiBaseUrl()}/api/courses/${courseId}`;
}

// Singleton reachability cache
let _serverReachable: boolean | null = null;
let _lastReachabilityCheck = 0;

export async function isServerReachable(forceCheck = false): Promise<boolean> {
  if (typeof window === 'undefined') return true;
  if (isTauriDesktop()) return true;
  if (!navigator.onLine) {
    _serverReachable = false;
    return false;
  }

  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    _serverReachable = false;
    return false;
  }

  const now = Date.now();
  if (!forceCheck && _serverReachable !== null && now - _lastReachabilityCheck < 10000) {
    return _serverReachable;
  }

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2500);
    const res = await smartFetch(`${baseUrl}/health`, { signal: ctrl.signal });
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
 * ── Endpoint routing model ────────────────────────────────────────────────────
 *
 * Everything is LOCAL-FIRST: course/lesson/tab reads and writes, checkpoints,
 * annotations, prompts, schedules, theme and cached assets are served from the
 * device's own store — NativeStore on Tauri (the same course files the backend
 * reads from disk) and IndexedDB in browsers. The app keeps working with no
 * connectivity at all.
 *
 * ONLINE_ONLY is the short list of endpoints that cannot work without the
 * backend server or external services: AI/LLM generation and grading, course
 * creation & ingest, attachment uploads, device pairing/sync, e-mail, backup
 * and maintenance. They always go through smartFetch and surface errors when
 * the server is unreachable.
 */
const ONLINE_ONLY: Array<{ methods?: string[]; pattern: RegExp }> = [
  // AI / LLM generation & grading (config reads stay local)
  { methods: ['POST'], pattern: /^\/api\/llm$/ },
  { pattern: /^\/api\/queue/ },
  { pattern: /^\/api\/pop-quiz\// },
  { pattern: /^\/api\/builder\// },
  { pattern: /^\/api\/parse$/ },
  { pattern: /^\/api\/courses\/[^/]+\/unit-test\// },
  { pattern: /^\/api\/courses\/[^/]+\/prompt-context/ },
  { methods: ['POST'], pattern: /^\/api\/courses\/[^/]+\/course-docs$/ },
  // Course lifecycle & backend-managed files
  { methods: ['POST'], pattern: /^\/api\/courses$/ },
  { pattern: /^\/api\/courses\/[^/]+\/locker-docs/ },
  { pattern: /^\/api\/courses\/[^/]+\/open$/ },
  { pattern: /^\/api\/courses\/[^/]+\/schedule\/mark-lesson-done$/ },
  // Server & external services
  { pattern: /^\/api\/sync\// },
  { pattern: /^\/api\/pairing\// },
  { pattern: /^\/api\/backup\// },
  { pattern: /^\/api\/maintenance\// },
  { pattern: /^\/api\/settings\/(storage|open-folder|mcp|emailserver)/ },
  { pattern: /^\/api\/network-ip$/ }
];

function isOnlineOnlyRoute(pathname: string, searchParams: URLSearchParams, method: string): boolean {
  // Generation-status polling (?status=true) reads the server's live job
  // registry, which only the backend knows about.
  if (/^\/api\/courses\/[^/]+\/course-docs$/.test(pathname) && searchParams.has('status')) {
    return true;
  }
  return ONLINE_ONLY.some(
    (rule) => (!rule.methods || rule.methods.includes(method)) && rule.pattern.test(pathname)
  );
}

/**
 * Typed fetch for the backend API.
 *
 * Local-first everywhere: only the ONLINE_ONLY endpoints above require the
 * server. Reading, writing, checkpoints, annotations, prompts and schedules
 * all keep working offline from the device's own store.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase();
  const [pathname, search] = path.split('?');
  const searchParams = new URLSearchParams(search || '');

  // 1. Online-only endpoints always hit the backend server.
  if (isOnlineOnlyRoute(pathname, searchParams, method)) {
    return smartFetch(`${getApiBaseUrl()}${path}`, init);
  }

  // 2. Desktop Tauri: NativeStore reads/writes the very course files the
  //    local backend serves — going direct is faster and works even if the
  //    backend process is down.
  if (isTauriDesktop()) {
    return offlineFetch(path, method, init);
  }

  // 3. Vite dev browser: the dev server IS the backend.
  if (typeof window !== 'undefined' && window.location.port === '5173') {
    return smartFetch(path, init);
  }

  // 4. iPad / paired browser: the desktop is the sync master — try it first
  //    (3.5s timeout, 15s reachability cache) and serve from the local synced
  //    store when it cannot be reached. Offline devices skip straight to the
  //    local store.
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return offlineFetch(path, method, init);
  }
  const now = Date.now();
  if (!(_serverReachable === false && now - _lastReachabilityCheck < 15_000)) {
    const baseUrl = getApiBaseUrl();
    try {
      let res: Response;
      if (init?.signal) {
        res = await smartFetch(`${baseUrl}${path}`, init);
      } else {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3500);
        try {
          res = await smartFetch(`${baseUrl}${path}`, { ...init, signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
      }
      _serverReachable = true;
      _lastReachabilityCheck = now;
      return res;
    } catch {
      _serverReachable = false;
      _lastReachabilityCheck = now;
      console.warn(`[apiFetch] server unreachable — serving ${method} ${path} from local store`);
      return offlineFetch(path, method, init);
    }
  }
  return offlineFetch(path, method, init);
}

// ── Offline Local Storage Interception ───────────────────────────────────────

async function offlineFetch(path: string, method: string, init?: RequestInit): Promise<Response> {
  const store = await import('./storage/clientStore');
  const [pathname, search] = path.split('?');
  const searchParams = new URLSearchParams(search || '');

  function jsonRes(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // GET /api/courses
  if (method === 'GET' && pathname === '/api/courses') {
    const courses = await store.listCachedCourses();
    return jsonRes({ courses });
  }

  // POST /api/courses (offline course creation)
  if (method === 'POST' && pathname === '/api/courses') {
    const body = JSON.parse((init?.body as string) || '{}');
    const courseId = (body.id || '').trim().toLowerCase();
    if (!courseId) return jsonRes({ message: 'Course ID is required.' }, 400);
    const title = (body.title || '').trim();
    if (!title) return jsonRes({ message: 'Course title is required.' }, 400);

    const units = Array.isArray(body.units) ? body.units : [];
    const manifest = {
      id: courseId,
      title,
      grade: body.grade || '11',
      level: body.level || 'University',
      description: body.description || '',
      updatedAt: new Date().toISOString(),
      units: units.map((u: any, uIdx: number) => ({
        number: Number(u.number) || uIdx + 1,
        title: u.title || `Unit ${uIdx + 1}`,
        lessons: (Array.isArray(u.lessons) ? u.lessons : []).map((l: any, lIdx: number) => ({
          id: l.id || `${String(uIdx + 1).padStart(2, '0')}.${String(lIdx + 1).padStart(2, '0')}`,
          title: l.title || `Lesson ${lIdx + 1}`,
          type: l.type === 'assignment' ? 'assignment' : 'lesson'
        }))
      }))
    };

    await store.saveCourseManifestLocally(courseId, manifest);

    for (const unit of units) {
      if (Array.isArray(unit.lessons)) {
        for (const lesson of unit.lessons) {
          if (lesson.id && lesson.content) {
            await store.saveDocumentLocally(courseId, `${lesson.id}.lesson.md`, lesson.content);
          }
        }
      }
    }

    return jsonRes({ success: true, courseId, course: manifest }, 201);
  }

  // GET /api/checkpoints
  if (method === 'GET' && pathname === '/api/checkpoints') {
    const checkpoints = await store.listAllCheckpointsLocally();
    return jsonRes({ checkpoints });
  }

  // GET /api/schedules
  if (method === 'GET' && pathname === '/api/schedules') {
    const courses = (await store.listCachedCourses()).filter((c) => !c.archived);
    const schedules: any[] = [];
    for (const c of courses) {
      const md = (await store.getDocument(c.id, 'course.schedule.md')) || '';
      schedules.push({
        courseId: c.id,
        courseTitle: c.title || c.id.toUpperCase(),
        exists: Boolean(md && md.trim().length > 0),
        markdown: md
      });
    }
    return jsonRes({ schedules });
  }

  const reservedSubpaths = ['course-docs', 'checkpoints', 'annotations', 'open', 'meta', 'unit-test', 'export-pdf', 'locker-docs'];

  // GET|DELETE /api/courses/:id
  const courseGetMatch = pathname.match(/^\/api\/courses\/([^/]+)$/);
  if (courseGetMatch) {
    const courseId = decodeURIComponent(courseGetMatch[1]);
    if (method === 'GET') {
      const course = await store.getCachedCourse(courseId);
      if (!course) return jsonRes({ message: 'Course not found in offline storage' }, 404);
      return jsonRes({ course });
    }
    if (method === 'DELETE') {
      const permanentParam = searchParams.get('permanent');
      const permanent = permanentParam !== null ? permanentParam === 'true' : true;
      if (!permanent) {
        const course = await store.getCachedCourse(courseId);
        if (course) {
          course.archived = true;
          await store.saveCourseManifestLocally(courseId, course);
          return jsonRes({ success: true, courseId, action: 'archived', permanent: false });
        }
      }
      await store.deleteCourseLocally(courseId);
      return jsonRes({ success: true, courseId, action: 'deleted', permanent: true });
    }
  }

  // GET|PUT /api/courses/:id/meta
  const courseMetaMatch = pathname.match(/^\/api\/courses\/([^/]+)\/meta$/);
  if (courseMetaMatch) {
    const courseId = decodeURIComponent(courseMetaMatch[1]);
    const course = await store.getCachedCourse(courseId);
    if (!course) return jsonRes({ message: 'Course not found in offline storage' }, 404);
    if (method === 'GET') {
      return jsonRes({ course });
    }
    if (method === 'PUT') {
      const body = JSON.parse((init?.body as string) || '{}');
      if (typeof body.title === 'string') course.title = body.title;
      if (typeof body.description === 'string') course.description = body.description;
      if (typeof body.archived === 'boolean') course.archived = body.archived;
      await store.saveCourseManifestLocally(courseId, course);
      return jsonRes({ success: true, course });
    }
  }

  // GET /api/courses/:id/:lessonId (lesson bundle)
  const lessonGetMatch = pathname.match(/^\/api\/courses\/([^/]+)\/([^/]+)$/);
  if (method === 'GET' && lessonGetMatch && !reservedSubpaths.includes(lessonGetMatch[2])) {
    const courseId = decodeURIComponent(lessonGetMatch[1]);
    const lessonId = decodeURIComponent(lessonGetMatch[2]);
    console.log(`[OfflineFetch] GET lesson bundle for ${courseId}/${lessonId}`);
    const { lesson, tabs } = await store.getLessonBundleLocally(courseId, lessonId);
    return jsonRes({ courseId, lessonId, lesson, tabs });
  }

  // PUT /api/courses/:id/:lessonId (save tab offline)
  if (method === 'PUT' && lessonGetMatch && !reservedSubpaths.includes(lessonGetMatch[2])) {
    const courseId = decodeURIComponent(lessonGetMatch[1]);
    const lessonId = decodeURIComponent(lessonGetMatch[2]);
    const body = JSON.parse((init?.body as string) || '{}');
    const tab = body.tab || searchParams.get('tab') || 'lesson';
    const content = body.content || '';
    const filename = tab === 'lesson' ? `${lessonId}.lesson.md` : `${lessonId}.${tab}.md`;
    await store.saveDocumentLocally(courseId, filename, content);
    return jsonRes({ success: true });
  }

  // DELETE /api/courses/:id/:lessonId (delete tab offline)
  if (method === 'DELETE' && lessonGetMatch && !reservedSubpaths.includes(lessonGetMatch[2])) {
    const courseId = decodeURIComponent(lessonGetMatch[1]);
    const lessonId = decodeURIComponent(lessonGetMatch[2]);
    const tab = searchParams.get('tab');
    if (!tab) return jsonRes({ message: 'tab parameter required' }, 400);
    const filename = `${lessonId}.${tab.toLowerCase().trim()}.md`;
    const removed = await store.deleteDocumentLocally(courseId, filename);
    return jsonRes({ success: true, removed });
  }

  // GET /api/courses/:id/course-docs?type=xxx
  const courseDocMatch = pathname.match(/^\/api\/courses\/([^/]+)\/course-docs$/);
  if (method === 'GET' && courseDocMatch) {
    const courseId = decodeURIComponent(courseDocMatch[1]);
    const type = searchParams.get('type') || 'summary';
    const filename = type === 'logs' ? 'logs.md' : `course.${type}.md`;
    const md = await store.getDocument(courseId, filename);
    return jsonRes({ exists: Boolean(md), markdown: md || '' });
  }

  // PUT /api/courses/:id/course-docs
  if (method === 'PUT' && courseDocMatch) {
    const courseId = decodeURIComponent(courseDocMatch[1]);
    const body = JSON.parse((init?.body as string) || '{}');
    const tab = body.tab || body.type || 'schedule';
    const content = body.content || '';
    const filename = tab === 'logs' ? 'logs.md' : `course.${tab}.md`;
    await store.saveDocumentLocally(courseId, filename, content);
    return jsonRes({ success: true });
  }

  // DELETE /api/courses/:id/course-docs (delete course doc offline)
  if (method === 'DELETE' && courseDocMatch) {
    const courseId = decodeURIComponent(courseDocMatch[1]);
    const type = searchParams.get('type') || searchParams.get('tab') || '';
    if (!type) return jsonRes({ message: 'type parameter required' }, 400);
    const filename = type === 'logs' ? 'logs.md' : `course.${type.toLowerCase().trim()}.md`;
    const removed = await store.deleteDocumentLocally(courseId, filename);
    return jsonRes({ success: true, removed });
  }

  // GET /api/courses/:id/annotations
  const annMatch = pathname.match(/^\/api\/courses\/([^/]+)\/annotations$/);
  if (method === 'GET' && annMatch) {
    const strokes = await store.getAnnotationsLocally(annMatch[1]);
    return jsonRes({ strokes });
  }

  // PUT /api/courses/:id/annotations (merge upserts locally, queue for push)
  if (method === 'PUT' && annMatch) {
    const body = JSON.parse((init?.body as string) || '{}');
    const upserts = Array.isArray(body.upserts) ? body.upserts : [];
    await store.saveAnnotationsLocally(annMatch[1], upserts);
    return jsonRes({ success: true, merged: upserts.length });
  }

  // GET /api/courses/:id/checkpoints
  const cpGetMatch = pathname.match(/^\/api\/courses\/([^/]+)\/checkpoints$/);
  if (method === 'GET' && cpGetMatch) {
    const checkpoints = await store.getCachedCheckpoints(cpGetMatch[1]);
    return jsonRes({ checkpoints });
  }

  // POST /api/courses/:id/checkpoints (create or update note)
  if (method === 'POST' && cpGetMatch) {
    const body = JSON.parse((init?.body as string) || '{}');
    const courseId = cpGetMatch[1];
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
  const posPostMatch = pathname.match(/^\/api\/courses\/([^/]+)\/checkpoints\/position$/);
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
  const cpDelMatch = pathname.match(/^\/api\/courses\/([^/]+)\/checkpoints\/([^/]+)$/);
  if (method === 'DELETE' && cpDelMatch) {
    await store.deleteCheckpointLocally(cpDelMatch[1], cpDelMatch[2]);
    return jsonRes({ success: true });
  }

  // GET /api/prompts
  if (method === 'GET' && pathname === '/api/prompts') {
    const prompts = await store.listPrompts();
    return jsonRes({ prompts });
  }

  // POST /api/prompts
  if (method === 'POST' && pathname === '/api/prompts') {
    const body = JSON.parse((init?.body as string) || '{}');
    const { id, content } = body;
    if (!id || typeof content !== 'string') {
      return new Response(JSON.stringify({ message: 'id and content required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    await store.savePromptLocally(id, content);
    return jsonRes({ success: true });
  }

  // DELETE /api/prompts
  if (method === 'DELETE' && pathname === '/api/prompts') {
    const targetId = searchParams.get('id');
    if (!targetId) {
      return new Response(JSON.stringify({ message: 'id parameter required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    await store.deletePromptLocally(targetId);
    return jsonRes({ success: true });
  }

  // GET /api/settings/theme
  if (pathname === '/api/settings/theme' && method === 'GET') {
    if (isTauriEnvironment()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const theme = await invoke<string | null>('get_setting', { key: 'theme' });
        if (theme) return jsonRes({ success: true, theme });
      } catch {}
    }
    const theme = typeof localStorage !== 'undefined' ? localStorage.getItem('app_theme') || 'system' : 'system';
    return jsonRes({ success: true, theme });
  }

  // POST /api/settings/theme
  if (pathname === '/api/settings/theme' && method === 'POST') {
    const body = JSON.parse((init?.body as string) || '{}');
    const theme = body.theme || 'system';
    if (isTauriEnvironment()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_setting', { key: 'theme', value: theme });
      } catch {}
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('app_theme', theme);
    }
    return jsonRes({ success: true, theme });
  }

  // GET /api/llm
  if (method === 'GET' && pathname === '/api/llm') {
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

  // GET /api/courses/:id/assets/** (offline: serve cached binary assets, e.g. course.pdf)
  const assetGetMatch = pathname.match(/^\/api\/courses\/([^/]+)\/assets\/(.+)$/);
  if (method === 'GET' && assetGetMatch) {
    const buffer = await store.getCachedPdfAsset(pathname);
    if (buffer) {
      console.log(`[OfflineFetch] GET asset ${pathname} from pdf cache (${Math.round(buffer.byteLength / 1024)} KB)`);
      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': pathname.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }
    return jsonRes({ message: 'Offline: document not cached on this device yet.' }, 503);
  }

  // Fallback for unhandled offline actions
  return new Response(
    JSON.stringify({
      message: 'Offline: this action requires an active connection to your desktop.'
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}
