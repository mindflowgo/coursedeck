// app/src/lib/syncState.svelte.ts
// Reactive sync store for CourseDeck iPad Lite using Svelte 5 runes.

import { debugLog } from './debugLog.svelte';
import {
  getPendingPushPayload,
  getPendingPushAnnotations,
  getPendingPushDocuments,
  getPendingPushPrompts,
  getPendingPushAssets,
  readLockerDocBytes,
  hasCachedData,
  getLastSyncedAt,
  getDesktopUrl,
  clearPendingPush,
  clearPendingPushText,
  removePendingPushAsset,
  isTauri,
  listCachedCourses,
  saveLlmConfigLocally,
  setMeta,
  PUSH_QUEUED_EVENT,
  type SyncZipSummary
} from './storage/clientStore';
import { getApiBaseUrl, isServerReachable, isTauriDesktop, setCachedDesktopUrl, smartFetch } from './api';

export const syncState = $state({
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  serverReachable: false,
  lastSyncedAt: null as string | null,
  hasCachedData: false,
  pendingPushCount: 0,
  isSyncing: false,
  isPushing: false,
  syncError: null as string | null,
  pushError: null as string | null,
  // Subtle grey progress lines rendered by the sync UI while a sync runs.
  syncLog: [] as string[]
});

const SYNC_LOG_MAX = 10;

function appendSyncLog(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  debugLog(trimmed, { tag: 'sync' });
  const lines = syncState.syncLog;
  if (lines[lines.length - 1] === trimmed) return;
  lines.push(trimmed);
  if (lines.length > SYNC_LOG_MAX) {
    lines.splice(0, lines.length - SYNC_LOG_MAX);
  }
}

async function countPendingPush(): Promise<number> {
  const [checkpoints, annotations, documents, prompts, assets] = await Promise.all([
    getPendingPushPayload(),
    getPendingPushAnnotations(),
    getPendingPushDocuments(),
    getPendingPushPrompts(),
    getPendingPushAssets()
  ]);
  return (
    Object.values(checkpoints).reduce((sum, arr) => sum + (arr?.length || 0), 0) +
    Object.values(annotations).reduce((sum, arr) => sum + (arr?.length || 0), 0) +
    Object.values(documents).reduce((sum, arr) => sum + (arr?.length || 0), 0) +
    Object.values(assets).reduce((sum, arr) => sum + (arr?.length || 0), 0) +
    prompts.length
  );
}

export async function refreshPendingPushCount(): Promise<number> {
  if (typeof window === 'undefined') return 0;
  try {
    syncState.pendingPushCount = await countPendingPush();
    return syncState.pendingPushCount;
  } catch {
    return 0;
  }
}

// ── Background auto-push ──────────────────────────────────────────────────────
// Local writes land in the pending-push queues (see clientStore); a debounced
// flush pushes them to the desktop whenever it is reachable, so edits made on
// a synced device propagate without waiting for the manual "Push Changes" item.

const AUTO_PUSH_DEBOUNCE_MS = 3000;
let autoPushTimer: ReturnType<typeof setTimeout> | null = null;
let isAutoPushing = false;

function scheduleAutoPush(delayMs = AUTO_PUSH_DEBOUNCE_MS): void {
  if (typeof window === 'undefined' || isTauriDesktop()) return;
  if (autoPushTimer) clearTimeout(autoPushTimer);
  autoPushTimer = setTimeout(() => {
    autoPushTimer = null;
    void attemptAutoPush();
  }, delayMs);
}

async function attemptAutoPush(): Promise<void> {
  if (isAutoPushing || syncState.isPushing || syncState.isSyncing) return;
  if (!getApiBaseUrl()) return; // no desktop paired
  try {
    const pending = await countPendingPush();
    if (pending === 0) return;
    if (!(await isServerReachable())) return;
    isAutoPushing = true;
    await refreshPendingPushCount();
    await pushToDesktop();
  } catch {
    // Desktop unreachable or push rejected — queues stay intact and the next
    // write/reconnect reschedules a flush.
  } finally {
    isAutoPushing = false;
  }
}

