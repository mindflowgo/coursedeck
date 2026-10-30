// app/src/lib/api.routing.test.ts
// Verifies the local-first routing contract: on Tauri (desktop AND iPad),
// every file-backed route is served from the local store; only ONLINE_ONLY
// routes (LLM generation, sync, ...) touch the network.

import { describe, expect, it, beforeEach, mock } from 'bun:test';

const storeCalls: string[] = [];
const fetchCalls: Array<{ url: string; method: string }> = [];

const lessonBundle = { lesson: '# Lesson from local store', tabs: { summary: '# Summary' } };

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
    return [];
  },
  saveCheckpointLocally: async () => {
    storeCalls.push('saveCheckpointLocally');
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
  getCachedPdfAsset: async () => undefined,
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
  }
}));

const { apiFetch, isTauriMobile } = await import('./api');

describe('apiFetch routing in a Tauri mobile (iPad) environment', () => {
  beforeEach(() => {
    storeCalls.length = 0;
    fetchCalls.length = 0;
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
});
