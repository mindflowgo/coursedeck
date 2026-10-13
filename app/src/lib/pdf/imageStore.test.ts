import { describe, expect, test } from 'bun:test';
import { decodeQuotedPrintable, looksQuotedPrintable, rasterDimensions } from './imageStore';

/**
 * The raster size drives both export time and PDF size: before this rule,
 * every asset — including 24pt inline icons — was rasterized at its natural
 * resolution.
 */
describe('rasterDimensions', () => {
  test('rasterizes an inline icon at its 24pt display size, supersampled 2x', () => {
    // 24pt / 0.75 pt-per-px = 32px, x2 supersample = 64px (source is 150px)
    expect(rasterDimensions(24, 24, 150, 150)).toEqual({ width: 64, height: 64 });
  });

  test('rasterizes a full-width block figure proportionally', () => {
    const { width, height } = rasterDimensions(515.28, 360, 2000, 2000);
    expect(width).toBe(1374); // 515.28 / 0.75 * 2
    expect(height).toBe(960); // 360 / 0.75 * 2
  });

  test('never upscales past the per-side cap', () => {
    const { width, height } = rasterDimensions(10000, 8000, 20000, 16000);
    expect(width).toBe(4096);
    expect(height).toBeLessThanOrEqual(4096);
    // Aspect ratio preserved through the clamp.
    expect(width / height).toBeCloseTo(10000 / 8000, 2);
  });

  test('degenerate sizes stay at least one pixel', () => {
    const { width, height } = rasterDimensions(0, 0, 10, 10);
    expect(width).toBeGreaterThanOrEqual(1);
    expect(height).toBeGreaterThanOrEqual(1);
  });

  test('never exceeds the source resolution, so an embed can only shrink', () => {
    // A 40px source shown at 24pt (32px display): capped at the source, not 2x.
    expect(rasterDimensions(24, 24, 40, 40)).toEqual({ width: 40, height: 40 });
    // A source smaller than its display size is used as-is (no invention).
    // 500x300 px source == 375x225 pt at 0.75 pt/px.
    expect(rasterDimensions(375, 225, 500, 300)).toEqual({ width: 500, height: 300 });
    // Between 1x and 2x display, the source resolution wins.
    expect(rasterDimensions(100, 100, 200, 200)).toEqual({ width: 200, height: 200 });
  });

  test('the result never exceeds the natural size in either axis', () => {
    const cases: [number, number, number, number][] = [
      [24, 24, 150, 150],
      [375, 225, 500, 300],
      [515.28, 360, 2000, 2000],
      [515.28, 309.3, 500, 300],
      [50, 100, 90, 180]
    ];
    for (const [dw, dh, nw, nh] of cases) {
      const r = rasterDimensions(dw, dh, nw, nh);
      expect(r.width).toBeLessThanOrEqual(nw);
      expect(r.height).toBeLessThanOrEqual(nh);
      expect(r.width).toBeGreaterThanOrEqual(1);
      expect(r.height).toBeGreaterThanOrEqual(1);
    }
  });
});

/**
 * A handful of bundled SVGs are quoted-printable encoded on disk but served
 * as `image/svg+xml`, which the browser rejects outright — so those figures
 * were silently missing from exports.
 */
describe('quoted-printable SVG repair', () => {
  // Verbatim head of data/courses/baf3m/assets/icons/baf3m_02.06.02.svg
  const corrupt =
    '<svg id=3D"Layer_1" data-name=3D"Layer 1" xmlns=3D"http://www.w3.org/200s=\r\nvg" viewBox=3D"0 0 477.69 64.5">';

  test('detects a quoted-printable document', () => {
    expect(looksQuotedPrintable(corrupt)).toBe(true);
  });

  test('leaves a valid SVG alone', () => {
    const valid = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';
    expect(looksQuotedPrintable(valid)).toBe(false);
    expect(decodeQuotedPrintable(valid)).toBe(valid);
  });

  test('restores the encoded document', () => {
    const fixed = decodeQuotedPrintable(corrupt);
    // Attribute quoting is restored and no escape/soft-break sequences remain.
    expect(fixed).toContain('id="Layer_1"');
    expect(fixed).toContain('viewBox="0 0 477.69 64.5"');
    expect(fixed).not.toContain('=3D');
    expect(fixed).not.toMatch(/=\r?\n/);
  });
});
