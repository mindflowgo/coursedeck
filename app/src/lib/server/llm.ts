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
  /** Per-request LLM deadline in seconds (Settings → Request Timeout, 30–150). */
  timeoutSeconds?: number;
}

/**
 * Per-request LLM deadline when neither the call site nor stored config says
 * otherwise. 150s as the default: generation on slow providers regularly
 * needs more than the previous 90s, and it is configurable in Settings.
 */
const DEFAULT_TIMEOUT_MS = 150_000;

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

export function timeoutMessage(timeoutMs: number): string {
  return (
    `LLM request timed out after ${Math.round(timeoutMs / 1000)}s. ` +
    `No response arrived from the model in that window — ` +
    `raise "Request Timeout" in Settings, or switch to a faster/less loaded model.`
  );
}

/**
 * Optional tap on the LLM call lifecycle (attempt retries, still-waiting
 * heartbeats, final status/usage). Call sites with a user-visible log feed
 * (the generation queue) pass a sink so progress shows up in the UI; other
 * callers leave server-console logging as the only output.
 */
export type LLMLogSink = (level: 'info' | 'warn' | 'error', message: string) => void;

/** How often an in-flight attempt reports "still waiting" to the sink. */
export const LLM_HEARTBEAT_INTERVAL_MS = 30_000;


export class LLMService {
  static loadStoredConfig(): LLMConfig | null {
    try {
      const p = getLlmConfigPath();
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch {
      // Gracefully handle unreadable/sandboxed paths without throwing or logging noisy warnings
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
        model: config.model ? config.model.trim() : '',
        timeoutSeconds: config.timeoutSeconds ?? existing?.timeoutSeconds
      };
      fs.writeFileSync(p, JSON.stringify(cleanConfig, null, 2), 'utf8');
      console.log(`[LLM Config Saved] Base URL: ${cleanConfig.baseUrl}, Model: ${cleanConfig.model || '(server default)'}`);
    } catch (e) {
      console.warn('Failed to save stored LLM config:', e);
    }
  }

  /**
   * Effective deadline for one LLM attempt: an explicit override wins.
   * Otherwise uses the configured Request Timeout from Settings, falling back to 150s.
   * If `isFloor` is true (e.g. for course schedules), the deadline will not fall below that floor.
   */
  static resolveRequestTimeoutMs(
    config: LLMConfig | null | undefined,
    explicitOrFloorMs?: number,
    opts?: { isFloor?: boolean }
  ): number {
    const configuredMs = (config?.timeoutSeconds && config.timeoutSeconds > 0)
      ? Math.round(config.timeoutSeconds) * 1000
      : DEFAULT_TIMEOUT_MS;

    if (explicitOrFloorMs && explicitOrFloorMs > 0) {
      if (opts?.isFloor) {
        return Math.max(configuredMs, explicitOrFloorMs);
      }
      return explicitOrFloorMs;
    }
    return configuredMs;
  }

