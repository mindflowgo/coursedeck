import { isCheckpointType, normalizeAiStatus, type Anchor, type Checkpoint, type SelectionRange } from '$lib/checkpoint';
import { AnnotationSourceConflictError, annotationSourceCandidates, requiredAnnotationAnchorIds, type AnnotationRenderer } from '$lib/checkpoint/sourceAnchors';
import * as store from './storage/clientStore';
import { pdfGetInfo } from './pdfClient';
import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

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

let _cachedDesktopUrl = '';

export function setCachedDesktopUrl(url: string): void {
  const clean = (url || '').trim().replace(/\/+$/, '');
  _cachedDesktopUrl = clean;
  if (typeof localStorage !== 'undefined' && clean) {
    try {
      localStorage.setItem('desktop_url', clean);
    } catch {}
  }
}

export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  // In desktop Tauri app (Mac/Windows/Linux), point to local Bun backend sidecar
  if (isTauriDesktop()) {
    return `http://127.0.0.1:${BACKEND_PORT}`;
  }
  if (_cachedDesktopUrl) {
    return _cachedDesktopUrl;
  }
  // In iPad Tauri or mobile client, use saved desktop URL
  try {
    const custom = localStorage.getItem('desktop_url');
    if (custom) {
      _cachedDesktopUrl = custom.replace(/\/+$/, '');
      return _cachedDesktopUrl;
    }
  } catch {}

  // In desktop browser dev (localhost:5173), Vite/SvelteKit handles /api itself
  if (window.location.port === '5173') return '';

  return '';
}

/**
 * Base URL for course asset references in rendered markdown.
 *
 * iPad app: assets are synced onto the device's own filesystem and served
 * through the `courseasset://` protocol registered in the iOS build, so lesson
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
 * LOCAL-FIRST with server fall-through. Each app (desktop and iPad alike) is
 * a file client: `offlineFetch` below answers every operation it can from the
 * device's own files — NativeStore on Tauri (the same course/library files
 * the desktop backend reads) and IndexedDB caches in browsers — so reading,
 * writing, checkpoints, annotations, prompts, schedules and the library all
 * work with no connectivity at all. Local writes made on a synced device are
 * propagated back to the desktop by the background push queue (see
 * syncState.pushToDesktop).
 *
 * Anything offlineFetch does NOT handle falls through to the server: LLM
 * generation and grading, ingest & course-docs generation, pairing/sync,
 * backup, maintenance — the external-facing surface. On the desktop that is
 * the local Bun sidecar; on the iPad it is the paired desktop over the
 * network, so those operations surface an error when it is unreachable.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // Vite dev browser: the dev server IS the backend — skip the local layer.
  if (typeof window !== 'undefined' && window.location.port === '5173') {
    return smartFetch(path, init);
  }

  // 1. Local-first: serve every file-backed operation from the device's own
  //    store. `null` means "not a local route".
  const local = await offlineFetch(path, (init?.method || 'GET').toUpperCase(), init);
  if (local) return local;

  // 2. Fall through to the server (desktop sidecar / paired desktop).
  return smartFetch(`${getApiBaseUrl()}${path}`, init);
}

// ── Offline Local Storage Interception ───────────────────────────────────────

const LIBRARY_EXTENSIONS: Record<string, 'pdf' | 'epub' | 'mobi'> = {
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.mobi': 'mobi'
};

function detectLibraryFormat(filename: string): 'pdf' | 'epub' | 'mobi' | null {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return null;
  return LIBRARY_EXTENSIONS[filename.slice(dot).toLowerCase()] ?? null;
}

/** Same title derivation the backend's LibraryService applies to unnamed files. */
function libraryTitleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Same cap the backend enforces — reject before buffering the bytes locally. */
const MAX_LIBRARY_UPLOAD_BYTES = 500 * 1024 * 1024;

/**
 * The device's own file-backed API surface. Returns a Response when this
 * route is served locally, or null when it is not a local route — apiFetch
 * then falls through to the server. A returned Response (including 4xx/5xx)
 * is the local layer's authoritative answer.
 */
