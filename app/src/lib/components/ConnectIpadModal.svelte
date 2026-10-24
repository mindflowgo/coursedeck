<!-- app/src/lib/components/ConnectIpadModal.svelte -->
<script lang="ts">
  import { apiFetch } from '$lib/api';
  import { generate } from 'lean-qr';
  import { Tablet, X, Copy, Check, Sparkles, QrCode } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
  }

  let { isOpen, onClose }: Props = $props();

  let pairingInfo = $state<{
    port: number;
    lanIps: string[];
    hostname: string;
    primaryIp: string;
    primaryUrl: string;
    bonjourUrl: string;
  } | null>(null);

  let isLoading = $state(false);
  let copied = $state(false);
  let activeUrlType = $state<'ip' | 'bonjour'>('ip');
  let selectedIpIndex = $state(0);

  $effect(() => {
    if (isOpen) {
      isLoading = true;
      copied = false;
      selectedIpIndex = 0;
      apiFetch('/api/pairing/info')
        .then((r) => r.json())
        .then((data) => {
          pairingInfo = data;
          if (data.lanIps && data.lanIps.length > 0) {
            activeUrlType = 'ip';
          } else {
            activeUrlType = 'bonjour';
          }
        })
        .catch((e) => {
          console.error('Failed to load pairing info:', e);
        })
        .finally(() => {
          isLoading = false;
        });
    }
  });

  let activeTargetUrl = $derived.by(() => {
    if (!pairingInfo) return '';
    if (activeUrlType === 'ip' && pairingInfo.lanIps && pairingInfo.lanIps.length > 0) {
      const ip = pairingInfo.lanIps[selectedIpIndex] || pairingInfo.lanIps[0];
      return `http://${ip}:${pairingInfo.port}`;
    }
    if (pairingInfo.bonjourUrl) {
      return pairingInfo.bonjourUrl;
    }
    return pairingInfo.primaryUrl || '';
  });

  let qrDataUrl = $derived.by(() => {
    if (!activeTargetUrl) return '';
    try {
      const code = generate(activeTargetUrl);
      return code.toDataURL({ scale: 6, pad: 2 });
    } catch (e) {
      console.error('[QR Code Generation Error]', e);
      return '';
    }
  });

  function copyToClipboard() {
    if (!activeTargetUrl) return;
    navigator.clipboard.writeText(activeTargetUrl).then(() => {
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    });
  }
</script>