  static async generateResult(
    config: LLMConfig,
    systemPrompt: string,
    userPrompt: string,
    options?: { timeoutMs?: number; onLog?: LLMLogSink; heartbeatMs?: number }
  ): Promise<LLMResult> {
    const timeoutMs = LLMService.resolveRequestTimeoutMs(config, options?.timeoutMs);
    const heartbeatMs = options?.heartbeatMs ?? LLM_HEARTBEAT_INTERVAL_MS;
    const emit = options?.onLog;
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
      stream: true,
      stream_options: { include_usage: true },
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

    console.log('\n=================== [LLM API Request Package] ===================');
    console.log(`Endpoint:    ${primaryUrl}`);
    console.log(`Session ID:  ${payload.session_id || 'none'}`);
    console.log(`Model:       ${payload.model || '(server default)'}`);
    console.log(`Timeout:     ${Math.round(timeoutMs / 1000)}s (per attempt)`);
    console.log(`Auth Header: ${authHeaderDisplay}`);
    console.log(`\n--- SYSTEM PROMPT (${systemPrompt.length.toLocaleString()} chars) ---`);
    console.log(systemPrompt);
    console.log(`\n--- USER PROMPT (${userPrompt.length.toLocaleString()} chars, ~${Math.round(userPrompt.length / 4).toLocaleString()} tokens) ---`);
    console.log(userPrompt);
    console.log('=================================================================\n');
    emit?.('info', `Request sent to ${payload.model || 'default model'} — waiting for the model to respond…`);

    /**
     * Fetches and reads the response body under a deadline (see
     * resolveRequestTimeoutMs). Uses SSE streaming when supported so proxies do
     * not drop connections during long generation / reasoning phases.
     */
    const fetchWithRetry = async (
      url: string,
      bodyJson: string,
      maxRetries = 2
    ): Promise<{
      status: number;
      statusText: string;
      bodyText: string;
      elapsedMs: number;
      completion?: string;
      usage?: LLMResult['usage'];
    }> => {
      type AttemptResult =
        | {
            kind: 'ok';
            status: number;
            statusText: string;
            bodyText: string;
            completion?: string;
            usage?: LLMResult['usage'];
          }
        | { kind: 'retry'; status: number; retryAfterMs: number | null };

      let attempt = 0;
      while (true) {
        const controller = new AbortController();
        const startedAt = Date.now();
        const heartbeat = emit
          ? setInterval(
              () =>
                emit(
                  'info',
                  `⏳ Still waiting for the model… ${Math.round((Date.now() - startedAt) / 1000)}s of the ${Math.round(timeoutMs / 1000)}s deadline used${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`
                ),
              heartbeatMs
            )
          : undefined;

        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let rejectDeadline: ((err: Error) => void) | undefined;
        const deadline = new Promise<never>((_, reject) => {
          rejectDeadline = reject;
          deadlineTimer = setTimeout(() => reject(new Error(timeoutMessage(timeoutMs))), timeoutMs);
        });
        deadline.catch(() => {});

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

          if (response.status < 200 || response.status >= 300) {
            const bodyText = await response.text();
            return {
              kind: 'ok',
              status: response.status,
              statusText: response.statusText,
              bodyText
            };
          }

          // Headers arrived (HTTP 200). Extend deadlineTimer to an overall safety limit
          // (e.g. 15 minutes) so in-flight streaming isn't killed by the initial connection window.
          if (deadlineTimer) clearTimeout(deadlineTimer);
          const maxStreamMs = Math.max(timeoutMs, 900_000);
          deadlineTimer = setTimeout(() => {
            controller.abort();
            rejectDeadline?.(new Error(`LLM stream exceeded safety limit of ${Math.round(maxStreamMs / 1000)}s.`));
          }, maxStreamMs);

          const contentType = response.headers.get('content-type') || '';
          const isSSE = contentType.includes('text/event-stream') || (Boolean(payload.stream) && !contentType.includes('application/json'));

          if (isSSE && response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let streamCompletion = '';
            let streamUsage: LLMResult['usage'] | undefined;
            let lastLogAt = Date.now();
            let receivedAnyChunk = false;

            // Inactivity timer: reset on every chunk. If no data arrives for 60s, abort.
            const inactivityMs = Math.max(60_000, timeoutMs);
            let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
            const resetInactivity = () => {
              if (inactivityTimer) clearTimeout(inactivityTimer);
              inactivityTimer = setTimeout(() => {
                controller.abort();
                rejectDeadline?.(new Error(`LLM stream stalled: no data received for ${Math.round(inactivityMs / 1000)}s.`));
              }, inactivityMs);
            };
            resetInactivity();

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                receivedAnyChunk = true;
                resetInactivity();
                const chunkText = decoder.decode(value, { stream: true });
                buffer += chunkText;

                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed.startsWith('data:')) continue;
                  const dataStr = trimmed.slice(5).trim();
                  if (dataStr === '[DONE]') continue;
                  try {
                    const parsed = JSON.parse(dataStr);
                    const delta = parsed.choices?.[0]?.delta;
                    if (delta?.reasoning_content) {
                      const now = Date.now();
                      if (now - lastLogAt >= 10_000) {
                        emit?.('info', `🧠 Model is reasoning & planning… (${Math.round((now - startedAt) / 1000)}s)`);
                        lastLogAt = now;
                      }
                    }
                    if (delta?.content) {
                      streamCompletion += delta.content;
                      const now = Date.now();
                      if (now - lastLogAt >= 10_000) {
                        emit?.('info', `📝 Generating schedule… ${streamCompletion.length.toLocaleString()} chars (${Math.round((now - startedAt) / 1000)}s)`);
                        lastLogAt = now;
                      }
                    }
                    if (parsed.usage) {
                      streamUsage = parsed.usage;
                    }
                  } catch {}
                }
              }
            } finally {
              if (inactivityTimer) clearTimeout(inactivityTimer);
            }

