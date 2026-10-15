<script lang="ts">
  import { apiFetch } from '$lib/api';
  import { X, Server, Sparkles, CheckCircle2, AlertCircle, Loader2, ArrowRight } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
    onConfigured: () => void;
  }

  let { isOpen, onClose, onConfigured }: Props = $props();

  let provider = $state('openai_compatible');
  let baseUrl = $state('http://localhost:11434/v1');
  let apiKey = $state('');
  let authHeaderType: 'bearer' | 'api_key' | 'both' = $state('bearer');
  let model = $state('');
  let temperature = $state(0.3);

  const REQUEST_TIMEOUT_STEPS: readonly number[] = [30, 60, 90, 120, 150, 300, 600];
  let timeoutSeconds = $state(150);

  let isTesting = $state(false);
  let statusMessage = $state<{ success: boolean; text: string } | null>(null);
  let hasStoredApiKey = $state(false);

  $effect(() => {
    if (isOpen) {
      // Clean up any legacy API key from localStorage
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('ilc_llm_apiKey');
      }

      // Load config from server
      apiFetch('/api/llm')
        .then((res) => res.json())
        .then((data) => {
          if (data && data.config) {
            provider = data.config.provider || 'openai_compatible';
            baseUrl = data.config.baseUrl || 'http://localhost:11434/v1';
            model = data.config.model ?? '';
            authHeaderType = data.config.authHeaderType || 'bearer';
            temperature = data.config.temperature ?? 0.3;
            timeoutSeconds = data.config.timeoutSeconds ?? 150;
            hasStoredApiKey = Boolean(data.config.hasApiKey);
          } else if (typeof localStorage !== 'undefined') {
            provider = localStorage.getItem('ilc_llm_provider') || 'openai_compatible';
            baseUrl = localStorage.getItem('ilc_llm_baseUrl') || 'http://localhost:11434/v1';
            authHeaderType = (localStorage.getItem('ilc_llm_authHeaderType') as any) || 'bearer';
            model = localStorage.getItem('ilc_llm_model') ?? '';
            temperature = parseFloat(localStorage.getItem('ilc_llm_temp') || '0.3');
            timeoutSeconds = Number(localStorage.getItem('ilc_llm_timeout')) || 150;
          }
        })
        .catch(() => {});
    }
  });

  function handleSaveAndContinue() {
    const cleanModel = model.trim();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('ilc_llm_provider', provider);
      localStorage.setItem('ilc_llm_baseUrl', baseUrl);
      localStorage.removeItem('ilc_llm_apiKey');
      localStorage.setItem('ilc_llm_authHeaderType', authHeaderType);
      localStorage.setItem('ilc_llm_model', cleanModel);
      localStorage.setItem('ilc_llm_temp', temperature.toString());
      localStorage.setItem('ilc_llm_timeout', timeoutSeconds.toString());
    }

    // Sync to server immediately so background worker uses CURRENT active settings
    apiFetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save_config',
        config: {
          provider,
          baseUrl,
          apiKey: apiKey || undefined,
          authHeaderType,
          model: cleanModel,
          temperature,
          timeoutSeconds
        }
      })
    }).catch((err) => console.warn('Failed to sync LLM config to server:', err));

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
            provider,
            baseUrl,
            apiKey,
            authHeaderType,
            model,
            temperature,
            timeoutSeconds
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

  function isPublicIp(urlStr: string): boolean {
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
</script>

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs">
    <div class="w-full max-w-lg rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150">
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
            bind:value={provider}
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          >
            <option value="openai_compatible">OpenAI-Compatible (Ollama, vLLM, LMStudio, OpenRouter, Local)</option>
            <option value="gemini">Google Gemini (OpenAI compatibility endpoint)</option>
            <option value="ollama">Ollama Local</option>
          </select>
        </div>

        <div class="space-y-1">
          <label for="modal-base-url" class="text-xs font-medium text-stone-700 dark:text-stone-300">Base URL</label>
          <input
            id="modal-base-url"
            type="text"
            bind:value={baseUrl}
            placeholder="http://localhost:11434/v1"
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          />
          <p class="text-[10px] text-stone-400 dark:text-stone-500">For free local AI with Ollama, run <code>ollama run llama3</code></p>
          {#if isPublicIp(baseUrl)}
            <p class="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
              Note: Direct IP access to cloud APIs (like DeepSeek, OpenAI, Groq) is blocked by Cloudflare (error 1003). Use the domain name (e.g. <code>https://api.deepseek.com</code>) instead of an IP.
            </p>
          {/if}
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="modal-model-name" class="text-xs font-medium text-stone-700 dark:text-stone-300">Model Name (optional)</label>
            <input
              id="modal-model-name"
              type="text"
              bind:value={model}
              placeholder="e.g. gpt-4o-mini, llama3 (or blank)"
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
            class="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 text-white dark:text-stone-900 text-xs font-medium transition shadow-2xs cursor-pointer"
          >
            <span>Save & Generate</span>
            <ArrowRight class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
