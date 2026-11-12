// app/src/lib/api.routing.test.ts
// Verifies the local-first routing contract: every file-backed route is served
// from the local store; anything the local layer does not handle falls
// through to the server (LLM generation, sync, backup, live job status).

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { AnnotationSourceConflictError } from './checkpoint/sourceAnchors';

const storeCalls: string[] = [];
const fetchCalls: Array<{ url: string; method: string }> = [];

const lessonBundle = { lesson: '# Lesson from local store', tabs: { summary: '# Summary' } };

// Mutable library store state, reset in beforeEach.
let libManifest: any = { version: 1, documents: [] };
let libDiskEntries: any | null = null;
let libSaveShouldFail = false;
const libSavedDocs = new Map<string, ArrayBuffer>();
let libAnnotations: any[] = [];
let libCheckpoints: any[] = [];
let courseCheckpoints: any[] = [];
let anchorMigrationError: Error | null = null;

const windowStub = {
  __TAURI_INTERNALS__: {},
  location: { protocol: 'tauri:', hostname: 'tauri.localhost', port: '' },
  addEventListener: () => {},
  dispatchEvent: () => true
};

// Pretend to be an iPad inside the Tauri webview BEFORE api.ts is imported:
// its module top-level registers window listeners and the routing helpers
// read window/navigator/localStorage at call time.
(globalThis as any).window = windowStub;
(globalThis as any).navigator = {
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
  platform: 'MacIntel',
  maxTouchPoints: 5,
  onLine: true
};
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};
(globalThis as any).fetch = async (input: any, init?: RequestInit) => {
  fetchCalls.push({ url: String(input), method: (init?.method || 'GET').toUpperCase() });
  return new Response(JSON.stringify({ network: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

// No real Tauri runtime here: make the native bridges throw so smartFetch
// exercises its window.fetch fallback (that IS the network path we assert on).
// Keep every named export other suites link against (e.g. pencilKit's
// addPluginListener): bun runs all test files in one process, and a partial
// core mock replaces the real module for files that load later.
await mock.module('@tauri-apps/api/core', () => ({
  invoke: async () => {
    throw new Error('no tauri runtime in tests');
  },
  addPluginListener: async () => () => {},
  convertFileSrc: (path: string) => path,
  transformCallback: () => 0
}));
await mock.module('@tauri-apps/plugin-http', () => ({
  fetch: async () => {
    throw new Error('no tauri runtime in tests');
  }
}));

await mock.module('./storage/clientStore', () => ({
  PUSH_QUEUED_EVENT: 'coursedeck:push-queued',
  isTauri: () => true,
  listCachedCourses: async () => {
    storeCalls.push('listCachedCourses');
    return [{ id: 'foo', title: 'Foo', units: [] }];
  },
  getCachedCourse: async () => {
    storeCalls.push('getCachedCourse');
    return { id: 'foo', title: 'Foo', units: [] };
  },
  saveCourseManifestLocally: async () => {
    storeCalls.push('saveCourseManifestLocally');
  },
  deleteCourseLocally: async () => {
    storeCalls.push('deleteCourseLocally');
  },
  getDocument: async () => {
    storeCalls.push('getDocument');
    return undefined;
  },
  saveDocumentLocally: async () => {
    storeCalls.push('saveDocumentLocally');
  },
  prepareAnnotationSourceLocally: async () => {
    storeCalls.push('prepareAnnotationSourceLocally');
    if (anchorMigrationError) throw anchorMigrationError;
    return { sourceFile: '01.01.lesson.html', renderer: 'html', content: '<p data-anchor-id="example">Local</p>' };
  },
  deleteDocumentLocally: async () => {
    storeCalls.push('deleteDocumentLocally');
    return true;
  },
  getLessonBundleLocally: async () => {
    storeCalls.push('getLessonBundleLocally');
    return lessonBundle;
  },
  listAllCheckpointsLocally: async () => {
    storeCalls.push('listAllCheckpointsLocally');
    return [];
  },
  getCachedCheckpoints: async () => {
    storeCalls.push('getCachedCheckpoints');
    return courseCheckpoints;
  },
  saveCheckpointLocally: async (_courseId: string, checkpoint: any) => {
    storeCalls.push('saveCheckpointLocally');
    const idx = courseCheckpoints.findIndex((c) => c.id === checkpoint.id);
    if (idx !== -1) {
      courseCheckpoints[idx] = checkpoint;
    } else {
      courseCheckpoints.push(checkpoint);
    }
  },
  deleteCheckpointLocally: async () => {
    storeCalls.push('deleteCheckpointLocally');
  },
  getPendingPushPayload: async () => ({}),
  getPendingPushAnnotations: async () => ({}),
  getPendingPushDocuments: async () => ({}),
  getPendingPushPrompts: async () => [],
  clearPendingPush: async () => {},
  getLlmStore: async () => {
    storeCalls.push('getLlmStore');
    return undefined;
  },
  listPrompts: async () => {
    storeCalls.push('listPrompts');
    return [];
  },
  savePromptLocally: async () => {
    storeCalls.push('savePromptLocally');
  },
  deletePromptLocally: async () => {
    storeCalls.push('deletePromptLocally');
  },
  getAnnotationsLocally: async () => {
    storeCalls.push('getAnnotationsLocally');
    return [];
  },
  saveAnnotationsLocally: async () => {
    storeCalls.push('saveAnnotationsLocally');
  },
  listLockerDocsLocally: async () => {
    storeCalls.push('listLockerDocsLocally');
    return [
      {
        filename: 'course.pdf',
        size: 1234,
        updatedAt: new Date().toISOString(),
        url: '/api/courses/foo/assets/locker_docs/course.pdf',
        ext: 'pdf'
      }
    ];
  },
  saveLockerDocLocally: async () => {
    storeCalls.push('saveLockerDocLocally');
    return {
      filename: 'pasted.jpg',
      size: 10,
      updatedAt: new Date().toISOString(),
      url: '/api/courses/foo/assets/locker_docs/pasted.jpg',
      ext: 'jpg'
    };
  },
  deleteLockerDocLocally: async () => {
    storeCalls.push('deleteLockerDocLocally');
    return true;
  },
  getAllGroupsLocally: async () => [{ id: 'stem', name: 'STEM', type: 'course' }],
  getGroupNamesLocally: async (type?: string) => ['STEM'],
  saveGroupsLocally: async () => {},
  getGroupsLocally: async (type?: string) => {
    storeCalls.push('getGroupsLocally');
    return [{ id: 'stem', name: 'STEM', type: type || 'course' }];
  },
  addGroupLocally: async (type: string, name: string) => {
    storeCalls.push('addGroupLocally');
    return { group: { id: name.toLowerCase(), name, type }, groups: [{ id: name.toLowerCase(), name, type }] };
  },
  renameGroupLocally: async (type: string, oldName: string, newName: string) => {
    storeCalls.push('renameGroupLocally');
    return { groups: [{ id: newName.toLowerCase(), name: newName, type }], updatedCount: 1 };
  },
  deleteGroupLocally: async (type: string, name: string, clearEntities?: boolean) => {
    storeCalls.push('deleteGroupLocally');
    return { groups: [], updatedCount: 1 };
  },
  reorderGroupsLocally: async (type: string, names: string[]) => {
    storeCalls.push('reorderGroupsLocally');
    return names;
  },
  getLibraryManifestLocally: async () => {
    storeCalls.push('getLibraryManifestLocally');
    return libManifest;
  },
  saveLibraryManifestLocally: async (manifest: unknown) => {
    storeCalls.push('saveLibraryManifestLocally');
    libManifest = manifest;
  },
  listLibraryDocsOnDisk: async () => {
    storeCalls.push('listLibraryDocsOnDisk');
    return libDiskEntries;
  },
  saveLibraryDocLocally: async (filename: string, bytes: ArrayBuffer) => {
    storeCalls.push('saveLibraryDocLocally');
    if (libSaveShouldFail) {
      throw new Error('save_library_doc: disk full');
    }
    libSavedDocs.set(filename, bytes);
    return { filename, size: bytes.byteLength, mtime_ms: Date.now() };
  },
  deleteLibraryDocLocally: async (filename: string) => {
    storeCalls.push('deleteLibraryDocLocally');
    libSavedDocs.delete(filename);
    return true;
  },
  getLibraryAnnotationsLocally: async () => libAnnotations,
  saveLibraryAnnotationsLocally: async (strokes: unknown[]) => {
    libAnnotations = strokes as any[];
  },
  getLibraryCheckpointsLocally: async () => libCheckpoints,
  saveLibraryCheckpointsLocally: async (checkpoints: unknown[]) => {
    libCheckpoints = checkpoints as any[];
  }
}));

const { apiFetch, isTauriMobile, resolveFetchTransport, smartFetch } = await import('./api');

describe('apiFetch routing in a Tauri mobile (iPad) environment', () => {
  beforeEach(() => {
    storeCalls.length = 0;
    fetchCalls.length = 0;
    libManifest = { version: 1, documents: [] };
    libDiskEntries = null;
    libSaveShouldFail = false;
    libSavedDocs.clear();
    libAnnotations = [];
    libCheckpoints = [];
    courseCheckpoints = [];
    anchorMigrationError = null;
  });

  it('detects the iPad as Tauri mobile', () => {
    expect(isTauriMobile()).toBe(true);
  });

  it('serves lesson bundles from the local store, never the network', async () => {
    const res = await apiFetch('/api/courses/foo/01.01');
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.lesson).toBe('# Lesson from local store');
    expect(storeCalls).toContain('getLessonBundleLocally');
    expect(fetchCalls.length).toBe(0);
  });

  it('persists annotation anchors locally without falling through to the network', async () => {
    const res = await apiFetch('/api/courses/foo/annotation-anchors', { method: 'POST', body: JSON.stringify({ file: '01.01.lesson.md', renderer: 'html', requiredAnchorIds: ['example'] }) });
    expect(res.status).toBe(200);
    expect((await res.json()).sourceFile).toBe('01.01.lesson.html');
    expect(storeCalls).toEqual(['prepareAnnotationSourceLocally']);
    expect(fetchCalls).toHaveLength(0);
  });

  it('rejects invalid and stale source migrations and exposes native write failures', async () => {
    const post = () => apiFetch('/api/courses/foo/annotation-anchors', { method: 'POST', body: JSON.stringify({ file: '01.01.lesson.md', renderer: 'html' }) });
    const invalid = await apiFetch('/api/courses/foo/annotation-anchors', { method: 'POST', body: JSON.stringify({ file: '../outside.md', renderer: 'markdown' }) });
    expect(invalid.status).toBe(400);
    expect(storeCalls).toHaveLength(0);
    anchorMigrationError = new AnnotationSourceConflictError('Source changed');
    expect((await post()).status).toBe(409);
    anchorMigrationError = new Error('Native disk is read-only');
    expect((await post()).status).toBe(500);
    expect(fetchCalls).toHaveLength(0);
  });

  it('serves the course list and manifest from the local store', async () => {
    await apiFetch('/api/courses');
    expect(storeCalls).toContain('listCachedCourses');

    await apiFetch('/api/courses/foo');
    expect(storeCalls).toContain('getCachedCourse');
    expect(fetchCalls.length).toBe(0);
  });

  it('serves checkpoints from the local store', async () => {
    await apiFetch('/api/courses/foo/checkpoints');
    expect(storeCalls).toContain('getCachedCheckpoints');
    expect(fetchCalls.length).toBe(0);
  });

  it('preserves anchor/selection/AI fields when creating checkpoints locally', async () => {
    const res = await apiFetch('/api/courses/foo/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: '01.01.lesson.md',
        verticalPosition: 320,
        type: 'ai',
        color: 'lavender',
        anchor: { type: 'block', verticalPosition: 320, blockId: 'cd-test', renderer: 'markdown', sourceFile: '01.01.lesson.md' },
        selection: { text: 'quadratic formula', startAnchorId: 'cd-test', endAnchorId: 'cd-test', charStart: 12, charEnd: 29 },
        aiQuestion: 'Why does the discriminant matter?',
        aiStatus: 'pending'
      })
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.checkpoint.type).toBe('ai');
    expect(data.checkpoint.anchor).toEqual({ type: 'block', verticalPosition: 320, blockId: 'cd-test', renderer: 'markdown', sourceFile: '01.01.lesson.md' });
    expect(data.checkpoint.selection.text).toBe('quadratic formula');
    expect(data.checkpoint.aiQuestion).toBe('Why does the discriminant matter?');
    expect(data.checkpoint.aiStatus).toBe('pending');
    // The stored copy keeps the same fields (queued for desktop push).
    expect(courseCheckpoints.length).toBe(1);
    expect(courseCheckpoints[0].anchor.type).toBe('block');
    expect(courseCheckpoints[0].aiStatus).toBe('pending');
    expect(fetchCalls.length).toBe(0);
  });

  it('keeps existing AI fields when locally updating a checkpoint without them', async () => {
    courseCheckpoints = [
      {
        id: 'cp_ai_1',
        file: '01.01.lesson.md',
        verticalPosition: 100,
        type: 'ai',
        color: 'lavender',
        noteText: '',
        date: '2026-11-01T00:00:00.000Z',
        anchor: { type: 'block', verticalPosition: 100, blockId: 'cd-test', renderer: 'markdown', sourceFile: '01.01.lesson.md' },
        selection: { text: 'legacy quote' },
        aiQuestion: 'original question',
        aiAnswer: 'original answer',
        aiStatus: 'done'
      }
    ];
    const res = await apiFetch('/api/courses/foo/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'cp_ai_1',
        file: '01.01.lesson.md',
        verticalPosition: 140,
        color: 'pink',
        noteText: 'edited note'
      })
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.checkpoint.noteText).toBe('edited note');
    expect(data.checkpoint.type).toBe('ai');
    expect(data.checkpoint.aiQuestion).toBe('original question');
    expect(data.checkpoint.aiAnswer).toBe('original answer');
    expect(data.checkpoint.aiStatus).toBe('done');
    expect(data.checkpoint.selection.text).toBe('legacy quote');
    expect(fetchCalls.length).toBe(0);
  });

  it('patches checkpoint AI status locally without touching the network', async () => {
    courseCheckpoints = [
      {
        id: 'cp_ai_2',
        file: '01.02.lesson.md',
        verticalPosition: 50,
        type: 'ai',
        date: '2026-11-01T00:00:00.000Z',
        aiQuestion: 'q',
        aiStatus: 'pending'
      }
    ];
    const res = await apiFetch('/api/courses/foo/checkpoints/cp_ai_2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiAnswer: 'the answer', aiStatus: 'ready' })
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.checkpoint.aiAnswer).toBe('the answer');
    // Legacy 'ready' is normalized to the canonical status set.
    expect(data.checkpoint.aiStatus).toBe('done');
    expect(storeCalls).toContain('saveCheckpointLocally');
    expect(fetchCalls.length).toBe(0);
  });

  it('returns 404 when patching an unknown checkpoint locally', async () => {
    const res = await apiFetch('/api/courses/foo/checkpoints/missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiStatus: 'done' })
    });
    expect(res.status).toBe(404);
    expect(fetchCalls.length).toBe(0);
  });

  it('writes lesson tabs to the local store', async () => {
    const res = await apiFetch('/api/courses/foo/01.01', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: 'lesson', content: '# edited' })
    });
    expect(res.status).toBe(200);
    expect(storeCalls).toContain('saveDocumentLocally');
    expect(fetchCalls.length).toBe(0);
  });

  it('serves locker docs listings from the local store', async () => {
    const res = await apiFetch('/api/courses/foo/locker-docs');
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.files[0].filename).toBe('course.pdf');
    expect(storeCalls).toContain('listLockerDocsLocally');
    expect(fetchCalls.length).toBe(0);
  });

  it('saves locker doc uploads to the local store', async () => {
    const formData = new FormData();
    formData.append('file', new File([new Uint8Array([1, 2, 3])], 'pasted.jpg', { type: 'image/jpeg' }));
    const res = await apiFetch('/api/courses/foo/locker-docs', { method: 'POST', body: formData });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.file.filename).toBe('pasted.jpg');
    expect(storeCalls).toContain('saveLockerDocLocally');
    expect(fetchCalls.length).toBe(0);
  });

  it('creates course locally with group and updates local groups without network', async () => {
    const res = await apiFetch('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'bio12',
        title: 'Biology 12',
        group: 'Sciences',
        units: [
          {
            number: 1,
            title: 'Cellular Biology',
            lessons: [{ id: '01.01', title: 'Intro', content: '# Intro to Cells' }]
          }
        ]
      })
    });
    expect(res.status).toBe(201);
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(data.course.group).toBe('Sciences');
    expect(storeCalls).toContain('addGroupLocally');
    expect(storeCalls).toContain('saveCourseManifestLocally');
    expect(storeCalls).toContain('saveDocumentLocally');
    expect(fetchCalls.length).toBe(0);
  });

  it('serves /api/settings/groups from local store', async () => {
    const res = await apiFetch('/api/settings/groups?type=course');
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.names).toEqual(['STEM']);
    expect(storeCalls).toContain('getGroupsLocally');
    expect(fetchCalls.length).toBe(0);
  });

  it('adds group via /api/settings/groups offline', async () => {
    const res = await apiFetch('/api/settings/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', type: 'course', name: 'Humanities' })
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(storeCalls).toContain('addGroupLocally');
    expect(fetchCalls.length).toBe(0);
  });

  it('manages library groups via /api/settings/groups offline', async () => {
    // Add library group
    const addRes = await apiFetch('/api/settings/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', type: 'library', name: 'Reference' })
    });
    expect(addRes.status).toBe(200);
    expect(storeCalls).toContain('addGroupLocally');

    // Rename library group
    const renameRes = await apiFetch('/api/settings/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', type: 'library', oldName: 'Reference', newName: 'Documentation' })
    });
    expect(renameRes.status).toBe(200);
    expect(storeCalls).toContain('renameGroupLocally');

    // Delete library group
    const deleteRes = await apiFetch('/api/settings/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', type: 'library', name: 'Documentation' })
    });
    expect(deleteRes.status).toBe(200);
    expect(storeCalls).toContain('deleteGroupLocally');
    expect(fetchCalls.length).toBe(0);
  });

  it('keeps LLM generation on the network', async () => {
    await apiFetch('/api/llm', { method: 'POST', body: '{}' });
    expect(fetchCalls.length).toBe(1);
    expect(storeCalls.length).toBe(0);
  });

  it('keeps sync push on the network', async () => {
    await apiFetch('/api/sync/push', { method: 'POST', body: '{}' });
    expect(fetchCalls.length).toBe(1);
    expect(storeCalls.length).toBe(0);
  });

  it('falls through to the server for routes the local layer does not handle', async () => {
    await apiFetch('/api/backup/list');
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe('/api/backup/list');
    expect(storeCalls.length).toBe(0);
  });

  it('polls course-doc generation status on the network, not from the local store', async () => {
    await apiFetch('/api/courses/foo/course-docs?status=true&type=summary');
    expect(fetchCalls.length).toBe(1);
    expect(storeCalls.length).toBe(0);
  });

  it('saves library uploads to the local store, never the network', async () => {
    const formData = new FormData();
    formData.append('file', new File([new Uint8Array([1, 2, 3])], 'Physics Book.pdf', { type: 'application/pdf' }));
    formData.append('title', 'Physics 11');
    formData.append('description', 'Reference textbook');
    const res = await apiFetch('/api/library/upload', { method: 'POST', body: formData });
    expect(res.status).toBe(201);
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(data.document.title).toBe('Physics 11');
    expect(data.document.format).toBe('pdf');
    expect(data.document.description).toBe('Reference textbook');
    expect(data.document.position).toBe(0);
    expect(storeCalls).toContain('saveLibraryDocLocally');
    expect(storeCalls).toContain('saveLibraryManifestLocally');
    expect(libManifest.documents.length).toBe(1);
    expect(libManifest.documents[0].filename).toBe('Physics Book.pdf');
    expect(libSavedDocs.has('Physics Book.pdf')).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });

  it('rejects library uploads with unsupported formats', async () => {
    const formData = new FormData();
    formData.append('file', new File([new Uint8Array([1])], 'notes.txt', { type: 'text/plain' }));
    const res = await apiFetch('/api/library/upload', { method: 'POST', body: formData });
    expect(res.status).toBe(400);
    expect(fetchCalls.length).toBe(0);
  });

  it('surfaces native save failures from library uploads', async () => {
    libSaveShouldFail = true;
    const formData = new FormData();
    formData.append('file', new File([new Uint8Array([1, 2])], 'bad.pdf', { type: 'application/pdf' }));
    const res = await apiFetch('/api/library/upload', { method: 'POST', body: formData });
    expect(res.status).toBe(500);
    const data: any = await res.json();
    expect(data.message).toContain('disk full');
    // The manifest was not touched by the failed upload
    expect(libManifest.documents.length).toBe(0);
    expect(fetchCalls.length).toBe(0);
  });

  it('reconciles the library manifest with /library files found on disk', async () => {
    libDiskEntries = [{ filename: 'dropped-book.epub', size: 42, mtime_ms: 1700000000000 }];
    const res = await apiFetch('/api/library');
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.documents.length).toBe(1);
    expect(data.documents[0].filename).toBe('dropped-book.epub');
    expect(data.documents[0].format).toBe('epub');
    expect(data.documents[0].title).toBe('Dropped Book');
    // The reconciled manifest is persisted back to the store
    expect(libManifest.documents.length).toBe(1);
    expect(fetchCalls.length).toBe(0);
  });

  it('deletes library documents along with their annotations and checkpoints', async () => {
    libManifest = {
      version: 1,
      documents: [
        { id: 'b.pdf', filename: 'b.pdf', format: 'pdf', title: 'B', description: '', additionDate: '2026-01-01T00:00:00.000Z', position: 0 }
      ]
    };
    libSavedDocs.set('b.pdf', new Uint8Array([1, 2, 3]).slice().buffer);
    libAnnotations = [{ id: 's1', file: 'b.pdf:p1', tool: 'marker', color: 'yellow', points: [1], authorWidth: 600, date: '2026-01-01T00:00:00.000Z' }];
    libCheckpoints = [{ id: 'c1', courseId: 'library', file: 'b.pdf:p3', verticalPosition: 3, type: 'position', date: '2026-01-01T00:00:00.000Z' }];

    const res = await apiFetch('/api/library/b.pdf', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(storeCalls).toContain('deleteLibraryDocLocally');
    expect(libManifest.documents.length).toBe(0);
    expect(libSavedDocs.has('b.pdf')).toBe(false);
    expect(libAnnotations.length).toBe(0);
    expect(libCheckpoints.length).toBe(0);
    expect(fetchCalls.length).toBe(0);
  });
});

