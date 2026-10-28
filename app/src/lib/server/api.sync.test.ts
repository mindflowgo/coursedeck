import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { handleApiRequest } from './api';
import { CourseService } from './courses';

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
  fs.writeFileSync(path.join(testCourseDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
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
    expect(archive[`courses/${testCourseId}/manifest.json`]).toBeDefined();
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
    expect(archive[`courses/${testCourseId}/manifest.json`]).toBeDefined();
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
    for (const rel of ['manifest.json', '01.01.lesson.md', 'assets/locker_docs/course.pdf']) {
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
    expect(archive[`courses/${testCourseId}/manifest.json`]).toBeDefined();
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
});
