import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as any).window = {};
(globalThis as any).navigator = {
  userAgent: '',
  platform: '',
  maxTouchPoints: 0
};

(globalThis as any).$state = (v: any) => v;
(globalThis as any).$derived = (v: any) => v;

await mock.module('$app/environment', () => ({
  browser: true
}));

await mock.module('$lib/api', () => ({
  apiFetch: async () => ({ ok: true, json: async () => ({}) })
}));

export const invokedCommands: { cmd: string; args?: any }[] = [];

await mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: any) => {
    invokedCommands.push({ cmd, args });
  },
  addPluginListener: async () => () => {}
}));

const {
  isIPad,
  mapPencilKitWidth,
  mapAppWidthToPencilKit,
  registerPencilKitExcludedRegion,
  unregisterPencilKitExcludedRegion,
  refreshPencilKitExcludedRects,
  clearPencilKitExcludedRects
} = await import('./pencilKit');

describe('isIPad detection', () => {
  beforeEach(() => {
    (globalThis as any).window = {};
    (globalThis as any).navigator = {
      userAgent: '',
      platform: '',
      maxTouchPoints: 0
    };
  });

  it('detects iPadOS via MacIntel with touch points > 1', () => {
    (globalThis as any).navigator = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5
    };
    expect(isIPad()).toBe(true);
  });

  it('detects legacy iPad via userAgent', () => {
    (globalThis as any).navigator = {
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
      platform: 'iPad',
      maxTouchPoints: 2
    };
    expect(isIPad()).toBe(true);
  });

  it('returns false for macOS desktop (MacIntel but maxTouchPoints 0)', () => {
    (globalThis as any).navigator = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 0
    };
    expect(isIPad()).toBe(false);
  });

  it('returns false for iPhone', () => {
    (globalThis as any).navigator = {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5
    };
    expect(isIPad()).toBe(false);
  });

  it('returns false for Windows PC', () => {
    (globalThis as any).navigator = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      platform: 'Win32',
      maxTouchPoints: 0
    };
    expect(isIPad()).toBe(false);
  });

  it('respects window.__isIPad override', () => {
    (globalThis as any).window.__isIPad = true;
    expect(isIPad()).toBe(true);
    (globalThis as any).window.__isIPad = false;
    expect(isIPad()).toBe(false);
  });
});

describe('PencilKit width mapping', () => {
  it('maps PencilKit pen widths to half-thickness author dimensions (~0.4x)', () => {
    expect(mapPencilKitWidth('marker', 3.5)).toBe(1.4);
    expect(mapPencilKitWidth('marker', 2.0)).toBe(0.8);
    expect(mapPencilKitWidth('marker', 6.0)).toBe(2.4);
  });

  it('maps PencilKit marker/highlighter widths to half of previous (~0.5x)', () => {
    expect(mapPencilKitWidth('highlighter', 24.0)).toBe(12.0);
    expect(mapPencilKitWidth('highlighter', 16.0)).toBe(8.0);
    expect(mapPencilKitWidth('highlighter', 36.0)).toBe(18.0);
  });

  it('round-trips between app widths and native PencilKit widths', () => {
    const penPencilWidth = mapAppWidthToPencilKit('marker', 1.4);
    expect(mapPencilKitWidth('marker', penPencilWidth)).toBe(1.4);

    const hlPencilWidth = mapAppWidthToPencilKit('highlighter', 12.0);
    expect(mapPencilKitWidth('highlighter', hlPencilWidth)).toBe(12.0);
  });
});

describe('Dynamic PencilKit exclusion rects', () => {
  const originalDocument = (globalThis as any).document;
  const originalWindow = (globalThis as any).window;

  beforeEach(() => {
    invokedCommands.length = 0;
    (globalThis as any).window = {
      innerWidth: 1024,
      innerHeight: 768,
      __isIPad: true,
      __pencilKitReady: true
    };
    (globalThis as any).document = {
      documentElement: { style: {} },
      querySelectorAll: () => []
    };
    (globalThis as any).requestAnimationFrame = (cb: () => void) => {
      cb();
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};
    clearPencilKitExcludedRects();
    invokedCommands.length = 0;
  });

  afterEach(() => {
    (globalThis as any).document = originalDocument;
    (globalThis as any).window = originalWindow;
  });

  it('aggregates programmatic exclusion regions and dispatches IPC', async () => {
    const unreg = registerPencilKitExcludedRegion('test-popover', [
      { x: 100, y: 50, width: 200, height: 150 }
    ]);

    await refreshPencilKitExcludedRects(80);

    const last = invokedCommands.filter((c) => c.cmd === 'plugin:pencilkit|set_excluded_rects').pop();
    expect(last).toBeDefined();
    expect(last?.args.rects).toEqual([{ x: 100, y: 50, width: 200, height: 150 }]);
    expect(last?.args.topHeight).toBe(80);

    unreg();
    await refreshPencilKitExcludedRects(80);
    const afterUnreg = invokedCommands[invokedCommands.length - 1];
    expect(afterUnreg?.args.rects).toEqual([]);
  });

  it('filters out non-positive and completely off-screen rects', async () => {
    registerPencilKitExcludedRegion('offscreen-tests', () => [
      { x: -500, y: 50, width: 100, height: 100 }, // totally to the left
      { x: 2000, y: 50, width: 100, height: 100 }, // totally to the right
      { x: 50, y: 50, width: 0, height: 100 },    // zero width
      { x: 50, y: 50, width: 80, height: 80 }     // valid in viewport
    ]);

    await refreshPencilKitExcludedRects();

    const last = invokedCommands.filter((c) => c.cmd === 'plugin:pencilkit|set_excluded_rects').pop();
    expect(last?.args.rects).toEqual([{ x: 50, y: 50, width: 80, height: 80 }]);
  });

  it('scans DOM elements matching exclusion attributes and combines with providers', async () => {
    const mockEl = {
      offsetParent: {},
      offsetWidth: 120,
      offsetHeight: 40,
      getBoundingClientRect: () => ({
        left: 250,
        top: 300,
        right: 370,
        bottom: 340,
        width: 120,
        height: 40
      })
    };

    (globalThis as any).HTMLElement = class {};
    Object.setPrototypeOf(mockEl, (globalThis as any).HTMLElement.prototype);

    (globalThis as any).document.querySelectorAll = () => [mockEl];

    registerPencilKitExcludedRegion('custom-button', [
      { x: 10, y: 20, width: 50, height: 30 }
    ]);

    await refreshPencilKitExcludedRects();

    const last = invokedCommands.filter((c) => c.cmd === 'plugin:pencilkit|set_excluded_rects').pop();
    expect(last?.args.rects).toEqual([
      { x: 10, y: 20, width: 50, height: 30 },
      { x: 250, y: 300, width: 120, height: 40 }
    ]);
  });

  it('clears all exclusions cleanly when requested', () => {
    registerPencilKitExcludedRegion('temp', [{ x: 1, y: 1, width: 10, height: 10 }]);
    clearPencilKitExcludedRects();
    const last = invokedCommands[invokedCommands.length - 1];
    expect(last?.cmd).toBe('plugin:pencilkit|set_excluded_rects');
    expect(last?.args.rects).toEqual([]);
  });
});
