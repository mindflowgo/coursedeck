import { describe, it, expect, afterAll, afterEach, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LLMService,
  timeoutMessage,
  resolveLlamaCppUrl,
  resolveCompletionsUrl,
  resolveResponsesUrl,
  type LLMConfig,
  type LLMLogSink
} from './llm';
import { doesModelSupportTemperature, isTemperatureUnsupportedError } from '../llmProviders';

type SinkCall = Array<{ level: 'info' | 'warn' | 'error'; message: string }>;

const originalFetch = globalThis.fetch;

describe('resolveLlamaCppUrl', () => {
  it('targets the native endpoints from a bare host', () => {
    expect(resolveLlamaCppUrl('http://localhost:9931', 'completion')).toBe('http://localhost:9931/completion');
    expect(resolveLlamaCppUrl('http://localhost:9931/', 'apply-template')).toBe('http://localhost:9931/apply-template');
  });

  it('normalizes OpenAI-style base URLs (users paste those from other providers)', () => {
    expect(resolveLlamaCppUrl('http://localhost:8080/v1', 'completion')).toBe('http://localhost:8080/completion');
    expect(resolveLlamaCppUrl('http://localhost:8080/v1/chat/completions', 'completion')).toBe(
      'http://localhost:8080/completion'
    );
  });

  it('does not double-append an endpoint that is already present', () => {
    expect(resolveLlamaCppUrl('http://localhost:9931/completion', 'completion')).toBe('http://localhost:9931/completion');
    expect(resolveLlamaCppUrl('http://localhost:9931/apply-template', 'completion')).toBe(
      'http://localhost:9931/completion'
    );
  });
});

