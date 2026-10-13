/**
 * API contract test for the bundled sidecar (server/index.ts).
 *
 * Boots the sidecar on a scratch DATA_DIR and asserts the response shapes
 * the frontend relies on — the class of bug found when the sidecar drifted
 * from the SvelteKit routes (addTasks vs enqueue, cancelAll vs cancel, ...).
 *
 * Usage: bun run scripts/api-contract.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { makePng, imageSize } from './test-image';

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = fs.mkdtempSync('/tmp/ilc-contract-');
fs.mkdirSync(path.join(SCRATCH, 'courses'), { recursive: true });

// Synthetic course with one oversized PNG (8:6 aspect) so compression runs
// end-to-end through the compiled/bundled codec path. Images are synthesized
// with Bun.Image — no pngjs/jpeg-js dependencies needed.
await (async () => {
  const courseDir = path.join(SCRATCH, 'courses', 'tst01');
  fs.mkdirSync(path.join(courseDir, 'assets', 'img'), { recursive: true });
  fs.writeFileSync(path.join(courseDir, 'assets', 'img', 'big_diagram.png'), await makePng(900));
  fs.writeFileSync(
    path.join(courseDir, '01.01.lesson.md'),
    '# Lesson\n\n![Big diagram](./assets/img/big_diagram.png)\n'
  );
})();

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(
  route: string,
  init?: RequestInit & { headers?: Record<string, string> }
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${BASE}${route}`, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

// Boot sidecar on the scratch data dir
const proc = Bun.spawn(['bun', 'server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH },
  stdout: 'pipe',
  stderr: 'pipe'
});

try {
  // Wait for readiness
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/queue`);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ready) throw new Error('sidecar did not start');
  console.log(`Sidecar ready on ${BASE} (scratch: ${SCRATCH})\n`);

  console.log('Queue contract:');
  {
    const q = await req('/api/queue?courseId=tst01');
    check(
      'GET /api/queue returns QueueStatus shape',
      q.status === 200 &&
        ['isRunning', 'isPaused', 'pendingCount', 'completedCount', 'failedCount', 'tasks', 'recentLogs'].every(
          (k) => k in q.body
        )
    );

    const noCourse = await req('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue' })
    });
    check('enqueue without courseId → 400 {message}', noCourse.status === 400 && typeof noCourse.body.message === 'string');

    const courseWide = await req('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue', courseId: 'zzz9' })
    });
    check(
      'course-wide enqueue → {success, enqueued[], status}',
      courseWide.status === 200 &&
        courseWide.body.success === true &&
        Array.isArray(courseWide.body.enqueued) &&
        typeof courseWide.body.status?.isRunning === 'boolean'
    );

    const byLesson = await req('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue', courseId: 'zzz9', lessonId: '01.01', tab: 'summary' })
    });
    check(
      'lesson enqueue with tab → {success, enqueued[], status}',
      byLesson.status === 200 && Array.isArray(byLesson.body.enqueued) && 'status' in byLesson.body
    );

    const lessonTab = await req('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue', courseId: 'zzz9', lessonId: '01.01', tab: 'lesson' })
    });
    check('enqueue with tab=lesson rejected → 400', lessonTab.status === 400);

    const bogusTab = await req('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue', courseId: 'zzz9', tabs: ['summary', 'nope'] })
    });
    check('enqueue with unknown tab name rejected → 400', bogusTab.status === 400);

    const legacyAction = await req('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancelAll' })
    });
    check('legacy action name (cancelAll) rejected like SvelteKit route', legacyAction.status === 400);

    for (const action of ['pause', 'resume', 'cancel', 'retry']) {
      const r = await req('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      check(`action ${action} → {success, status}`, r.status === 200 && r.body.success === true && 'status' in r.body);
    }
  }

  console.log('\nPrompts contract:');
  {
    const p = await req('/api/prompts');
    check('GET /api/prompts → {prompts: array}', p.status === 200 && Array.isArray(p.body.prompts));

    const bad = await req('/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'summary' })
    });
    check('POST without content → 400', bad.status === 400);
  }

  console.log('\nCourses / LLM / maintenance:');
  {
    const c = await req('/api/courses');
    check('GET /api/courses → {courses: array}', c.status === 200 && Array.isArray(c.body.courses));

    const llm = await req('/api/llm');
    check('GET /api/llm → {hasConfig: boolean}', llm.status === 200 && typeof llm.body.hasConfig === 'boolean');

    const missing = await req('/api/courses/zzz9');
    check('GET unknown course → 404 {message}', missing.status === 404 && typeof missing.body.message === 'string');

    const compress = await req('/api/maintenance/compress-images', { method: 'POST', body: '{}' });
    check(
      'compress-images → {success, results[], totals}',
      compress.status === 200 && Array.isArray(compress.body.results) && 'totals' in compress.body
    );
  }

  console.log('\nBackup export:');
  {
    const res = await fetch(`${BASE}/api/backup/export`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    check(
      'GET /api/backup/export → zip payload',
      res.status === 200 &&
        res.headers.get('content-type') === 'application/zip' &&
        bytes.length >= 4 &&
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b
    );
  }

  console.log('\nCORS hardening:');
  {
    const evil = await fetch(`${BASE}/api/courses`, { headers: { Origin: 'https://evil.example' } });
    check('foreign origin gets no ACAO header', evil.headers.get('access-control-allow-origin') === null);

    const local = await fetch(`${BASE}/api/courses`, { headers: { Origin: 'http://localhost:5173' } });
    check('localhost origin echoed', local.headers.get('access-control-allow-origin') === 'http://localhost:5173');

    const tauri = await fetch(`${BASE}/api/courses`, { headers: { Origin: 'http://tauri.localhost' } });
    check('tauri webview origin echoed', tauri.headers.get('access-control-allow-origin') === 'http://tauri.localhost');
  }

  console.log('\nImage compression roundtrip (tst01):');
  {
    // Re-seed a fresh oversized PNG (an earlier all-courses compress call may
    // have already consumed the one created at boot).
    const courseDir = path.join(SCRATCH, 'courses', 'tst01');
    fs.writeFileSync(path.join(courseDir, 'assets', 'img', 'big_diagram.png'), await makePng(900));

    const res = await req('/api/maintenance/compress-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: 'tst01' })
    });
    const entry = res.body.results?.[0];
    check('compress-images converts the oversized PNG', res.status === 200 && entry?.converted === 1);

    const jpgPath = path.join(courseDir, 'assets', 'img', 'big_diagram.jpg');
    const pngGone = !fs.existsSync(path.join(courseDir, 'assets', 'img', 'big_diagram.png'));
    check('original PNG removed, JPEG present', pngGone && fs.existsSync(jpgPath));

    const dims = await imageSize(fs.readFileSync(jpgPath));
    check('JPEG clamped to 512px width', dims.width === 512 && dims.height === 384);

    const md = fs.readFileSync(path.join(courseDir, '01.01.lesson.md'), 'utf8');
    check(
      'markdown ref rewritten with |50% spec',
      md.includes('![Big diagram|50%](./assets/img/big_diagram.jpg)')
    );
  }

  console.log('\nURL decoding:');
  {
    // An asset name containing a literal '%' arrives percent-encoded (%25);
    // it must decode once and miss (404), not double-decode and blow up (500).
    const pct = await fetch(`${BASE}/api/courses/tst01/assets/img/100%25.png`);
    check('asset path with encoded % → 404, not double-decoded 500', pct.status === 404);

    const malformed = await fetch(`${BASE}/api/courses/%E0%A4%A`);
    check('malformed percent escape in path → 400', malformed.status === 400);
  }

  console.log('\nUnknown route:');
  {
    const nf = await req('/api/definitely-not-a-route');
    check('404 with {message}', nf.status === 404 && typeof nf.body.message === 'string');
  }
} finally {
  proc.kill(9);
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {}
}

console.log(
  failures === 0 ? '\nAll sidecar contract checks passed.' : `\n${failures} contract check(s) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
