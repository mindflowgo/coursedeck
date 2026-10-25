<!-- app/src/lib/components/SyncStatusPill.svelte -->
<script lang="ts">
  import { syncState, syncFromDesktop, pushToDesktop } from '$lib/syncState.svelte';
  import { isTauriDesktop } from '$lib/api';
  import { confirmDialog } from '$lib/dialog';
  import { ArrowDownToLine, ArrowUpToLine, RefreshCw, Check } from 'lucide-svelte';

  const isClient = !isTauriDesktop();
  let syncSuccessFlash = $state(false);
  let pushSuccessFlash = $state(false);

  async function handleManualSync() {
    if (syncState.isSyncing) return;
    if (syncState.pendingPushCount > 0) {
      const proceed = await confirmDialog(
        `You have ${syncState.pendingPushCount} note or checkpoint change(s) that haven't been pushed to your computer yet.\n\nSyncing now will replace local data with the computer's current copy. Would you like to push your changes first?`,
        'Sync Warning'
      );
      if (proceed) {
        try {
          await pushToDesktop();
        } catch {
          return;
        }
      }
    }

    try {
      await syncFromDesktop();
      syncSuccessFlash = true;
      setTimeout(() => (syncSuccessFlash = false), 2500);
    } catch (e) {
      console.error('Manual sync failed:', e);
    }
  }

  async function handleManualPush() {
    if (syncState.isPushing) return;
    try {
      await pushToDesktop();
      pushSuccessFlash = true;
      setTimeout(() => (pushSuccessFlash = false), 2500);
    } catch (e) {
      console.error('Manual push failed:', e);
    }
  }
</script>

{#if isClient}
  <div class="flex items-center space-x-1.5 text-xs font-medium">
    <!-- Status Indicator -->
    <div
      class="flex items-center space-x-1.5 px-2.5 py-1 rounded-full border transition-colors {syncState.serverReachable
        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400'
        : 'bg-stone-100 dark:bg-stone-800 border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400'}"
      title={syncState.serverReachable ? 'Connected to desktop computer' : 'Offline Mode (using local cache)'}
    >
      <span
        class="w-1.5 h-1.5 rounded-full {syncState.serverReachable ? 'bg-emerald-500 animate-pulse' : 'bg-stone-400'}"
      ></span>
      <span class="text-[11px] hidden md:inline">
        {syncState.serverReachable ? 'Connected' : 'Offline'}
      </span>
    </div>

    <!-- Re-sync button (when desktop is reachable) -->
    {#if syncState.serverReachable}
      <button
        type="button"
        onclick={handleManualSync}
        disabled={syncState.isSyncing}
        title="Sync latest courses from your computer"
        class="flex items-center space-x-1 px-2 py-1 rounded-lg border border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-300 text-[11px] transition cursor-pointer disabled:opacity-50"
      >
        {#if syncState.isSyncing}
          <RefreshCw class="w-3 h-3 animate-spin text-stone-500" />
          <span class="hidden sm:inline">Syncing...</span>
        {:else if syncSuccessFlash}
          <Check class="w-3 h-3 text-emerald-500" />
          <span class="hidden sm:inline text-emerald-600 dark:text-emerald-400">Synced!</span>
        {:else}
          <ArrowDownToLine class="w-3 h-3 text-stone-400" />
          <span class="hidden sm:inline">Sync</span>
        {/if}
      </button>

      <!-- Push changes button (when pending writes exist) -->
      {#if syncState.pendingPushCount > 0}
        <button
          type="button"
          onclick={handleManualPush}
          disabled={syncState.isPushing}
          title="Push {syncState.pendingPushCount} local note/checkpoint change(s) to your computer"
          class="flex items-center space-x-1 px-2 py-1 rounded-lg border border-amber-400/60 dark:border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 text-[11px] font-semibold transition cursor-pointer disabled:opacity-50"
        >
          {#if syncState.isPushing}
            <RefreshCw class="w-3 h-3 animate-spin text-amber-600" />
            <span>Pushing...</span>
          {:else if pushSuccessFlash}
            <Check class="w-3 h-3 text-emerald-500" />
            <span>Pushed!</span>
          {:else}
            <ArrowUpToLine class="w-3 h-3 text-amber-500" />
            <span>Push ({syncState.pendingPushCount})</span>
          {/if}
        </button>
      {/if}
    {:else}
      {#if syncState.pendingPushCount > 0}
        <!-- Offline pending indicator -->
        <div
          class="flex items-center space-x-1 px-2 py-1 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[11px] border border-amber-500/20"
          title="{syncState.pendingPushCount} change(s) saved locally. They will be pushed when you reconnect to your computer."
        >
          <span>{syncState.pendingPushCount} pending push</span>
        </div>
      {/if}
    {/if}
  </div>
{/if}
