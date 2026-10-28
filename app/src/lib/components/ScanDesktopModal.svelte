<!-- app/src/lib/components/ScanDesktopModal.svelte -->
<script lang="ts">
  import {
    syncFromDesktop,
    fetchDesktopCourses,
    type DesktopCourseSummary
  } from '$lib/syncState.svelte';
  import { listCachedCourses } from '$lib/storage/clientStore';
  import { isTauriMobile } from '$lib/api';
  import {
    Monitor,
    X,
    CheckCircle2,
    AlertCircle,
    Loader2,
    Sparkles,
    QrCode,
    Camera,
    Download,
    BookOpen,
    FileText,
    Check,
    RotateCcw
  } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
  }

  let { isOpen, onClose }: Props = $props();

  let progress = $state<'scan' | 'loading' | 'select' | 'syncing' | 'done' | 'error'>('scan');
  let errorMessage = $state('');
  let isScanning = $state(false);
  let showManual = $state(false);
  let manualUrl = $state('');
  let manualError = $state('');

  let targetUrl = $state('');
  let keysOpt = $state(true);
  let courses = $state<DesktopCourseSummary[] | null>(null);
  let selected = $state<Record<string, boolean>>({});
  let onDevice = $state<Set<string>>(new Set());
  let syncedCourseCount = $state(0);

  const selectedIds = $derived(Object.entries(selected).filter(([, v]) => v).map(([id]) => id));
  const allSelected = $derived(
    courses !== null && courses.length > 0 && selectedIds.length === courses.length
  );

  // Only the native mobile app has the barcode scanner plugin; browsers sync
  // same-origin instead.
  const nativeScan = isTauriMobile();

  function resetState() {
    progress = 'scan';
    errorMessage = '';
    isScanning = false;
    manualError = '';
    courses = null;
    selected = {};
    syncedCourseCount = 0;
  }

  function toggleCourse(id: string) {
    selected[id] = !selected[id];
  }

  function toggleAll() {
    if (!courses) return;
    const shouldSelect = !allSelected;
    const next: Record<string, boolean> = {};
    for (const c of courses) {
      next[c.id] = shouldSelect;
    }
    selected = next;
  }

  async function loadCoursesForUrl(url: string) {
    progress = 'loading';
    errorMessage = '';
    targetUrl = url;

    try {
      const [list, cached] = await Promise.all([
        fetchDesktopCourses(url),
        listCachedCourses()
      ]);
      courses = list;
      onDevice = new Set(cached.map((c) => c.id.toLowerCase()));
      const next: Record<string, boolean> = {};
      for (const course of list) {
        next[course.id] = true;
      }
      selected = next;
      progress = 'select';
    } catch (e: any) {
      console.warn('[ScanDesktopModal] Failed to load courses from', url, e);
      errorMessage = e instanceof Error ? e.message : 'Could not reach the desktop app';
      progress = 'error';
    }
  }

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
    let cleanUrl = scannedUrl.trim();
    keysOpt = true;

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

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('desktop_url', cleanUrl);
      }
    } catch {}

    await loadCoursesForUrl(cleanUrl);
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

  async function startSyncSelected() {
    if (selectedIds.length === 0) return;
    progress = 'syncing';
    errorMessage = '';

    try {
      await syncFromDesktop({
        includeLlmKeys: keysOpt,
        customUrl: targetUrl,
        courseIds: selectedIds
      });
      syncedCourseCount = selectedIds.length;
      progress = 'done';
    } catch (e: any) {
      console.error('[Sync Error]', e);
      errorMessage = e instanceof Error ? e.message : 'Failed to download selected courses';
      progress = 'error';
    }
  }

  function retry() {
    if (targetUrl) {
      loadCoursesForUrl(targetUrl);
    } else if (nativeScan) {
      startScan();
    } else {
      startDownload();
    }
  }

  function handleClose() {
    resetState();
    onClose();
  }

  $effect(() => {
    if (isOpen && progress === 'scan' && !isScanning) {
      const savedUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('desktop_url') : '';
      if (savedUrl) {
        loadCoursesForUrl(savedUrl);
      } else if (nativeScan) {
        startScan();
      }
    }
  });
</script>

