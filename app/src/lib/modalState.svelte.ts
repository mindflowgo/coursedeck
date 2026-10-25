// app/src/lib/modalState.svelte.ts
// Global UI modal store to ensure dialogs render at root viewport level.

export const modalState = $state({
  isConnectIpadOpen: false,
  isScanDesktopOpen: false
});

export function openConnectIpadModal(): void {
  modalState.isConnectIpadOpen = true;
}

export function closeConnectIpadModal(): void {
  modalState.isConnectIpadOpen = false;
}

export function openScanDesktopModal(): void {
  modalState.isScanDesktopOpen = true;
}

export function closeScanDesktopModal(): void {
  modalState.isScanDesktopOpen = false;
}
