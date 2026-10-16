import { describe, it, expect, afterAll, afterEach, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LLMService, timeoutMessage, resolveLlamaCppUrl, resolveCompletionsUrl, type LLMConfig, type LLMLogSink } from './llm';

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

describe('multi-card store', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ilc-llm-store-'));
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
    expect(resolveCompletionsUrl(resolved!.baseUrl)).toBe('https://api.deepseek.com/v1/chat/completions');
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
});

afterAll(() => {
  // Safety: never leave a stubbed fetch behind.
  globalThis.fetch = originalFetch;
});
