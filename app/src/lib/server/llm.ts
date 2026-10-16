import fs from 'node:fs';
import path from 'node:path';
import { getLlmConfigPath } from './paths';
import { getProviderPreset, protocolForProvider, type LlmCardSummary } from '../llmProviders';

export type LlmAuthHeaderType = 'bearer' | 'api_key' | 'both';

export interface LLMConfig {
  /** Provider preset id; selects the transport (see `../llmProviders`). */
  provider: string;
  baseUrl: string;
  apiKey?: string;
  authHeaderType?: LlmAuthHeaderType;
  model?: string;
  temperature?: number;
  sessionId?: string;
  /** Per-request LLM deadline in seconds (Settings → Request Timeout, 30–150). */
  timeoutSeconds?: number;
  /** Store card this config came from, when known (per-card API key fallback). */
  cardId?: string;
}

/** One model-provider card in Settings. */
export interface LlmModelCard {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  apiKey?: string;
  authHeaderType?: LlmAuthHeaderType;
  model?: string;
  temperature?: number;
  timeoutSeconds?: number;
}

/** Persisted multi-card store (`data/llm_config.json`, version 2). */
export interface LlmStore {
  version: 2;
  activeId: string | null;
  cards: LlmModelCard[];
}

const CARD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function newCardId(): string {
  return `card_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Collapses non-finite temperatures/timeouts into sane defaults. */
function cleanNumber(value: unknown, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

function cleanAuthType(value: unknown): LlmAuthHeaderType {
  return value === 'api_key' || value === 'both' ? value : 'bearer';
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

/**
 * llama.cpp's native endpoints live beside (not under) the OAI-compatible one,
 * so OAI-style base URLs users paste from other providers are normalized
 * instead of rejected.
 */
export function resolveLlamaCppUrl(baseUrl: string, endpoint: 'completion' | 'apply-template'): string {
  if (!baseUrl) return '';
  const clean = baseUrl
    .trim()
    .replace(/\/+$/, '')
    // Strip any completion-flavoured suffix, with or without the OAI /v1 prefix.
    .replace(/\/(v1\/)?(chat\/)?completions?$/i, '')
    .replace(/\/(completion|apply-template)$/i, '')
    .replace(/\/v1$/i, '')
    .replace(/\/+$/, '');
  return `${clean}/${endpoint}`;
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
  /**
   * Reads the store and reports whether it was actually readable.
   *
   * An unreadable/corrupt file must not be presented as "no models
   * configured": callers that can overwrite it (the Settings model manager)
   * would then save an empty list over a recoverable configuration.
   */
  static readStore(): { ok: true; store: LlmStore } | { ok: false; store: LlmStore; error: string } {
    const empty: LlmStore = { version: 2, activeId: null, cards: [] };
    try {
      const p = getLlmConfigPath();
      if (!fs.existsSync(p)) return { ok: true, store: empty };
      return { ok: true, store: LLMService.migrateStore(JSON.parse(fs.readFileSync(p, 'utf8'))) };
    } catch (err: any) {
      return { ok: false, store: empty, error: err?.message || String(err) };
    }
  }

  /** Lenient read for generation paths: an unreadable file simply means "not configured". */
  static loadStore(): LlmStore {
    return LLMService.readStore().store;
  }

  static saveStore(store: LlmStore): void {
    try {
      const p = getLlmConfigPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const clean = LLMService.migrateStore(store);
      // Blank API keys mean "keep the stored one" — the client never receives keys.
      const previous = LLMService.loadStore();
      for (const card of clean.cards) {
        if (!card.apiKey) {
          card.apiKey = previous.cards.find((c) => c.id === card.id)?.apiKey ?? '';
        }
      }
      if (clean.cards.length === 0 && previous.cards.length > 0) {
        console.warn(
          `[LLM Store] Clearing the model list (${previous.cards.length} card(s) removed) — AI features will report "no model configured" until a model is added.`
        );
      }
      fs.writeFileSync(p, JSON.stringify(clean, null, 2), 'utf8');
      const active = LLMService.activeCard(clean);
      console.log(
        `[LLM Store Saved] ${clean.cards.length} model(s) | Active: ${active ? `${active.label} → ${active.model || '(server default)'}` : '(none)'}`
      );
    } catch (e) {
      console.warn('Failed to save stored LLM store:', e);
    }
  }

  /** The card every AI feature routes through; falls back to the first card. */
  static activeCard(store: LlmStore): LlmModelCard | null {
    return store.cards.find((c) => c.id === store.activeId) ?? store.cards[0] ?? null;
  }

  /**
   * Resolves the active model card as a call-ready `LLMConfig`.
   *
   * This is the single routing point for "all AI features use the ACTIVE model":
   * the queue worker, course-doc generation, schedule enrichment and Ask-AI all
   * obtain their config here, so switching the active card in Settings changes
   * every consumer without touching their call sites.
   */
  static loadStoredConfig(): LLMConfig | null {
    const card = LLMService.activeCard(LLMService.loadStore());
    if (!card || !card.baseUrl) return null;
    return {
      provider: card.provider,
      baseUrl: card.baseUrl,
      apiKey: card.apiKey,
      authHeaderType: card.authHeaderType,
      model: card.model,
      temperature: card.temperature,
      timeoutSeconds: card.timeoutSeconds,
      cardId: card.id
    };
  }

  /**
   * Legacy single-config write path (AI setup modal): updates the active card
   * in place, or creates the first card when the store is empty.
   */
  static saveStoredConfig(config: LLMConfig): void {
    const store = LLMService.loadStore();
    const existing = config.cardId
      ? store.cards.find((c) => c.id === config.cardId)
      : LLMService.activeCard(store);

    const card: LlmModelCard = {
      id: existing?.id ?? newCardId(),
      label: existing?.label || getProviderPreset(config.provider).label,
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKey:
        typeof config.apiKey === 'string' && config.apiKey.trim()
          ? config.apiKey.trim()
          : (existing?.apiKey ?? ''),
      authHeaderType: config.authHeaderType ?? existing?.authHeaderType ?? 'bearer',
      // A blank string clears the model id (server default); a non-string keeps the stored one.
      model: typeof config.model === 'string' ? config.model.trim() : (existing?.model ?? ''),
      temperature: config.temperature ?? existing?.temperature ?? 0.3,
      timeoutSeconds: config.timeoutSeconds ?? existing?.timeoutSeconds ?? 150
    };

    LLMService.saveStore({
      version: 2,
      activeId: existing?.id ?? card.id,
      cards: existing ? store.cards.map((c) => (c.id === existing.id ? card : c)) : [...store.cards, card]
    });
  }

  static setActiveCard(id: string): boolean {
    const store = LLMService.loadStore();
    if (!store.cards.some((c) => c.id === id)) return false;
    LLMService.saveStore({ ...store, activeId: id });
    return true;
  }

  /** Replaces the card list wholesale (Settings model manager) — order preserved. */
  static replaceCards(cards: LlmModelCard[], activeId: string | null): LlmStore {
    LLMService.saveStore({ version: 2, activeId, cards });
    return LLMService.loadStore();
  }

  /** Strips API keys so the client sees only connection metadata. */
  static summarizeCards(store: LlmStore): LlmCardSummary[] {
    return store.cards.map(({ apiKey, ...card }) => ({ ...card, hasApiKey: Boolean(apiKey && apiKey.trim()) }));
  }

  /**
   * Normalizes an incoming card list exactly the way persistence will, so a
   * caller can tell how many cards would actually survive a save. Cards without
   * a Base URL are unusable and are dropped — code that treats the raw array
   * length as "how many models will be stored" would miss that.
   */
  static normalizeCards(raw: unknown): LlmModelCard[] {
    return LLMService.migrateStore({ version: 2, activeId: null, cards: Array.isArray(raw) ? raw : [] }).cards;
  }

  /**
   * Accepts the version-2 store or the legacy flat single-config file and
   * always returns a normalized store. Cards must carry a non-empty baseUrl;
   * anything else is dropped rather than persisted as a broken entry.
   */
  private static migrateStore(raw: any): LlmStore {
    const rawCards: any[] = Array.isArray(raw?.cards)
      ? raw.cards
      : // Legacy shape: one flat config object (pre multi-card installs).
        raw && typeof raw.baseUrl === 'string' && raw.baseUrl.trim()
        ? [{ ...raw, id: 'card_default', label: getProviderPreset(raw.provider).label }]
        : [];

    const cards: LlmModelCard[] = [];
    const seenIds = new Set<string>();
    for (const c of rawCards) {
      const baseUrl = typeof c?.baseUrl === 'string' ? c.baseUrl.trim() : '';
      if (!baseUrl) continue;
      const provider = getProviderPreset(typeof c?.provider === 'string' ? c.provider : undefined).id;
      let id = typeof c?.id === 'string' && CARD_ID_PATTERN.test(c.id) ? c.id : newCardId();
      while (seenIds.has(id)) id = newCardId();
      seenIds.add(id);
      cards.push({
        id,
        label: typeof c?.label === 'string' && c.label.trim() ? c.label.trim() : getProviderPreset(provider).label,
        provider,
        baseUrl,
        apiKey: typeof c?.apiKey === 'string' ? c.apiKey.trim() : '',
        authHeaderType: cleanAuthType(c?.authHeaderType),
        model: typeof c?.model === 'string' ? c.model.trim() : '',
        temperature: cleanNumber(c?.temperature, 0.3, 0),
        // Capped so a huge persisted value cannot make Bun clamp the timer to
        // 1ms (which would fail every request with an instant timeout).
        timeoutSeconds: Math.min(cleanNumber(c?.timeoutSeconds, 150, 1), 3600)
      });
    }

    const activeId = cards.some((c) => c.id === raw?.activeId) ? raw.activeId : (cards[0]?.id ?? null);
    return { version: 2, activeId, cards };
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

  /**
   * Renders system+user turns into a single prompt string for llama.cpp's
   * native `/completion` endpoint, preferring the server's own chat template
   * (`/apply-template`) so each model is fed the format it was trained on.
   * Any failure — older build without the endpoint, network error — degrades
   * to a plain transcript instead of failing the generation.
   */
  private static async buildLlamaCppPrompt(
    config: LLMConfig,
    headers: Record<string, string>,
    systemPrompt: string,
    userPrompt: string,
    timeoutMs: number
  ): Promise<string> {
    const fallback = `${systemPrompt}\n\n${userPrompt}`;
    const templateUrl = resolveLlamaCppUrl(config.baseUrl, 'apply-template');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 20_000));
    try {
      const response = await fetch(templateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        console.warn(
          `[LLM API] llama.cpp /apply-template unavailable (HTTP ${response.status}) at ${templateUrl}; falling back to a plain system+user prompt — output quality may be lower on this build.`
        );
        return fallback;
      }
      const data = await response.json();
      const templated = typeof data?.prompt === 'string' ? data.prompt : '';
      if (!templated.trim()) {
        console.warn('[LLM API] llama.cpp /apply-template returned no prompt; falling back to a plain system+user prompt.');
        return fallback;
      }
      return templated;
    } catch (err: any) {
      console.warn(
        `[LLM API] llama.cpp /apply-template failed (${err?.message || err}); falling back to a plain system+user prompt.`
      );
      return fallback;
    } finally {
      clearTimeout(timer);
    }
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
    const isLlamaCppNative = protocolForProvider(config.provider) === 'llamacpp_native';
    const primaryUrl = isLlamaCppNative
      ? resolveLlamaCppUrl(config.baseUrl, 'completion')
      : resolveCompletionsUrl(config.baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    try {
      const parsedUrl = new URL(primaryUrl);
      if (parsedUrl.hostname && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(parsedUrl.hostname)) {
        headers['Host'] = parsedUrl.host;
      }
    } catch {}

    // Use the caller's key, else the stored key of the SAME card when the
    // request targets that card's endpoint — a posted cardId can therefore
    // never forward one card's key to a different host. Endpoints are compared
    // resolved, so equivalent URL spellings (…:1234 vs …:1234/v1) still match.
    const storedCard = LLMService.loadStore().cards.find((c) => c.id === config.cardId);
    const endpointOf = (baseUrl: string, provider: string | undefined) =>
      protocolForProvider(provider) === 'llamacpp_native'
        ? resolveLlamaCppUrl(baseUrl, 'completion')
        : resolveCompletionsUrl(baseUrl);
    // Each side resolves with its OWN provider protocol, so a changed protocol
    // (different endpoint path, same host) also drops the stored key.
    const sameEndpoint = Boolean(
      storedCard && endpointOf(storedCard.baseUrl, storedCard.provider) === endpointOf(config.baseUrl, config.provider)
    );
    const rawKey = (config.apiKey && config.apiKey.trim()) || (sameEndpoint ? storedCard!.apiKey : '') || '';
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

    /**
     * llama.cpp's native `/completion` takes a single templated prompt rather
     * than a messages array, so the model's own chat template is applied first
     * via `/apply-template` (falling back to a plain system+user transcript on
     * older builds that do not expose that endpoint).
     */
    let nativePrompt: string | null = null;
    if (isLlamaCppNative) {
      nativePrompt = await LLMService.buildLlamaCppPrompt(config, headers, systemPrompt, userPrompt, timeoutMs);
    }

    const payload: Record<string, any> = isLlamaCppNative
      ? {
          prompt: nativePrompt,
          // -1: generate until the model stops or the context fills, matching
          // the chat endpoints' behaviour (llama.cpp's own default).
          n_predict: -1,
          cache_prompt: true,
          stream: true
        }
      : {
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        };

    if (!isLlamaCppNative && config.model && config.model.trim()) {
      payload.model = config.model.trim();
    }

    if (config.temperature !== undefined) {
      payload.temperature = config.temperature;
    }

    if (!isLlamaCppNative && config.sessionId && config.sessionId.trim()) {
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
                    // OpenAI shape: choices[0].delta.content. llama.cpp native
                    // /completion shape: top-level content (its `stop` flag and
                    // `timings` ride along on the same objects).
                    const delta = parsed.choices?.[0]?.delta;
                    const textChunk = isLlamaCppNative ? parsed.content : delta?.content;
                    if (delta?.reasoning_content) {
                      const now = Date.now();
                      if (now - lastLogAt >= 10_000) {
                        emit?.('info', `🧠 Model is reasoning & planning… (${Math.round((now - startedAt) / 1000)}s)`);
                        lastLogAt = now;
                      }
                    }
                    if (textChunk) {
                      streamCompletion += textChunk;
                      const now = Date.now();
                      if (now - lastLogAt >= 10_000) {
                        emit?.('info', `📝 Generating… ${streamCompletion.length.toLocaleString()} chars (${Math.round((now - startedAt) / 1000)}s)`);
                        lastLogAt = now;
                      }
                    }
                    if (parsed.usage) {
                      streamUsage = parsed.usage;
                    } else if (isLlamaCppNative && (parsed.tokens_evaluated !== undefined || parsed.timings?.predicted_n !== undefined)) {
                      // llama.cpp reports token counts as tokens_evaluated/timings
                      // rather than a usage object.
                      streamUsage = {
                        prompt_tokens: parsed.tokens_evaluated,
                        completion_tokens: parsed.timings?.predicted_n,
                        total_tokens: (parsed.tokens_evaluated ?? 0) + (parsed.timings?.predicted_n ?? 0)
                      };
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
    if (res.status === 404 && !isLlamaCppNative && !config.baseUrl.includes('/v1')) {
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
        completion = isLlamaCppNative
          ? (typeof data.content === 'string' ? data.content : '')
          : (data.choices?.[0]?.message?.content || '');
        usage = data.usage ?? (isLlamaCppNative && data.tokens_evaluated !== undefined
          ? {
              prompt_tokens: data.tokens_evaluated,
              completion_tokens: data.timings?.predicted_n,
              total_tokens: (data.tokens_evaluated ?? 0) + (data.timings?.predicted_n ?? 0)
            }
          : undefined);
      } catch {
        completion = res.bodyText;
      }
    }

    const safeCompletion = completion ?? '';

    const tokensInfo = usage?.total_tokens !== undefined
      ? ` | "total_tokens":${usage.total_tokens} (prompt: ${usage.prompt_tokens ?? '?'}, completion: ${usage.completion_tokens ?? '?'})`
      : (usage ? ` | usage: ${JSON.stringify(usage)}` : '');

    console.log(`[LLM API Success] Generated ${safeCompletion.length.toLocaleString()} characters${tokensInfo}.\n`);

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
