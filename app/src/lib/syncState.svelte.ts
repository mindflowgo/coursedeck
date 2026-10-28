// app/src/lib/syncState.svelte.ts
// Reactive sync store for CourseDeck iPad Lite using Svelte 5 runes.

import {
  getPendingPushPayload,
  getPendingPushAnnotations,
  hasCachedData,
  getLastSyncedAt,
  getDesktopUrl,
  clearPendingPush,
  isTauri,
  saveLlmConfigLocally,
  setMeta,
  type SyncZipSummary
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
    const annotations = await getPendingPushAnnotations();
    const count =
      Object.values(payload).reduce((sum, arr) => sum + (arr?.length || 0), 0) +
      Object.values(annotations).reduce((sum, arr) => sum + (arr?.length || 0), 0);
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

export interface DesktopCourseSummary {
  id: string;
  title: string;
  lessonCount: number;
  coursePDF: boolean;
}

/** Course list from the desktop for the selective-sync picker. */
export async function fetchDesktopCourses(customUrl?: string): Promise<DesktopCourseSummary[]> {
  const { getApiBaseUrl } = await import('./api');
  const baseUrl = customUrl ? customUrl.replace(/\/+$/, '') : getApiBaseUrl();
  const res = await smartFetch(`${baseUrl}/api/sync/courses`);
  if (!res.ok) {
    throw new Error(`Desktop returned ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { courses?: DesktopCourseSummary[] };
  return data.courses ?? [];
}

export async function syncFromDesktop(
  opts?: { includeLlmKeys?: boolean; customUrl?: string; since?: string; courseIds?: string[] }
): Promise<void> {
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
    // Incremental sync cursor: only files modified on the desktop after this
    // ISO timestamp are sent. Omitted = full sync. getLastSyncedAt() is the
    // natural cursor once selective sync UI exists.
    if (opts?.since) {
      params.set('since', opts.since);
    }
    // Selective sync: only these course ids are bundled. Omitted = all.
    if (opts?.courseIds && opts.courseIds.length > 0) {
      params.set('courseIds', opts.courseIds.join(','));
    }

    const { getApiBaseUrl } = await import('./api');
    const baseUrl = opts?.customUrl ? opts.customUrl.replace(/\/+$/, '') : getApiBaseUrl();
    const desktopUrl = baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');

    if (!isTauri()) {
      throw new Error('Sync runs inside the CourseDeck app.');
    }

    // One zip archive downloaded and extracted natively in Rust — no JSON
    // bundle, no base64 assets, nothing large passing through the webview.
    const { invoke } = await import('@tauri-apps/api/core');
    const summary = await invoke<SyncZipSummary>('sync_fetch_bundle_zip', {
      url: `${baseUrl}/api/sync/bundle?${params.toString()}`
    });

    if (summary.llmConfig) {
      await saveLlmConfigLocally(summary.llmConfig);
    }
    await setMeta('last_synced_at', summary.generatedAt);
    await setMeta('desktop_url', desktopUrl);
    try {
      if (typeof localStorage !== 'undefined' && desktopUrl) {
        localStorage.setItem('desktop_url', desktopUrl.replace(/\/+$/, ''));
      }
    } catch {}

    syncState.lastSyncedAt = summary.generatedAt;
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
    const annotations = await getPendingPushAnnotations();
    const count =
      Object.values(checkpoints).reduce((sum, arr) => sum + (arr?.length || 0), 0) +
      Object.values(annotations).reduce((sum, arr) => sum + (arr?.length || 0), 0);

    if (count === 0) {
      syncState.pendingPushCount = 0;
      return { success: true };
    }

    const { getApiBaseUrl } = await import('./api');
    const baseUrl = getApiBaseUrl();
    const res = await smartFetch(`${baseUrl}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpoints, annotations })
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
