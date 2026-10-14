import fs from 'node:fs';
import path from 'node:path';
import { getLlmConfigPath } from './paths';

export interface LLMConfig {
  provider: 'openai_compatible' | 'ollama' | 'gemini';
  baseUrl: string;
  apiKey?: string;
  authHeaderType?: 'bearer' | 'api_key' | 'both';
  model?: string;
  temperature?: number;
  sessionId?: string;
}

export interface LLMResult {
  completion: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export function resolveCompletionsUrl(baseUrl: string): string {
  if (!baseUrl) return '';
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) {
    return clean;
  }
  if (clean.endsWith('/v1')) {
    return `${clean}/chat/completions`;
  }
  return `${clean}/v1/chat/completions`;
}

export class LLMService {
  static loadStoredConfig(): LLMConfig | null {
    try {
      const p = getLlmConfigPath();
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (e) {
      console.warn('Failed to load stored LLM config:', e);
    }
    return null;
  }

  static saveStoredConfig(config: LLMConfig): void {
    try {
      const p = getLlmConfigPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const existing = LLMService.loadStoredConfig();
      const apiKey = (config.apiKey && config.apiKey.trim())
        ? config.apiKey.trim()
        : (existing?.apiKey || '');
      const cleanConfig: LLMConfig = {
        ...config,
        apiKey,
        model: config.model ? config.model.trim() : ''
      };
      fs.writeFileSync(p, JSON.stringify(cleanConfig, null, 2), 'utf8');
      console.log(`[LLM Config Saved] Base URL: ${cleanConfig.baseUrl}, Model: ${cleanConfig.model || '(server default)'}`);
    } catch (e) {
      console.warn('Failed to save stored LLM config:', e);
    }
  }

  static async generateResult(
    config: LLMConfig,
    systemPrompt: string,
    userPrompt: string,
    options?: { timeoutMs?: number }
  ): Promise<LLMResult> {
    const timeoutMs = options?.timeoutMs ?? 90_000;
    const primaryUrl = resolveCompletionsUrl(config.baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    try {
      const parsedUrl = new URL(primaryUrl);
      if (parsedUrl.hostname && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(parsedUrl.hostname)) {
        headers['Host'] = parsedUrl.host;
      }
    } catch {}

    // Use passed key or fallback to stored key
    const rawKey = (config.apiKey && config.apiKey.trim()) || LLMService.loadStoredConfig()?.apiKey || '';
    if (rawKey.trim()) {
      const trimmedKey = rawKey.trim();
      const cleanKey = trimmedKey.replace(/^bearer\s+/i, '');
      const authType = config.authHeaderType || 'bearer';

      if (authType === 'bearer' || authType === 'both') {
        headers['Authorization'] = `Bearer ${cleanKey}`;
      }
      if (authType === 'api_key' || authType === 'both') {
        headers['api-key'] = cleanKey;
        headers['x-api-key'] = cleanKey;
      }
    }

    const payload: Record<string, any> = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };

    if (config.model && config.model.trim()) {
      payload.model = config.model.trim();
    }

    if (config.temperature !== undefined) {
      payload.temperature = config.temperature;
    }

    if (config.sessionId && config.sessionId.trim()) {
      payload.session_id = config.sessionId.trim();
    }

    const authHeaderDisplay = headers['Authorization']
      ? `Bearer ${headers['Authorization'].slice(7, 11)}***`
      : (headers['api-key'] ? 'api-key: ***' : 'None');

    const isDebug = process.env.DEBUG_LLM === 'true' || process.env.NODE_ENV === 'development';
    if (isDebug) {
      const systemPreview = systemPrompt.length > 200 ? systemPrompt.slice(0, 200) + '...' : systemPrompt;
      const userPreview = userPrompt.length > 200 ? userPrompt.slice(0, 200) + '...' : userPrompt;
      console.log('\n=================== [LLM API Request] ===================');
      console.log(`Endpoint:    ${primaryUrl}`);
      console.log(`Session ID:  ${payload.session_id || 'none'}`);
      console.log(`Model:       ${payload.model || '(server default)'}`);
      console.log(`Auth Header: ${authHeaderDisplay}`);
      console.log(`System Prompt Preview:\n${systemPreview}`);
      console.log(`\nUser Prompt Length: ${userPrompt.length.toLocaleString()} chars (~${Math.round(userPrompt.length / 4).toLocaleString()} tokens)`);
      console.log(`User Prompt Preview:\n${userPreview}`);
      console.log('=========================================================\n');
    } else {
      console.log(`[LLM API Request] Model: ${payload.model || 'default'} | Endpoint: ${primaryUrl} (~${Math.round(userPrompt.length / 4)} tokens)`);
    }

    /**
     * Fetches and fully reads the response body under a deadline (default 90s).
     * A provider that sends headers but never finishes the body (or dribbles
     * it forever) used to hang the generation worker permanently — the
     * Promise.race deadline guarantees the failure fires regardless of how
     * the runtime surfaces aborts on in-flight body reads.
     */
    const fetchWithRetry = async (
      url: string,
      bodyJson: string,
      maxRetries = 2
    ): Promise<{ status: number; statusText: string; bodyText: string }> => {
      type AttemptResult =
        | { kind: 'ok'; status: number; statusText: string; bodyText: string }
        | { kind: 'retry'; status: number; retryAfterMs: number | null };

      let attempt = 0;
      while (true) {
        const controller = new AbortController();
        const work = (async (): Promise<AttemptResult> => {
          const response = await fetch(url, {
            method: 'POST',
            headers,
            body: bodyJson,
            signal: controller.signal
          });

          if (
            (response.status === 429 ||
              response.status === 502 ||
              response.status === 503 ||
              response.status === 504) &&
            attempt < maxRetries
          ) {
            let retryAfterMs: number | null = null;
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) {
              const parsed = parseInt(retryAfter, 10);
              if (!isNaN(parsed) && parsed > 0 && parsed <= 30) {
                retryAfterMs = parsed * 1000;
              }
            }
            return { kind: 'retry', status: response.status, retryAfterMs };
          }

          const bodyText = await response.text();
          return {
            kind: 'ok',
            status: response.status,
            statusText: response.statusText,
            bodyText
          };
        })();
        // Swallow a late rejection if the deadline wins the race.
        work.catch(() => {});

        const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`)),
            timeoutMs
          );
        });
        deadline.catch(() => {});

        try {
          const result = (await Promise.race([work, deadline])) as AttemptResult;

          if (result.kind === 'retry') {
            attempt++;
            const waitMs = result.retryAfterMs ?? attempt * 1500;
            console.warn(`[LLM API] HTTP ${result.status} from ${url}. Retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})...`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }

          return { status: result.status, statusText: result.statusText, bodyText: result.bodyText };
        } catch (err: any) {
          const timedOut = /timed out after/i.test(String(err?.message || ''));
          if (timedOut) {
            // Do NOT retry on timeout — repeating an expensive request that already exceeded
            // the full deadline multiplies delay without fixing slow model generation.
            throw new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
          }
          if (attempt < maxRetries) {
            attempt++;
            const waitMs = attempt * 1500;
            console.warn(
              `[LLM API] Network error (${err?.message || err}). Retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})...`
            );
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw new Error(`LLM request failed after ${attempt + 1} attempt(s): ${err?.message || err}`);
        } finally {
          clearTimeout(abortTimer);
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }
      }
    };

    const bodyJson = JSON.stringify(payload);
    let res = await fetchWithRetry(primaryUrl, bodyJson);

    // Fallback: If 404 and primary had appended /v1/chat/completions, try direct /chat/completions
    if (res.status === 404 && !config.baseUrl.includes('/v1')) {
      const cleanBase = config.baseUrl.trim().replace(/\/+$/, '');
      const fallbackUrl = `${cleanBase}/chat/completions`;
      if (fallbackUrl !== primaryUrl) {
        console.warn(`[LLM API] Primary URL returned 404, attempting fallback URL: ${fallbackUrl}`);
        const fallbackRes = await fetchWithRetry(fallbackUrl, bodyJson);
        if (fallbackRes.status >= 200 && fallbackRes.status < 300) {
          res = fallbackRes;
        }
      }
    }

    console.log(`[LLM API Response] Status: ${res.status} ${res.statusText}`);

    if (res.status < 200 || res.status >= 300) {
      console.error(`[LLM API Error Body] ${res.bodyText.slice(0, 500)}`);
      if (res.bodyText.includes('Direct IP access is not allowed')) {
        throw new Error(
          `LLM Error (${res.status}): Direct IP access is not allowed by Cloudflare. Check your LLM Base URL in Settings — use the provider's domain name (e.g. https://api.deepseek.com) instead of a direct IP address.`
        );
      }
      throw new Error(`LLM Error (${res.status}): ${res.bodyText.slice(0, 500)}`);
    }

    const data = JSON.parse(res.bodyText);
    const completion = data.choices?.[0]?.message?.content || '';
    const usage = data.usage;
    const tokensInfo = usage?.total_tokens !== undefined
      ? ` | "total_tokens":${usage.total_tokens} (prompt: ${usage.prompt_tokens ?? '?'}, completion: ${usage.completion_tokens ?? '?'})`
      : (usage ? ` | usage: ${JSON.stringify(usage)}` : '');

    console.log(`[LLM API Success] Generated ${completion.length.toLocaleString()} characters${tokensInfo}.\n`);

    return { completion, usage };
  }

  static async generate(
    config: LLMConfig,
    systemPrompt: string,
    userPrompt: string,
    options?: { timeoutMs?: number }
  ): Promise<string> {
    const result = await this.generateResult(config, systemPrompt, userPrompt, options);
    return result.completion;
  }

  static async testConnection(config: LLMConfig): Promise<{ success: boolean; message: string }> {
    try {
      const testConfig = {
        ...config,
        sessionId: config.sessionId || 'test-session'
      };
      const testRes = await this.generate(testConfig, 'You are a test assistant.', 'Reply with "OK"');
      if (testRes.toLowerCase().includes('ok')) {
        return { success: true, message: 'Connection successful!' };
      }
      return { success: true, message: `Connected, received response: ${testRes.slice(0, 50)}...` };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Connection failed' };
    }
  }
}