async function offlineFetch(path: string, method: string, init?: RequestInit): Promise<Response | null> {
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
    const group = typeof body.group === 'string' && body.group.trim() ? body.group.trim() : undefined;
    const manifest = {
      id: courseId,
      title,
      grade: body.grade || '11',
      level: body.level || 'University',
      description: body.description || '',
      ...(group ? { group } : {}),
      coursePDF: Boolean(body.coursePDF),
      updatedAt: new Date().toISOString(),
      units: units.map((u: any, uIdx: number) => ({
        number: Number(u.number) || uIdx + 1,
        title: u.title || `Unit ${uIdx + 1}`,
        lessons: (Array.isArray(u.lessons) ? u.lessons : []).map((l: any, lIdx: number) => ({
          id: String(l.id || `${String(uIdx + 1).padStart(2, '0')}-${String(lIdx + 1).padStart(2, '0')}`).replace(/^(\d+)\.(\d+)/, '$1-$2'),
          title: l.title || `Lesson ${lIdx + 1}`,
          type: l.type === 'assignment' ? 'assignment' : 'lesson',
          pageRange: typeof l.pageRange === 'string' && l.pageRange.trim() ? l.pageRange.trim() : undefined,
          readingDescription: typeof l.readingDescription === 'string' && l.readingDescription.trim() ? l.readingDescription.trim() : undefined
        }))
      }))
    };

    if (group) {
      await store.addGroupLocally('course', group);
    }

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

  // ── Offline /api/library Handlers ─────────────────────────────────────────

  // GET /api/library or POST /api/library/refresh (reconciles the manifest with the /library directory on
  // disk in Tauri, mirroring the backend's syncWithDisk auto-discovery)
  if ((method === 'GET' && pathname === '/api/library') || (method === 'POST' && pathname === '/api/library/refresh')) {
    const manifest = await store.getLibraryManifestLocally();
    const diskEntries = await store.listLibraryDocsOnDisk();

    if (diskEntries) {
      const byFilename = new Map(manifest.documents.map((d) => [d.filename, d]));
      const active = new Set<string>();
      let changed = false;

      for (const entry of diskEntries) {
        const fmt = detectLibraryFormat(entry.filename);
        if (!fmt) continue;
        active.add(entry.filename);

        const existing = byFilename.get(entry.filename);
        if (!existing) {
          let pages: number | undefined;
          if (fmt === 'pdf') {
            try {
              const info = await pdfGetInfo(`/api/library/pdf/${encodeURIComponent(entry.filename)}`);
              pages = info.page_count > 0 ? info.page_count : undefined;
            } catch {}
          }
          byFilename.set(entry.filename, {
            id: entry.filename,
            filename: entry.filename,
            format: fmt,
            title: libraryTitleFromFilename(entry.filename),
            description: '',
            additionDate: new Date(entry.mtime_ms || Date.now()).toISOString(),
            pages: pages || (fmt === 'pdf' ? 1 : undefined),
            lastPage: 1,
            fileSize: entry.size,
            position: byFilename.size
          });
          changed = true;
        } else if (existing.fileSize !== entry.size) {
          existing.fileSize = entry.size;
          changed = true;
        }
      }

      for (const filename of Array.from(byFilename.keys())) {
        if (!active.has(filename)) {
          byFilename.delete(filename);
          changed = true;
        }
      }

      if (changed) {
        manifest.documents = Array.from(byFilename.values());
        manifest.documents.sort((a, b) => {
          if (a.position !== b.position) return a.position - b.position;
          const dateA = new Date(a.additionDate).getTime();
          const dateB = new Date(b.additionDate).getTime();
          if (dateA !== dateB) return dateB - dateA;
          return a.filename.localeCompare(b.filename);
        });
        manifest.documents.forEach((d, i) => (d.position = i));
        await store.saveLibraryManifestLocally(manifest);
      }
    }

    return jsonRes({ documents: manifest.documents });
  }

  // POST /api/library/upload (Tauri only: writes straight to the device's
  // own /library directory via the native commands; browsers fall through
  // to the server's multipart route)
  if (method === 'POST' && pathname === '/api/library/upload') {
    if (!isTauriEnvironment()) {
      return null;
    }
    const formData = typeof FormData !== 'undefined' && init?.body instanceof FormData ? init.body : null;
    const file = formData?.get('file');
    if (!(file instanceof File)) {
      return jsonRes({ message: 'No file provided' }, 400);
    }
    const fmt = detectLibraryFormat(file.name);
    if (!fmt) {
      return jsonRes(
        { message: `Unsupported document format for "${file.name}". Allowed: .pdf, .epub, .mobi` },
        400
      );
    }
    if (file.size > MAX_LIBRARY_UPLOAD_BYTES) {
      return jsonRes(
        { message: `"${file.name}" exceeds the 500 MB library upload limit` },
        413
      );
    }
    const formString = (key: string): string => {
      const v = formData?.get(key);
      return typeof v === 'string' ? v.trim() : '';
    };
    const title = formString('title');
    const description = formString('description');

    const bytes = await file.arrayBuffer();
    let saved: store.LibraryDocEntry;
    try {
      saved = await store.saveLibraryDocLocally(file.name, bytes);
    } catch (err) {
      console.error('[OfflineUpload] save_library_doc failed:', err);
      return jsonRes(
        { message: err instanceof Error ? err.message : 'Failed to save document to /library' },
        500
      );
    }

    let pages: number | undefined;
    if (fmt === 'pdf') {
      try {
        const info = await pdfGetInfo(`/api/library/pdf/${encodeURIComponent(saved.filename)}`);
        pages = info.page_count > 0 ? info.page_count : undefined;
      } catch {}
    }

    const manifest = await store.getLibraryManifestLocally();
    const existingIdx = manifest.documents.findIndex(
      (d) => d.filename.toLowerCase() === saved.filename.toLowerCase()
    );
    const existing = existingIdx >= 0 ? manifest.documents[existingIdx] : undefined;

    const doc: store.ClientLibraryDocument = {
      id: saved.filename,
      filename: saved.filename,
      format: fmt,
      title: title || libraryTitleFromFilename(saved.filename),
      description,
      additionDate: new Date().toISOString(),
      pages: pages || (fmt === 'pdf' ? 1 : undefined),
      lastPage: existing?.lastPage || 1,
      fileSize: saved.size,
      position: existing?.position ?? manifest.documents.length
    };

    if (existingIdx >= 0) {
      manifest.documents[existingIdx] = doc;
    } else {
      manifest.documents.push(doc);
    }
    await store.saveLibraryManifestLocally(manifest);
    return jsonRes({ success: true, document: doc }, 201);
  }

  // PUT /api/library/meta
  if (method === 'PUT' && pathname === '/api/library/meta') {
    const body = JSON.parse((init?.body as string) || '{}');
    const manifest = await store.getLibraryManifestLocally();
    const doc = manifest.documents.find((d) => d.id === body.id || d.filename === body.id);
    if (!doc) return jsonRes({ message: 'Document not found' }, 404);
    if (typeof body.title === 'string') doc.title = body.title.trim();
    if (typeof body.description === 'string') doc.description = body.description.trim();
    if (typeof body.lastPage === 'number') doc.lastPage = body.lastPage;
    if (typeof body.position === 'number') doc.position = body.position;
    if (typeof body.thumbnail === 'string') doc.thumbnail = body.thumbnail;
    if (typeof body.group === 'string' || body.group === null) {
      if (!body.group || !body.group.trim()) {
        delete doc.group;
      } else {
        doc.group = body.group.trim();
      }
    }
    await store.saveLibraryManifestLocally(manifest);
    return jsonRes({ success: true, document: doc });
  }

  // PUT /api/library/reorder
  if (method === 'PUT' && pathname === '/api/library/reorder') {
    const body = JSON.parse((init?.body as string) || '{}');
    const orderedIds = Array.isArray(body.orderedIds) ? (body.orderedIds as string[]) : [];
    const manifest = await store.getLibraryManifestLocally();
    const byId = new Map(manifest.documents.map((d) => [d.id.toLowerCase(), d]));
    const reordered: typeof manifest.documents = [];
    const used = new Set<string>();
    orderedIds.forEach((rawId, index) => {
      const id = rawId.toLowerCase();
      const doc = byId.get(id);
      if (doc) {
        doc.position = index;
        reordered.push(doc);
        used.add(id);
      }
    });
    let nextPos = reordered.length;
    for (const doc of manifest.documents) {
      if (!used.has(doc.id.toLowerCase())) {
        doc.position = nextPos++;
        reordered.push(doc);
      }
    }
    manifest.documents = reordered;
    await store.saveLibraryManifestLocally(manifest);
    return jsonRes({ success: true, documents: reordered });
  }

  // DELETE /api/library/:id
  const libDelMatch = pathname.match(/^\/api\/library\/([^/]+)$/);
  if (method === 'DELETE' && libDelMatch) {
    const id = decodeURIComponent(libDelMatch[1]);
    if (id !== 'annotations' && id !== 'checkpoints' && id !== 'meta' && id !== 'reorder' && id !== 'upload') {
      const manifest = await store.getLibraryManifestLocally();
      const doc = manifest.documents.find((d) => d.id === id || d.filename === id);
      if (doc) {
        manifest.documents = manifest.documents.filter((d) => d.id !== doc.id && d.filename !== doc.filename);
        manifest.documents.forEach((d, i) => (d.position = i));
        await store.saveLibraryManifestLocally(manifest);
        await store.deleteLibraryDocLocally(doc.filename);

        // Purge the document's annotations and checkpoints, like the server's deleteDocument.
        const annotations = await store.getLibraryAnnotationsLocally();
        const keptStrokes = annotations.filter(
          (s) => !s.file.startsWith(`${doc.filename}:`) && s.file !== doc.filename
        );
        if (keptStrokes.length !== annotations.length) {
          await store.saveLibraryAnnotationsLocally(keptStrokes);
        }
        const checkpoints = await store.getLibraryCheckpointsLocally();
        const keptCps = checkpoints.filter(
          (c) => !c.file.startsWith(`${doc.filename}:`) && c.file !== doc.filename
        );
        if (keptCps.length !== checkpoints.length) {
          await store.saveLibraryCheckpointsLocally(keptCps);
        }
      }
      return jsonRes({ success: true });
    }
  }

  // GET /api/library/annotations
  if (method === 'GET' && pathname === '/api/library/annotations') {
    const strokes = await store.getLibraryAnnotationsLocally();
    return jsonRes({ strokes });
  }

  // PUT /api/library/annotations
  if (method === 'PUT' && pathname === '/api/library/annotations') {
    const body = JSON.parse((init?.body as string) || '{}');
    const upserts = Array.isArray(body.upserts) ? body.upserts : [];
    const existing = await store.getLibraryAnnotationsLocally();
    const byId = new Map(existing.map((s) => [s.id, s]));
    for (const up of upserts) {
      if (!up || typeof up !== 'object') continue;
      const cur = byId.get(up.id);
      if (!cur || new Date(up.date).getTime() >= new Date(cur.date).getTime()) {
        byId.set(up.id, up);
      }
    }
    const merged = Array.from(byId.values());
    await store.saveLibraryAnnotationsLocally(merged);
    return jsonRes({ success: true, merged: upserts.length, strokes: merged });
  }

  // GET /api/library/checkpoints
  if (method === 'GET' && pathname === '/api/library/checkpoints') {
    const checkpoints = await store.getLibraryCheckpointsLocally();
    return jsonRes({ checkpoints });
  }

  // POST /api/library/checkpoints
  if (method === 'POST' && pathname === '/api/library/checkpoints') {
    const body = JSON.parse((init?.body as string) || '{}');
    const checkpoints = await store.getLibraryCheckpointsLocally();
    const now = new Date().toISOString();
    const aiStatus = normalizeAiStatus(body.aiStatus);
    const anchor =
      body.anchor && typeof body.anchor === 'object' && !Array.isArray(body.anchor)
        ? (body.anchor as Anchor)
        : undefined;
    const selection =
      body.selection && typeof body.selection === 'object' && !Array.isArray(body.selection)
        ? (body.selection as SelectionRange)
        : undefined;
    let cp: Checkpoint;
    if (body.id) {
      const idx = checkpoints.findIndex((c) => c.id === body.id);
      if (idx !== -1) {
        checkpoints[idx] = {
          ...checkpoints[idx],
          file: body.file,
          verticalPosition: body.verticalPosition,
          color: body.color || checkpoints[idx].color || 'yellow',
          noteText: body.noteText ?? checkpoints[idx].noteText ?? '',
          date: now,
          ...(anchor !== undefined && { anchor }),
          ...(selection !== undefined && { selection }),
          ...(typeof body.aiQuestion === 'string' && { aiQuestion: body.aiQuestion }),
          ...(typeof body.aiAnswer === 'string' && { aiAnswer: body.aiAnswer }),
          ...(aiStatus !== undefined && { aiStatus })
        };
        await store.saveLibraryCheckpointsLocally(checkpoints);
        return jsonRes({ success: true, checkpoint: checkpoints[idx] });
      }
    }
    cp = {
      id: body.id || `library_note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      courseId: 'library',
      file: body.file,
      verticalPosition: body.verticalPosition,
      type: isCheckpointType(body.type) ? body.type : 'note',
      color: body.color || 'yellow',
      noteText: body.noteText || '',
      date: now,
      ...(anchor !== undefined && { anchor }),
      ...(selection !== undefined && { selection }),
      ...(typeof body.aiQuestion === 'string' && { aiQuestion: body.aiQuestion }),
      ...(typeof body.aiAnswer === 'string' && { aiAnswer: body.aiAnswer }),
      ...(aiStatus !== undefined && { aiStatus })
    };
    checkpoints.push(cp);
    await store.saveLibraryCheckpointsLocally(checkpoints);
    return jsonRes({ success: true, checkpoint: cp });
  }

  // POST /api/library/checkpoints/position
  if (method === 'POST' && pathname === '/api/library/checkpoints/position') {
    const body = JSON.parse((init?.body as string) || '{}');
    const checkpoints = await store.getLibraryCheckpointsLocally();
    const now = new Date().toISOString();
    const cleanFile = (body.file || '').trim();
    const page = typeof body.page === 'number' ? body.page : (typeof body.verticalPosition === 'number' ? body.verticalPosition : 1);
    const fileKey = `${cleanFile}:p${page}`;
    const idx = checkpoints.findIndex((c) => c.type === 'position' && (c.file.startsWith(`${cleanFile}:p`) || c.file === cleanFile));
    let cp: Checkpoint;
    if (idx !== -1) {
      cp = {
        ...checkpoints[idx],
        file: fileKey,
        verticalPosition: page,
        date: now
      };
      checkpoints[idx] = cp;
    } else {
      cp = {
        id: `pos_library_${cleanFile.replace(/[^a-z0-9_-]/gi, '_')}`,
        courseId: 'library',
        file: fileKey,
        verticalPosition: page,
        type: 'position',
        date: now
      };
      checkpoints.push(cp);
    }
    await store.saveLibraryCheckpointsLocally(checkpoints);
    const manifest = await store.getLibraryManifestLocally();
    const doc = manifest.documents.find((d) => d.id === cleanFile || d.filename === cleanFile);
    if (doc) {
      doc.lastPage = page;
      await store.saveLibraryManifestLocally(manifest);
    }
    return jsonRes({ success: true, checkpoint: cp });
  }

  // DELETE /api/library/checkpoints/:cpId
  const libCpDelMatch = pathname.match(/^\/api\/library\/checkpoints\/([^/]+)$/);
  if (method === 'DELETE' && libCpDelMatch) {
    const checkpoints = await store.getLibraryCheckpointsLocally();
    const filtered = checkpoints.filter((c) => c.id !== libCpDelMatch[1]);
    await store.saveLibraryCheckpointsLocally(filtered);
    return jsonRes({ success: true });
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

  const anchorSourceMatch = pathname.match(/^\/api\/courses\/([^/]+)\/annotation-anchors$/);
  if (anchorSourceMatch && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((init?.body as string) || '{}');
      annotationSourceCandidates(body.file, body.renderer as AnnotationRenderer);
      requiredAnnotationAnchorIds(body.requiredAnchorIds);
    } catch (err) {
      return jsonRes({ message: err instanceof Error ? err.message : 'Invalid annotation source' }, 400);
    }
    try {
      const source = await store.prepareAnnotationSourceLocally(decodeURIComponent(anchorSourceMatch[1]), body.file as string, body.renderer as AnnotationRenderer, requiredAnnotationAnchorIds(body.requiredAnchorIds));
      return source ? jsonRes(source) : jsonRes({ message: 'Annotation source file not found' }, 404);
    } catch (err) {
      if (err instanceof AnnotationSourceConflictError) return jsonRes({ message: err.message }, 409);
      return jsonRes({ message: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  const reservedSubpaths = ['course-docs', 'checkpoints', 'annotations', 'annotation-anchors', 'open', 'meta', 'unit-test', 'export-pdf', 'locker-docs'];

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
      if (body.group !== undefined) {
        const trimmedGroup = typeof body.group === 'string' ? body.group.trim() : '';
        if (trimmedGroup) {
          course.group = trimmedGroup;
          await store.addGroupLocally('course', trimmedGroup);
        } else {
          delete course.group;
        }
      }
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
    const { lesson, tabs, format, hasCompanion } = await store.getLessonBundleLocally(courseId, lessonId);
    return jsonRes({ courseId, lessonId, lesson, tabs, format: format || 'markdown', hasCompanion: Boolean(hasCompanion) });
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
  // (?status=true polls the server's live generation job — not a local route)
  const courseDocMatch = pathname.match(/^\/api\/courses\/([^/]+)\/course-docs$/);
  if (method === 'GET' && courseDocMatch && !searchParams.has('status')) {
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

  // GET|POST|DELETE /api/courses/:id/locker-docs (assets/locker_docs — always local)
  const lockerMatch = pathname.match(/^\/api\/courses\/([^/]+)\/locker-docs$/);
  if (lockerMatch) {
    const courseId = decodeURIComponent(lockerMatch[1]);

    if (method === 'GET') {
      const files = await store.listLockerDocsLocally(courseId);
      return jsonRes({ success: true, courseId, files });
    }

    if (method === 'POST') {
      const formData = typeof FormData !== 'undefined' && init?.body instanceof FormData ? init.body : null;
      const file = formData?.get('file');
      if (!(file instanceof File)) {
        return jsonRes({ message: 'A file is required' }, 400);
      }
      const bytes = await file.arrayBuffer();
      const saved = await store.saveLockerDocLocally(courseId, file.name, bytes);
      // course.pdf toggles the manifest flag; the manifest push propagates it.
      if (saved.filename.toLowerCase() === 'course.pdf') {
        const manifest = await store.getCachedCourse(courseId);
        if (manifest && !manifest.coursePDF) {
          manifest.coursePDF = true;
          await store.saveCourseManifestLocally(courseId, manifest);
        }
      }
      return jsonRes({ success: true, courseId, file: saved });
    }

    if (method === 'DELETE') {
      const filename = searchParams.get('file');
      if (!filename) return jsonRes({ message: 'file query parameter required' }, 400);
      const removed = await store.deleteLockerDocLocally(courseId, filename);
      if (removed && (filename.split('/').pop() || '').toLowerCase() === 'course.pdf') {
        const manifest = await store.getCachedCourse(courseId);
        if (manifest?.coursePDF) {
          manifest.coursePDF = false;
          await store.saveCourseManifestLocally(courseId, manifest);
        }
      }
      return jsonRes({ success: removed });
    }
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
    const now = new Date().toISOString();
    const aiStatus = normalizeAiStatus(body.aiStatus);
    const anchor =
      body.anchor && typeof body.anchor === 'object' && !Array.isArray(body.anchor)
        ? (body.anchor as Anchor)
        : undefined;
    const selection =
      body.selection && typeof body.selection === 'object' && !Array.isArray(body.selection)
        ? (body.selection as SelectionRange)
        : undefined;

    // Updating an existing record must preserve fields the caller omitted
    // (mirrors the server's update branch).
    let existing: Checkpoint | undefined;
    if (body.id) {
      const cached = await store.getCachedCheckpoints(courseId);
      existing = cached.find((c) => c.id === body.id);
    }

    const cp: Checkpoint = {
      id: body.id || `cp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file: body.file,
      verticalPosition: body.verticalPosition ?? 0,
      type: existing && body.type === undefined ? existing.type : (isCheckpointType(body.type) ? body.type : 'note'),
      color: body.color || existing?.color || 'yellow',
      noteText: body.noteText ?? existing?.noteText ?? '',
      date: now,
      ...((anchor ?? existing?.anchor) !== undefined && { anchor: anchor ?? existing?.anchor }),
      ...((selection ?? existing?.selection) !== undefined && { selection: selection ?? existing?.selection }),
      ...((typeof body.aiQuestion === 'string' || existing?.aiQuestion !== undefined) && {
        aiQuestion: typeof body.aiQuestion === 'string' ? body.aiQuestion : existing?.aiQuestion
      }),
      ...((typeof body.aiAnswer === 'string' || existing?.aiAnswer !== undefined) && {
        aiAnswer: typeof body.aiAnswer === 'string' ? body.aiAnswer : existing?.aiAnswer
      }),
      ...((aiStatus !== undefined || existing?.aiStatus !== undefined) && {
        aiStatus: aiStatus ?? existing?.aiStatus
      })
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

  // PATCH /api/courses/:id/checkpoints/:cpId (async AI answer update)
  const cpPatchMatch = pathname.match(/^\/api\/courses\/([^/]+)\/checkpoints\/([^/]+)$/);
  if (method === 'PATCH' && cpPatchMatch) {
    const body = JSON.parse((init?.body as string) || '{}');
    const [, courseId, checkpointId] = cpPatchMatch;
    const list = await store.getCachedCheckpoints(courseId);
    const idx = list.findIndex((c) => c.id === checkpointId);
    if (idx === -1) {
      return jsonRes({ error: 'Checkpoint not found' }, 404);
    }
    const aiStatus = normalizeAiStatus(body.aiStatus);
    const patched: Checkpoint = {
      ...list[idx],
      date: new Date().toISOString(),
      ...(typeof body.aiAnswer === 'string' && { aiAnswer: body.aiAnswer }),
      ...(typeof body.noteText === 'string' && { noteText: body.noteText }),
      ...(aiStatus !== undefined && { aiStatus })
    };
    list[idx] = patched;
    await store.saveCheckpointLocally(courseId, patched);
    return jsonRes({ success: true, checkpoint: patched });
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
        await invoke('set_setting', { key: 'theme', value: theme });
      } catch {}
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('app_theme', theme);
    }
    return jsonRes({ success: true, theme });
  }

  // GET /api/settings/groups
  if (method === 'GET' && pathname === '/api/settings/groups') {
    const type = searchParams.get('type') || undefined;
    const groups = await store.getGroupsLocally(type);
    const names = groups.map((g) => g.name);
    return jsonRes({ success: true, names, groups });
  }

  // POST /api/settings/groups
  if (method === 'POST' && pathname === '/api/settings/groups') {
    const body = JSON.parse((init?.body as string) || '{}');
    const type = body.type || 'course';
    const action = body.action || (body.name ? 'add' : 'groups');

    if (action === 'add') {
      const name = (body.name || '').trim();
      if (!name) return jsonRes({ message: 'Group name is required' }, 400);
      const { group, groups } = await store.addGroupLocally(type, name);
      const names = groups.filter((g) => g.type.toLowerCase() === type.toLowerCase()).map((g) => g.name);
      return jsonRes({ success: true, group, groups, names });
    }

    if (action === 'rename') {
      const oldName = (body.oldName || '').trim();
      const newName = (body.newName || '').trim();
      if (!oldName || !newName) return jsonRes({ message: 'Both oldName and newName are required' }, 400);
      const { groups, updatedCount } = await store.renameGroupLocally(type, oldName, newName);
      const names = groups.filter((g) => g.type.toLowerCase() === type.toLowerCase()).map((g) => g.name);
      return jsonRes({ success: true, groups, names, updatedCount });
    }

    if (action === 'delete') {
      const name = (body.name || '').trim();
      if (!name) return jsonRes({ message: 'Group name is required' }, 400);
      const clearEntities = body.clearEntities !== false;
      const { groups, updatedCount } = await store.deleteGroupLocally(type, name, clearEntities);
      const names = groups.filter((g) => g.type.toLowerCase() === type.toLowerCase()).map((g) => g.name);
      return jsonRes({ success: true, groups, names, updatedCount });
    }

    if (action === 'groups' || Array.isArray(body.names)) {
      const names = Array.isArray(body.names) ? body.names : [];
      const updatedNames = await store.reorderGroupsLocally(type, names);
      return jsonRes({ success: true, names: updatedNames });
    }

    return jsonRes({ message: 'Invalid action' }, 400);
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

  // POST /api/llm (iPad or offline local LLM operations)
  if (method === 'POST' && pathname === '/api/llm') {
    if (!isTauriMobile()) return null;

    const body = JSON.parse((init?.body as string) || '{}');
    const action = body.action;

    if (action === 'save_store') {
      const cards = Array.isArray(body.cards) ? body.cards : [];
      const activeId = body.activeId || (cards[0]?.id ?? null);
      const newStore = { version: 2, activeId, cards };
      await store.saveLlmConfigLocally(newStore);
      const active = cards.find((c: any) => c.id === activeId) ?? null;
      return jsonRes({
        success: true,
        hasConfig: Boolean(active?.baseUrl),
        activeId,
        cards: cards.map(({ apiKey: _k, ...rest }: any) => ({ ...rest, hasApiKey: Boolean(_k) })),
        config: active ? { ...active, hasApiKey: Boolean(active.apiKey) } : null
      });
    }

    if (action === 'set_active') {
      const id = typeof body.id === 'string' ? body.id : '';
      const llmStore = await store.getLlmStore();
      if (!llmStore || !llmStore.cards.some((c) => c.id === id)) {
        return jsonRes({ message: 'Model card not found' }, 404);
      }
      llmStore.activeId = id;
      await store.saveLlmConfigLocally(llmStore);
      const active = llmStore.cards.find((c) => c.id === id) ?? null;
      return jsonRes({
        success: true,
        hasConfig: Boolean(active?.baseUrl),
        activeId: id,
        cards: llmStore.cards.map(({ apiKey: _k, ...rest }) => ({ ...rest, hasApiKey: Boolean(_k) })),
        config: active ? { ...active, hasApiKey: Boolean(active.apiKey) } : null
      });
    }

    if (action === 'save_config') {
      const cfg = body.config;
      if (!cfg || !cfg.baseUrl || !cfg.baseUrl.trim()) {
        return jsonRes({ message: 'A Base URL is required to save an AI model' }, 400);
      }
      let llmStore = await store.getLlmStore();
      if (!llmStore) {
        llmStore = { version: 2, activeId: null, cards: [] };
      }
      const existingIdx = cfg.cardId
        ? llmStore.cards.findIndex((c) => c.id === cfg.cardId)
        : llmStore.cards.findIndex((c) => c.id === llmStore?.activeId);
      const cardId = (existingIdx >= 0 ? llmStore.cards[existingIdx].id : null) || cfg.cardId || `card_${Date.now().toString(36)}`;
      const card: store.ClientLlmModelCard = {
        id: cardId,
        label: cfg.label || cfg.provider || 'AI Model',
        provider: cfg.provider || 'openai_compatible',
        baseUrl: cfg.baseUrl.trim(),
        apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : (existingIdx >= 0 ? llmStore.cards[existingIdx].apiKey : ''),
        authHeaderType: cfg.authHeaderType || 'bearer',
        model: typeof cfg.model === 'string' ? cfg.model.trim() : '',
        temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.3,
        timeoutSeconds: typeof cfg.timeoutSeconds === 'number' ? cfg.timeoutSeconds : 150,
        sendSessionId: Boolean(cfg.sendSessionId)
      };
      if (existingIdx >= 0) {
        llmStore.cards[existingIdx] = card;
      } else {
        llmStore.cards.push(card);
      }
      if (!llmStore.activeId || existingIdx >= 0) {
        llmStore.activeId = cardId;
      }
      await store.saveLlmConfigLocally(llmStore);
      return jsonRes({ success: true, message: 'LLM configuration saved', activeId: llmStore.activeId });
    }

    if (action === 'test' || action === 'generate') {
      let card: store.ClientLlmModelCard | null = null;
      if (body.config?.baseUrl) {
        card = body.config as store.ClientLlmModelCard;
      } else {
        const stored = await store.getLlmStore();
        if (!stored) {
          return jsonRes({ message: 'No AI model configured on this device. Add a model in Settings or sync from desktop.' }, 400);
        }
        card = stored.cards.find((c) => c.id === stored.activeId) ?? stored.cards[0] ?? null;
      }

      if (!card?.baseUrl) {
        return jsonRes({ message: 'No AI model configured on this device.' }, 400);
      }

      if (action === 'test') {
        try {
          const { generateDirect } = await import('$lib/llmClient');
          await generateDirect(card, 'You are a connectivity test.', 'Reply with the single word: OK');
          return jsonRes({ success: true, message: 'Connected!' });
        } catch (err: any) {
          return jsonRes({ success: false, message: err?.message || 'Connection failed' });
        }
      }

      const { systemPrompt, userPrompt } = body;
      if (!systemPrompt || !userPrompt) {
        return jsonRes({ message: 'systemPrompt and userPrompt are required for generation' }, 400);
      }
      try {
        const { generateDirect } = await import('$lib/llmClient');
        const result = await generateDirect(card, systemPrompt, userPrompt);
        return jsonRes({ success: true, completion: result.completion, usage: result.usage });
      } catch (err: any) {
        return jsonRes({ message: err?.message || 'LLM generation failed' }, 500);
      }
    }

    return null;
  }

  // Not a local route — apiFetch falls through to the server.
  return null;
}
