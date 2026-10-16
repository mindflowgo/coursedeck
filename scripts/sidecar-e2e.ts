/**
 * End-to-end test of the sidecar backend (server/index.ts → shared handler):
 * boots the sidecar on a scratch DATA_DIR, ingests a crafted course zip,
 * saves lesson tabs (incl. save-as-new-version), exercises course-docs and
 * theme endpoints, and roundtrips a backup export→import.
 *
 * Usage: bun run scripts/sidecar-e2e.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import { makePng } from './test-image';
import { killProcessTree } from './test-process';

const PORT = 3194;
const BASE = `http://127.0.0.1:${PORT}`;

// Strip sandbox proxy for local test loopback
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.all_proxy;
delete process.env.ALL_PROXY;

const SCRATCH = fs.mkdtempSync('/tmp/ilc-sidecar-e2e-');
fs.mkdirSync(path.join(SCRATCH, 'courses', 'gtest1', '_backup'), { recursive: true });

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

// Craft a lesson package zip (fflate — same codec the extractor uses)
const html = `<html><body><section id="ilc_mindsOn"><h1>Learning activity 1.1</h1><div class="ilcLearningGoals">Goals here</div><img src="img/pic.png"></section></body></html>`;
const zipBytes = zipSync(
  {
    'gwl3o_u1la1.html': new TextEncoder().encode(html),
    'img/pic.png': await makePng(40) // 8:6 aspect → 40x30
  },
  { level: 6 }
);
fs.writeFileSync(path.join(SCRATCH, 'courses', 'gtest1', '_backup', 'gwl3o_u1la1.zip'), zipBytes);

// Boot the sidecar
const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !/^(http|https|all)_proxy$/i.test(k)) {
    cleanEnv[k] = v;
  }
}
cleanEnv.PORT = String(PORT);
cleanEnv.DATA_DIR = SCRATCH;

const proc = Bun.spawn([process.execPath, 'server/index.ts'], {
  env: cleanEnv,
  stdout: 'pipe',
  stderr: 'pipe'
});

try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/courses`);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ready) throw new Error('sidecar did not start');

  // Ingest
  const form = new FormData();
  form.append('courseId', 'gtest1');
  form.append('mode', 'add');
  form.append(
    'files',
    new Blob([zipBytes], { type: 'application/zip' }),
    'gwl3o_u1la1.zip'
  );
  const parseRes = await fetch(`${BASE}/api/parse`, { method: 'POST', body: form });
  const parseBody: any = await parseRes.json();
  check('ingest via /api/parse', parseRes.status === 200 && parseBody.success === true, JSON.stringify(parseBody).slice(0, 120));

  const courseDir = path.join(SCRATCH, 'courses', 'gtest1');
  const lessonMd = path.join(courseDir, '01.01.lesson.md');
  check('lesson markdown written', fs.existsSync(lessonMd));
  const mdText = fs.existsSync(lessonMd) ? fs.readFileSync(lessonMd, 'utf8') : '';
  const fmMatch = mdText.match(/^---\s*\n([\s\S]*?)\n---/);
  const fm = fmMatch ? (globalThis as any).Bun.YAML.parse(fmMatch[1]) : null;
  check('frontmatter parses (Bun.YAML round-trip)', fm !== null && typeof fm === 'object' && 'title' in fm, mdText.slice(0, 80));
  check('asset extracted from zip', fs.existsSync(path.join(courseDir, 'assets', 'img', 'pic.png')));

  // Lesson save (one file per lesson+tab; versioning was removed from the app)
  const putRes = await fetch(`${BASE}/api/courses/gtest1/01.01`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab: 'summary', content: '# S\n\ncontent v1' })
  });
  const putBody: any = await putRes.json();
  check('lesson PUT save → {success, filename}', putRes.status === 200 && putBody.success === true && typeof putBody.filename === 'string', JSON.stringify(putBody));

  const putRes2 = await fetch(`${BASE}/api/courses/gtest1/01.01`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab: 'summary', content: '# S\n\ncontent v2' })
  });
  const putBody2: any = await putRes2.json();
  check('lesson PUT overwrite save → {success}', putRes2.status === 200 && putBody2.success === true, JSON.stringify(putBody2));

  // Course-docs GET (aggregated notes)
  const notesRes = await fetch(`${BASE}/api/courses/gtest1/course-docs?type=notes`);
  const notesBody: any = await notesRes.json();
  check(
    'course-docs GET ?type=notes',
    notesRes.status === 200 && notesBody.success === true && typeof notesBody.markdown === 'string' && notesBody.markdown.length > 0,
    JSON.stringify(notesBody).slice(0, 80)
  );

  // Theme endpoint
  const themeRes = await fetch(`${BASE}/api/settings/theme`);
  const themeBody: any = await themeRes.json();
  check('theme GET', themeRes.status === 200 && themeBody.success === true && typeof themeBody.theme === 'string');

  // Backup export → import roundtrip
  const exp = await fetch(`${BASE}/api/backup/export`);
  const backupBytes = new Uint8Array(await exp.arrayBuffer());
  check('backup export zip', exp.status === 200 && backupBytes[0] === 0x50 && backupBytes[1] === 0x4b);

  const impForm = new FormData();
  impForm.append('file', new Blob([backupBytes], { type: 'application/zip' }), 'backup.zip');
  const imp = await fetch(`${BASE}/api/backup/import`, { method: 'POST', body: impForm });
  const impBody: any = await imp.json();
  check('backup import restores', imp.status === 200 && impBody.success === true && impBody.filesRestored > 0, JSON.stringify(impBody).slice(0, 120));
} finally {
  killProcessTree(proc);
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? 'All sidecar e2e checks passed.' : `${failures} sidecar e2e check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
