// app/src/lib/debugLog.svelte.ts
// DebugLog(): the app's single logging channel for subsystem diagnostics
// (sync, storage, …). Every call is appended to a persistent debug log file at
// the app data root (`Documents/debug.log` on iPad — visible in the Files app;
// `<data>/debug.log` on desktop). Console output only happens while the
// Debugger toggle in Settings is on, so production stays quiet by default.

export interface DebugLogOptions {
  /** Short subsystem tag, e.g. 'sync'. */
  tag?: string;
  level?: 'log' | 'warn' | 'error';
}

export const debugState = $state({
  enabled: false
});

const DEBUG_ENABLED_KEY = 'coursedeck_debug_enabled';
const DEBUG_CAP_MAX = 500;

/** In-memory mirror of the recent file lines, so the console inspector can
 * show DebugLog output even when the Debugger toggle was off at write time. */
export const debugLogBuffer = $state({
  lines: [] as string[]
});

function pushBuffer(line: string): void {
  debugLogBuffer.lines.push(line);
  if (debugLogBuffer.lines.length > DEBUG_CAP_MAX) {
    debugLogBuffer.lines.splice(0, debugLogBuffer.lines.length - DEBUG_CAP_MAX);
  }
}

export function initDebugger(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    debugState.enabled = localStorage.getItem(DEBUG_ENABLED_KEY) === 'true';
  } catch {}
}

export function setDebuggerEnabled(enabled: boolean): void {
  debugState.enabled = enabled;
  try {
    localStorage.setItem(DEBUG_ENABLED_KEY, String(enabled));
  } catch {}
  debugLog(enabled ? 'Debugger enabled' : 'Debugger disabled', { tag: 'debug' });
}

/** Persistent append — Tauri command on native, server endpoint in browsers
 * (writing into the paired desktop's data root). Never throws. */
async function appendToFile(line: string): Promise<void> {
  try {
    const { isTauri } = await import('./storage/clientStore');
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('debug_log_append', { message: line });
    } else {
      const { apiFetch } = await import('./api');
      await apiFetch('/api/debug-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: line })
      }).catch(() => {});
    }
  } catch {
    // Logging must never throw — drop the line if nothing accepts it.
  }
}

export function debugLog(message: string, opts?: DebugLogOptions): void {
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  const level = opts?.level ?? 'log';
  const tag = opts?.tag ? `[${opts.tag}] ` : '';
  const line = `${ts} ${tag}${message}`;

  pushBuffer(line);
  void appendToFile(line);

  if (debugState.enabled) {
    if (level === 'error') console.error(`[debug] ${line}`);
    else if (level === 'warn') console.warn(`[debug] ${line}`);
    else console.log(`[debug] ${line}`);
  }
}
