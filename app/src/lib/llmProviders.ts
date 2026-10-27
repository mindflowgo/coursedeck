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
  /** OpenAI Responses API `/v1/responses` with instructions & input (OpenCode GPT-6/5.6, Grok). */
  | 'openai_responses'
  /** llama.cpp `llama-server` native `/completion` endpoint (raw prompt, not OAI-compatible). */
  | 'llamacpp_native';

export interface LlmProviderPreset {
  id: string;
  label: string;
  defaultBaseUrl: string;
  defaultModel?: string;
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
    hint: 'Any server exposing /chat/completions. Include the version prefix in the Base URL (e.g. https://api.openai.com/v1).'
  },
  {
    id: 'zcode',
    label: 'ZCode / Z.ai GLM',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.3-flash',
    protocol: 'openai_chat',
    hint: 'ZCode / Z.ai GLM OpenAI-compatible endpoint. Requires an API key (e.g. from Z.ai / BigModel coding plan). Never hardcode API keys.'
  },
  {
    id: 'opencode',
    label: 'OpenCode (Go / Zen)',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'glm-5.3-flash',
    protocol: 'openai_chat',
    hint: 'OpenCode OpenAI-compatible gateway (Go & Zen). Supports GLM, Claude, GPT, and DeepSeek. Requires an API key (oc_sk_...).'
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

/**
 * Model prefixes that require or use the OpenAI Responses protocol (`/responses`).
 * Scanned in `isResponsesProtocolModel` to determine endpoint routing.
 */
export const LLM_RESPONSE_FORMAT: readonly string[] = ['gpt-', 'grok-'];

/**
 * Returns true if the model matches any known Responses protocol prefix.
 */
export function isResponsesProtocolModel(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.trim().toLowerCase();
  return LLM_RESPONSE_FORMAT.some((prefix) => m.startsWith(prefix));
}

/**
 * Known model names and patterns that do not support the `temperature` parameter.
 * (e.g. OpenAI o1/o3/o4 family, GPT-6, Luna models, and reasoning models).
 */
export function doesModelSupportTemperature(model: string | undefined): boolean {
  if (!model) return true;
  const m = model.trim().toLowerCase();
  if (/^o[1-9](-|$)/i.test(m) || /^gpt-6(-|$)/i.test(m) || m.includes('luna') || m.includes('reasoning')) {
    return false;
  }
  return true;
}

/**
 * Detects whether an API error indicates that the `temperature` parameter is unsupported.
 */
export function isTemperatureUnsupportedError(errorText: string | undefined): boolean {
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return (
    lower.includes("unsupported parameter: 'temperature'") ||
    lower.includes('unsupported parameter: "temperature"') ||
    lower.includes("'temperature' is not supported") ||
    lower.includes('"temperature" is not supported') ||
    lower.includes('temperature is not supported') ||
    lower.includes('does not support temperature') ||
    (lower.includes('temperature') && lower.includes('unsupported')) ||
    (lower.includes('temperature') && lower.includes('invalid_request_error') && lower.includes('param'))
  );
}

export function protocolForProvider(id: string | undefined, model?: string): LlmProtocol {
  const baseProtocol = getProviderPreset(id).protocol;
  if (baseProtocol === 'llamacpp_native') return 'llamacpp_native';
  if (isResponsesProtocolModel(model)) return 'openai_responses';
  return baseProtocol;
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
