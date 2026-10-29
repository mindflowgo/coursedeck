/**
 * Free-hand markup domain model.
 *
 * Strokes are drawn over rendered markdown documents (the `.markdown-body`
 * container) and persisted per course in `annotations.json`, mirroring the
 * checkpoint pipeline (server JSON + Tauri offline storage + pending push).
 *
 * Coordinates are stored in author pixels relative to the `.markdown-body`
 * top-left corner, together with the container width at draw time
 * (`authorWidth`). Renderers rescale both axes uniformly by
 * `currentWidth / authorWidth` so stroke shapes never distort when the
 * document reflows at a different width (phone vs iPad, zoom, resize).
 */

export type MarkupTool = 'marker' | 'highlighter';

export type MarkupColor =
  | 'white'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'red'
  | 'black'
  | 'hl-yellow'
  | 'hl-green'
  | 'hl-pink'
  | (string & {});

export interface MarkupStroke {
  id: string; // uuid — merge key across devices
  file: string; // docFileName, e.g. "01.01.lesson.md"
  tool: MarkupTool;
  color: MarkupColor;
  /** Flat [x0, y0, p0, x1, y1, p1, ...] — author px + pressure 0..1 per point. */
  points: number[];
  authorWidth: number;
  date: string; // ISO 8601 — last-write-wins merge key
  deleted?: string; // tombstone ISO date (erase / undo / clear)
  width?: number; // Custom stroke width in author px (e.g. from PencilKit)
  opacity?: number; // Custom stroke opacity 0..1 (e.g. from PencilKit)
}

export const MARKUP_TOOLS: MarkupTool[] = ['marker', 'highlighter'];

export const PALETTE_COLORS: { id: MarkupColor; label: string; hex: string }[] = [
  { id: 'white', label: 'White', hex: '#ffffff' },
  { id: 'blue', label: 'Blue', hex: '#007aff' },
  { id: 'green', label: 'Green', hex: '#34c759' },
  { id: 'yellow', label: 'Yellow', hex: '#ffcc00' },
  { id: 'red', label: 'Red', hex: '#ff3b30' }
];

export const MARKER_COLORS: MarkupColor[] = ['white', 'blue', 'green', 'yellow', 'red', 'black'];
export const HIGHLIGHTER_COLORS: MarkupColor[] = ['hl-yellow', 'hl-green', 'hl-pink'];

/**
 * Structural validation shared by the server merge, the offline store, and
 * the sync push handler. Tolerates unknown/legacy fields by design.
 */
export function isMarkupStroke(value: unknown): value is MarkupStroke {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.file === 'string' &&
    v.file.length > 0 &&
    (v.tool === 'marker' || v.tool === 'highlighter') &&
    typeof v.color === 'string' &&
    Array.isArray(v.points) &&
    v.points.length >= 3 &&
    v.points.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    typeof v.authorWidth === 'number' &&
    v.authorWidth > 0 &&
    typeof v.date === 'string' &&
    (v.deleted === undefined || typeof v.deleted === 'string') &&
    (v.width === undefined || (typeof v.width === 'number' && Number.isFinite(v.width))) &&
    (v.opacity === undefined || (typeof v.opacity === 'number' && Number.isFinite(v.opacity)))
  );
}
