import { describe, it, expect, afterEach } from 'bun:test';
import { generateDirect } from './llmClient';
import { LLM_RESPONSE_FORMAT, isResponsesProtocolModel } from './llmProviders';

const originalFetch = globalThis.fetch;

describe('LLM_RESPONSE_FORMAT and isResponsesProtocolModel', () => {
  it('scans LLM_RESPONSE_FORMAT prefixes correctly', () => {
    expect(LLM_RESPONSE_FORMAT).toContain('gpt-');
    expect(LLM_RESPONSE_FORMAT).toContain('grok-');

    expect(isResponsesProtocolModel('gpt-6-luna')).toBe(true);
    expect(isResponsesProtocolModel('gpt-5.6-luna')).toBe(true);
    expect(isResponsesProtocolModel('grok-4.6')).toBe(true);
    expect(isResponsesProtocolModel('grok-4.7')).toBe(true);
    expect(isResponsesProtocolModel('grok-build')).toBe(true);

    expect(isResponsesProtocolModel('glm-5.3-flash')).toBe(false);
    expect(isResponsesProtocolModel('deepseek-chat')).toBe(false);
    expect(isResponsesProtocolModel('qwen2.5-7b')).toBe(false);
    expect(isResponsesProtocolModel('')).toBe(false);
    expect(isResponsesProtocolModel(undefined)).toBe(false);
  });
});

describe('generateDirect', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fails immediately when no model is configured for a non-llamacpp provider', async () => {
    await expect(
      generateDirect(
        { provider: 'opencode', baseUrl: 'https://opencode.ai/zen/go/v1', model: '' },
        'system',
        'user'
      )
    ).rejects.toThrow(/No model configured for active AI model/);

    await expect(
      generateDirect(
        { provider: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' },
        'system',
        'user'
      )
    ).rejects.toThrow(/No model configured for active AI model/);
  });

  it('does not invent fallback models and sends the user-specified model', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;

    const res = await generateDirect(
      { provider: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', model: 'my-custom-model' },
      'system',
      'user'
    );

    expect(res.completion).toBe('hello');
    expect(capturedBody.model).toBe('my-custom-model');
  });
});
