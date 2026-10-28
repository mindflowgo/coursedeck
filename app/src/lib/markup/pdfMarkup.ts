/**
 * Pure coordinate geometry, scale math, and file key utilities for PDF markup.
 *
 * Markings are stored in top-left-origin page point space ([0..pageWidth, 0..pageHeight])
 * with `authorWidth = pageWidth`. Scale is strictly derived from actual geometry
 * (`displayWidth / pageWidth`), eliminating rounding drift from nominal zoomScale.
 */

/**
 * Returns a canonical, human-readable file key for a PDF page's strokes.
 * E.g., `getPdfPageFileKey("/api/courses/mcr3u/assets/locker_docs/course.pdf", 0)` -> `"course.pdf:p1"`
 */
export function getPdfPageFileKey(docPath: string, pageIndex: number): string {
  const clean = (docPath || 'document.pdf').split('?')[0];
  const baseDoc = clean.split('/').pop() || 'document.pdf';
  return `${baseDoc}:p${pageIndex + 1}`;
}

/**
 * Parses a PDF page file key into its base document filename and 0-based page index.
 * Returns null if the file key does not conform to the `${baseDoc}:p${pageNumber}` format.
 */
export function parsePdfPageFileKey(fileKey: string): {
  baseDoc: string;
  pageNumber: number;
  pageIndex: number;
} | null {
  if (!fileKey) return null;
  const match = fileKey.match(/^(.+):p(\d+)$/);
  if (!match) return null;
  const pageNumber = parseInt(match[2], 10);
  if (Number.isNaN(pageNumber) || pageNumber < 1) return null;
  return {
    baseDoc: match[1],
    pageNumber,
    pageIndex: pageNumber - 1
  };
}

/**
 * Computes the exact render scale from displayed width and canonical page point width.
 * Using actual `displayWidth / pageWidth` instead of nominal `zoomScale` avoids sub-pixel
 * drift introduced by integer rounding in CSS pixel dimensions.
 */
export function computePdfRenderScale(displayWidth: number, pageWidth: number): number {
  if (!pageWidth || pageWidth <= 0) return 1;
  return displayWidth / pageWidth;
}

/**
 * Normalizes viewport client pointer coordinates into canonical top-left-origin
 * PDF page points, clamped within the page boundary.
 */
export function normalizePdfPoint(
  clientX: number,
  clientY: number,
  pageRect: { left: number; top: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number
): { x: number; y: number } {
  const scale = computePdfRenderScale(pageRect.width, pageWidth);
  const rawX = (clientX - pageRect.left) / scale;
  const rawY = (clientY - pageRect.top) / scale;

  return {
    x: Math.max(0, Math.min(pageWidth, rawX)),
    y: Math.max(0, Math.min(pageHeight, rawY))
  };
}

/**
 * Scales a canonical top-left-origin point to screen display coordinates.
 */
export function denormalizePdfPoint(
  point: { x: number; y: number },
  scale: number
): { x: number; y: number } {
  return {
    x: point.x * scale,
    y: point.y * scale
  };
}

/**
 * Pure indexer grouping non-deleted strokes by file for O(1) page/file lookup.
 */
export function indexStrokesByFile<T extends { file: string; deleted?: string }>(
  strokes: T[]
): Record<string, T[]> {
  const index: Record<string, T[]> = {};
  for (const s of strokes) {
    if (!s.deleted) {
      if (!index[s.file]) index[s.file] = [];
      index[s.file].push(s);
    }
  }
  return index;
}

