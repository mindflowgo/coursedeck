import { describe, it, expect, afterAll, afterEach } from 'bun:test';
import { LLMService, timeoutMessage, type LLMConfig, type LLMLogSink } from './llm';

type SinkCall = Array<{ level: 'info' | 'warn' | 'error'; message: string }>;

const originalFetch = globalThis.fetch;

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
