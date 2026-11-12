import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { handleApiRequest } from './api';
import { CourseService } from './courses';
import { getPromptsDir, getDataDir } from './paths';

const testCourseId = 'sync_bundle_test_101';
const testCourseDir = path.join(CourseService.getCoursesDir(), testCourseId);

function setupTestCourse(): void {
  fs.mkdirSync(testCourseDir, { recursive: true });
  const manifest = {
    id: testCourseId,
    title: 'Sync Test Course',
    grade: '11',
    level: 'Academic',
    units: []
  };
  fs.writeFileSync(path.join(testCourseDir, '.manifest.json'), JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(testCourseDir, '01.01.lesson.md'), '# Lesson 1 content', 'utf8');

  const lockerDir = path.join(testCourseDir, 'assets', 'locker_docs');
  const imgDir = path.join(testCourseDir, 'assets', 'img');
  const backupDir = path.join(testCourseDir, '_backup');
  fs.mkdirSync(lockerDir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  fs.writeFileSync(
    path.join(lockerDir, 'course.pdf'),
    Buffer.from('%PDF-1.4 dummy textbook content for testing course.pdf')
  );
  fs.writeFileSync(
    path.join(imgDir, 'diagram.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  );
  fs.writeFileSync(path.join(backupDir, 'raw.zip'), Buffer.from('legacy archive'), 'utf8');
}

describe('Sync Bundle API (/api/sync/bundle)', () => {
  beforeEach(() => {
    if (fs.existsSync(testCourseDir)) {
      fs.rmSync(testCourseDir, { recursive: true, force: true });
    }
    setupTestCourse();
  });

  afterEach(() => {
    if (fs.existsSync(testCourseDir)) {
      fs.rmSync(testCourseDir, { recursive: true, force: true });
    }
  });

  it('lists desktop courses for the selective-sync picker', async () => {
    const req = new Request('http://127.0.0.1:3182/api/sync/courses', { method: 'GET' });
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const data = await res.json();
    const entry = data.courses.find((c: any) => c.id === testCourseId);
    expect(entry).toBeDefined();
    expect(entry.title).toBe('Sync Test Course');
    expect(typeof entry.lessonCount).toBe('number');
    expect(typeof entry.coursePDF).toBe('boolean');
  });

  it('returns a zip archive by default with all course files and assets', async () => {
    const req = new Request(`http://127.0.0.1:3182/api/sync/bundle?courseIds=${testCourseId}`, {
      method: 'GET'
    });
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');

    const archive = unzipSync(new Uint8Array(await res.arrayBuffer()));

    const lesson = Buffer.from(archive[`courses/${testCourseId}/01.01.lesson.md`]).toString('utf8');
    expect(lesson).toBe('# Lesson 1 content');
    expect(archive[`courses/${testCourseId}/.manifest.json`]).toBeDefined();
    expect(archive[`courses/${testCourseId}/assets/locker_docs/course.pdf`]).toBeDefined();
    expect(archive[`courses/${testCourseId}/assets/img/diagram.png`]).toBeDefined();
  });

  it('streams a zip bundle with course files, assets, sync meta — and no _backup', async () => {
    const req = new Request(
      `http://127.0.0.1:3182/api/sync/bundle?courseIds=${testCourseId}`,
      { method: 'GET' }
    );
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('X-Sync-Generated-At')).toBeTruthy();

    const archive = unzipSync(new Uint8Array(await res.arrayBuffer()));

    // Markdown + manifest + assets are all present with course content
    const lesson = Buffer.from(archive[`courses/${testCourseId}/01.01.lesson.md`]).toString('utf8');
    expect(lesson).toBe('# Lesson 1 content');
    expect(archive[`courses/${testCourseId}/.manifest.json`]).toBeDefined();
    expect(
      archive[`courses/${testCourseId}/assets/locker_docs/course.pdf`]
    ).toBeDefined();
    expect(archive[`courses/${testCourseId}/assets/img/diagram.png`]).toBeDefined();

    // The _backup directory is excluded
    expect(archive[`courses/${testCourseId}/_backup/raw.zip`]).toBeUndefined();
    expect(Object.keys(archive).some((k) => k.includes('_backup'))).toBe(false);

    // Sync metadata rides along at a well-known path
    const meta = JSON.parse(Buffer.from(archive['_sync/meta.json']).toString('utf8'));
    expect(meta.version).toBe(1);
    expect(meta.generatedAt).toBeTruthy();
    expect(Array.isArray(meta.prompts)).toBe(true);
    expect(meta.llmConfig).toBeDefined();
  });

  it('incremental zip bundles only files modified since the given timestamp', async () => {
    // Age everything except diagram.png by a day
    const dayAgo = new Date(Date.now() - 86_400_000);
    for (const rel of ['.manifest.json', '01.01.lesson.md', 'assets/locker_docs/course.pdf']) {
      fs.utimesSync(path.join(testCourseDir, rel), dayAgo, dayAgo);
    }

    const since = new Date(Date.now() - 60_000).toISOString();
    const req = new Request(
      `http://127.0.0.1:3182/api/sync/bundle?courseIds=${testCourseId}&since=${encodeURIComponent(since)}`,
      { method: 'GET' }
    );
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const archive = unzipSync(new Uint8Array(await res.arrayBuffer()));

    // Freshly modified file is included; aged files are left out
    expect(archive[`courses/${testCourseId}/assets/img/diagram.png`]).toBeDefined();
    expect(archive[`courses/${testCourseId}/assets/locker_docs/course.pdf`]).toBeUndefined();
    expect(archive[`courses/${testCourseId}/01.01.lesson.md`]).toBeUndefined();
    // The manifest rides along whenever the course has any change
    expect(archive[`courses/${testCourseId}/.manifest.json`]).toBeDefined();
    expect(archive['_sync/meta.json']).toBeDefined();
  });

  it('omits courses with no changes since the timestamp', async () => {
    const dayAgo = new Date(Date.now() - 86_400_000);
    fs.utimesSync(testCourseDir, dayAgo, dayAgo);
    const ageAll = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        fs.utimesSync(abs, dayAgo, dayAgo);
        if (entry.isDirectory()) ageAll(abs);
      }
    };
    ageAll(testCourseDir);

    const since = new Date(Date.now() - 60_000).toISOString();
    const req = new Request(
      `http://127.0.0.1:3182/api/sync/bundle?courseIds=${testCourseId}&since=${encodeURIComponent(since)}`,
      { method: 'GET' }
    );
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Sync-Courses')).toBe('0');

    const archive = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(archive).some((k) => k.startsWith('courses/'))).toBe(false);
    expect(archive['_sync/meta.json']).toBeDefined();
  });

  it('rejects an invalid since timestamp', async () => {
    const req = new Request(
      `http://127.0.0.1:3182/api/sync/bundle?since=not-a-date`,
      { method: 'GET' }
    );
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(400);
  });

  it('fullCourses bypasses the since cursor so new courses arrive complete', async () => {
    // Age every file: an incremental sync would skip the whole course.
    const dayAgo = new Date(Date.now() - 86_400_000);
    const ageAll = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        fs.utimesSync(abs, dayAgo, dayAgo);
        if (entry.isDirectory()) ageAll(abs);
      }
    };
    ageAll(testCourseDir);

    const since = new Date(Date.now() - 60_000).toISOString();
    const req = new Request(
      `http://127.0.0.1:3182/api/sync/bundle?courseIds=${testCourseId}&since=${encodeURIComponent(since)}&fullCourses=${testCourseId}`,
      { method: 'GET' }
    );
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Sync-Courses')).toBe('1');

    const archive = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(archive[`courses/${testCourseId}/01.01.lesson.md`]).toBeDefined();
    expect(archive[`courses/${testCourseId}/assets/locker_docs/course.pdf`]).toBeDefined();
    expect(archive[`courses/${testCourseId}/assets/img/diagram.png`]).toBeDefined();
  });

  it('prepare streams NDJSON progress, writes a valid bundle, and serves it by token', async () => {
    const req = new Request(
      `http://127.0.0.1:3182/api/sync/bundle/prepare?courseIds=${testCourseId}`,
      { method: 'POST', body: new FormData() }
    );
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');

    const lines = (await res.text())
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const complete = lines.find((l: any) => l.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.token).toMatch(/^sync-[\w-]+\.zip$/);
    expect(complete.url).toContain('/api/sync/bundle/download?token=');
    // At least the opening and final progress lines streamed through.
    expect(lines.some((l: any) => l.type === 'progress')).toBe(true);

    // The prepared archive downloads intact and contains the course.
    const dl = new Request(`http://127.0.0.1:3182${complete.url}`, { method: 'GET' });
    const dlRes = await handleApiRequest(dl, new URL(dl.url));
    expect(dlRes.status).toBe(200);
    const archive = unzipSync(new Uint8Array(await dlRes.arrayBuffer()));
    expect(archive[`courses/${testCourseId}/01.01.lesson.md`]).toBeDefined();
    expect(archive['_sync/meta.json']).toBeDefined();

    // Don't leave the prepared temp file behind in the data dir.
    fs.rmSync(path.join(getDataDir(), '_sync-tmp', complete.token), { force: true });

    // Bogus tokens are rejected.
    const bad = new Request(
      `http://127.0.0.1:3182/api/sync/bundle/download?token=${encodeURIComponent('../../evil.zip')}`,
      { method: 'GET' }
    );
    const badRes = await handleApiRequest(bad, new URL(bad.url));
    expect(badRes.status).toBe(400);
  });
});

