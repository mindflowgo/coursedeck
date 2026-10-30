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
import { killProcessTree } from './test-process';

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

// Strip sandbox proxy for local test loopback
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.all_proxy;
delete process.env.ALL_PROXY;
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

const SCRATCH = fs.mkdtempSync('/tmp/ilc-contract-');
fs.mkdirSync(path.join(SCRATCH, 'courses'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'settings.json'), JSON.stringify({ data_dir: SCRATCH }), 'utf8');
// Prompt templates exist in a real install; seed the ones course-doc generation
// looks up first so those checks exercise the LLM-config gate, not a missing prompt.
fs.mkdirSync(path.join(SCRATCH, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'prompts', 'course_schedule.md'), 'Generate a study schedule.\n');
fs.writeFileSync(path.join(SCRATCH, 'prompts', 'course_summary.md'), 'Summarize the course.\n');

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
  // Minimal manifest so course-doc endpoints recognise the fixture course.
  fs.writeFileSync(
    path.join(courseDir, 'meta.json'),
    JSON.stringify({
      id: 'tst01',
      title: 'Contract Fixture Course',
      grade: '11',
      level: 'U',
      description: 'scratch fixture',
      units: [
        {
          number: 1,
          title: 'Unit One',
          lessons: [
            {
              id: '01.01',
              code: 'tst01_u1la1',
              title: 'Lesson One',
              unitNumber: 1,
              lessonNumber: 1,
              type: 'lesson',
              hasFull: true,
              hasSummary: false,
              hasNotes: false,
              hasTest: false
            }
          ]
        }
      ],
      updatedAt: '2026-10-13'
    })
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
const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !/^(http|https|all)_proxy$/i.test(k)) {
    cleanEnv[k] = v;
  }
}
cleanEnv.PORT = String(PORT);
cleanEnv.DATA_DIR = SCRATCH;
cleanEnv.ILC_SETTINGS_PATH = path.join(SCRATCH, 'settings.json');
cleanEnv.NO_PROXY = '*';
cleanEnv.no_proxy = '*';

const proc = Bun.spawn([process.execPath, 'server/index.ts'], {
  env: cleanEnv,
  stdout: 'pipe',
  stderr: 'pipe'
});

