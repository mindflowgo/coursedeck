// app/src/lib/syncState.svelte.ts
// Reactive sync store for CourseDeck iPad Lite using Svelte 5 runes.

import {
  getPendingPushPayload,
  hasCachedData,
  getLastSyncedAt,
  getDesktopUrl,
  importBundle,
  clearPendingPush,
  type SyncBundle
} from './storage/clientStore';
import { isServerReachable, isTauriDesktop, smartFetch } from './api';

export const syncState = $state({
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  serverReachable: false,
  lastSyncedAt: null as string | null,
  hasCachedData: false,
  pendingPushCount: 0,
  isSyncing: false,
  isPushing: false,
  syncError: null as string | null,
  pushError: null as string | null
});

export async function refreshPendingPushCount(): Promise<number> {
  if (typeof window === 'undefined') return 0;
  try {
    const payload = await getPendingPushPayload();
    const count = Object.values(payload).reduce((sum, arr) => sum + (arr?.length || 0), 0);
    syncState.pendingPushCount = count;
    return count;
  } catch {
    return 0;
  }
}

export async function initSyncState(): Promise<void> {
  if (typeof window === 'undefined' || isTauriDesktop()) return;

  syncState.isOnline = navigator.onLine;

  // Restore the desktop address if localStorage was evicted but IndexedDB
  // survived — getApiBaseUrl() reads synchronously from localStorage, so a
  // previously-paired iPad must never lose the address after a web-data purge.
  try {
    if (!localStorage.getItem('desktop_url')) {
      const stored = await getDesktopUrl();
      if (stored) localStorage.setItem('desktop_url', stored.replace(/\/+$/, ''));
    }
  } catch {}

  syncState.lastSyncedAt = (await getLastSyncedAt()) ?? null;
  syncState.hasCachedData = await hasCachedData();
  await refreshPendingPushCount();

  window.addEventListener('online', () => {
    syncState.isOnline = true;
    checkReachability();
  });

  window.addEventListener('offline', () => {
    syncState.isOnline = false;
    syncState.serverReachable = false;
  });

  await checkReachability();
}

export async function checkReachability(): Promise<boolean> {
  if (typeof window === 'undefined' || isTauriDesktop()) return true;
  const reachable = await isServerReachable(true);
  syncState.serverReachable = reachable;
  if (reachable) {
    await refreshPendingPushCount();
  }
  return reachable;
}

export async function syncFromDesktop(opts?: { includeLlmKeys?: boolean; customUrl?: string }): Promise<void> {
  syncState.isSyncing = true;
  syncState.syncError = null;

  try {
    if (opts?.customUrl && typeof localStorage !== 'undefined') {
      localStorage.setItem('desktop_url', opts.customUrl.replace(/\/+$/, ''));
    }

    const params = new URLSearchParams();
    if (opts?.includeLlmKeys) {
      params.set('includeLlmKeys', 'true');
    }

    const { getApiBaseUrl } = await import('./api');
    const baseUrl = opts?.customUrl ? opts.customUrl.replace(/\/+$/, '') : getApiBaseUrl();
    const endpoint = `${baseUrl}/api/sync/bundle?${params.toString()}`;

    let res: Response;
    try {
      res = await smartFetch(endpoint);
    } catch (netErr: any) {
      const detail = netErr instanceof Error ? netErr.message : String(netErr);
      throw new Error(`Could not connect to desktop app at ${baseUrl} (${detail}). Please make sure your computer is open on the same Wi-Fi.`);
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.message || `Server returned ${res.status} ${res.statusText}`);
    }

    const bundle: SyncBundle = await res.json();
    const desktopUrl = baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');

    await importBundle(bundle, desktopUrl);

    syncState.lastSyncedAt = bundle.generatedAt;
    syncState.hasCachedData = true;
    syncState.serverReachable = true;
    // On fresh sync, pending local writes are reset
    await clearPendingPush();
    syncState.pendingPushCount = 0;
  } catch (e) {
    console.error('[Sync Error]', e);
    syncState.syncError = e instanceof Error ? e.message : 'Sync failed';
    throw e;
  } finally {
    syncState.isSyncing = false;
  }
}

export async function pushToDesktop(): Promise<{ success: boolean; results?: Record<string, any> }> {
  syncState.isPushing = true;
  syncState.pushError = null;

  try {
    const checkpoints = await getPendingPushPayload();
    const count = Object.values(checkpoints).reduce((sum, arr) => sum + (arr?.length || 0), 0);

    if (count === 0) {
      syncState.pendingPushCount = 0;
      return { success: true };
    }

    const { getApiBaseUrl } = await import('./api');
    const baseUrl = getApiBaseUrl();
    const res = await smartFetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpoints })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `Push failed (${res.status})`);
    }

    const data = await res.json();
    await clearPendingPush();
    syncState.pendingPushCount = 0;
    syncState.serverReachable = true;
    return { success: true, results: data.results };
  } catch (e) {
    console.error('[Push Error]', e);
    syncState.pushError = e instanceof Error ? e.message : 'Push failed';
    throw e;
  } finally {
    syncState.isPushing = false;
  }
}
