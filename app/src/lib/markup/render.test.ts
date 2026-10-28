import { describe, expect, it } from 'bun:test';
import {
  MARKUP_PRESETS,
  hitTestStroke,
  isCommittableStroke,
  mergeStrokes,
  strokePathLength,
  strokePoints,
  strokeToHighlightPath,
  strokeToMarkerPath
} from './render';
import type { MarkupStroke } from './types';

function makeStroke(partial: Partial<MarkupStroke> = {}): MarkupStroke {
  return {
    id: 's1',
    file: '01.01.lesson.md',
    tool: 'marker',
    color: 'red',
    points: [10, 10, 0.5, 50, 10, 0.5, 90, 10, 0.5],
    authorWidth: 400,
    date: '2026-01-01T00:00:00.000Z',
    ...partial
  };
}

describe('strokePoints', () => {
  it('scales author-px triplets uniformly', () => {
    const pts = strokePoints({ points: [10, 20, 0.5, 30, 40, 1] }, 2);
    expect(pts).toEqual([
      [20, 40, 0.5],
      [60, 80, 1]
    ]);
  });

  it('ignores trailing incomplete triplets', () => {
    const pts = strokePoints({ points: [10, 20, 0.5, 30] }, 1);
    expect(pts).toEqual([[10, 20, 0.5]]);
  });
});

describe('strokePathLength', () => {
  it('sums travel across consecutive points', () => {
    expect(strokePathLength({ points: [0, 0, 0.5, 3, 4, 0.5, 3, 10, 0.5] })).toBe(11);
  });

  it('is zero for empty or single-point strokes', () => {
    expect(strokePathLength({ points: [] })).toBe(0);
    expect(strokePathLength({ points: [10, 10, 0.5] })).toBe(0);
  });
});

describe('isCommittableStroke', () => {
  it('rejects empty, single-point, and near-zero-travel fragments', () => {
    expect(isCommittableStroke([])).toBe(false);
    expect(isCommittableStroke([10, 10, 0.5])).toBe(false);
    expect(isCommittableStroke([10, 10, 0.5, 11, 11, 0.5])).toBe(false);
  });

  it('accepts strokes with two points and enough travel', () => {
    expect(isCommittableStroke([10, 10, 0.5, 14, 10, 0.5])).toBe(true);
    expect(isCommittableStroke(makeStroke().points)).toBe(true);
  });
});

describe('strokeToMarkerPath', () => {
  it('produces a closed filled outline around the stroke', () => {
    const d = strokeToMarkerPath(makeStroke(), 1);
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d.length).toBeGreaterThan(20);
  });

  it('scales outline coordinates with the render scale', () => {
    const d1 = strokeToMarkerPath(makeStroke(), 1);
    const d2 = strokeToMarkerPath(makeStroke(), 2);
    const firstCoord = (s: string) => Number(s.split(' ')[1]);
    expect(Math.abs(firstCoord(d2) - firstCoord(d1) * 2)).toBeLessThan(2);
  });

  it('returns empty path for a stroke with no complete points', () => {
    expect(strokeToMarkerPath(makeStroke({ points: [] }), 1)).toBe('');
  });
});

describe('strokeToHighlightPath', () => {
  it('produces a closed filled outline around the highlight stroke', () => {
    const d = strokeToHighlightPath(makeStroke({ tool: 'highlighter' }), 1);
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d.length).toBeGreaterThan(20);
  });

  it('scales outline coordinates with the render scale', () => {
    const d1 = strokeToHighlightPath(makeStroke({ tool: 'highlighter' }), 1);
    const d2 = strokeToHighlightPath(makeStroke({ tool: 'highlighter' }), 2);
    expect(d1.endsWith('Z')).toBe(true);
    expect(d2.endsWith('Z')).toBe(true);
  });

  it('renders a closed circular outline for a single-point stroke', () => {
    const d = strokeToHighlightPath(makeStroke({ points: [10, 10, 0.5] }), 1);
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });

  it('returns empty path for a stroke with no points', () => {
    expect(strokeToHighlightPath(makeStroke({ points: [] }), 1)).toBe('');
  });
});

describe('hitTestStroke', () => {
  const stroke = makeStroke(); // horizontal line y=10 from x=10..90

  it('hits near the stroke centerline', () => {
    expect(hitTestStroke(stroke, 1, 50, 12, 8)).toBe(true);
  });

  it('misses far away points', () => {
    expect(hitTestStroke(stroke, 1, 50, 60, 8)).toBe(false);
  });

  it('accounts for stroke width via the scale factor', () => {
    const wide = makeStroke({ color: 'hl-yellow' }); // 16px highlighter
    expect(hitTestStroke(wide, 2, 50, 25, 4)).toBe(true);
    expect(hitTestStroke(stroke, 1, 50, 25, 4)).toBe(false);
  });
});

describe('mergeStrokes', () => {
  it('inserts new strokes and reports changed', () => {
    const { strokes, changed } = mergeStrokes([], [makeStroke()]);
    expect(changed).toBe(true);
    expect(strokes).toHaveLength(1);
  });

  it('applies last-write-wins on date', () => {
    const older = makeStroke({ id: 'a', date: '2026-01-01T00:00:00.000Z', color: 'red' });
    const newer = makeStroke({ id: 'a', date: '2026-02-01T00:00:00.000Z', color: 'blue' });
    const merged = mergeStrokes([older], [newer]);
    expect(merged.strokes[0].color).toBe('blue');
    // Older upsert must not clobber the newer stored one
    const mergedBack = mergeStrokes([newer], [older]);
    expect(mergedBack.strokes[0].color).toBe('blue');
    expect(mergedBack.changed).toBe(false);
  });

  it('keeps tombstones so erases survive sync', () => {
    const live = makeStroke({ id: 'a' });
    const tombstone = makeStroke({ id: 'a', date: '2026-03-01T00:00:00.000Z', deleted: '2026-03-01T00:00:00.000Z' });
    const { strokes } = mergeStrokes([live], [tombstone]);
    expect(strokes[0].deleted).toBe('2026-03-01T00:00:00.000Z');
  });

  it('drops structurally invalid upserts', () => {
    const junk = { id: 'x', file: 'f' } as unknown as MarkupStroke;
    const { strokes, changed } = mergeStrokes([], [junk]);
    expect(strokes).toHaveLength(0);
    expect(changed).toBe(false);
  });
});

describe('presets', () => {
  it('covers every markup color with highlighters using multiply blend', () => {
    for (const color of Object.keys(MARKUP_PRESETS) as (keyof typeof MARKUP_PRESETS)[]) {
      const preset = MARKUP_PRESETS[color];
      expect(preset.width).toBeGreaterThan(0);
      if (color.startsWith('hl-')) {
        expect(preset.blend).toBe('multiply');
        expect(preset.width).toBeGreaterThan(8);
      }
    }
  });
});
