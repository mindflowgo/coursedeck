<script lang="ts">
  import { apiFetch } from '$lib/api';
  import { LLM_PROVIDER_PRESETS, getProviderPreset, isPublicIpUrl } from '$lib/llmProviders';
  import { X, Server, Sparkles, CheckCircle2, AlertCircle, Loader2, ArrowRight } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
    onConfigured: () => void;
  }

  let { isOpen, onClose, onConfigured }: Props = $props();

  let provider = $state('openai_compatible');
  let baseUrl = $state(getProviderPreset('openai_compatible').defaultBaseUrl);
  let apiKey = $state('');
  let authHeaderType: 'bearer' | 'api_key' | 'both' = $state('bearer');
  let model = $state('');
  let temperature = $state(0.3);
  /** Card being edited; lets the server reuse its stored API key when the field is left blank. */
  let cardId = $state<string | undefined>(undefined);

  const REQUEST_TIMEOUT_STEPS: readonly number[] = [30, 60, 90, 120, 150, 300, 600];
  let timeoutSeconds = $state(150);
  let sendSessionId = $state(false);

  let isTesting = $state(false);
  let isSaving = $state(false);
  let statusMessage = $state<{ success: boolean; text: string } | null>(null);
  let hasStoredApiKey = $state(false);

  $effect(() => {
    if (isOpen) {
      // Load the ACTIVE model card from the server (single source of truth)
      apiFetch('/api/llm')
        .then((res) => res.json())
        .then((data) => {
          if (data && data.config) {
            cardId = data.config.id;
            provider = data.config.provider || 'openai_compatible';
            baseUrl = data.config.baseUrl || getProviderPreset(provider).defaultBaseUrl;
            model = data.config.model ?? '';
            authHeaderType = data.config.authHeaderType || 'bearer';
            temperature = data.config.temperature ?? 0.3;
            timeoutSeconds = data.config.timeoutSeconds ?? 150;
            sendSessionId = Boolean(data.config.sendSessionId);
            hasStoredApiKey = Boolean(data.config.hasApiKey);
          }
        })
        .catch(() => {});
    }
  });

  /** Preset change swaps the example URL in unless the user typed their own. */
  function handleProviderChange(nextProvider: string) {
    const unchanged = !baseUrl.trim() || baseUrl.trim() === getProviderPreset(provider).defaultBaseUrl;
    provider = nextProvider;
    if (unchanged) baseUrl = getProviderPreset(nextProvider).defaultBaseUrl;
  }

  async function handleSaveAndContinue() {
    if (isSaving) return;
    const cleanModel = model.trim();
    if (!baseUrl.trim()) {
      statusMessage = { success: false, text: 'A Base URL is required (e.g. http://localhost:1234/v1).' };
      return;
    }

    isSaving = true;
    // Save first so the background worker is guaranteed to see the new model.
    try {
      const res = await apiFetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_config',
          config: {
            cardId,
            provider,
            baseUrl,
            apiKey: apiKey || undefined,
            authHeaderType,
            model: cleanModel,
            temperature,
            timeoutSeconds,
            sendSessionId
          }
        })
      });
      if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`);
    } catch (err: any) {
      statusMessage = { success: false, text: err?.message || 'Failed to save the AI model — check the Base URL.' };
      return;
    } finally {
      isSaving = false;
    }

    onConfigured();
    onClose();
  }

  async function testConnection() {
    isTesting = true;
    statusMessage = null;

    try {
      const res = await apiFetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'test',
          config: {
            cardId,
            provider,
            baseUrl,
            apiKey,
            authHeaderType,
            model,
            temperature,
            timeoutSeconds,
            sendSessionId
          }
        })
      });

      const data = await res.json();
      statusMessage = {
        success: data.success,
        text: data.message || (data.success ? 'Connected successfully!' : 'Connection failed')
      };
    } catch (err: any) {
      statusMessage = {
        success: false,
        text: err?.message || 'Failed to contact LLM endpoint'
      };
    } finally {
      isTesting = false;
    }
  }

</script>

<svelte:window onkeydown={(e) => { if (isOpen && e.key === 'Escape') onClose(); }} />

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs">
    <!-- Backdrop dismiss -->
    <button
      type="button"
      class="absolute inset-0 w-full h-full cursor-default"
      onclick={onClose}
      aria-label="Close modal overlay"
      tabindex="-1"
    ></button>

    <div class="relative z-10 w-full max-w-lg rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150">
      <!-- Header -->
      <div class="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2.5">
          <div class="p-2 rounded-xl bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200 shadow-2xs">
            <Server class="w-4 h-4" />
          </div>
          <div>
            <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">Setup AI / LLM Connection</h2>
            <p class="text-[11px] text-stone-500 dark:text-stone-400">Configure an LLM to generate summaries, cheatsheets, and tests</p>
          </div>
        </div>

        <button
          onclick={onClose}
          class="p-1 rounded-md text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Provider Form -->
      <div class="space-y-3.5">
        <div class="space-y-1">
          <label for="modal-provider" class="text-xs font-medium text-stone-700 dark:text-stone-300">Provider</label>
          <select
            id="modal-provider"
            value={provider}
            onchange={(event) => handleProviderChange(event.currentTarget.value)}
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          >
            {#each LLM_PROVIDER_PRESETS as preset (preset.id)}
              <option value={preset.id}>{preset.label}</option>
            {/each}
          </select>
        </div>

        <div class="space-y-1">
          <label for="modal-base-url" class="text-xs font-medium text-stone-700 dark:text-stone-300">Base URL</label>
          <input
            id="modal-base-url"
            type="text"
            bind:value={baseUrl}
            placeholder={getProviderPreset(provider).defaultBaseUrl}
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          />
          <p class="text-[10px] text-stone-400 dark:text-stone-500">{getProviderPreset(provider).hint}</p>
          {#if isPublicIpUrl(baseUrl)}
            <p class="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
              Note: Direct IP access to cloud APIs (like DeepSeek, OpenAI, Groq) is blocked by Cloudflare (error 1003). Use the domain name (e.g. <code>https://api.deepseek.com</code>) instead of an IP.
            </p>
          {/if}
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="modal-model-name" class="text-xs font-medium text-stone-700 dark:text-stone-300">Model ID (optional)</label>
            <input
              id="modal-model-name"
              type="text"
              bind:value={model}
              placeholder="e.g. gpt-4o-mini, qwen2.5-7b"
              class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
            />
          </div>

          <div class="space-y-1">
            <label for="modal-api-key" class="text-xs font-medium text-stone-700 dark:text-stone-300">API Key (if required)</label>
            <input
              id="modal-api-key"
              type="password"
              bind:value={apiKey}
              placeholder={hasStoredApiKey ? 'Key saved on server (leave blank to keep)' : 'sk-...'}
              class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
            />
          </div>
        </div>

        <!-- Auth Header Option -->
        <div class="space-y-1 pt-1">
          <label for="modal-auth-type" class="text-xs font-medium text-stone-700 dark:text-stone-300 flex items-center justify-between">
            <span>Auth Header Format</span>
            <span class="text-[10px] text-stone-400 dark:text-stone-500 font-mono">Authorization: Bearer</span>
          </label>
          <select
            id="modal-auth-type"
            bind:value={authHeaderType}
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          >
            <option value="bearer">Authorization: Bearer &#123;key&#125; (Standard OpenAPI / OpenAI)</option>
            <option value="api_key">api-key: &#123;key&#125; (Azure / Custom OpenAPI)</option>
            <option value="both">Both (Authorization: Bearer + api-key)</option>
          </select>
        </div>

        <!-- Request Timeout Option -->
        <div class="space-y-1 pt-1">
          <label for="modal-timeout" class="text-xs font-medium text-stone-700 dark:text-stone-300 flex items-center justify-between">
            <span>Request Timeout</span>
            <span class="text-[10px] text-stone-400 dark:text-stone-500 font-mono">per attempt</span>
          </label>
          <select
            id="modal-timeout"
            bind:value={timeoutSeconds}
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          >
            {#each REQUEST_TIMEOUT_STEPS as step (step)}
              <option value={step}>{step}s{step === 150 ? ' (default)' : ''}</option>
            {/each}
          </select>
          <p class="text-[10px] text-stone-400 dark:text-stone-500">Raise this if generation fails with "timed out" (slow providers need more).</p>
        </div>

        <!-- Optional Send session_id checkbox -->
        <div class="pt-1">
          <label for="modal-send-session-id" class="inline-flex items-center space-x-2 text-xs text-stone-700 dark:text-stone-300 select-none cursor-pointer">
            <input
              id="modal-send-session-id"
              type="checkbox"
              bind:checked={sendSessionId}
              class="rounded border-stone-300 dark:border-stone-700 text-stone-900 dark:text-stone-100 focus:ring-stone-900 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Send session ID (<code>session_id</code>)</span>
          </label>
          <p class="text-[10px] text-stone-400 dark:text-stone-500 pl-5.5">
            Keep unchecked if your provider rejects extra inputs with HTTP 400.
          </p>
        </div>
      </div>

      <!-- Test connection status -->
      {#if statusMessage}
        <div class="flex items-center space-x-2 text-xs p-3 rounded-lg border {statusMessage.success ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/60 text-emerald-800 dark:text-emerald-200' : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800/60 text-rose-800 dark:text-rose-200'}">
          {#if statusMessage.success}
            <CheckCircle2 class="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          {:else}
            <AlertCircle class="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
          {/if}
          <span>{statusMessage.text}</span>
        </div>
      {/if}

      <!-- Actions -->
      <div class="flex items-center justify-between pt-2 border-t border-stone-100 dark:border-stone-800">
        <button
          onclick={testConnection}
          disabled={isTesting}
          class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 text-xs text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          {#if isTesting}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>Testing...</span>
          {:else}
            <span>Test Connection</span>
          {/if}
        </button>

        <div class="flex items-center space-x-2">
          <button
            onclick={onClose}
            class="px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 text-xs text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            onclick={handleSaveAndContinue}
            disabled={isSaving}
            class="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 text-white dark:text-stone-900 text-xs font-medium transition shadow-2xs cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            {#if isSaving}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Saving...</span>
            {:else}
              <span>Save & Generate</span>
              <ArrowRight class="w-3.5 h-3.5" />
            {/if}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