{#if isOpen}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 overflow-y-auto"
    role="presentation"
    onclick={handleClose}
  >
    <div
      class="my-auto bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-3xl p-5 sm:p-6 max-w-sm w-full shadow-2xl flex flex-col max-h-[85vh] animate-in fade-in duration-200 text-stone-900 dark:text-stone-100"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={() => {}}
    >
      <!-- Header -->
      <div class="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-stone-800 shrink-0">
        <div class="flex items-center space-x-2.5">
          <div class="w-8 h-8 rounded-xl bg-amber-400/10 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <Monitor class="w-4 h-4" />
          </div>
          <div>
            <h2 class="text-sm font-semibold">
              {#if progress === 'select'}
                Choose Courses
              {:else if progress === 'done'}
                Sync Complete
              {:else}
                Sync with Desktop
              {/if}
            </h2>
            <p class="text-[11px] text-stone-500 dark:text-stone-400 truncate max-w-[200px]">
              {#if progress === 'select'}
                Select which courses to download
              {:else if targetUrl}
                {targetUrl.replace(/^https?:\/\//, '')}
              {:else}
                Re-download Courses
              {/if}
            </p>
          </div>
        </div>

        <button
          type="button"
          onclick={handleClose}
          aria-label="Close"
          class="p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- State: Scan -->
      {#if progress === 'scan'}
        {#if nativeScan}
          <div class="py-6 flex flex-col items-center justify-center space-y-4 text-center">
            <div class="w-16 h-16 rounded-2xl bg-amber-400/10 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <Camera class="w-8 h-8" />
            </div>

            <div class="space-y-1">
              <p class="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Scan your desktop app QR-code
              </p>
              <p class="text-xs text-stone-500 dark:text-stone-400 max-w-xs leading-relaxed">
                Click the iPad icon on your Mac's top bar to show the code, then tap below to open the camera.
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
          </div>
        {:else}
          <div class="py-6 flex flex-col items-center justify-center space-y-4 text-center">
            <div class="w-16 h-16 rounded-2xl bg-amber-400/10 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <Download class="w-8 h-8" />
            </div>

            <div class="space-y-1">
              <p class="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Connect to desktop
              </p>
              <p class="text-xs text-stone-500 dark:text-stone-400 max-w-xs leading-relaxed">
                Download latest course material and notes from the desktop app you're connected to.
              </p>
            </div>

            <button
              type="button"
              onclick={startDownload}
              class="w-full py-3 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center space-x-2"
            >
              <Download class="w-4 h-4" />
              <span>Choose Courses to Download</span>
            </button>
          </div>
        {/if}

      <!-- State: Loading Desktop Courses -->
      {:else if progress === 'loading'}
        <div class="py-12 flex flex-col items-center justify-center space-y-4">
          <Loader2 class="w-8 h-8 animate-spin text-stone-900 dark:text-stone-100" />
          <div class="text-center space-y-1">
            <p class="text-xs font-semibold text-stone-900 dark:text-stone-100">Contacting desktop app...</p>
            <p class="text-[11px] text-stone-500 dark:text-stone-400">Fetching available courses list</p>
          </div>
        </div>

      <!-- State: Course Selector Choice -->
      {:else if progress === 'select'}
        <div class="flex-1 flex flex-col min-h-0 pt-2 space-y-2">
          <!-- Selection bar -->
          <div class="flex items-center justify-between px-1 text-xs text-stone-500 dark:text-stone-400">
            <span>{selectedIds.length} of {courses?.length || 0} selected</span>
            <button
              type="button"
              onclick={toggleAll}
              class="font-medium text-amber-600 dark:text-amber-400 hover:underline cursor-pointer"
            >
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
          </div>

          <!-- Courses list -->
          <div class="flex-1 overflow-y-auto space-y-1 pr-0.5 max-h-64 border border-stone-100 dark:border-stone-800/80 rounded-2xl p-1 bg-stone-50/50 dark:bg-stone-950/30">
            {#if courses && courses.length > 0}
              {#each courses as course (course.id)}
                <button
                  type="button"
                  onclick={() => toggleCourse(course.id)}
                  class="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-left hover:bg-white dark:hover:bg-stone-800 transition cursor-pointer"
                >
                  <span
                    class="w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition
                      {selected[course.id]
                        ? 'bg-stone-900 dark:bg-stone-100 border-stone-900 dark:border-stone-100'
                        : 'border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800'}"
                  >
                    {#if selected[course.id]}
                      <Check class="w-3.5 h-3.5 text-white dark:text-stone-900 stroke-[3]" />
                    {/if}
                  </span>

                  <span class="flex-1 min-w-0">
                    <span class="block text-xs font-semibold text-stone-900 dark:text-stone-100 truncate">
                      {course.title}
                    </span>
                    <span class="flex items-center gap-2 text-[10px] text-stone-500 dark:text-stone-400 mt-0.5">
                      <span class="inline-flex items-center gap-1">
                        <BookOpen class="w-3 h-3" />
                        {course.lessonCount} lesson{course.lessonCount === 1 ? '' : 's'}
                      </span>
                      {#if course.coursePDF}
                        <span class="inline-flex items-center gap-1 text-stone-600 dark:text-stone-300">
                          <FileText class="w-3 h-3" /> Textbook
                        </span>
                      {/if}
                      {#if onDevice.has(course.id.toLowerCase())}
                        <span class="text-emerald-600 dark:text-emerald-400 font-medium">On device</span>
                      {/if}
                    </span>
                  </span>
                </button>
              {/each}
            {:else}
              <div class="py-8 text-center text-xs text-stone-400">
                No courses found on your desktop.
              </div>
            {/if}
          </div>

          <!-- Bottom Action Buttons -->
          <div class="pt-2 space-y-2 shrink-0">
            <button
              type="button"
              onclick={startSyncSelected}
              disabled={selectedIds.length === 0}
              class="w-full py-3 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center space-x-2 disabled:opacity-40"
            >
              <Download class="w-4 h-4" />
              <span>Download {selectedIds.length} Selected Course{selectedIds.length === 1 ? '' : 's'}</span>
            </button>

            <button
              type="button"
              onclick={() => {
                progress = 'scan';
                targetUrl = '';
                if (nativeScan) startScan();
              }}
              class="w-full py-1 text-[11px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition cursor-pointer text-center"
            >
              Switch desktop / Scan new QR code
            </button>
          </div>
        </div>

      <!-- State: Syncing (Native ZIP Download & Extraction) -->
      {:else if progress === 'syncing'}
        <div class="py-8 flex flex-col items-center justify-center space-y-4">
          <div class="relative">
            <Loader2 class="w-10 h-10 animate-spin text-stone-900 dark:text-stone-100" />
            <Sparkles class="w-4 h-4 text-amber-500 absolute -top-1 -right-1 animate-pulse" />
          </div>
          <div class="text-center space-y-1">
            <p class="text-xs font-semibold text-stone-900 dark:text-stone-100">
              Downloading course bundle archive...
            </p>
            <p class="text-[11px] text-stone-500 dark:text-stone-400">
              Streaming ZIP archive & extracting offline files natively
            </p>
          </div>
        </div>

      <!-- State: Done -->
      {:else if progress === 'done'}
        <div class="py-4 space-y-4 text-center">
          <div class="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCircle2 class="w-6 h-6" />
          </div>
          <div class="space-y-1">
            <p class="text-sm font-semibold text-stone-900 dark:text-stone-100">Sync Complete!</p>
            <p class="text-xs text-stone-500 dark:text-stone-400 max-w-xs mx-auto">
              Successfully downloaded {syncedCourseCount} course{syncedCourseCount === 1 ? '' : 's'} and updated your offline library.
            </p>
          </div>
          <button
            type="button"
            onclick={() => {
              handleClose();
              if (typeof window !== 'undefined') {
                window.location.reload();
              }
            }}
            class="w-full py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer"
          >
            Open Library
          </button>
        </div>

      <!-- State: Error -->
      {:else if progress === 'error'}
        <div class="py-4 space-y-4">
          <div class="flex items-start space-x-3 text-red-600 dark:text-red-400 text-xs bg-red-50 dark:bg-red-950/40 p-3.5 rounded-xl border border-red-200 dark:border-red-900/40">
            <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
            <span class="break-words">{errorMessage}</span>
          </div>
          <div class="flex items-center space-x-3">
            <button
              type="button"
              onclick={() => {
                progress = 'scan';
                if (nativeScan) startScan();
              }}
              class="flex-1 py-2 rounded-xl border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
            >
              Scan QR Code
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

      <!-- Bottom manual fallback option when in scan mode -->
      {#if nativeScan && (progress === 'scan' || progress === 'error')}
        <div class="pt-1 space-y-2 shrink-0">
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
{/if}
