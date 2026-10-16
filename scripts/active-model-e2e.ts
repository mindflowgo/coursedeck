/**
 * End-to-end proof of active-model routing + both transports.
 *
 * Boots two mock local model servers (llama.cpp native, OpenAI-compatible),
 * boots the real sidecar against a scratch data dir, saves them as model cards,
 * then exercises Ask-AI and the lesson summary queue with each card active.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killProcessTree } from './test-process';

const APP_PORT = 3214;
const LLAMACPP_PORT = 3215;
const OAI_PORT = 3216;
const APP = `http://127.0.0.1:${APP_PORT}`;

const hits = { applyTemplate: 0, nativeCompletion: 0, oaiChat: 0 };

// --- mock llama.cpp server (llama-server) ---
const llamacpp = Bun.serve({
  port: LLAMACPP_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/apply-template') {
      hits.applyTemplate += 1;
      const body: any = await req.json();
      const rendered = body.messages.map((m: any) => `<|im_start|>${m.role}\n${m.content}<|im_end|>`).join('\n');
      return Response.json({ prompt: `${rendered}\n<|im_start|>assistant\n` });
    }
    if (url.pathname === '/completion') {
      hits.nativeCompletion += 1;
      const sse =
        'data: {"content":"LLAMACPP-","stop":false}\n\n' +
        'data: {"content":"NATIVE-OK","stop":false}\n\n' +
        'data: {"content":"","stop":true,"tokens_evaluated":7,"timings":{"predicted_n":3}}\n\n' +
        'data: [DONE]\n\n';
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  }
});

// --- mock OpenAI-compatible server (second card) ---
const oai = Bun.serve({
  port: OAI_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/v1/chat/completions') {
      hits.oaiChat += 1;
      const sse =
        'data: {"choices":[{"delta":{"content":"OAI-"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"CARD-OK"}}]}\n\n' +
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n' +
        'data: [DONE]\n\n';
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  }
});

// --- scratch data dir with one course + lesson ---
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ilc-active-e2e-'));
const courseDir = path.join(SCRATCH, 'courses', 'zztest');
fs.mkdirSync(courseDir, { recursive: true });
fs.writeFileSync(
  path.join(courseDir, 'meta.json'),
  JSON.stringify({
    id: 'zztest',
    title: 'Routing Fixture',
    grade: '11',
    level: 'U',
    description: 'fixture',
    units: [
      {
        number: 1,
        title: 'Unit One',
        lessons: [
          {
            id: '01.01',
            code: 'zztest_u1la1',
            title: 'Lesson One',
            unitNumber: 1,
            lessonNumber: 1,
            type: 'lesson',
            hasFull: true,
            hasSummary: false,
            hasCheatsheet: false,
            hasTest: false
          }
        ]
      }
    ],
    updatedAt: '2026-10-15'
  })
);
fs.writeFileSync(path.join(courseDir, '01.01.lesson.md'), '# Lesson One\n\nFixture content for routing.\n');
fs.mkdirSync(path.join(SCRATCH, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'prompts', 'summary.md'), 'Summarize the lesson.');

const sidecar = Bun.spawn(['bun', 'server/index.ts'], {
  env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: SCRATCH },
  stdout: 'pipe',
  stderr: 'pipe',
  cwd: process.cwd()
});

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

async function json(route: string, body?: unknown, method = 'POST') {
  const res = await fetch(`${APP}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${APP}/api/queue`);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ready) throw new Error('sidecar did not start');

  // Save two cards; llama.cpp card is active.
  const saved = await json('/api/llm', {
    action: 'save_store',
    activeId: 'card_lc',
    cards: [
      { id: 'card_lc', label: 'Local llama.cpp', provider: 'llamacpp', baseUrl: `http://127.0.0.1:${LLAMACPP_PORT}`, model: 'local-model', temperature: 0.3, timeoutSeconds: 60 },
      { id: 'card_oai', label: 'Local OAI', provider: 'lmstudio', baseUrl: `http://127.0.0.1:${OAI_PORT}/v1`, model: 'oai-model', temperature: 0.3, timeoutSeconds: 60 }
    ]
  });
  check('save_store stores both cards', saved.status === 200 && saved.body.cards?.length === 2, JSON.stringify(saved.body).slice(0, 120));
  check('active card is the llama.cpp one', saved.body.activeId === 'card_lc');

  // 1. Ask-AI (no config in the request) must hit the llama.cpp native protocol.
  const askAi = await json('/api/llm', { action: 'generate', sessionId: 'zztest-note', systemPrompt: 'You are a tutor.', userPrompt: 'Explain the lesson.' });
  check('Ask-AI routes through ACTIVE llama.cpp card', askAi.status === 200 && askAi.body.completion === 'LLAMACPP-NATIVE-OK', JSON.stringify(askAi.body).slice(0, 160));
  check('llama.cpp native endpoints were used', hits.applyTemplate === 1 && hits.nativeCompletion === 1, JSON.stringify(hits));

  // 2. Queue generation follows the active card too.
  const enqueued = await json('/api/queue', { action: 'enqueue', courseId: 'zztest', lessonId: '01.01', lessonTitle: 'Lesson One', tab: 'summary' });
  check('summary enqueued', enqueued.status === 200 && enqueued.body.enqueued?.length === 1, JSON.stringify(enqueued.body).slice(0, 120));

  let summaryDone = false;
  for (let i = 0; i < 100; i++) {
    const status = await json('/api/queue?courseId=zztest', undefined, 'GET');
    const task = status.body.tasks?.find((t: any) => t.tab === 'summary');
    if (task?.status === 'completed') {
      summaryDone = true;
      break;
    }
    if (task?.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const summaryFile = path.join(courseDir, '01.01.summary.md');
  const summaryText = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '';
  check('queued summary completed via llama.cpp card', summaryDone && summaryText.includes('LLAMACPP-NATIVE-OK'), summaryText.slice(0, 120));

  // 3. Switch the active card to the OpenAI-compatible server — same feature must follow.
  const switched = await json('/api/llm', { action: 'set_active', id: 'card_oai' });
  check('set_active switches to the OAI card', switched.status === 200 && switched.body.activeId === 'card_oai');

  const askAi2 = await json('/api/llm', { action: 'generate', systemPrompt: 'You are a tutor.', userPrompt: 'Explain again.' });
  check('Ask-AI follows the newly active OAI card', askAi2.status === 200 && askAi2.body.completion === 'OAI-CARD-OK', JSON.stringify(askAi2.body).slice(0, 160));
  check('OpenAI-compatible endpoint was used', hits.oaiChat === 1, JSON.stringify(hits));

  const enq2 = await json('/api/queue', { action: 'enqueue', courseId: 'zztest', lessonId: '01.01', lessonTitle: 'Lesson One', tab: 'cheatsheet' });
  check('cheatsheet enqueued', enq2.status === 200 && enq2.body.enqueued?.length === 1);

  let cheatsheetDone = false;
  for (let i = 0; i < 100; i++) {
    const status = await json('/api/queue?courseId=zztest', undefined, 'GET');
    const task = status.body.tasks?.find((t: any) => t.tab === 'cheatsheet');
    if (task?.status === 'completed') {
      cheatsheetDone = true;
      break;
    }
    if (task?.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const cheatsheetFile = path.join(courseDir, '01.01.cheatsheet.md');
  const cheatsheetText = fs.existsSync(cheatsheetFile) ? fs.readFileSync(cheatsheetFile, 'utf8') : '';
  check('queued cheatsheet followed the new active card', cheatsheetDone && cheatsheetText.includes('OAI-CARD-OK'), cheatsheetText.slice(0, 120));
} catch (err: any) {
  console.error('E2E error:', err?.message || err);
  failures += 1;
} finally {
  killProcessTree(sidecar);
  llamacpp.stop(true);
  oai.stop(true);
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? '\nActive-model routing e2e PASSED.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
