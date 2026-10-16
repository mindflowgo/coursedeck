/**
 * Provider metadata shared by the server LLM client and the Settings UI.
 *
 * Dependency-free on purpose: `src/lib/server/llm.ts` imports it for transport
 * routing while Svelte components import it for presets and labels, so the two
 * can never disagree about what a provider id means.
 */

/** Transport a provider speaks. */
export type LlmProtocol =
  /** OpenAI `/v1/chat/completions` with a `messages` array (LM Studio, Ollama, Gemini, vLLM…). */
  | 'openai_chat'
  /** llama.cpp `llama-server` native `/completion` endpoint (raw prompt, not OAI-compatible). */
  | 'llamacpp_native';

export interface LlmProviderPreset {
  id: string;
  label: string;
  defaultBaseUrl: string;
  protocol: LlmProtocol;
  /** One-line guidance shown under the card's Base URL field. */
  hint: string;
}

export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = [
  {
    id: 'openai_compatible',
    label: 'OpenAI-Compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    protocol: 'openai_chat',
    hint: 'Any server exposing /v1/chat/completions. Use the domain name, not a raw IP (Cloudflare blocks direct IP access).'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    defaultBaseUrl: 'http://localhost:1234/v1',
    protocol: 'openai_chat',
    hint: 'LM Studio server speaks the OpenAI-compatible protocol. Model ID must match the loaded model (see LM Studio → Developer → Server).'
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server (native /completion)',
    defaultBaseUrl: 'http://localhost:9931',
    protocol: 'llamacpp_native',
    hint: 'llama-server native protocol (default port 9931; older builds and --port 8080 setups use 8080). Uses the model chat template via /apply-template.'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    defaultBaseUrl: 'http://localhost:11434/v1',
    protocol: 'openai_chat',
    hint: 'Ollama’s OpenAI-compatible endpoint. Model ID is the Ollama tag, e.g. llama3.1:8b.'
  },
  {
    id: 'gemini',
    label: 'Google Gemini (OpenAI endpoint)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai_chat',
    hint: 'Gemini via its OpenAI-compatibility endpoint; requires an API key.'
  }
];

export function getProviderPreset(id: string | undefined): LlmProviderPreset {
  return LLM_PROVIDER_PRESETS.find((p) => p.id === id) ?? LLM_PROVIDER_PRESETS[0];
}

/**
 * Client-safe view of one provider card: the stored API key itself never leaves
 * the server, only whether one is saved. Shared by the `/api/llm` response
 * shaping (server) and the Settings UI (client).
 */
export interface LlmCardSummary {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  authHeaderType?: 'bearer' | 'api_key' | 'both';
  model?: string;
  temperature?: number;
  timeoutSeconds?: number;
  sendSessionId?: boolean;
  hasApiKey: boolean;
}

export function protocolForProvider(id: string | undefined): LlmProtocol {
  return getProviderPreset(id).protocol;
}

/**
 * True for a public IPv4 literal — direct IP access to cloud APIs is rejected
 * by Cloudflare (error 1003), so the UI warns and suggests a domain name.
 * Private ranges (10/8, 172.16/12, 192.168/16, 127/8) are local and fine.
 */
export function isPublicIpUrl(urlStr: string): boolean {
  try {
    const clean = urlStr.trim();
    if (!clean) return false;
    const host = new URL(clean.startsWith('http') ? clean : `http://${clean}`).hostname;
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
    return true;
  } catch {
    return false;
  }
}
