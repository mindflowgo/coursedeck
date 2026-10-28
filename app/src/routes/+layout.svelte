<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { theme } from '$lib/theme.svelte';
  import { zoom } from '$lib/zoom.svelte';
  import ZoomIndicator from '$lib/components/ZoomIndicator.svelte';
  import InitialSyncModal from '$lib/components/InitialSyncModal.svelte';
  import ConnectIpadModal from '$lib/components/ConnectIpadModal.svelte';
  import ScanDesktopModal from '$lib/components/ScanDesktopModal.svelte';
  import {
    modalState,
    closeConnectIpadModal,
    closeScanDesktopModal,
    closeInitialSyncModal
  } from '$lib/modalState.svelte';
  import { initNavHistory } from '$lib/navHistory';
  import { isTauriDesktop } from '$lib/api';
  import { initSyncState } from '$lib/syncState.svelte';
  import { initWebviewGestures } from '$lib/webviewGestures';

  onMount(() => {
    // Skip app initialization and modal prompts when rendered inside an iframe
    if (typeof window !== 'undefined' && window.self !== window.top) {
      return;
    }

    const cleanupGestures = initWebviewGestures();

    theme.init();
    zoom.init();
    initNavHistory();

    // The InitialSyncModal ("Scan QR-code on your desktop") must NEVER open on
    // its own — it is only shown when the user explicitly presses the tablet
    // (Connect iPad) icon on a non-desktop client.
    if (!isTauriDesktop()) {
      void initSyncState();
    }

    return () => {
      cleanupGestures();
    };
  });

  let { children } = $props();
</script>

{#if modalState.isInitialSyncOpen}
  <InitialSyncModal
    onDone={() => {
      closeInitialSyncModal();
      // Reload or trigger route re-evaluation after initial sync
      window.location.reload();
    }}
    onSkip={() => {
      closeInitialSyncModal();
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
