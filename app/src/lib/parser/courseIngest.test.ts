import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CourseIngest } from './courseIngest';

const temporaryRoots: string[] = [];

function makeCourseDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coursedeck-ingest-test-'));
  temporaryRoots.push(root);
  const courseDir = path.join(root, 'baf3m');
  fs.mkdirSync(courseDir, { recursive: true });
  return courseDir;
}

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=',
  'base64'
);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('CourseIngest compatibility', () => {
  it('re-parses an archived HTML package with its sibling assets under <stem>assets', async () => {
    const courseDir = makeCourseDir();
    const backupDir = path.join(courseDir, '_backup');
    const companionDir = path.join(backupDir, 'Lesson 1.5assets');
    fs.mkdirSync(companionDir, { recursive: true });
    fs.writeFileSync(path.join(companionDir, 'photo.png'), TINY_PNG);
    fs.writeFileSync(
      path.join(backupDir, 'Lesson 1.5.html'),
      `<!doctype html>
<html>
<head><title>Lesson 1.5: Percents</title></head>
<body><main id="mainContent">
<h1>Lesson 1.5: Percents</h1>
<p><img src="Lesson 1.5assets/photo.png" alt="Photo"></p>
</main></body>
</html>`
    );

    // The course assets folder is intentionally absent: everything must be
    // rebuilt from the archived package alone.
    expect(fs.existsSync(path.join(courseDir, 'assets'))).toBe(false);

    const manifest = await new CourseIngest().ingestCourse(courseDir);
    expect(manifest.units.flatMap((unit) => unit.lessons.map((lesson) => lesson.id))).toContain('01.05');
    expect(fs.existsSync(path.join(courseDir, 'assets', 'img', 'photo.png'))).toBe(true);

    const lesson = fs.readFileSync(path.join(courseDir, '01.05.lesson.md'), 'utf8');
    expect(lesson).toContain('![Photo](./assets/img/photo.png)');
  });

  it('preserves iOS-created empty metadata and unknown root/unit/lesson fields', async () => {
    const courseDir = makeCourseDir();
    fs.writeFileSync(
      path.join(courseDir, 'meta.json'),
      JSON.stringify(
        {
          id: 'baf3m',
          title: 'iOS Course',
          grade: '',
          level: '',
          description: '',
          customRoot: { keep: true },
          units: [
            {
              number: 1,
              title: '',
              customUnit: 'keep-unit',
              lessons: [
                {
                  id: '01.01',
                  code: '',
                  title: '',
                  unitNumber: 1,
                  lessonNumber: 1,
                  type: 'lesson',
                  hasFull: true,
                  hasSummary: false,
                  hasCheatsheet: false,
                  hasTest: false,
                  customLesson: 'keep-lesson'
                }
              ]
            }
          ],
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        null,
        2
      )
    );
    fs.writeFileSync(path.join(courseDir, '01.01.lesson.md'), '# Lesson 01.01\n');

    const manifest = await new CourseIngest().ingestCourse(courseDir);
    expect(manifest.grade).toBe('');
    expect(manifest.level).toBe('');
    expect(manifest.description).toBe('');
    expect((manifest as unknown as { customRoot: unknown }).customRoot).toEqual({ keep: true });
    expect((manifest.units[0] as unknown as { customUnit: string }).customUnit).toBe('keep-unit');
    expect(manifest.units[0].title).toBe('');
    expect(
      (manifest.units[0].lessons[0] as unknown as { customLesson: string }).customLesson
    ).toBe('keep-lesson');
  });

  it('merges existing manifest lessons when _backup is absent', async () => {
    const courseDir = makeCourseDir();
    fs.writeFileSync(
      path.join(courseDir, 'meta.json'),
      JSON.stringify(
        {
          id: 'baf3m',
          title: 'BAF3M',
          units: [
            {
              number: 1,
              title: 'Fractions Unit',
              lessons: [
                {
                  id: '01.01',
                  code: 'baf3m_u1la1',
                  title: 'Lesson 01.01',
                  unitNumber: 1,
                  lessonNumber: 1,
                  type: 'lesson',
                  hasFull: true,
                  hasSummary: false,
                  hasCheatsheet: false,
                  hasTest: false
                },
                {
                  id: '01.02',
                  code: 'baf3m_u1la2',
                  title: 'Lesson 01.02',
                  unitNumber: 1,
                  lessonNumber: 2,
                  type: 'lesson',
                  hasFull: true,
                  hasSummary: false,
                  hasCheatsheet: false,
                  hasTest: false
                }
              ]
            }
          ],
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        null,
        2
      )
    );
    fs.writeFileSync(path.join(courseDir, '01.01.lesson.md'), '# Lesson 01.01\n');
    fs.writeFileSync(path.join(courseDir, '01.02.lesson.md'), '# Lesson 01.02\n');

    const manifest = await new CourseIngest().ingestCourse(courseDir);
    const ids = manifest.units.flatMap((unit) => unit.lessons.map((lesson) => lesson.id));
    expect(ids).toEqual(['01.01', '01.02']);
    expect(manifest.units[0].title).toBe('Fractions Unit');
  });
});