describe('resolveCompletionsUrl', () => {
  it('resolves standard /v1 OpenAI base URLs', () => {
    expect(resolveCompletionsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
    expect(resolveCompletionsUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('preserves full /chat/completions endpoints without double-appending', () => {
    expect(resolveCompletionsUrl('https://api.z.ai/api/paas/v4/chat/completions')).toBe(
      'https://api.z.ai/api/paas/v4/chat/completions'
    );
  });

  it('resolves ZCode / Z.ai / BigModel /paas/v4 base URLs directly to chat completions', () => {
    expect(resolveCompletionsUrl('https://api.z.ai/api/paas/v4')).toBe(
      'https://api.z.ai/api/paas/v4/chat/completions'
    );
    expect(resolveCompletionsUrl('https://open.bigmodel.cn/api/paas/v4/')).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions'
    );
  });

  it('appends /chat/completions directly to baseUrl without injecting /v1', () => {
    expect(resolveCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/chat/completions'
    );
    expect(resolveCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
    expect(resolveCompletionsUrl('https://custom.host/v4')).toBe(
      'https://custom.host/v4/chat/completions'
    );
  });
});

describe('resolveResponsesUrl', () => {
  it('appends /responses to base URL', () => {
    expect(resolveResponsesUrl('https://opencode.ai/zen/go/v1')).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(resolveResponsesUrl('https://opencode.ai/zen/go/v1/')).toBe('https://opencode.ai/zen/go/v1/responses');
  });

  it('replaces /chat/completions with /responses', () => {
    expect(resolveResponsesUrl('https://opencode.ai/zen/go/v1/chat/completions')).toBe(
      'https://opencode.ai/zen/go/v1/responses'
    );
  });

  it('preserves existing /responses path', () => {
    expect(resolveResponsesUrl('https://opencode.ai/zen/go/v1/responses')).toBe(
      'https://opencode.ai/zen/go/v1/responses'
    );
  });
});

describe('multi-card store', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'app-llm-store-'));
  const previousDataDir = process.env.DATA_DIR;

  beforeAll(() => {
    process.env.DATA_DIR = scratch;
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  // The key-forwarding test below stubs fetch; never leave it installed.
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function writeConfig(raw: unknown) {
    fs.writeFileSync(path.join(scratch, 'llm_config.json'), JSON.stringify(raw), 'utf8');
  }

  it('migrates the legacy flat config into a single active card', () => {
    writeConfig({
      provider: 'lmstudio',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'sk-legacy',
      model: 'qwen2.5-7b',
      temperature: 0.4,
      timeoutSeconds: 60
    });

    const store = LLMService.loadStore();
    expect(store.cards).toHaveLength(1);
    expect(store.activeId).toBe(store.cards[0].id);
    expect(store.cards[0]).toMatchObject({
      provider: 'lmstudio',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'sk-legacy',
      model: 'qwen2.5-7b',
      timeoutSeconds: 60
    });

    // loadStoredConfig resolves the active card, so every AI feature follows it.
    expect(LLMService.loadStoredConfig()).toMatchObject({
      baseUrl: 'http://localhost:1234/v1',
      cardId: store.cards[0].id
    });
  });

  it('migrates a restored cloud config to the same endpoint the old build used', () => {
    // Restoring a pre-multi-card install (e.g. a DeepSeek setup) must not change
    // where requests go: base URL + the OpenAI /v1/chat/completions suffix.
    writeConfig({
      provider: 'openai_compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      authHeaderType: 'api_key',
      model: 'deepseek-flash',
      temperature: 0.3,
      timeoutSeconds: 150
    });

    const resolved = LLMService.loadStoredConfig();
    expect(resolved).toMatchObject({ model: 'deepseek-flash', authHeaderType: 'api_key' });
    expect(resolveCompletionsUrl(resolved!.baseUrl)).toBe('https://api.deepseek.com/chat/completions');
  });

  it('normalizeCards exposes what would actually survive a save', () => {
    // The save guard counts these, not the raw submitted length: a card with no
    // Base URL is unusable and would otherwise clear the stored configuration.
    const usable = LLMService.normalizeCards([
      { id: 'a', label: 'A', provider: 'openai_compatible', baseUrl: '  ', model: 'm', temperature: 0.3, timeoutSeconds: 60 },
      { id: 'b', label: 'B', provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1', model: 'm', temperature: 0.3, timeoutSeconds: 60 }
    ]);
    expect(usable.map((c) => c.id)).toEqual(['b']);
    expect(LLMService.normalizeCards([{ baseUrl: '' }])).toEqual([]);
    expect(LLMService.normalizeCards(undefined)).toEqual([]);
  });

  it('reports an unreadable config instead of pretending it is an empty store', () => {
    // A swallowed read error must be distinguishable from "no models": presenting
    // it as empty is what would let a later save wipe a recoverable config.
    fs.writeFileSync(path.join(scratch, 'llm_config.json'), '{ this is not json', 'utf8');
    expect(LLMService.readStore().ok).toBe(false);
    expect(LLMService.loadStore().cards).toEqual([]);

    // A missing file, by contrast, is a legitimate empty store.
    fs.rmSync(path.join(scratch, 'llm_config.json'));
    expect(LLMService.readStore().ok).toBe(true);
  });

  it('routes loadStoredConfig through the ACTIVE card only', () => {
    writeConfig({
      version: 2,
      activeId: 'card_b',
      cards: [
        { id: 'card_a', label: 'Local llama.cpp', provider: 'llamacpp', baseUrl: 'http://localhost:9931', model: 'llama-3.1-8b', apiKey: '', temperature: 0.3, timeoutSeconds: 150 },
        { id: 'card_b', label: 'Cloud', provider: 'openai_compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-cloud', model: 'gpt-4o-mini', temperature: 0.2, timeoutSeconds: 150 }
      ]
    });

    expect(LLMService.loadStoredConfig()).toMatchObject({
      provider: 'openai_compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      cardId: 'card_b'
    });

    expect(LLMService.setActiveCard('card_a')).toBe(true);
    expect(LLMService.loadStoredConfig()).toMatchObject({
      provider: 'llamacpp',
      baseUrl: 'http://localhost:9931',
      cardId: 'card_a'
    });
    expect(LLMService.setActiveCard('card_missing')).toBe(false);
  });

  it('keeps API keys for cards whose key input is blank, and summarises without exposing keys', () => {
    writeConfig({
      version: 2,
      activeId: 'card_a',
      cards: [
        { id: 'card_a', label: 'A', provider: 'openai_compatible', baseUrl: 'https://a.example/v1', apiKey: 'sk-keep', model: 'm', temperature: 0.3, timeoutSeconds: 150 }
      ]
    });

    LLMService.replaceCards(
      [
        { id: 'card_a', label: 'A', provider: 'openai_compatible', baseUrl: 'https://a.example/v1', apiKey: '', model: 'm', temperature: 0.3, timeoutSeconds: 150 },
        { id: 'card_new', label: 'B', provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1', apiKey: 'sk-new', model: 'local', temperature: 0.3, timeoutSeconds: 150 }
      ],
      'card_new'
    );

    const store = LLMService.loadStore();
    expect(store.cards.find((c) => c.id === 'card_a')?.apiKey).toBe('sk-keep');
    expect(store.cards.find((c) => c.id === 'card_new')?.apiKey).toBe('sk-new');
    expect(store.activeId).toBe('card_new');

    const summaries = LLMService.summarizeCards(store);
    expect(summaries.map((s) => s.hasApiKey)).toEqual([true, true]);
    expect(summaries.every((s) => !('apiKey' in s))).toBe(true);
  });

  it('drops cards without a base URL instead of persisting broken entries', () => {
    LLMService.replaceCards(
      [
        { id: 'card_ok', label: 'OK', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '', temperature: 0.3, timeoutSeconds: 150 },
        { id: 'card_bad', label: 'Bad', provider: 'ollama', baseUrl: '   ', apiKey: '', model: '', temperature: 0.3, timeoutSeconds: 150 }
      ],
      'card_ok'
    );
    const store = LLMService.loadStore();
    expect(store.cards.map((c) => c.id)).toEqual(['card_ok']);
  });

  it('caps an absurd stored timeout so it cannot clamp every request to an instant timeout', () => {
    writeConfig({
      version: 2,
      activeId: 'card_a',
      cards: [
        { id: 'card_a', label: 'A', provider: 'openai_compatible', baseUrl: 'https://a.example/v1', apiKey: '', model: 'm', temperature: 0.3, timeoutSeconds: 1e12 }
      ]
    });
    expect(LLMService.loadStoredConfig()?.timeoutSeconds).toBe(3600);
  });

  it('never forwards one card\'s API key to a different endpoint', async () => {
    writeConfig({
      version: 2,
      activeId: 'card_a',
      cards: [
        { id: 'card_a', label: 'A', provider: 'openai_compatible', baseUrl: 'https://a.example/v1', apiKey: 'sk-secret', model: 'm', temperature: 0.3, timeoutSeconds: 60 }
      ]
    });

    const authHeaders: Array<string | null> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      authHeaders.push(headers['Authorization'] ?? null);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;

    // Same card, different host: the stored key must NOT ride along.
    await LLMService.generateResult(
      { provider: 'openai_compatible', baseUrl: 'http://evil.example/v1', apiKey: '', cardId: 'card_a' },
      's',
      'u',
      { timeoutMs: 5_000, heartbeatMs: 3_600_000 }
    );
    expect(authHeaders[0]).toBeNull();

    // Same card, same endpoint spelled differently (trailing slash): key applies.
    await LLMService.generateResult(
      { provider: 'openai_compatible', baseUrl: 'https://a.example/v1/', apiKey: '', cardId: 'card_a' },
      's',
      'u',
      { timeoutMs: 5_000, heartbeatMs: 3_600_000 }
    );
    expect(authHeaders[1]).toBe('Bearer sk-secret');
  });

  it('automatically adds x-opencode-session header for opencode.ai endpoints', async () => {
    let capturedSessionHeader: string | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      capturedSessionHeader = headers['x-opencode-session'];
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;

    await LLMService.generateResult(
      { provider: 'opencode', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'oc_sk_test' },
      's',
      'u',
      { timeoutMs: 5_000, heartbeatMs: 3_600_000 }
    );
    expect(capturedSessionHeader).toBeDefined();
    expect(capturedSessionHeader).toMatch(/^session_/);
  });

  it('persists and migrates the sendSessionId setting', () => {
    writeConfig({
      version: 2,
      activeId: 'card_strict',
      cards: [
        { id: 'card_strict', label: 'Strict Provider', provider: 'openai_compatible', baseUrl: 'https://strict.example/v1', sendSessionId: true }
      ]
    });

    const store = LLMService.loadStore();
    expect(store.cards[0].sendSessionId).toBe(true);

    const activeConfig = LLMService.loadStoredConfig();
    expect(activeConfig?.sendSessionId).toBe(true);

    // Legacy migration defaults sendSessionId to false
    writeConfig({
      provider: 'openai_compatible',
      baseUrl: 'https://legacy.example/v1'
    });
    const migratedStore = LLMService.loadStore();
    expect(migratedStore.cards[0].sendSessionId).toBe(false);
  });
});

describe('sendSessionId option', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('excludes session_id from payload when sendSessionId is false or omitted', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;

    await LLMService.generateResult(
      { provider: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', sessionId: 'test-session-123' },
      'system',
      'user',
      { timeoutMs: 5_000 }
    );

    expect(capturedBody).not.toBeNull();
    expect(capturedBody.session_id).toBeUndefined();
    expect('session_id' in capturedBody).toBe(false);
  });

  it('includes session_id in payload when sendSessionId is true', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;

    await LLMService.generateResult(
      { provider: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', sessionId: 'test-session-123', sendSessionId: true },
      'system',
      'user',
      { timeoutMs: 5_000 }
    );

    expect(capturedBody).not.toBeNull();
    expect(capturedBody.session_id).toBe('test-session-123');
  });

  it('testConnection does not send session_id when sendSessionId is false or omitted', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;

    const res = await LLMService.testConnection({
      provider: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1'
    });

    expect(res.success).toBe(true);
    expect(capturedBody).not.toBeNull();
    expect('session_id' in capturedBody).toBe(false);
  });

  it('testConnection sends session_id when sendSessionId is true', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;

    const res = await LLMService.testConnection({
      provider: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      sendSessionId: true
    });

    expect(res.success).toBe(true);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.session_id).toBe('test-session');
  });
});

describe('llama.cpp native transport', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders the chat template, sends a prompt (not messages), and parses content chunks', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const sse =
      'data: {"content":"Hel","stop":false}\n\n' +
      'data: {"content":"lo","stop":false}\n\n' +
      'data: {"content":"","stop":true,"tokens_evaluated":11,"timings":{"predicted_n":2}}\n\n' +
      'data: [DONE]\n\n';

    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      if (String(url).endsWith('/apply-template')) {
        return new Response(JSON.stringify({ prompt: '<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nU<|im_end|>\n' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const result = await LLMService.generateResult(
      { provider: 'llamacpp', baseUrl: 'http://localhost:9931', temperature: 0.2 },
      'S',
      'U',
      { timeoutMs: 5_000, heartbeatMs: 3_600_000 }
    );

    expect(calls[0].url).toBe('http://localhost:9931/apply-template');
    expect(calls[0].body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' }
    ]);

    expect(calls[1].url).toBe('http://localhost:9931/completion');
    expect(calls[1].body.prompt).toContain('<|im_start|>system');
    expect(calls[1].body.messages).toBeUndefined();
    expect(calls[1].body.stream).toBe(true);
    expect(calls[1].body.temperature).toBe(0.2);

    expect(result.completion).toBe('Hello');
    expect(result.usage).toEqual({ prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 });
  });

  it('falls back to a plain transcript when /apply-template is unavailable', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      if (String(url).endsWith('/apply-template')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(
        JSON.stringify({ content: 'done', stop: true, tokens_evaluated: 3, timings: { predicted_n: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const result = await LLMService.generateResult(
      { provider: 'llamacpp', baseUrl: 'http://localhost:9931' },
      'SYS',
      'USER',
      { timeoutMs: 5_000, heartbeatMs: 3_600_000 }
    );

    expect(calls[1].body.prompt).toBe('SYS\n\nUSER');
    expect(result.completion).toBe('done');
  });
});

describe('LLMService.resolveRequestTimeoutMs', () => {
  it('uses the configured Request Timeout from Settings', () => {
    const config: LLMConfig = { provider: 'openai_compatible', baseUrl: 'http://x/v1', timeoutSeconds: 30 };
    expect(LLMService.resolveRequestTimeoutMs(config)).toBe(30_000);
    expect(LLMService.resolveRequestTimeoutMs(config)).not.toBe(150_000);
  });

  it('falls back to 150s when the setting is absent or invalid', () => {
    expect(LLMService.resolveRequestTimeoutMs({ provider: 'openai_compatible', baseUrl: 'http://x/v1' })).toBe(150_000);
    expect(LLMService.resolveRequestTimeoutMs({ provider: 'openai_compatible', baseUrl: 'http://x/v1', timeoutSeconds: 0 })).toBe(150_000);
    expect(LLMService.resolveRequestTimeoutMs(null)).toBe(150_000);
  });

  it('a per-call override (e.g. the 300s schedule budget) wins over the setting', () => {
    const config: LLMConfig = { provider: 'openai_compatible', baseUrl: 'http://x/v1', timeoutSeconds: 150 };
    expect(LLMService.resolveRequestTimeoutMs(config, 300_000)).toBe(300_000);
    // Zero/negative overrides mean "not provided", not a zero deadline.
    expect(LLMService.resolveRequestTimeoutMs(config, 0)).toBe(150_000);
  });
});

describe('timeoutMessage', () => {
  it('states the elapsed window and the Settings knob that changes it', () => {
    const message = timeoutMessage(150_000);
    expect(message).toMatch(/timed out after 150s/);
    expect(message).toMatch(/Request Timeout/);
  });
});

describe('LLM lifecycle logging (onLog sink)', () => {
  const sinks: SinkCall[] = [];

  function collectSink(): { sink: LLMLogSink; calls: SinkCall } {
    const calls: SinkCall = [];
    sinks.push(calls);
    return { sink: (level, message) => calls.push({ level, message }), calls };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    sinks.length = 0;
  });

  it('emits still-waiting heartbeats while the model is silent, and the timeout error when the deadline expires', async () => {
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    const { sink, calls } = collectSink();

    await expect(
      LLMService.generateResult(
        { provider: 'openai_compatible', baseUrl: 'http://stub/v1' },
        'system',
        'user',
        { timeoutMs: 650, heartbeatMs: 50, onLog: sink }
      )
    ).rejects.toMatchObject({});

    const timedOut = calls.find((c) => c.level === 'error');
    expect(timedOut?.message).toMatch(/timed out after 1s/);
    const heartbeats = calls.filter((c) => c.message.includes('Still waiting'));
    expect(heartbeats.length).toBeGreaterThan(1);
  });

  it('reports rate-limit retries and the successful response with elapsed time and token usage', async () => {
    const responses = [
      new Response('busy', { status: 503, headers: { 'retry-after': '1' } }),
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    ];
    let call = 0;
    globalThis.fetch = (async () => responses[call++] ?? new Response('{}')) as unknown as typeof fetch;
    const { sink, calls } = collectSink();

    const result = await LLMService.generateResult(
      { provider: 'openai_compatible', baseUrl: 'http://stub/v1' },
      'system',
      'user',
      { timeoutMs: 5_000, onLog: sink, heartbeatMs: 3_600_000 }
    );
    expect(result.completion).toBe('hello');

    const retry = calls.find((c) => c.level === 'warn');
    expect(retry?.message).toMatch(/HTTP 503/);
    expect(retry?.message).toMatch(/attempt 1 of 2/);
    const success = calls.find((c) => c.level === 'info' && /Response received/.test(c.message));
    expect(success?.message).toMatch(/Response received in \d+s/);
    expect(success?.message).toMatch(/total_tokens":15/);
  });

  it('indicates clearly when HTTP 429 occurs that the plan/quota is exhausted', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { code: '1308', message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 06:04:36' }
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch;

    const { sink, calls } = collectSink();

    await expect(
      LLMService.generateResult(
        { provider: 'zcode', baseUrl: 'https://api.z.ai/api/paas/v4' },
        'system',
        'user',
        { timeoutMs: 5_000, onLog: sink }
      )
    ).rejects.toThrow(/Plan quota or rate limit exhausted \(HTTP 429\)/);

    const errorCall = calls.find((c) => c.level === 'error');
    expect(errorCall?.message).toMatch(/Plan quota or rate limit exhausted \(HTTP 429\)/);
    expect(errorCall?.message).toMatch(/Usage limit reached for 5 hour/);
    expect(errorCall?.message).toMatch(/Our plan is exhausted for now/);
  });
});

describe('openai_responses transport', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('routes models like gpt-6-luna to /responses with instructions and input payload and parses SSE deltas', async () => {
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const sse =
      'event: response.output_text.delta\ndata: {"delta":"Hello "}\n\n' +
      'event: response.output_text.delta\ndata: {"delta":"world!"}\n\n' +
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":8,"output_tokens":2,"total_tokens":10}}}\n\n';

    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
        headers: init.headers
      });
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const result = await LLMService.generateResult(
      { provider: 'opencode', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'gpt-6-luna', apiKey: 'oc_sk_test' },
      'You are a helpful assistant.',
      'Say hello.',
      { timeoutMs: 5_000, heartbeatMs: 3_600_000 }
    );

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(calls[0].body.model).toBe('gpt-6-luna');
    expect(calls[0].body.instructions).toBe('You are a helpful assistant.');
    expect(calls[0].body.input).toBe('Say hello.');
    expect(calls[0].body.messages).toBeUndefined();
    expect(calls[0].headers['x-opencode-session']).toMatch(/^session_/);

    expect(result.completion).toBe('Hello world!');
    expect(result.usage).toEqual({ prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 });
  });

  it('automatically falls back from chat/completions to responses when receiving ModelProtocolUnsupported error', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const unsupportedErrorBody = JSON.stringify({
      type: 'error',
      error: { type: 'ModelProtocolUnsupported', message: 'Model does not support this protocol.' }
    });

    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      if (calls.length === 1) {
        return new Response(unsupportedErrorBody, { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        JSON.stringify({
          output: [{ content: [{ type: 'output_text', text: 'Fallback response working!' }] }],
          usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    // Notice protocol is default openai_compatible without auto-detection trigger model name:
    const result = await LLMService.generateResult(
      { provider: 'opencode', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'custom-future-model' },
      'Sys instructions',
      'User input',
      { timeoutMs: 5_000, heartbeatMs: 3_600_000 }
    );

    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(calls[1].url).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(calls[1].body.instructions).toBe('Sys instructions');
    expect(calls[1].body.input).toBe('User input');
    expect(result.completion).toBe('Fallback response working!');
  });

  it('omits temperature parameter for gpt-6-luna and reasoning models', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({
          output: [{ content: [{ type: 'output_text', text: 'Luna response!' }] }],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const result = await LLMService.generateResult(
      { provider: 'opencode', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'gpt-6-luna', temperature: 0.3 },
      'Sys',
      'User',
      { timeoutMs: 5_000, heartbeatMs: 3_600_000 }
    );

    expect(calls.length).toBe(1);
    expect(calls[0].body.model).toBe('gpt-6-luna');
    expect(calls[0].body.temperature).toBeUndefined();
    expect(result.completion).toBe('Luna response!');
  });

  it('automatically retries without temperature when provider returns Unsupported parameter error', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const lunaErrorBody = JSON.stringify({
      model: 'unknown-luna-variant',
      error: {
        message: "Unsupported parameter: 'temperature' is not supported with this model.",
        type: 'invalid_request_error',
        param: 'temperature',
        code: null
      }
    });

    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      if (calls.length === 1) {
        return new Response(lunaErrorBody, { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Success on retry!' } }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const result = await LLMService.generateResult(
      { provider: 'openai_compatible', baseUrl: 'https://api.example.com/v1', model: 'unknown-model', temperature: 0.7 },
      'Sys',
      'User',
      { timeoutMs: 5_000, heartbeatMs: 3_600_000 }
    );

    expect(calls.length).toBe(2);
    expect(calls[0].body.temperature).toBe(0.7);
    expect(calls[1].body.temperature).toBeUndefined();
    expect(result.completion).toBe('Success on retry!');
  });
});

describe('doesModelSupportTemperature and isTemperatureUnsupportedError helpers', () => {
  it('correctly identifies models that disallow temperature', () => {
    expect(doesModelSupportTemperature('gpt-6-luna')).toBe(false);
    expect(doesModelSupportTemperature('gpt-6')).toBe(false);
    expect(doesModelSupportTemperature('o1')).toBe(false);
    expect(doesModelSupportTemperature('o1-mini')).toBe(false);
    expect(doesModelSupportTemperature('o3-mini')).toBe(false);
    expect(doesModelSupportTemperature('o4-preview')).toBe(false);
    expect(doesModelSupportTemperature('deepseek-reasoning')).toBe(false);
    expect(doesModelSupportTemperature('luna-chat')).toBe(false);

    expect(doesModelSupportTemperature('gpt-4o')).toBe(true);
    expect(doesModelSupportTemperature('gpt-4o-mini')).toBe(true);
    expect(doesModelSupportTemperature('claude-3-5-sonnet')).toBe(true);
    expect(doesModelSupportTemperature('glm-5.3-flash')).toBe(true);
    expect(doesModelSupportTemperature('')).toBe(true);
    expect(doesModelSupportTemperature(undefined)).toBe(true);
  });

  it('correctly detects unsupported temperature error messages', () => {
    expect(
      isTemperatureUnsupportedError(
        '{"model":"gpt-6-luna","error":{"message":"Unsupported parameter: \'temperature\' is not supported with this model.","type":"invalid_request_error","param":"temperature","code":null}}'
      )
    ).toBe(true);
    expect(isTemperatureUnsupportedError("temperature is not supported for this model")).toBe(true);
    expect(isTemperatureUnsupportedError("Unsupported parameter: temperature")).toBe(true);
    expect(isTemperatureUnsupportedError("model does not support temperature")).toBe(true);

    expect(isTemperatureUnsupportedError("Rate limit exceeded")).toBe(false);
    expect(isTemperatureUnsupportedError("Invalid API key")).toBe(false);
  });
});

afterAll(() => {
  // Safety: never leave a stubbed fetch behind.
  globalThis.fetch = originalFetch;
});