describe('Sync Push API (/api/sync/push)', () => {
  const pushCourseId = 'sync_push_test_101';
  const pushCourseDir = path.join(CourseService.getCoursesDir(), pushCourseId);
  const testPromptId = 'push_test_prompt_9x';
  const testPromptPath = () => path.join(getPromptsDir(), `${testPromptId}.md`);

  beforeEach(() => {
    fs.rmSync(pushCourseDir, { recursive: true, force: true });
    fs.mkdirSync(pushCourseDir, { recursive: true });
    fs.writeFileSync(
      path.join(pushCourseDir, '.manifest.json'),
      JSON.stringify({ id: pushCourseId, title: 'Push Test', units: [] }),
      'utf8'
    );
  });

  afterEach(() => {
    fs.rmSync(pushCourseDir, { recursive: true, force: true });
    if (fs.existsSync(testPromptPath())) fs.rmSync(testPromptPath(), { force: true });
  });

  async function push(payload: Record<string, unknown>): Promise<any> {
    const req = new Request('http://127.0.0.1:3182/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);
    return res.json();
  }

  it('applies pushed documents with mtime-guarded last-writer-wins', async () => {
    await push({
      documents: {
        [pushCourseId]: [
          { filename: '01.01.lesson.md', content: '# edited on ipad', date: new Date().toISOString() }
        ]
      }
    });
    expect(fs.readFileSync(path.join(pushCourseDir, '01.01.lesson.md'), 'utf8')).toBe('# edited on ipad');

    // A desktop edit made after the iPad write is newer — the stale push must not clobber it.
    fs.writeFileSync(path.join(pushCourseDir, '01.01.lesson.md'), '# desktop wins', 'utf8');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(pushCourseDir, '01.01.lesson.md'), future, future);
    await push({
      documents: {
        [pushCourseId]: [
          { filename: '01.01.lesson.md', content: '# stale ipad edit', date: new Date().toISOString() }
        ]
      }
    });
    expect(fs.readFileSync(path.join(pushCourseDir, '01.01.lesson.md'), 'utf8')).toBe('# desktop wins');
  });

  it('applies document tombstones only when the delete is newer than the file', async () => {
    fs.writeFileSync(path.join(pushCourseDir, '01.02.lesson.md'), '# old', 'utf8');

    // Tombstone older than the file: keep the file.
    await push({
      documents: {
        [pushCourseId]: [
          { filename: '01.02.lesson.md', content: null, date: new Date(Date.now() - 120_000).toISOString() }
        ]
      }
    });
    expect(fs.existsSync(path.join(pushCourseDir, '01.02.lesson.md'))).toBe(true);

    // Tombstone newer than the file: delete it.
    await push({
      documents: {
        [pushCourseId]: [
          { filename: '01.02.lesson.md', content: null, date: new Date(Date.now() + 120_000).toISOString() }
        ]
      }
    });
    expect(fs.existsSync(path.join(pushCourseDir, '01.02.lesson.md'))).toBe(false);
  });

  it('rejects path-traversal document filenames', async () => {
    const data = await push({
      documents: {
        [pushCourseId]: [
          { filename: '../evil.md', content: 'x', date: new Date().toISOString() }
        ]
      }
    });
    expect(data.results[pushCourseId].errors.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(CourseService.getCoursesDir(), 'evil.md'))).toBe(false);
  });

  it('propagates checkpoint saves and delete tombstones', async () => {
    const hasCp = () => CourseService.getCheckpoints(pushCourseId).some((c) => c.id === 'cp_push_1');

    await push({
      checkpoints: {
        [pushCourseId]: [
          { id: 'cp_push_1', file: '01.01.lesson.md', verticalPosition: 0.5, type: 'note', date: new Date().toISOString() }
        ]
      }
    });
    expect(hasCp()).toBe(true);

    // Older tombstone: desktop keeps its copy.
    await push({
      checkpoints: {
        [pushCourseId]: [{ id: 'cp_push_1', deleted: true, date: new Date(Date.now() - 60_000).toISOString() }]
      }
    });
    expect(hasCp()).toBe(true);

    // Newer tombstone: checkpoint is removed.
    await push({
      checkpoints: {
        [pushCourseId]: [{ id: 'cp_push_1', deleted: true, date: new Date(Date.now() + 60_000).toISOString() }]
      }
    });
    expect(hasCp()).toBe(false);
  });

  it('applies pushed prompt saves and delete tombstones', async () => {
    await push({
      prompts: [{ id: testPromptId, content: '# Push Test', date: new Date().toISOString() }]
    });
    expect(fs.existsSync(testPromptPath())).toBe(true);

    await push({
      prompts: [{ id: testPromptId, content: null, date: new Date(Date.now() + 60_000).toISOString() }]
    });
    expect(fs.existsSync(testPromptPath())).toBe(false);
  });

  it('ignores assets in the push payload — binaries move through the multipart locker-doc routes', async () => {
    const lockerDir = path.join(pushCourseDir, 'assets', 'locker_docs');
    const assetPath = path.join(lockerDir, 'pasted.jpg');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);

    // Legacy field shape (with base64) must be ignored, never written.
    await push({
      assets: {
        [pushCourseId]: [{ filename: 'pasted.jpg', base64: bytes.toString('base64'), date: new Date().toISOString() }]
      }
    });
    expect(fs.existsSync(assetPath)).toBe(false);
  });

  it('applies pushed locker-doc binaries via the multipart route with last-writer-wins', async () => {
    const lockerDir = path.join(pushCourseDir, 'assets', 'locker_docs');
    const assetPath = path.join(lockerDir, 'pasted.jpg');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    fs.mkdirSync(lockerDir, { recursive: true });

    async function uploadLockerDoc(file: File, date?: string): Promise<any> {
      const formData = new FormData();
      formData.append('file', file);
      if (date) formData.append('date', date);
      const req = new Request(
        `http://127.0.0.1:3182/api/courses/${pushCourseId}/locker-docs`,
        { method: 'POST', body: formData }
      );
      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      return res.json();
    }

    // Fresh upload with the writing device's timestamp lands on disk.
    const writeDate = new Date().toISOString();
    await uploadLockerDoc(new File([new Uint8Array(bytes)], 'pasted.jpg'), writeDate);
    expect(fs.existsSync(assetPath)).toBe(true);
    expect(fs.readFileSync(assetPath).equals(bytes)).toBe(true);

    // A stale push (older than the desktop's copy) is skipped, not clobbering.
    const newerDesktopWrite = new Date(Date.now() + 60_000);
    fs.utimesSync(assetPath, newerDesktopWrite, newerDesktopWrite);
    await uploadLockerDoc(new File([new Uint8Array([0x00])], 'pasted.jpg'), writeDate);
    expect(fs.readFileSync(assetPath).equals(bytes)).toBe(true);

    // Tombstones go through the same route's DELETE.
    const del = new Request(
      `http://127.0.0.1:3182/api/courses/${pushCourseId}/locker-docs?file=${encodeURIComponent('pasted.jpg')}`,
      { method: 'DELETE' }
    );
    const delRes = await handleApiRequest(del, new URL(del.url));
    expect(delRes.status).toBe(200);
    expect(fs.existsSync(assetPath)).toBe(false);
  });

  it('contains traversal filenames in the locker-doc multipart route', async () => {
    const formData = new FormData();
    formData.append('file', new File([new Uint8Array([1])], '../../evil.bin'));
    const req = new Request(
      `http://127.0.0.1:3182/api/courses/${pushCourseId}/locker-docs`,
      { method: 'POST', body: formData }
    );
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    // Basename'd into the locker dir — nothing may escape the course folder.
    expect(fs.existsSync(path.join(CourseService.getCoursesDir(), 'evil.bin'))).toBe(false);
    expect(fs.existsSync(path.join(pushCourseDir, 'assets', 'locker_docs', 'evil.bin'))).toBe(true);
  });
});
