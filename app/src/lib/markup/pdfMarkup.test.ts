import { describe, expect, it } from 'bun:test';
import {
  computePdfRenderScale,
  denormalizePdfPoint,
  getPdfPageFileKey,
  indexStrokesByFile,
  normalizePdfPoint,
  parsePdfPageFileKey
} from './pdfMarkup';

describe('getPdfPageFileKey', () => {
  it('formats standard URLs into baseDoc:p{N} format', () => {
    expect(getPdfPageFileKey('/api/courses/mcr3u/assets/locker_docs/course.pdf', 0)).toBe(
      'course.pdf:p1'
    );
    expect(getPdfPageFileKey('/api/courses/mcr3u/assets/locker_docs/course.pdf', 12)).toBe(
      'course.pdf:p13'
    );
  });

  it('strips query parameters from the path', () => {
    expect(getPdfPageFileKey('/assets/textbook.pdf?v=12345', 4)).toBe('textbook.pdf:p5');
  });

  it('handles simple filenames without paths', () => {
    expect(getPdfPageFileKey('book.pdf', 9)).toBe('book.pdf:p10');
  });

  it('handles empty path fallback', () => {
    expect(getPdfPageFileKey('', 0)).toBe('document.pdf:p1');
  });
});

describe('parsePdfPageFileKey', () => {
  it('parses valid page keys correctly', () => {
    const parsed = parsePdfPageFileKey('course.pdf:p14');
    expect(parsed).toEqual({
      baseDoc: 'course.pdf',
      pageNumber: 14,
      pageIndex: 13
    });
  });

  it('returns null for non-matching or invalid keys', () => {
    expect(parsePdfPageFileKey('01.01.lesson.md')).toBeNull();
    expect(parsePdfPageFileKey('course.pdf')).toBeNull();
    expect(parsePdfPageFileKey('course.pdf:p0')).toBeNull();
    expect(parsePdfPageFileKey('course.pdf:p-5')).toBeNull();
    expect(parsePdfPageFileKey('')).toBeNull();
  });
});

describe('computePdfRenderScale', () => {
  it('computes exact ratio between display width and page point width', () => {
    expect(computePdfRenderScale(612, 612)).toBe(1.0);
    expect(computePdfRenderScale(918, 612)).toBe(1.5);
    expect(computePdfRenderScale(765, 612)).toBe(1.25);
  });

  it('handles non-integer rounded display widths without drift', () => {
    // Say displayWidth is rounded to 764 due to Math.round(611.5 * 1.25)
    const scale = computePdfRenderScale(764, 612);
    expect(scale).toBe(764 / 612);
  });

  it('safely handles zero or negative widths', () => {
    expect(computePdfRenderScale(612, 0)).toBe(1.0);
    expect(computePdfRenderScale(612, -100)).toBe(1.0);
  });
});

describe('normalizePdfPoint & denormalizePdfPoint', () => {
  const pageRect = { left: 100, top: 50, width: 918, height: 1188 }; // 612x792 at 1.5x zoom
  const pageWidth = 612;
  const pageHeight = 792;

  it('normalizes client coordinates to top-left PDF page points', () => {
    // Top-left corner
    const p1 = normalizePdfPoint(100, 50, pageRect, pageWidth, pageHeight);
    expect(p1.x).toBe(0);
    expect(p1.y).toBe(0);

    // Exact center: 100 + 918/2 = 559, 50 + 1188/2 = 644
    const pCenter = normalizePdfPoint(559, 644, pageRect, pageWidth, pageHeight);
    expect(pCenter.x).toBeCloseTo(306, 5);
    expect(pCenter.y).toBeCloseTo(396, 5);
  });

  it('clamps coordinates outside page boundaries', () => {
    const outLeft = normalizePdfPoint(50, 50, pageRect, pageWidth, pageHeight);
    expect(outLeft.x).toBe(0);

    const outRight = normalizePdfPoint(2000, 2000, pageRect, pageWidth, pageHeight);
    expect(outRight.x).toBe(612);
    expect(outRight.y).toBe(792);
  });

  it('round-trips through normalize and denormalize within epsilon', () => {
    const clientX = 425.5;
    const clientY = 310.2;
    const normalized = normalizePdfPoint(clientX, clientY, pageRect, pageWidth, pageHeight);
    const scale = computePdfRenderScale(pageRect.width, pageWidth);
    const denormalized = denormalizePdfPoint(normalized, scale);

    expect(denormalized.x + pageRect.left).toBeCloseTo(clientX, 5);
    expect(denormalized.y + pageRect.top).toBeCloseTo(clientY, 5);
  });
});

describe('indexStrokesByFile & persistence round-trip', () => {
  it('groups strokes by file key and omits tombstones', () => {
    const s1 = { id: 's1', file: 'course.pdf:p1', points: [10, 10, 0.5] };
    const s2 = { id: 's2', file: 'course.pdf:p2', points: [20, 20, 0.5] };
    const s3 = { id: 's3', file: 'course.pdf:p1', points: [30, 30, 0.5], deleted: '2026-01-01' };

    const index = indexStrokesByFile([s1, s2, s3]);

    expect(index['course.pdf:p1']).toHaveLength(1);
    expect(index['course.pdf:p1'][0].id).toBe('s1');
    expect(index['course.pdf:p2']).toHaveLength(1);
    expect(index['course.pdf:p2'][0].id).toBe('s2');
    expect(index['course.pdf:p3']).toBeUndefined();
  });

  it('verifies draw -> reload persistence round-trip consistency', () => {
    const { mergeStrokes } = require('./render');

    // 1. Initial state (empty)
    let storedStrokes: any[] = [];

    // 2. User draws a stroke on page 14
    const drawStroke = {
      id: 'stroke-uuid-14',
      file: 'course.pdf:p14',
      tool: 'marker',
      color: 'red',
      points: [100, 150, 0.7, 105, 155, 0.7],
      authorWidth: 612,
      date: '2026-10-27T21:00:00.000Z'
    };

    const saved = mergeStrokes(storedStrokes, [drawStroke]);
    storedStrokes = saved.strokes;

    // 3. Simulate reload / fresh session: re-index loaded strokes
    const reloadedIndex = indexStrokesByFile(storedStrokes);
    expect(reloadedIndex['course.pdf:p14']).toBeDefined();
    expect(reloadedIndex['course.pdf:p14']).toHaveLength(1);
    expect(reloadedIndex['course.pdf:p14'][0]).toEqual(drawStroke);

    // 4. User erases stroke -> tombstone merged -> reload
    const tombstone = {
      ...drawStroke,
      date: '2026-10-27T21:05:00.000Z',
      deleted: '2026-10-27T21:05:00.000Z'
    };
    const afterErase = mergeStrokes(storedStrokes, [tombstone]);
    storedStrokes = afterErase.strokes;

    const afterEraseIndex = indexStrokesByFile(storedStrokes);
    expect(afterEraseIndex['course.pdf:p14']).toBeUndefined();
  });
});