{#if isOpen}
  <!-- Centered fixed backdrop covering entire viewport -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-xs p-4 overflow-y-auto"
    role="presentation"
    onclick={onClose}
  >
    <div
      class="relative my-auto bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-6 sm:p-7 max-w-sm w-full shadow-2xl space-y-4 animate-in fade-in duration-200 text-stone-900 dark:text-stone-100"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={() => {}}
    >
      <!-- Modal Header -->
      <div class="flex items-center justify-between pb-1 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2.5">
          <div class="w-8 h-8 rounded-xl bg-amber-400/10 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <Tablet class="w-4 h-4" />
          </div>
          <div>
            <h2 class="text-sm font-semibold">Connect an iPad</h2>
            <p class="text-[11px] text-stone-500 dark:text-stone-400">Scan QR code on your local Wi-Fi</p>
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

      {#if isLoading}
        <div class="py-12 flex flex-col items-center justify-center space-y-2 text-xs text-stone-400">
          <div class="w-6 h-6 border-2 border-stone-300 dark:border-stone-700 border-t-stone-900 dark:border-t-stone-100 rounded-full animate-spin"></div>
          <span>Detecting network IP...</span>
        </div>
      {:else if pairingInfo}
        <div class="space-y-4">
          <!-- QR Code Container (Always crisp white background for high camera contrast) -->
          <div class="flex flex-col items-center justify-center p-4 bg-white rounded-2xl border border-stone-200 shadow-inner">
            {#if qrDataUrl}
              <img
                src={qrDataUrl}
                alt="QR Code to connect iPad"
                class="w-48 h-48 image-rendering-pixelated rounded-lg"
              />
            {:else}
              <div class="w-48 h-48 flex items-center justify-center text-xs text-stone-400">
                Generating QR code...
              </div>
            {/if}
            <span class="text-[11px] text-stone-500 font-medium mt-2 flex items-center gap-1">
              <QrCode class="w-3.5 h-3.5" />
              Scan with iPad Camera
            </span>
          </div>

          <!-- IP Address Box -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400 px-1">
              <span>Local Network Address</span>
              {#if pairingInfo.bonjourUrl && pairingInfo.lanIps.length > 0}
                <div class="flex items-center space-x-1 text-[10px]">
                  <button
                    type="button"
                    class="px-1.5 py-0.5 rounded transition cursor-pointer {activeUrlType === 'ip' ? 'bg-stone-200 dark:bg-stone-700 font-semibold text-stone-900 dark:text-stone-100' : 'text-stone-400 hover:text-stone-600'}"
                    onclick={() => (activeUrlType = 'ip')}
                  >
                    IP
                  </button>
                  <span>|</span>
                  <button
                    type="button"
                    class="px-1.5 py-0.5 rounded transition cursor-pointer {activeUrlType === 'bonjour' ? 'bg-stone-200 dark:bg-stone-700 font-semibold text-stone-900 dark:text-stone-100' : 'text-stone-400 hover:text-stone-600'}"
                    onclick={() => (activeUrlType = 'bonjour')}
                  >
                    Bonjour
                  </button>
                </div>
              {/if}
            </div>

            {#if activeUrlType === 'ip' && pairingInfo.lanIps.length > 1}
              <div class="flex items-center gap-1.5 overflow-x-auto py-0.5 px-0.5">
                {#each pairingInfo.lanIps as ip, idx}
                  <button
                    type="button"
                    onclick={() => (selectedIpIndex = idx)}
                    class="px-2 py-0.5 rounded text-[10px] font-mono transition cursor-pointer {selectedIpIndex === idx ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-semibold' : 'bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700'}"
                  >
                    {ip}
                  </button>
                {/each}
              </div>
            {/if}

            <div class="flex items-center space-x-2 p-2 rounded-xl bg-stone-100 dark:bg-stone-800/80 border border-stone-200 dark:border-stone-700">
              <span class="font-mono text-xs font-semibold px-2 py-0.5 truncate flex-1 select-all">
                {activeTargetUrl}
              </span>
              <button
                type="button"
                onclick={copyToClipboard}
                title="Copy address"
                class="px-2.5 py-1.5 rounded-lg bg-white dark:bg-stone-700 border border-stone-200 dark:border-stone-600 text-stone-700 dark:text-stone-200 text-xs font-medium hover:bg-stone-50 dark:hover:bg-stone-600 transition flex items-center space-x-1 shrink-0 cursor-pointer"
              >
                {#if copied}
                  <Check class="w-3.5 h-3.5 text-emerald-500" />
                  <span class="text-[11px] text-emerald-600 dark:text-emerald-400">Copied</span>
                {:else}
                  <Copy class="w-3.5 h-3.5" />
                  <span class="text-[11px]">Copy</span>
                {/if}
              </button>
            </div>
          </div>

          <!-- Quick Help / PWA Tip -->
          <div class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-300 text-[11px] space-y-1">
            <div class="font-semibold flex items-center gap-1.5">
              <Sparkles class="w-3.5 h-3.5" />
              <span>Install to iPad Home Screen:</span>
            </div>
            <p class="leading-relaxed opacity-90">
              In iPad Safari, tap <strong>Share</strong> (box with arrow) &rarr; <strong>Add to Home Screen</strong> to use CourseDeck offline in full screen.
            </p>
          </div>
        </div>
      {:else}
        <div class="py-6 text-center text-xs text-stone-500">
          Could not find local network addresses. Please check your Wi-Fi connection.
        </div>
      {/if}

      <div class="pt-1">
        <button
          type="button"
          onclick={onClose}
          class="w-full py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold transition cursor-pointer"
        >
          Done
        </button>
      </div>
    </div>
  </div>
{/if}