            if (receivedAnyChunk || streamCompletion.length > 0) {
              return {
                kind: 'ok',
                status: response.status,
                statusText: response.statusText,
                bodyText: '',
                completion: streamCompletion,
                usage: streamUsage
              };
            }
          }

          const bodyText = await response.text();
          return {
            kind: 'ok',
            status: response.status,
            statusText: response.statusText,
            bodyText
          };
        })();
        work.catch(() => {});

        const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const result = (await Promise.race([work, deadline])) as AttemptResult;

          if (result.kind === 'retry') {
            attempt++;
            const waitMs = result.retryAfterMs ?? attempt * 1500;
            const waitNote = result.retryAfterMs ? 'provider asked' : 'backoff';
            console.warn(`[LLM API] HTTP ${result.status} from ${url}. Retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})...`);
            emit?.('warn', `Provider answered HTTP ${result.status} (rate limit / busy) after ${Math.round((Date.now() - startedAt) / 1000)}s — retrying, attempt ${attempt} of ${maxRetries} (${waitNote}, waiting ${Math.round(waitMs / 1000)}s)`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }

          return {
            status: result.status,
            statusText: result.statusText,
            bodyText: result.bodyText,
            completion: result.completion,
            usage: result.usage,
            elapsedMs: Date.now() - startedAt
          };
        } catch (err: any) {
          const timedOut = /timed out after/i.test(String(err?.message || ''));
          if (timedOut) {
            emit?.('error', timeoutMessage(timeoutMs) + ' The generation job has failed — press Retry in the AI Queue once the provider responds faster, or raise the Request Timeout in Settings and try again.');
            throw new Error(timeoutMessage(timeoutMs));
          }
          if (attempt < maxRetries) {
            attempt++;
            const waitMs = attempt * 1500;
            console.warn(
              `[LLM API] Network error (${err?.message || err}). Retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})...`
            );
            emit?.('warn', `Network error after ${Math.round((Date.now() - startedAt) / 1000)}s (${err?.message || err}) — retrying, attempt ${attempt} of ${maxRetries}`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          emit?.('error', `Request failed after ${attempt + 1} attempt(s): ${err?.message || err}`);
          throw new Error(`LLM request failed after ${attempt + 1} attempt(s): ${err?.message || err}`);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
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
      emit?.(
        'error',
        `Provider answered HTTP ${res.status} after ${Math.round(res.elapsedMs / 1000)}s` +
        ` (${res.statusText || 'error'}): ${res.bodyText.slice(0, 200)}`.trim()
      );
      if (res.bodyText.includes('Direct IP access is not allowed')) {
        throw new Error(
          `LLM Error (${res.status}): Direct IP access is not allowed by Cloudflare. Check your LLM Base URL in Settings — use the provider's domain name (e.g. https://api.deepseek.com) instead of a direct IP address.`
        );
      }
      throw new Error(`LLM Error (${res.status}): ${res.bodyText.slice(0, 500)}`);
    }

    let completion = res.completion;
    let usage = res.usage;

    if (completion === undefined) {
      try {
        const data = JSON.parse(res.bodyText);
        completion = data.choices?.[0]?.message?.content || '';
        usage = data.usage;
      } catch {
        completion = res.bodyText;
      }
    }

    const safeCompletion = completion ?? '';

    const tokensInfo = usage?.total_tokens !== undefined
      ? ` | "total_tokens":${usage.total_tokens} (prompt: ${usage.prompt_tokens ?? '?'}, completion: ${usage.completion_tokens ?? '?'})`
      : (usage ? ` | usage: ${JSON.stringify(usage)}` : '');

    console.log(`[LLM API Success] Generated ${safeCompletion.length.toLocaleString()} characters${tokensInfo}.\n`);
    console.log('=================== [LLM Response Content] ===================');
    console.log(safeCompletion);
    console.log('==============================================================\n');

    emit?.(
      'info',
      `✅ Response received in ${Math.round(res.elapsedMs / 1000)}s — ${safeCompletion.length.toLocaleString()} chars${tokensInfo}`
    );
    emit?.('info', `\n--- LLM RESPONSE CONTENT (${safeCompletion.length.toLocaleString()} chars) ---\n${safeCompletion}\n-------------------------------------------------------------`);

    return { completion: safeCompletion, usage };
  }

  static async generate(
    config: LLMConfig,
    systemPrompt: string,
    userPrompt: string,
    options?: { timeoutMs?: number; onLog?: LLMLogSink }
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
