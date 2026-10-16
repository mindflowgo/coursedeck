import { apiFetch } from '$lib/api';
import { LLM_PROVIDER_PRESETS, type LlmCardSummary } from '$lib/llmProviders';

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
    if (!res.ok) return null;
    return toSnapshot(await res.json());
  } catch {
    return null;
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
    model: '',
    temperature: 0.3,
    timeoutSeconds: 150,
    sendSessionId: false,
    apiKey: '',
    hasApiKey: false
  };
}