export async function initSyncState(): Promise<void> {
  if (typeof window === 'undefined' || isTauriDesktop()) return;

  syncState.isOnline = navigator.onLine;

  // Restore the desktop address if localStorage was evicted but IndexedDB
  // survived — getApiBaseUrl() reads synchronously from localStorage, so a
  // previously-paired iPad must never lose the address after a web-data purge.
  try {
    const stored = await getDesktopUrl();
    if (stored) {
      setCachedDesktopUrl(stored);
    } else if (localStorage.getItem('desktop_url')) {
      setCachedDesktopUrl(localStorage.getItem('desktop_url') || '');
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

  // Local writes queue themselves; flush them to the desktop in the background.
  window.addEventListener(PUSH_QUEUED_EVENT, () => scheduleAutoPush());

  await checkReachability();
}

export async function checkReachability(): Promise<boolean> {
  if (typeof window === 'undefined' || isTauriDesktop()) return true;
  const reachable = await isServerReachable(true);
  const wasReachable = syncState.serverReachable;
  syncState.serverReachable = reachable;
  if (reachable) {
    await refreshPendingPushCount();
    if (!wasReachable && syncState.pendingPushCount > 0) {
      // Reconnected: flush anything that piled up while offline.
      scheduleAutoPush(0);
    }
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
  opts?: {
    includeLlmKeys?: boolean;
    customUrl?: string;
    since?: string | null;
    courseIds?: string[];
    /** Courses the device doesn't have yet — archived in full, ignoring `since`. */
    fullCourseIds?: string[];
    /** Skip the pre-sync push and drop pending local writes ("replace local data"). */
    discardPendingPush?: boolean;
    forceFullSync?: boolean;
  }
): Promise<void> {
  syncState.isSyncing = true;
  syncState.syncError = null;
  syncState.syncLog = [];

  // Rust emits `sync-progress` while the bundle downloads and extracts; feed
  // the grey log lines in the sync UI.
  let unlistenProgress: (() => void) | null = null;

  try {
    if (opts?.customUrl && typeof localStorage !== 'undefined') {
      localStorage.setItem('desktop_url', opts.customUrl.replace(/\/+$/, ''));
      setCachedDesktopUrl(opts.customUrl);
    }

    const params = new URLSearchParams();
    if (opts?.includeLlmKeys) {
      params.set('includeLlmKeys', 'true');
    }
    // Incremental sync cursor: only files modified on the desktop after this
    // ISO timestamp are sent. Defaults to lastSyncedAt unless forceFullSync is requested.
    const lastSynced = await getLastSyncedAt();
    const sinceCursor = opts?.since !== undefined ? opts.since : (opts?.forceFullSync ? null : lastSynced);

    // Courses this device has never received must bypass the cursor, or the
    // desktop skips them (no file newer than the cursor → course omitted) and
    // the sync is a silent no-op. Computed here so every sync entry point is
    // correct by construction; callers may still override with fullCourseIds
    // to force a full re-download of partially-synced courses.
    appendSyncLog('Checking which courses are on this device…');
    let fullCourseIds = opts?.fullCourseIds;
    if (fullCourseIds === undefined) {
      const cached = await listCachedCourses().catch(() => []);
      const onDevice = new Set(cached.map((c) => c.id.toLowerCase()));
      let candidates = opts?.courseIds;
      if (!candidates && sinceCursor) {
        const desktop = await fetchDesktopCourses(opts?.customUrl).catch(() => []);
        candidates = desktop.map((c) => c.id);
      }
      fullCourseIds = (candidates ?? []).filter((id) => !onDevice.has(id.toLowerCase()));
    }
    if (fullCourseIds.length > 0) {
      appendSyncLog(`${fullCourseIds.length} course(s) will download in full`);
    } else {
      appendSyncLog('All selected courses already on device — incremental only');
    }

    if (sinceCursor) {
      params.set('since', sinceCursor);
    }
    // Selective sync: only these course ids are bundled. Omitted = all.
    if (opts?.courseIds && opts.courseIds.length > 0) {
      params.set('courseIds', opts.courseIds.join(','));
    }
    if (fullCourseIds.length > 0) {
      params.set('fullCourses', fullCourseIds.join(','));
    }

    const { getApiBaseUrl } = await import('./api');
    const baseUrl = opts?.customUrl ? opts.customUrl.replace(/\/+$/, '') : getApiBaseUrl();
    const desktopUrl = baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');

    if (!isTauri()) {
      throw new Error('Sync runs inside the CourseDeck app.');
    }

    // Unpushed local writes would be clobbered by the incoming bundle (the
    // extract blindly overwrites everything but annotations) and then dropped
    // by clearPendingPush below — flush them to the desktop first, and abort
    // loudly (rather than clobber silently) when the flush fails.
    // discardPendingPush is the user's explicit "replace local data" choice.
    await refreshPendingPushCount();
    if (syncState.pendingPushCount > 0 && !opts?.discardPendingPush) {
      appendSyncLog(`Pushing ${syncState.pendingPushCount} local change(s) first…`);
      try {
        await pushToDesktop();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendSyncLog(`Push failed: ${msg}`);
        throw new Error(
          `Could not push ${syncState.pendingPushCount} local change(s) to the desktop (${msg}). ` +
            'Sync was cancelled so your local changes are not lost — try again, or choose to replace local data.'
        );
      }
    } else if (syncState.pendingPushCount > 0) {
      appendSyncLog(`Discarding ${syncState.pendingPushCount} local change(s) (replacing local data)`);
    }

    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlistenProgress = await listen<{ message?: string }>('sync-progress', (event) => {
        if (event.payload.message) appendSyncLog(event.payload.message);
      });
    } catch {}

    const { invoke } = await import('@tauri-apps/api/core');

    // The desktop packs the zip server-side (streaming NDJSON progress, which
    // the Rust command relays as `sync-progress` events we already log), then
    // Rust downloads the prepared archive. Everything stays on the native
    // transport — a webview XHR from the iOS custom-scheme origin can't pass
    // the desktop's CORS allowlist, which is why streamUpload isn't used here.
    const base = opts?.customUrl ? opts.customUrl.replace(/\/+$/, '') : baseUrl;
    const query = params.toString();
    appendSyncLog(`Requesting bundle from ${base || 'desktop'}…`);
    debugLog(`prepare URL: ${base}/api/sync/bundle/prepare?${query}`, { tag: 'sync' });
    const prepared = await invoke<{
      url: string;
      courseCount: number;
      fileCount: number;
      generatedAt: string;
    }>('sync_prepare_bundle', {
      url: `${base}/api/sync/bundle/prepare${query ? `?${query}` : ''}`
    });
    if (!prepared?.url) {
      throw new Error('Desktop did not return a prepared bundle');
    }
    appendSyncLog(`Bundle ready — ${prepared.courseCount} course(s), ${prepared.fileCount} file(s)`);
    const summary = await invoke<SyncZipSummary>('sync_fetch_prepared_zip', {
      url: `${base}${prepared.url}`
    });
    appendSyncLog(`Imported ${summary.courses.length} course(s)`);
    for (const c of summary.courses) {
      debugLog(`${c.course_id}: ${c.files} files, ${c.assets} assets`, { tag: 'sync' });
    }

    if (summary.llmConfig) {
      await saveLlmConfigLocally(summary.llmConfig);
    }
    await setMeta('last_synced_at', summary.generatedAt);
    await setMeta('desktop_url', desktopUrl);
    setCachedDesktopUrl(desktopUrl);
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
    debugLog(`Sync error: ${e instanceof Error ? e.message : String(e)}`, { tag: 'sync', level: 'error' });
    syncState.syncError = e instanceof Error ? e.message : 'Sync failed';
    appendSyncLog(`Failed: ${syncState.syncError}`);
    throw e;
  } finally {
    unlistenProgress?.();
    syncState.isSyncing = false;
  }
}

async function gzipJsonPayload(data: unknown): Promise<{ body: BodyInit; isGzip: boolean }> {
  const jsonStr = JSON.stringify(data);
  if (typeof CompressionStream !== 'undefined') {
    try {
      const raw = new TextEncoder().encode(jsonStr);
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(raw);
      writer.close();
      const chunks: Uint8Array[] = [];
      const reader = cs.readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return { body: out, isGzip: true };
    } catch (e) {
      debugLog(`CompressionStream failed, sending raw JSON: ${e instanceof Error ? e.message : String(e)}`, { tag: 'push', level: 'warn' });
    }
  }
  return { body: jsonStr, isGzip: false };
}

export async function pushToDesktop(): Promise<{ success: boolean; results?: Record<string, any> }> {
  syncState.isPushing = true;
  syncState.pushError = null;

  try {
    const [checkpoints, annotations, documents, prompts, assets] = await Promise.all([
      getPendingPushPayload(),
      getPendingPushAnnotations(),
      getPendingPushDocuments(),
      getPendingPushPrompts(),
      getPendingPushAssets()
    ]);
    const count = await countPendingPush();

    if (count === 0) {
      syncState.pendingPushCount = 0;
      return { success: true };
    }

    const baseUrl = getApiBaseUrl();
    const assetCount = Object.values(assets).reduce((sum, arr) => sum + (arr?.length || 0), 0);

    // 1. Text entities as one compressed JSON push: checkpoints, annotations, documents, prompts.
    let results: Record<string, any> | undefined;
    if (count - assetCount > 0) {
      const { body, isGzip } = await gzipJsonPayload({ checkpoints, annotations, documents, prompts });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isGzip) {
        headers['Content-Encoding'] = 'gzip';
      }
      const res = await smartFetch(`${baseUrl}/api/sync/push`, {
        method: 'POST',
        headers,
        body
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Push failed (${res.status})`);
      }
      results = ((await res.json()) as { results?: Record<string, any> }).results;

      // ATOMICITY: Clear text pending queue immediately upon confirmed server merge
      await clearPendingPushText();
      await refreshPendingPushCount();
    }

    // 2. Locker-doc binaries as raw multipart uploads with concurrency pool of 3
    const assetTasks: Array<{ courseId: string; entry: (typeof assets)[string][number] }> = [];
    for (const [courseId, entries] of Object.entries(assets)) {
      for (const entry of entries) {
        assetTasks.push({ courseId, entry });
      }
    }

    if (assetTasks.length > 0) {
      const CONCURRENCY = 3;
      let taskIdx = 0;
      const errors: Error[] = [];

      const worker = async () => {
        while (taskIdx < assetTasks.length) {
          const current = assetTasks[taskIdx++];
          if (!current) break;
          const { courseId, entry } = current;
          const routeBase = `${baseUrl}/api/courses/${encodeURIComponent(courseId)}/locker-docs`;

          try {
            if (entry.deleted) {
              const res = await smartFetch(`${routeBase}?file=${encodeURIComponent(entry.filename)}`, {
                method: 'DELETE'
              });
              if (!res.ok) {
                throw new Error(`Failed to push delete of ${courseId}/${entry.filename} (${res.status})`);
              }
            } else {
              let bytes: ArrayBuffer;
              try {
                bytes = await readLockerDocBytes(courseId, entry.filename);
              } catch (err) {
                // The local file is gone — nothing to push, drop the entry.
                debugLog(`Skipping ${courseId}/${entry.filename} — unreadable locally: ${err instanceof Error ? err.message : String(err)}`, { tag: 'push', level: 'warn' });
                await removePendingPushAsset(courseId, entry.filename);
                continue;
              }

              const formData = new FormData();
              formData.append('file', new File([bytes], entry.filename));
              formData.append('date', entry.date);
              const res = await smartFetch(routeBase, { method: 'POST', body: formData });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || `Failed to push ${courseId}/${entry.filename} (${res.status})`);
              }
            }

            // ATOMICITY: Remove each asset from pending queue as soon as it succeeds
            await removePendingPushAsset(courseId, entry.filename);
            await refreshPendingPushCount();
          } catch (err: any) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
      };

      await Promise.all(
        new Array(Math.min(CONCURRENCY, assetTasks.length)).fill(null).map(() => worker())
      );

      if (errors.length > 0) {
        throw errors[0];
      }
    }

    await clearPendingPush();
    syncState.pendingPushCount = 0;
    syncState.serverReachable = true;
    return { success: true, results };
  } catch (e) {
    debugLog(`Push error: ${e instanceof Error ? e.message : String(e)}`, { tag: 'push', level: 'error' });
    syncState.pushError = e instanceof Error ? e.message : 'Push failed';
    throw e;
  } finally {
    syncState.isPushing = false;
  }
}
