<!-- app/src/lib/components/DeviceSyncDropdown.svelte -->
<script lang="ts">
  import { syncState, pushToDesktop } from '$lib/syncState.svelte';
  import CourseSyncPickerModal from './CourseSyncPickerModal.svelte';
  import { openScanDesktopModal } from '$lib/modalState.svelte';
  import {
    Monitor,
    QrCode,
    RefreshCw,
    ArrowUpToLine,
    Check
  } from 'lucide-svelte';

  let isOpen = $state(false);
  let showCoursePicker = $state(false);
  let pushSuccessFlash = $state(false);

  function handleSync() {
    if (syncState.isSyncing) return;
    isOpen = false;
    showCoursePicker = true;
  }

  async function handlePush() {
    if (syncState.isPushing) return;
    try {
      await pushToDesktop();
      pushSuccessFlash = true;
      setTimeout(() => (pushSuccessFlash = false), 2500);
      isOpen = false;
    } catch (e) {
      console.error('Push failed:', e);
    }
  }

  function handleScanDesktop() {
    isOpen = false;
    openScanDesktopModal();
  }
</script>

<div class="relative shrink-0">
  <!-- Desktop icon trigger button: 40px on mobile -->
  <button
    type="button"
    onclick={() => (isOpen = !isOpen)}
    aria-label="Desktop Sync Options"
    title="Desktop Sync Options"
    aria-expanded={isOpen}
    class="w-10 h-10 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center transition cursor-pointer shrink-0 relative {isOpen ? 'bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100' : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100'}"
  >
    {#if syncState.isSyncing}
      <RefreshCw class="w-5 h-5 sm:w-4 sm:h-4 animate-spin text-amber-500 shrink-0" />
    {:else}
      <Monitor class="w-5 h-5 sm:w-4 sm:h-4 shrink-0" />
    {/if}

    <!-- Subtle pending push indicator dot -->
    {#if syncState.pendingPushCount > 0}
      <span
        class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-stone-900"
        title="{syncState.pendingPushCount} pending note/checkpoint change(s)"
      ></span>
    {/if}
  </button>

  {#if isOpen}
    <!-- Backdrop to close on click outside -->
    <div
      class="fixed inset-0 z-40"
      onclick={() => (isOpen = false)}
      aria-hidden="true"
    ></div>

    <!-- Dropdown Menu -->
    <div
      class="absolute right-0 top-full mt-1.5 w-60 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 p-1 text-xs divide-y divide-stone-100 dark:divide-stone-800 animate-in fade-in zoom-in-95 duration-100 select-none"
    >
      <div class="py-1">
        <!-- 'Sync' Option: opens the course picker -->
        <button
          type="button"
          onclick={handleSync}
          disabled={syncState.isSyncing}
          class="flex w-full items-center space-x-2.5 px-3 py-2 rounded-lg text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-left disabled:opacity-50"
        >
          {#if syncState.isSyncing}
            <RefreshCw class="w-4 h-4 animate-spin text-amber-500 shrink-0" />
            <div class="flex flex-col">
              <span class="font-medium text-stone-900 dark:text-stone-100">Syncing...</span>
              <span class="text-[10px] text-stone-400">Updating course library</span>
            </div>
          {:else}
            <Monitor class="w-4 h-4 text-stone-500 dark:text-stone-400 shrink-0" />
            <div class="flex flex-col">
              <span class="font-medium text-stone-900 dark:text-stone-100">Sync</span>
              <span class="text-[10px] text-stone-400">Choose courses to download</span>
            </div>
          {/if}
        </button>

        <!-- Push Changes (when pending local changes exist) -->
        {#if syncState.pendingPushCount > 0}
          <button
            type="button"
            onclick={handlePush}
            disabled={syncState.isPushing}
            class="flex w-full items-center space-x-2.5 px-3 py-2 rounded-lg text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 transition cursor-pointer text-left disabled:opacity-50 mt-0.5"
          >
            {#if syncState.isPushing}
              <RefreshCw class="w-4 h-4 animate-spin text-amber-600 shrink-0" />
              <div class="flex flex-col">
                <span class="font-medium">Pushing...</span>
                <span class="text-[10px] text-amber-600/70">Uploading {syncState.pendingPushCount} change(s)</span>
              </div>
            {:else if pushSuccessFlash}
              <Check class="w-4 h-4 text-emerald-500 shrink-0" />
              <div class="flex flex-col">
                <span class="font-medium text-emerald-600">Pushed!</span>
                <span class="text-[10px] text-stone-400">Changes saved to computer</span>
              </div>
            {:else}
              <ArrowUpToLine class="w-4 h-4 text-amber-500 shrink-0" />
              <div class="flex flex-col">
                <span class="font-medium">Push Changes ({syncState.pendingPushCount})</span>
                <span class="text-[10px] text-amber-600/70">Send notes to computer</span>
              </div>
            {/if}
          </button>
        {/if}
      </div>

      <div class="py-1">
        <!-- Scan QR Connect App Option -->
        <button
          type="button"
          onclick={handleScanDesktop}
          class="flex w-full items-center space-x-2.5 px-3 py-2 rounded-lg text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-left"
        >
          <QrCode class="w-4 h-4 text-stone-500 dark:text-stone-400 shrink-0" />
          <div class="flex flex-col">
            <span class="font-medium text-stone-900 dark:text-stone-100">Scan QR Connect App</span>
            <span class="text-[10px] text-stone-400">
              Scan desktop app QR-code
            </span>
          </div>
        </button>
      </div>
    </div>
  {/if}

  {#if showCoursePicker}
    <CourseSyncPickerModal onClose={() => (showCoursePicker = false)} />
  {/if}
</div>
