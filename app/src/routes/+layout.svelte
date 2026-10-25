<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { theme } from '$lib/theme.svelte';
  import { zoom } from '$lib/zoom.svelte';
  import ZoomIndicator from '$lib/components/ZoomIndicator.svelte';
  import InitialSyncModal from '$lib/components/InitialSyncModal.svelte';
  import ConnectIpadModal from '$lib/components/ConnectIpadModal.svelte';
  import ScanDesktopModal from '$lib/components/ScanDesktopModal.svelte';
  import { modalState, closeConnectIpadModal, closeScanDesktopModal } from '$lib/modalState.svelte';
  import { initNavHistory } from '$lib/navHistory';
  import { isTauriDesktop } from '$lib/api';
  import { initSyncState, syncState } from '$lib/syncState.svelte';
  import { hasCachedData } from '$lib/storage/clientStore';

  let showInitialSync = $state(false);
  let syncCompleted = $state(false);

  onMount(async () => {
    theme.init();
    zoom.init();
    initNavHistory();

    if (!isTauriDesktop()) {
      await initSyncState();
      try {
        const hasData = await hasCachedData();
        const dismissed = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('initial_sync_dismissed') === 'true';
        if (!hasData && !dismissed) {
          showInitialSync = true;
        }
      } catch (e) {
        console.warn('Failed to check cached data:', e);
      }
    }
  });

  let { children } = $props();
</script>

{#if showInitialSync && !syncCompleted}
  <InitialSyncModal
    onDone={() => {
      showInitialSync = false;
      syncCompleted = true;
      // Reload or trigger route re-evaluation after initial sync
      window.location.reload();
    }}
    onSkip={() => {
      showInitialSync = false;
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('initial_sync_dismissed', 'true');
      }
    }}
  />
{/if}

<ConnectIpadModal
  isOpen={modalState.isConnectIpadOpen}
  onClose={closeConnectIpadModal}
/>

<ScanDesktopModal
  isOpen={modalState.isScanDesktopOpen}
  onClose={closeScanDesktopModal}
/>

<div class="h-full flex flex-col bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 font-sans transition-colors duration-150 w-full max-w-full min-w-0 overflow-x-hidden">
  {@render children()}
  <ZoomIndicator />
</div>
