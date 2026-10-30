import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as any).window = {};
(globalThis as any).navigator = {
  userAgent: '',
  platform: '',
  maxTouchPoints: 0
};

await mock.module('$app/environment', () => ({
  browser: true
}));

await mock.module('@tauri-apps/api/core', () => ({
  invoke: async () => {},
  addPluginListener: async () => () => {}
}));

await mock.module('./annotationStore.svelte', () => ({
  exitMarkupMode: () => {},
  markupUi: { mode: false, pencilOnly: false }
}));

const { isIPad, mapPencilKitWidth, mapAppWidthToPencilKit } = await import('./pencilKit');

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
