<!-- app/src/lib/components/ConnectIpadModal.svelte -->
<script lang="ts">
  import { generate } from 'lean-qr';
  import { Tablet, X, Sparkles, Loader2 } from 'lucide-svelte';
  import { apiFetch } from '$lib/api';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
  }

  let { isOpen, onClose }: Props = $props();

  let includeLlmKeys = $state(true);
  let lanUrl = $state('');
  let isLoading = $state(true);

  async function loadPairingInfo() {
    isLoading = true;
    try {
      const res = await apiFetch('/api/pairing/info');
      if (res.ok) {
        const data = await res.json();
        if (data.primaryUrl) {
          lanUrl = data.primaryUrl;
        } else if (data.primaryIp) {
          lanUrl = `http://${data.primaryIp}:${data.port || 3182}`;
        }
      }
    } catch (err) {
      console.error('[Pairing Info Error]', err);
    } finally {
      isLoading = false;
    }
  }

  $effect(() => {
    if (isOpen) {
      loadPairingInfo();
    }
  });

  let qrPayload = $derived.by(() => {
    if (!lanUrl) return '';
    try {
      const u = new URL(lanUrl);
      if (includeLlmKeys) {
        u.searchParams.set('includeLlmKeys', 'true');
      }
      return u.toString();
    } catch {
      return lanUrl;
    }
  });

  let qrDataUrl = $derived.by(() => {
    if (!qrPayload) return '';
    try {
      const code = generate(qrPayload);
      return code.toDataURL({ scale: 6, pad: 2 });
    } catch (e) {
      console.error('[QR Code Generation Error]', e);
      return '';
    }
  });
</script>

{#if isOpen}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-xs p-4 overflow-y-auto"
    role="presentation"
    onclick={onClose}
  >
    <div
      class="relative my-auto bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-3xl p-6 sm:p-7 max-w-xs w-full shadow-2xl space-y-5 animate-in fade-in duration-200 text-stone-900 dark:text-stone-100"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={() => {}}
    >
      <!-- Modal Header -->
      <div class="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2.5">
          <div class="w-8 h-8 rounded-xl bg-amber-400/10 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <Tablet class="w-4 h-4" />
          </div>
          <div>
            <h2 class="text-sm font-semibold">Connect iPad</h2>
            <p class="text-[11px] text-stone-500 dark:text-stone-400">CourseDeck iDevice Sync</p>
          </div>
        </div>

        <button
          type="button"
          onclick={onClose}
          aria-label="Close"
          class="p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Main Instruction -->
      <div class="text-center space-y-1">
        <p class="text-xs font-semibold text-stone-800 dark:text-stone-200">
          Scan QR-code with CourseDeck iDevice app
        </p>
        <p class="text-[11px] text-stone-500 dark:text-stone-400">
          Ensure your iPad is connected to the same Wi-Fi.
        </p>
      </div>

      <!-- Prominent QR Code -->
      <div class="flex justify-center">
        <div class="p-3 bg-white rounded-2xl border border-stone-200 shadow-sm inline-block">
          {#if qrDataUrl}
            <img
              src={qrDataUrl}
              alt="Scan QR-code with CourseDeck iDevice app"
              class="w-56 h-56 image-rendering-pixelated rounded-lg block"
            />
          {:else if isLoading}
            <div class="w-56 h-56 flex flex-col items-center justify-center space-y-2 text-stone-400 text-xs">
              <Loader2 class="w-6 h-6 animate-spin text-amber-500" />
              <span>Generating QR code...</span>
            </div>
          {:else}
            <div class="w-56 h-56 flex items-center justify-center text-stone-400 text-xs text-center p-4">
              Unable to generate QR code.
            </div>
          {/if}
        </div>
      </div>

      <!-- AI Configuration Toggle -->
      <label class="flex items-center justify-center space-x-2 cursor-pointer text-[11px] text-stone-600 dark:text-stone-400">
        <input
          type="checkbox"
          bind:checked={includeLlmKeys}
          class="rounded border-stone-300 dark:border-stone-600 text-stone-900 dark:text-stone-100 focus:ring-0"
        />
        <span class="flex items-center gap-1 font-medium">
          <Sparkles class="w-3.5 h-3.5 text-amber-500" />
          Include AI configuration & API keys
        </span>
      </label>

      <!-- Done Button -->
      <div>
        <button
          type="button"
          onclick={onClose}
          class="w-full py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer"
        >
          Done
        </button>
      </div>
    </div>
  </div>
{/if}
