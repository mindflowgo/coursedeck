import { apiFetch } from '$lib/api';
import {
  LLM_PROVIDER_PRESETS,
  isResponsesProtocolModel,
  doesModelSupportTemperature,
  isTemperatureUnsupportedError,
  type LlmCardSummary
} from '$lib/llmProviders';

export type { LlmCardSummary };

/** The stored model list as the Settings UI consumes it. */
export interface LlmStoreSnapshot {
  activeId: string | null;
  cards: LlmCardSummary[];
  /** The card every AI feature currently routes through. */
  active: LlmCardSummary | null;
}

/** A card being edited in Settings: `apiKey` holds only a newly typed key. */
export interface LlmCardDraft extends LlmCardSummary {
  apiKey: string;
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function toSnapshot(data: any): LlmStoreSnapshot {
  const cards: LlmCardSummary[] = Array.isArray(data?.cards) ? data.cards : [];
  const activeId = typeof data?.activeId === 'string' ? data.activeId : null;
  return {
    activeId,
    cards,
    active: cards.find((c) => c.id === activeId) ?? cards[0] ?? null
  };
}

/** Reads the persisted model store. Returns null when the backend can't serve it. */
export async function fetchLlmStore(): Promise<LlmStoreSnapshot | null> {
  try {
    const res = await apiFetch('/api/llm');
    if (res.ok) return toSnapshot(await res.json());
  } catch {
    // Offline or unreachable
  }

  if (typeof window !== 'undefined') {
    try {
      const { getLlmStore } = await import('./storage/clientStore');
      const store = await getLlmStore();
      if (store) {
        return toSnapshot(store);
      }
    } catch {}
  }
  return null;
}

/**
 * Returns the raw active LLM card (including apiKey if stored locally in IndexedDB),
 * enabling direct client-side generation when offline.
 */
export async function getActiveLlmConfig(): Promise<{
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  apiKey?: string;
  authHeaderType?: string;
  model?: string;
  temperature?: number;
  timeoutSeconds?: number;
  sendSessionId?: boolean;
} | null> {
  if (typeof window !== 'undefined') {
    try {
      const { getLlmStore } = await import('./storage/clientStore');
      const store = await getLlmStore();
      if (store?.cards) {
        const active = store.cards.find((c) => c.id === store.activeId) ?? store.cards[0] ?? null;
        if (active) return active as any;
      }
    } catch {}
  }
  return null;
}

/**
 * Calls the LLM API directly from the browser (no Bun proxy).
 * Used on iPad when offline. Supports OpenAI-compatible endpoints
 * and direct Gemini API.
 */
export async function generateDirect(
  card: { provider?: string; baseUrl: string; apiKey?: string; authHeaderType?: string; model?: string; temperature?: number; timeoutSeconds?: number; sendSessionId?: boolean },
  systemPrompt: string,
  userPrompt: string
): Promise<{ completion: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> {
  if (!card.baseUrl) {
    throw new Error('No Base URL configured for active AI model.');
  }

  const model = (card.model || '').trim();
  if (!model && card.provider !== 'llamacpp') {
    throw new Error('No model configured for active AI model. Please specify a model in Settings → AI Models.');
  }

  const apiKey = (card.apiKey || '').trim();

  const isResponses = isResponsesProtocolModel(model);
  const baseClean = card.baseUrl.trim().replace(/\/+$/, '');
  const url = isResponses
    ? (baseClean.endsWith('/responses')
        ? baseClean
        : baseClean.endsWith('/chat/completions')
        ? baseClean.replace(/\/chat\/completions$/, '/responses')
        : `${baseClean}/responses`)
    : (baseClean.endsWith('/chat/completions')
        ? baseClean
        : `${baseClean}/chat/completions`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (apiKey) {
    if (card.authHeaderType === 'api_key') {
      headers['x-api-key'] = apiKey;
    } else if (card.authHeaderType === 'both') {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  if (url.includes('opencode.ai')) {
    headers['x-opencode-session'] = (card as any).sessionId?.trim() || `session_${Date.now().toString(36)}`;
  }

  const sendTemp = typeof card.temperature === 'number' && doesModelSupportTemperature(model);
  const payload: Record<string, any> = isResponses
    ? {
        model,
        ...(sendTemp ? { temperature: card.temperature } : {}),
        instructions: systemPrompt,
        input: userPrompt
      }
    : {
        ...(model ? { model } : {}),
        ...(sendTemp ? { temperature: card.temperature } : {}),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      };

  const timeoutMs = (card.timeoutSeconds || 120) * 1000;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    let res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });

    if ((res.status === 400 || res.status === 422) && payload.temperature !== undefined) {
      const errClone = res.clone();
      const errText = await errClone.text().catch(() => '');
      if (isTemperatureUnsupportedError(errText)) {
        delete payload.temperature;
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
      }
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      if (res.status === 429) {
        let quotaDetail = '';
        try {
          const parsed = JSON.parse(txt);
          quotaDetail = parsed?.error?.message || parsed?.message || '';
        } catch {}
        throw new Error(
          `Plan quota or rate limit exhausted (HTTP 429): ${quotaDetail || txt || 'Usage limit reached'}. Our plan is exhausted for now — wait for the quota window to reset or upgrade your plan.`
        );
      }
      throw new Error(`AI request failed (${res.status}): ${txt}`);
    }

    const data = await res.json();
    const isResp = isResponses || data?.object === 'response';
    const completion = isResp
      ? (data.output?.[0]?.content?.[0]?.text ?? (data.output?.[0]?.text || ''))
      : (data.choices?.[0]?.message?.content ?? '');

    const rawUsage = data.usage ?? data.response?.usage;
    const usage = isResp && rawUsage
      ? {
          prompt_tokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens,
          completion_tokens: rawUsage.output_tokens ?? rawUsage.completion_tokens,
          total_tokens: rawUsage.total_tokens ?? ((rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0))
        }
      : rawUsage;

    return { completion, usage };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      throw new Error(`AI request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
}

/**
 * The single "which model does AI use" lookup for feature call sites: resolves
 * the ACTIVE card (or null when no model is configured), so the frontend never
 * needs its own copy of the LLM settings.
 */
export async function getActiveLlmCard(): Promise<LlmCardSummary | null> {
  const snapshot = await fetchLlmStore();
  return snapshot?.active ?? null;
}

/**
 * Persists the whole card list (add/edit/remove) plus the active selection.
 *
 * `allowEmpty` is the explicit opt-in the server requires to clear a
 * previously non-empty list, so an empty list caused by a bug or a stale tab
 * cannot silently wipe the configured models.
 */
export async function saveLlmStore(
  cards: LlmCardDraft[],
  activeId: string | null,
  opts?: { allowEmpty?: boolean }
): Promise<LlmStoreSnapshot> {
  const res = await apiFetch(
    '/api/llm',
    jsonInit({ action: 'save_store', cards, activeId, confirmClear: opts?.allowEmpty === true })
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || `Failed to save models (HTTP ${res.status})`);
  }
  // The response carries the same store view as GET, so no follow-up read is needed.
  // If a 200 ever arrives without a readable body, re-read rather than report a
  // failure for a save that actually succeeded.
  const data = await res.json().catch(() => null);
  if (data) return toSnapshot(data);
  const fresh = await fetchLlmStore();
  if (fresh) return fresh;
  throw new Error('Models were saved, but the response could not be read — reload the page to confirm.');
}

/** Switches which card all AI features route through. */
export async function setActiveLlmCard(id: string): Promise<void> {
  const res = await apiFetch('/api/llm', jsonInit({ action: 'set_active', id }));
  if (!res.ok) throw new Error(`Failed to switch active model (HTTP ${res.status})`);
}

/** Tests one card without saving it; blank apiKey falls back to the stored key. */
export async function testLlmCard(
  card: { id?: string; provider: string; baseUrl: string; apiKey?: string; authHeaderType?: string; model?: string; temperature?: number; timeoutSeconds?: number; sendSessionId?: boolean },
  storedId?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await apiFetch('/api/llm', jsonInit({ action: 'test', config: { ...card, cardId: storedId } }));
    const data = await res.json();
    if (!res.ok && !data?.message) {
      return { success: false, message: `Connection failed (HTTP ${res.status})` };
    }
    return { success: Boolean(data.success), message: data.message || (data.success ? 'Connected!' : 'Connection failed') };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Failed to contact the endpoint' };
  }
}

let draftCounter = 0;

/** New unsaved card pre-filled from the first provider preset. */
export function createLlmCardDraft(): LlmCardDraft {
  const preset = LLM_PROVIDER_PRESETS[0];
  draftCounter += 1;
  return {
    id: `card_${Date.now().toString(36)}_${draftCounter}`,
    label: preset.label,
    provider: preset.id,
    baseUrl: preset.defaultBaseUrl,
    authHeaderType: 'bearer',
    model: preset.defaultModel || '',
    temperature: 0.3,
    timeoutSeconds: 150,
    sendSessionId: false,
    apiKey: '',
    hasApiKey: false
  };
}