describe('smartFetch & resolveFetchTransport routing', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
  });

  it('routes internal webview schemes to browser window.fetch', () => {
    expect(resolveFetchTransport('tauri://localhost/index.html')).toBe('browser');
    expect(resolveFetchTransport('tauri://localhost')).toBe('browser');
    expect(resolveFetchTransport('http://tauri.localhost/bundle.js')).toBe('browser');
    expect(resolveFetchTransport('https://tauri.localhost/courses')).toBe('browser');
    expect(resolveFetchTransport('courseasset://localhost/baf3m/assets/img.png')).toBe('browser');
    expect(resolveFetchTransport('blob:http://tauri.localhost/f9a8b7c6')).toBe('browser');
    expect(resolveFetchTransport('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==')).toBe('browser');
  });

  it('routes relative paths and empty URLs to browser window.fetch', () => {
    expect(resolveFetchTransport('/api/courses')).toBe('browser');
    expect(resolveFetchTransport('/health')).toBe('browser');
    expect(resolveFetchTransport('api/sync/bundle')).toBe('browser');
    expect(resolveFetchTransport('')).toBe('browser');
  });

  it('on mobile, even loopback goes native — there is no local sidecar on a device', () => {
    expect(resolveFetchTransport('http://127.0.0.1:3182/api/courses')).toBe('native');
    expect(resolveFetchTransport('http://127.0.0.1:3182/health')).toBe('native');
    expect(resolveFetchTransport('http://localhost:3182/api/sync')).toBe('native');
    expect(resolveFetchTransport('http://[::1]:3182/health')).toBe('native');
  });

  it('on mobile, binary bodies go native — the webview transport cannot reach the LAN desktop', () => {
    // Desktop keeps the zero-IPC window.fetch strategy for heavy bodies, but
    // mobile would be stranded: WKWebView rejects LAN http from the custom
    // scheme origin ("Load failed"), which silently broke every iPad push.
    const externalUrl = 'https://api.openai.com/v1/audio/transcriptions';
    const form = new FormData();
    expect(resolveFetchTransport(externalUrl, { body: form })).toBe('native');

    const blob = new Blob(['data'], { type: 'application/octet-stream' });
    expect(resolveFetchTransport(externalUrl, { body: blob })).toBe('native');

    const buffer = new ArrayBuffer(64);
    expect(resolveFetchTransport(externalUrl, { body: buffer })).toBe('native');

    const uint8 = new Uint8Array([1, 2, 3]);
    expect(resolveFetchTransport(externalUrl, { body: uint8 })).toBe('native');

    expect(
      resolveFetchTransport('http://192.168.1.150:3182/api/sync/push', {
        method: 'POST',
        body: new Uint8Array([1, 2, 3])
      })
    ).toBe('native');
  });

  it('routes external cross-origin and remote LAN requests in Tauri to native tauriFetch', () => {
    expect(resolveFetchTransport('https://api.openai.com/v1/chat/completions')).toBe('native');
    expect(resolveFetchTransport('https://api.deepseek.com/chat/completions')).toBe('native');
    expect(resolveFetchTransport('https://generativelanguage.googleapis.com/v1beta/models')).toBe('native');
    expect(resolveFetchTransport('http://192.168.1.150:3182/api/sync')).toBe('native');
  });

  it('smartFetch successfully resolves local loopback requests through window.fetch', async () => {
    const res = await smartFetch('http://127.0.0.1:3182/health');
    expect(res.ok).toBe(true);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:3182/health');
  });

  it('smartFetch successfully falls back to window.fetch if native tauriFetch fails', async () => {
    // In our test harness, @tauri-apps/plugin-http is mocked to throw, so smartFetch
    // should gracefully fall back to window.fetch and log a warning.
    const res = await smartFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o' })
    });
    expect(res.ok).toBe(true);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetchCalls[0].method).toBe('POST');
  });
});
