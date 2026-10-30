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
export const MARKUP_PRESETS: Record<string, MarkupPreset> = {
  white: { label: 'White', color: '#ffffff', width: 1.4, opacity: 1, blend: 'normal' },
  blue: { label: 'Blue', color: '#007aff', width: 1.4, opacity: 1, blend: 'normal' },
  green: { label: 'Green', color: '#34c759', width: 1.4, opacity: 1, blend: 'normal' },
  yellow: { label: 'Yellow', color: '#ffcc00', width: 1.4, opacity: 1, blend: 'normal' },
  red: { label: 'Red', color: '#ff3b30', width: 1.4, opacity: 1, blend: 'normal' },
  black: { label: 'Black', color: '#1c1917', width: 1.4, opacity: 1, blend: 'normal' },
  'hl-yellow': { label: 'Neon Yellow', color: '#ffcc00', width: 12, opacity: 1, blend: 'multiply' },
  'hl-green': { label: 'Neon Green', color: '#34c759', width: 12, opacity: 1, blend: 'multiply' },
  'hl-pink': { label: 'Neon Pink', color: '#ff2d55', width: 12, opacity: 1, blend: 'multiply' }
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

/** Strokes must cover at least this much pen travel (author px) to be saved. */
export const MIN_COMMIT_TRAVEL_PX = 4;

/** Total pen travel along the flat triplet points, in author px. */
export function strokePathLength(stroke: Pick<MarkupStroke, 'points'>): number {
  let length = 0;
  for (let i = PRESSURE_STRIDE; i + PRESSURE_STRIDE - 1 < stroke.points.length; i += PRESSURE_STRIDE) {
    const dx = stroke.points[i] - stroke.points[i - PRESSURE_STRIDE];
    const dy = stroke.points[i + 1] - stroke.points[i - PRESSURE_STRIDE + 1];
    length += Math.hypot(dx, dy);
  }
  return length;
}

/**
 * Guard against committing gesture fragments: a real stroke has at least two
 * points and some minimum travel. Anything shorter is a pen tap or the debris
 * of an interrupted gesture and would render as a lone round dot.
 */
export function isCommittableStroke(points: number[]): boolean {
  if (points.length < PRESSURE_STRIDE * 2) return false;
  return strokePathLength({ points }) >= MIN_COMMIT_TRAVEL_PX;
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
  const baseWidth = stroke.width ?? MARKUP_PRESETS[stroke.color]?.width ?? 1.4;
  const outline = getStroke(pts, {
    size: baseWidth * scale,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: opts?.simulatePressure ?? false,
    last: opts?.live ?? false
  });
  return outlineToPath(outline);
}

/**
 * Highlighter stroke → filled SVG path `d` via perfect-freehand with uniform
 * width (no pressure thinning) and streamline smoothing. Produces a continuous,
 * solid closed polygon outline without internal stroke overlapping artifacts.
 */
export function strokeToHighlightPath(
  stroke: MarkupStroke,
  scale: number,
  opts?: { live?: boolean }
): string {
  const pts = strokePoints(stroke, scale);
  if (pts.length === 0) return '';
  const presetWidth = MARKUP_PRESETS[stroke.color]?.width ?? 12;
  const defaultHighlightWidth = stroke.tool === 'highlighter' ? presetWidth : 1.4;
  const width = stroke.width ?? defaultHighlightWidth;
  const outline = getStroke(pts, {
    size: width * scale,
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.6,
    simulatePressure: false,
    last: opts?.live ?? false
  });
  return outlineToPath(outline);
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
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
  const defaultWidth = stroke.tool === 'highlighter' ? 12 : 1.4;
  const baseWidth = stroke.width ?? MARKUP_PRESETS[stroke.color]?.width ?? defaultWidth;
  const radius = (baseWidth * scale) / 2 + tolerance;
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
