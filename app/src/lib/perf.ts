/**
 * Performance instrumentation for diagnosing slow views.
 *
 * Deliberately dependency-free and cheap: stage timers are `performance.now()`
 * deltas, and the observers only report entries that cross their thresholds.
 * Every record is printed to the console AND appended to a ring buffer on
 * `window.__ilcPerf`, so a run can be inspected afterwards without replaying
 * it (`copy(window.__ilcPerf)` in DevTools).
 *
 * Set `localStorage.app_perf = 'verbose'` to also print per-stage breakdowns
 * for trivial renders; the default prints one line per render regardless,
 * because repeated re-renders of the expensive markdown pipeline are exactly
 * what we are looking for.
 */

export interface PerfStage {
  name: string;
  ms: number;
}

export interface PerfRecord {
  /** Milliseconds since page load, so records order against navigation timing. */
  at: number;
  kind: string;
  detail: Record<string, unknown>;
}

const PAGE_START =
  typeof performance !== 'undefined' ? performance.now() : 0;

const MAX_RECORDS = 500;
const records: PerfRecord[] = [];

declare global {
  interface Window {
    __ilcPerf?: PerfRecord[];
  }
}

/** Records a perf event: console line plus ring-buffer entry. */
export function perf(kind: string, detail: Record<string, unknown>, message?: string): void {
  const record: PerfRecord = {
    at: +(performance.now() - PAGE_START).toFixed(1),
    kind,
    detail
  };
  records.push(record);
  if (records.length > MAX_RECORDS) records.shift();
  if (typeof window !== 'undefined') window.__ilcPerf = records;
  console.log(message ?? `[PERF][${kind}] ${formatDetail(detail)}`, detail);
}

/** Times a synchronous stage, appending to `stages` when one is supplied. */
export function timeStage<T>(stages: PerfStage[] | null, name: string, fn: () => T): T {
  const t0 = performance.now();
  const result = fn();
  if (stages) stages.push({ name, ms: +(performance.now() - t0).toFixed(1) });
  return result;
}

export function stagesSummary(stages: PerfStage[]): string {
  return stages.map((s) => `${s.name}=${s.ms}ms`).join(' ');
}

export function stagesTotal(stages: PerfStage[]): number {
  return +stages.reduce((sum, s) => sum + s.ms, 0).toFixed(1);
}

function formatDetail(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
}

/** Cheap content signature so repeated renders of identical input are visible as such. */
export function contentSignature(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 97) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** Runs `cb` after the browser has painted the current DOM update. */
export function afterPaint(cb: () => void): void {
  if (typeof requestAnimationFrame === 'undefined') {
    cb();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => cb()));
}

let observersInstalled = false;

/**
 * Starts the observers that explain *where* a slow view spends its time:
 * blocking tasks, layout shifts (the fingerprint of images or late content
 * invalidating a large layout), and asset traffic.
 */
export function installPerfObservers(): void {
  if (observersInstalled || typeof window === 'undefined') return;
  observersInstalled = true;

  // Uncaught errors and rejections are captured into the ring buffer because a
  // view that fails to render and a view that renders nothing look identical
  // from the outside, and the console that would tell them apart is gone by
  // the time anyone inspects the page.
  window.addEventListener('error', (event) => {
    perf(
      'js-error',
      { message: event.message, source: event.filename, line: event.lineno, col: event.colno },
      `[PERF][js-error] ${event.message} (${event.filename}:${event.lineno})`
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    perf(
      'js-rejection',
      { reason: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason) },
      `[PERF][js-rejection] ${reason instanceof Error ? reason.message : String(reason)}`
    );
  });

  // Mirror console.error/warn into the buffer so errors swallowed by a
  // catch block still leave a trace.
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        records.push({
          at: +(performance.now() - PAGE_START).toFixed(1),
          kind: `console-${level}`,
          detail: { args: args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))) }
        });
        if (records.length > MAX_RECORDS) records.shift();
        window.__ilcPerf = records;
      } catch {}
      original(...args);
    };
  }

  const Observer = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (!Observer) return;

  // Keep more than the default 250 resource entries so asset traffic from a
  // full course render is not silently truncated.
  try {
    performance.setResourceTimingBufferSize?.(2000);
  } catch {}

  observe(Observer, ['longtask'], (entry) => {
    const duration = (entry as PerformanceEntry & { duration: number }).duration;
    if (duration < 50) return;
    const attribution = (entry as PerformanceEntry & { attribution?: unknown[] }).attribution;
    perf(
      'longtask',
      { ms: +duration.toFixed(1), attribution: attribution && attribution.length ? attribution : 'unknown' },
      `[PERF][longtask] main thread blocked ${duration.toFixed(0)}ms`
    );
  });

  observe(Observer, ['layout-shift'], (entry) => {
    const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: unknown[] };
    if (shift.hadRecentInput || shift.value < 0.001) return;
    perf(
      'layout-shift',
      { score: +shift.value.toFixed(4), sources: shift.sources?.length ?? 0 },
      `[PERF][layout-shift] score ${shift.value.toFixed(4)} (${shift.sources?.length ?? 0} sources)`
    );
  });

  const assetStats = { count: 0, bytes: 0, ms: 0, slowest: [] as Array<{ name: string; ms: number; bytes: number }> };
  observe(Observer, ['resource'], (entry) => {
    const resource = entry as PerformanceResourceTiming;
    if (!resource.name.includes('/assets/')) return;
    assetStats.count += 1;
    assetStats.bytes += resource.encodedBodySize || resource.transferSize || 0;
    assetStats.ms += resource.duration;
    assetStats.slowest.push({
      name: resource.name.split('/').pop() ?? resource.name,
      ms: +resource.duration.toFixed(0),
      bytes: resource.encodedBodySize || 0
    });
    assetStats.slowest.sort((a, b) => b.ms - a.ms);
    assetStats.slowest.length = Math.min(assetStats.slowest.length, 5);
    if (assetStats.count % 25 === 0) {
      perf('assets', {
        loaded: assetStats.count,
        totalMB: +(assetStats.bytes / 1_048_576).toFixed(1),
        totalMs: +assetStats.ms.toFixed(0),
        slowest: assetStats.slowest
      });
    }
  });
}

/** Snapshot of everything loaded from `/assets/` so far — the image-loading budget. */
export function assetReport(): Record<string, unknown> {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const assets = entries.filter((e) => e.name.includes('/assets/'));
  const bytes = assets.reduce((sum, e) => sum + (e.encodedBodySize || e.transferSize || 0), 0);
  return {
    requests: assets.length,
    totalMB: +(bytes / 1_048_576).toFixed(1),
    transferMs: +assets.reduce((sum, e) => sum + e.duration, 0).toFixed(0),
    slowestMs: +Math.max(0, ...assets.map((e) => e.duration)).toFixed(0)
  };
}

function observe(
  Observer: typeof PerformanceObserver,
  entryTypes: string[],
  handler: (entry: PerformanceEntry) => void
): void {
  try {
    const observer = new Observer((list) => {
      for (const entry of list.getEntries()) handler(entry);
    });
    observer.observe({ entryTypes });
  } catch {
    // Unsupported entry type in this browser/webview — skip it silently.
  }
}