try {
  // Wait for readiness
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/queue`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ready) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`sidecar did not start: ${errText}`);
  }
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
    check(
      'GET /api/llm → {hasConfig, cards, activeId}',
      llm.status === 200 && typeof llm.body.hasConfig === 'boolean' && Array.isArray(llm.body.cards) && 'activeId' in llm.body
    );

    // Multi-card store: save two models, switch the active one, verify the
    // active card is what generation resolves (keys never echoed back).
    const saved = await req('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save_store',
        activeId: 'card_local',
        cards: [
          {
            id: 'card_local',
            label: 'Local llama.cpp',
            provider: 'llamacpp',
            baseUrl: 'http://127.0.0.1:9931',
            apiKey: 'sk-local',
            authHeaderType: 'bearer',
            model: 'qwen2.5-7b',
            temperature: 0.3,
            timeoutSeconds: 150
          },
          {
            id: 'card_cloud',
            label: 'Cloud',
            provider: 'openai_compatible',
            baseUrl: 'https://api.example.com/v1',
            apiKey: '',
            authHeaderType: 'bearer',
            model: 'gpt-4o-mini',
            temperature: 0.2,
            timeoutSeconds: 60
          }
        ]
      })
    });
    check(
      'POST /api/llm save_store → {success, activeId, cards[]}',
      saved.status === 200 && saved.body.success === true && saved.body.activeId === 'card_local' && saved.body.cards?.length === 2
    );
    check('save_store never echoes API keys', saved.body.cards?.every((c: any) => !('apiKey' in c)) === true);

    const afterSave = await req('/api/llm');
    check(
      'GET /api/llm resolves the ACTIVE card (llama.cpp native)',
      afterSave.body.config?.id === 'card_local' &&
        afterSave.body.config?.provider === 'llamacpp' &&
        afterSave.body.config?.model === 'qwen2.5-7b' &&
        afterSave.body.config?.hasApiKey === true
    );

    const switched = await req('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_active', id: 'card_cloud' })
    });
    check('POST /api/llm set_active → {success, activeId}', switched.status === 200 && switched.body.activeId === 'card_cloud');

    const switchedBack = await req('/api/llm');
    check(
      'active switch reroutes the resolved config',
      switchedBack.body.config?.id === 'card_cloud' && switchedBack.body.config?.model === 'gpt-4o-mini'
    );

    const unknownCard = await req('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_active', id: 'nope' })
    });
    check('set_active unknown card → 404', unknownCard.status === 404);

    // A card pointing at a port this script just released: the generate
    // fallback must resolve it (and fail fast with an endpoint error), never
    // demand a config in the body.
    const deadPortProbe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const deadPort = deadPortProbe.port;
    deadPortProbe.stop(true);
    await req('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save_store',
        activeId: 'card_dead',
        cards: [
          { id: 'card_dead', label: 'Dead endpoint', provider: 'openai_compatible', baseUrl: `http://127.0.0.1:${deadPort}/v1`, apiKey: '', model: 'x', temperature: 0.3, timeoutSeconds: 30 }
        ]
      })
    });
    const noConfig = await req('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'generate', systemPrompt: 's', userPrompt: 'u' })
    });
    check(
      'generate without config resolves the ACTIVE card',
      noConfig.status === 500 && /LLM request failed|LLM Error/i.test(String(noConfig.body.message))
    );

    // Clearing every model must be explicitly requested: an empty list from a
    // bug or a stale tab cannot silently wipe the configured models.
    const unconfirmedClear = await req('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_store', cards: [], activeId: null })
    });
    check(
      'save_store with an empty list (no confirmClear) → 409 and the models survive',
      unconfirmedClear.status === 409 && String(unconfirmedClear.body.message).includes('confirmClear')
    );
    const stillThere = await req('/api/llm');
    check('unconfirmed clear left the store untouched', stillThere.body.cards?.length === 1);

    // A card without a Base URL cannot be stored, so it must be rejected rather
    // than silently dropped — dropping it would clear the working configuration.
    const blankUrl = await req('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save_store',
        activeId: null,
        cards: [{ id: 'card_blank', label: 'Blank', provider: 'openai_compatible', baseUrl: '   ', apiKey: '', model: 'x', temperature: 0.3, timeoutSeconds: 60 }]
      })
    });
    check(
      'save_store with only Base-URL-less cards → 400 and the models survive',
      blankUrl.status === 400 && String(blankUrl.body.message).includes('Base URL')
    );
    const afterBlank = await req('/api/llm');
    check('blank-URL save left the store untouched', afterBlank.body.cards?.length === 1);

    // Restore the empty store (confirmed): later checks assert behaviour with no LLM configured.
    const cleared = await req('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_store', cards: [], activeId: null, confirmClear: true })
    });
    check('save_store clears the store with confirmClear → 0 cards', cleared.status === 200 && cleared.body.cards?.length === 0);

    // An unreadable config must fail loudly (never read as "no models") and must
    // not be overwritten by a save — that is how a recoverable config survives.
    const configPath = path.join(SCRATCH, 'llm_config.json');
    fs.writeFileSync(configPath, '{ not json at all', 'utf8');
    const corruptBytes = fs.readFileSync(configPath);

    const corruptGet = await req('/api/llm');
    check('GET /api/llm on a corrupt config → 500 (not "no models")', corruptGet.status === 500);

    const corruptSave = await req('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_store', cards: [{ id: 'x', label: 'X', provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1', model: 'm', temperature: 0.3, timeoutSeconds: 60 }], activeId: 'x' })
    });
    check('save_store on a corrupt config → 500', corruptSave.status === 500);
    check('corrupt config left byte-identical', Buffer.compare(corruptBytes, fs.readFileSync(configPath)) === 0);

    // Repairing it recovers without a restart.
    fs.rmSync(configPath);
    const repaired = await req('/api/llm');
    check('removing the broken file recovers → 200 {hasConfig:false}', repaired.status === 200 && repaired.body.hasConfig === false);

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

  console.log('\nCourse schedules:');
  {
    const empty = await req('/api/schedules');
    check(
      'GET /api/schedules → {schedules[]} with courseId/exists/markdown',
      empty.status === 200 &&
        Array.isArray(empty.body.schedules) &&
        empty.body.schedules.every(
          (s: any) => 'courseId' in s && 'courseTitle' in s && 'exists' in s && 'markdown' in s
        )
    );

    const initial = await req('/api/courses/tst01/course-docs?type=schedule');
    check(
      'course-docs GET ?type=schedule → {success, exists:false}',
      initial.status === 200 && initial.body.success === true && initial.body.exists === false
    );

    const sample =
      '# TST01 Study Schedule\n\n### 2026-01-05 · Mon\n- [ ] **Study** 01.01 — Lesson one (60m)\n';
    const put = await req('/api/courses/tst01/course-docs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'schedule', content: sample })
    });
    check('course-docs PUT type=schedule → {success}', put.status === 200 && put.body.success === true);

    const after = await req('/api/schedules');
    const tst = after.body.schedules?.find((s: any) => s.courseId === 'tst01');
    check('PUT schedule is reflected in /api/schedules', after.status === 200 && tst?.exists === true && tst.markdown.includes('- [ ] **Study** 01.01'));

    const gen = await req('/api/courses/tst01/course-docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'schedule', forceRegenerate: true })
    });
    check(
      'course-docs POST type=schedule reaches LLM-config check (400 config required)',
      gen.status === 400 && /LLM configuration/i.test(String(gen.body.message))
    );

    const bad = await req('/api/courses/tst01/course-docs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bad type!', content: 'x' })
    });
    check('course-docs rejects a malformed type → 400', bad.status === 400);
  }

  console.log('\nCourse checkpoints:');
  {
    const empty = await req('/api/checkpoints');
    check(
      'GET /api/checkpoints → {checkpoints: array}',
      empty.status === 200 && Array.isArray(empty.body.checkpoints)
    );

    const postNote = await req('/api/courses/tst01/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: '01.01.lesson.md',
        verticalPosition: 350,
        color: 'coral',
        noteText: 'Contract test note'
      })
    });
    check(
      'POST /checkpoints → creates note checkpoint',
      postNote.status === 200 &&
        postNote.body.success === true &&
        postNote.body.checkpoint?.type === 'note' &&
        postNote.body.checkpoint?.color === 'coral' &&
        postNote.body.checkpoint?.verticalPosition === 350
    );

    const noteId = postNote.body.checkpoint?.id;

    const postPos = await req('/api/courses/tst01/checkpoints/position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: '01.01.lesson.md',
        verticalPosition: 900
      })
    });
    check(
      'POST /checkpoints/position → records position checkpoint',
      postPos.status === 200 &&
        postPos.body.success === true &&
        postPos.body.checkpoint?.type === 'position' &&
        postPos.body.checkpoint?.verticalPosition === 900
    );

    const courseCps = await req('/api/courses/tst01/checkpoints');
    check(
      'GET /courses/:id/checkpoints → returns all checkpoints for course',
      courseCps.status === 200 &&
        Array.isArray(courseCps.body.checkpoints) &&
        courseCps.body.checkpoints.length === 2
    );

    const allNotes = await req('/api/checkpoints');
    check(
      'GET /api/checkpoints → returns only notes across courses',
      allNotes.status === 200 &&
        allNotes.body.checkpoints.length === 1 &&
        allNotes.body.checkpoints[0].noteText === 'Contract test note' &&
        allNotes.body.checkpoints[0].courseId === 'tst01'
    );

    const del = await req(`/api/courses/tst01/checkpoints/${noteId}`, {
      method: 'DELETE'
    });
    check('DELETE /checkpoints/:id → removes note', del.status === 200 && del.body.success === true);
  }

  console.log('\nCourse metadata (rename / archive):');
  {
    const rename = await req('/api/courses/tst01/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed Fixture', description: 'renamed description' })
    });
    check(
      'PUT /meta title+description → {success, course}',
      rename.status === 200 && rename.body.success === true && rename.body.course?.title === 'Renamed Fixture'
    );

    const renamed = await req('/api/courses/tst01');
    check(
      'rename persisted, visible in GET /api/courses/:id',
      renamed.body.course?.title === 'Renamed Fixture' &&
        renamed.body.course?.description === 'renamed description' &&
        Array.isArray(renamed.body.course?.units)
    );

    const blankTitle = await req('/api/courses/tst01/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' })
    });
    check('PUT /meta with blank title → 400', blankTitle.status === 400);

    const nothing = await req('/api/courses/tst01/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    check('PUT /meta with no fields → 400', nothing.status === 400);

    const arch = await req('/api/courses/tst01/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true })
    });
    check(
      'PUT /meta {archived:true} → {success, course.archived:true}',
      arch.status === 200 && arch.body.success === true && arch.body.course?.archived === true
    );

    const metaPath = path.join(SCRATCH, 'courses', 'tst01', 'meta.json');
    const metaOnDisk = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    check(
      'archive persisted in meta.json, rename + units intact',
      metaOnDisk.archived === true && metaOnDisk.title === 'Renamed Fixture' && Array.isArray(metaOnDisk.units)
    );

    const list = await req('/api/courses');
    const entry = list.body.courses?.find((c: any) => c.id === 'tst01');
    check('GET /api/courses still lists archived course with archived:true', entry?.archived === true);

    const sched = await req('/api/schedules');
    check(
      'archived course excluded from /api/schedules',
      sched.status === 200 && !sched.body.schedules?.some((s: any) => s.courseId === 'tst01')
    );

    const unarch = await req('/api/courses/tst01/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false })
    });
    check(
      'PUT /meta {archived:false} → restored, flag removed',
      unarch.status === 200 && unarch.body.success === true && unarch.body.course?.archived === undefined
    );

    const metaAfter = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const schedAfter = await req('/api/schedules');
    check(
      'unarchived course back in /api/schedules, flag removed from meta.json',
      metaAfter.archived === undefined && schedAfter.body.schedules?.some((s: any) => s.courseId === 'tst01')
    );

    const missing = await req('/api/courses/zzz9/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Nope' })
    });
    check('PUT /meta unknown course → 404 {message}', missing.status === 404 && typeof missing.body.message === 'string');
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
  killProcessTree(proc);
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {}
}

console.log(
  failures === 0 ? '\nAll sidecar contract checks passed.' : `\n${failures} contract check(s) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
