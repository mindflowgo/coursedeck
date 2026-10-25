<!-- app/src/lib/components/InitialSyncModal.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { syncFromDesktop } from '$lib/syncState.svelte';
  import { isTauriMobile } from '$lib/api';
  import { CheckCircle2, AlertCircle, Loader2, Sparkles, QrCode, Camera, Download } from 'lucide-svelte';

  let { onDone, onSkip }: { onDone: () => void; onSkip?: () => void } = $props();

  function handleSkip() {
    if (onSkip) {
      onSkip();
    } else {
      onDone();
    }
  }

  let progress = $state<'scan' | 'syncing' | 'done' | 'error'>('scan');
  let errorMessage = $state('');
  let isScanning = $state(false);
  let showManual = $state(false);
  let manualUrl = $state('');
  let manualError = $state('');

  // Only the native iPad app has the barcode scanner plugin; browsers pair
  // same-origin and get a plain download button instead of a failing import.
  const nativeScan = isTauriMobile();

  async function startScan() {
    isScanning = true;
    errorMessage = '';

    try {
      const { scan, Format, checkPermissions, requestPermissions } = await import('@tauri-apps/plugin-barcode-scanner');
      let perm = await checkPermissions();
      if (perm !== 'granted') {
        perm = await requestPermissions();
      }

      if (perm !== 'granted') {
        throw new Error('Camera permission denied. Please allow camera access in Settings.');
      }

      const res = await scan({
        cameraDirection: 'back',
        formats: [Format.QRCode]
      });

      if (res?.content) {
        await handleScannedUrl(res.content);
      }
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('cancelled') || msg.includes('canceled')) {
        isScanning = false;
        return;
      }
      console.error('[Native Barcode Scan Error]', e);
      errorMessage = msg || 'Failed to scan QR code.';
      progress = 'error';
    } finally {
      isScanning = false;
    }
  }

  async function handleScannedUrl(scannedUrl: string) {
    progress = 'syncing';
    errorMessage = '';

    try {
      let cleanUrl = scannedUrl.trim();
      let keysOpt = true;

      try {
        if (!/^https?:\/\//i.test(cleanUrl)) {
          cleanUrl = `http://${cleanUrl}`;
        }
        const u = new URL(cleanUrl);
        if (u.searchParams.has('includeLlmKeys')) {
          keysOpt = u.searchParams.get('includeLlmKeys') === 'true';
        }
        cleanUrl = `${u.protocol}//${u.host}`;
      } catch {}

      await syncFromDesktop({ includeLlmKeys: keysOpt, customUrl: cleanUrl });
      progress = 'done';
    } catch (e: any) {
      console.error('[Initial Sync Error]', e);
      errorMessage = e instanceof Error ? e.message : 'Failed to download courses from desktop';
      progress = 'error';
    }
  }

  async function connectManual() {
    let url = manualUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    try {
      const u = new URL(url);
      if (!u.hostname) throw new Error('missing host');
    } catch {
      manualError = 'Enter a valid desktop address, e.g. http://192.168.1.50:3182';
      return;
    }
    manualError = '';
    await handleScannedUrl(url);
  }

  // Browser (LAN Safari) path: sync from the origin the page was loaded from.
  async function startDownload() {
    await handleScannedUrl(window.location.origin);
  }

  function retry() {
    if (nativeScan) startScan();
    else startDownload();
  }

  onMount(() => {
    if (nativeScan) startScan();
  });
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 overflow-y-auto">
  <div class="my-auto bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-3xl p-6 sm:p-7 max-w-sm w-full shadow-2xl space-y-4 animate-in fade-in duration-200 text-stone-900 dark:text-stone-100">
    <!-- Header -->
    <div class="flex items-center space-x-3 pb-2 border-b border-stone-100 dark:border-stone-800">
      <div class="w-9 h-9 rounded-xl bg-amber-400/10 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
        <QrCode class="w-5 h-5" />
      </div>
      <div>
        <h2 class="text-sm font-semibold">Welcome to CourseDeck</h2>
        <p class="text-[11px] text-stone-500 dark:text-stone-400">Scan QR-code on your desktop to download</p>
      </div>
    </div>

    {#if progress === 'scan'}
      {#if nativeScan}
        <div class="py-6 flex flex-col items-center justify-center space-y-4 text-center">
          <div class="w-16 h-16 rounded-2xl bg-amber-400/10 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center">
            <Camera class="w-8 h-8" />
          </div>

          <div class="space-y-1">
            <p class="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Scan Desktop QR-Code
            </p>
            <p class="text-xs text-stone-500 dark:text-stone-400 max-w-xs leading-relaxed">
              Click the iPad icon on your Mac to show the QR code, then tap below to scan with your iPad camera.
            </p>
          </div>

          <button
            type="button"
            onclick={startScan}
            disabled={isScanning}
            class="w-full py-3 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center space-x-2"
          >
            <QrCode class="w-4 h-4" />
            <span>{isScanning ? 'Scanner Active...' : 'Open Camera to Scan'}</span>
          </button>

          <button
            type="button"
            onclick={handleSkip}
            class="text-xs text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition cursor-pointer"
          >
            Skip for now (browse offline)
          </button>
        </div>
      {:else}
        <div class="py-6 flex flex-col items-center justify-center space-y-4 text-center">
          <div class="w-16 h-16 rounded-2xl bg-amber-400/10 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center">
            <Download class="w-8 h-8" />
          </div>

          <div class="space-y-1">
            <p class="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Download Courses for Offline Use
            </p>
            <p class="text-xs text-stone-500 dark:text-stone-400 max-w-xs leading-relaxed">
              Your desktop app is reachable on this network. Download all courses to this device so you can study offline.
            </p>
          </div>

          <button
            type="button"
            onclick={startDownload}
            class="w-full py-3 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center space-x-2"
          >
            <Download class="w-4 h-4" />
            <span>Download for Offline Use</span>
          </button>
        </div>
      {/if}

    {:else if progress === 'syncing'}
      <div class="py-8 flex flex-col items-center justify-center space-y-4">
        <div class="relative">
          <Loader2 class="w-10 h-10 animate-spin text-stone-900 dark:text-stone-100" />
          <Sparkles class="w-4 h-4 text-amber-500 absolute -top-1 -right-1 animate-pulse" />
        </div>
        <div class="text-center space-y-1">
          <p class="text-xs font-semibold text-stone-900 dark:text-stone-100">Downloading courses from your desktop...</p>
          <p class="text-[11px] text-stone-500 dark:text-stone-400">Packaging manifests, lessons, and formulas into offline storage</p>
        </div>
      </div>

    {:else if progress === 'done'}
      <div class="py-4 space-y-4 text-center">
        <div class="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto">
          <CheckCircle2 class="w-6 h-6" />
        </div>
        <div class="space-y-1">
          <p class="text-sm font-semibold text-stone-900 dark:text-stone-100">Ready for Offline Study!</p>
          <p class="text-xs text-stone-500 dark:text-stone-400 max-w-xs mx-auto">
            All your courses and lesson notes are downloaded and stored locally on this iPad.
          </p>
        </div>
        <button
          type="button"
          onclick={onDone}
          class="w-full py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer"
        >
          Start Studying
        </button>
      </div>

    {:else if progress === 'error'}
      <div class="py-4 space-y-4">
        <div class="flex items-start space-x-3 text-red-600 dark:text-red-400 text-xs bg-red-50 dark:bg-red-950/40 p-3.5 rounded-xl border border-red-200 dark:border-red-900/40">
          <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
          <span class="break-words">{errorMessage}</span>
        </div>
        <div class="flex items-center space-x-3">
          <button
            type="button"
            onclick={handleSkip}
            class="flex-1 py-2 rounded-xl border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Skip for Now
          </button>
          <button
            type="button"
            onclick={retry}
            class="flex-1 py-2 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold transition cursor-pointer"
          >
            Try Again
          </button>
        </div>
      </div>
    {/if}

    {#if nativeScan && (progress === 'scan' || progress === 'error')}
      <div class="pt-1 space-y-2">
        {#if showManual}
          <div class="flex items-center gap-2 text-[10px] uppercase tracking-wide text-stone-400 dark:text-stone-600">
            <span class="flex-1 border-t border-stone-100 dark:border-stone-800"></span>
            or connect by address
            <span class="flex-1 border-t border-stone-100 dark:border-stone-800"></span>
          </div>
          <input
            type="url"
            bind:value={manualUrl}
            placeholder="http://192.168.1.50:3182"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            enterkeyhint="go"
            onkeydown={(e) => {
              if (e.key === 'Enter') connectManual();
            }}
            class="w-full px-3 py-2 rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800/60 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition"
          />
          {#if manualError}
            <p class="text-[11px] text-red-600 dark:text-red-400">{manualError}</p>
          {/if}
          <button
            type="button"
            onclick={connectManual}
            class="w-full py-2.5 rounded-xl border border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 text-xs font-semibold text-stone-700 dark:text-stone-300 transition cursor-pointer"
          >
            Connect
          </button>
        {:else}
          <button
            type="button"
            onclick={() => (showManual = true)}
            class="w-full text-[11px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 underline underline-offset-2 transition cursor-pointer"
          >
            Scan not working? Enter the desktop address manually
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
