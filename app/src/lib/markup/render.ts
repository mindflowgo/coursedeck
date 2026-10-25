import { getStroke } from 'perfect-freehand';
import type { MarkupColor, MarkupStroke } from './types';
import { isMarkupStroke } from './types';

/**
 * Pure stroke math for the markup overlay: author-px → SVG path generation,
 * eraser hit-testing, and last-write-wins merging. No DOM access here so the
 * whole module is unit-testable under bun:test.
 */

export interface MarkupPreset {
  label: string;
  color: string; // CSS color
  width: number; // stroke width in author px (scaled on render)
  opacity: number;
  /** Light-mode blend; highlighters switch to `screen` in dark mode via CSS. */
  blend: 'normal' | 'multiply';
}

// Markers are opaque perfect-freehand filled outlines. Highlighters are plain
// stroked SVG paths blended with multiply so text underneath stays crisp and
// only the paper tints (like a physical highlighter).
export const MARKUP_PRESETS: Record<MarkupColor, MarkupPreset> = {
  red: { label: 'Red', color: '#dc2626', width: 2.75, opacity: 1, blend: 'normal' },
  blue: { label: 'Blue', color: '#2563eb', width: 2.75, opacity: 1, blend: 'normal' },
  green: { label: 'Green', color: '#16a34a', width: 2.75, opacity: 1, blend: 'normal' },
  white: { label: 'White', color: '#ffffff', width: 2.75, opacity: 1, blend: 'normal' },
  black: { label: 'Black', color: '#1c1917', width: 2.75, opacity: 1, blend: 'normal' },
  'hl-yellow': { label: 'Neon Yellow', color: '#fde047', width: 16, opacity: 1, blend: 'multiply' },
  'hl-green': { label: 'Neon Green', color: '#4ade80', width: 16, opacity: 1, blend: 'multiply' },
  'hl-pink': { label: 'Neon Pink', color: '#f472b6', width: 16, opacity: 1, blend: 'multiply' }
};

const PRESSURE_STRIDE = 3;

/** Decodes the flat point triplets into scaled [x, y, pressure] triplets. */
export function strokePoints(stroke: Pick<MarkupStroke, 'points'>, scale: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + PRESSURE_STRIDE - 1 < stroke.points.length; i += PRESSURE_STRIDE) {
    out.push([stroke.points[i] * scale, stroke.points[i + 1] * scale, stroke.points[i + 2]]);
  }
  return out;
}

function outlineToPath(outline: number[][]): string {
  if (outline.length < 2) return '';
  const d = outline.reduce((acc, [x0, y0], i, arr) => {
    const [x1, y1] = arr[(i + 1) % arr.length];
    acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    return acc;
  }, ['M', outline[0][0], outline[0][1], 'Q'] as (string | number)[]);
  d.push('Z');
  return d.join(' ');
}

/**
 * Marker stroke → filled SVG path `d` via perfect-freehand, uniformly scaled
 * from author coordinates. `simulatePressure` gives mouse/finger strokes a
 * velocity-based taper; pen input uses its real pressure instead.
 */
export function strokeToMarkerPath(
  stroke: MarkupStroke,
  scale: number,
  opts?: { live?: boolean; simulatePressure?: boolean }
): string {
  const pts = strokePoints(stroke, scale);
  if (pts.length === 0) return '';
  const outline = getStroke(pts, {
    size: MARKUP_PRESETS[stroke.color].width * scale,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: opts?.simulatePressure ?? false,
    last: opts?.live ?? false
  });
  return outlineToPath(outline);
}

/**
 * Highlighter stroke → smoothed polyline SVG path `d` (quadratic midpoints,
 * round caps via CSS) scaled uniformly from author coordinates.
 */
export function strokeToHighlightPath(stroke: MarkupStroke, scale: number): string {
  const pts = strokePoints(stroke, scale);
  if (pts.length === 0) return '';
  if (pts.length === 1) {
    const [x, y] = pts[0];
    return `M ${x} ${y} L ${x + 0.01} ${y}`;
  }
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** Eraser hit test: point within `tolerance` px (CSS) of the scaled stroke. */
export function hitTestStroke(
  stroke: MarkupStroke,
  scale: number,
  x: number,
  y: number,
  tolerance = 8
): boolean {
  const pts = strokePoints(stroke, scale);
  if (pts.length === 0) return false;
  const radius = (MARKUP_PRESETS[stroke.color].width * scale) / 2 + tolerance;
  const radiusSq = radius * radius;
  if (pts.length === 1) {
    const dx = pts[0][0] - x;
    const dy = pts[0][1] - y;
    return dx * dx + dy * dy <= radiusSq;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    if (distToSegmentSq(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <= radiusSq) {
      return true;
    }
  }
  return false;
}

/**
 * Upsert-by-id merge with last-write-wins on `date`. Tombstoned (deleted)
 * strokes are kept — they are what makes erase/undo survive a sync merge.
 */
export function mergeStrokes(existing: MarkupStroke[], upserts: MarkupStroke[]): {
  strokes: MarkupStroke[];
  changed: boolean;
} {
  const byId = new Map<string, MarkupStroke>();
  for (const s of existing) {
    if (isMarkupStroke(s)) byId.set(s.id, s);
  }
  let changed = false;
  for (const up of upserts) {
    if (!isMarkupStroke(up)) continue;
    const cur = byId.get(up.id);
    if (!cur || new Date(up.date).getTime() >= new Date(cur.date).getTime()) {
      byId.set(up.id, up);
      changed = true;
    }
  }
  return { strokes: Array.from(byId.values()), changed };
}
