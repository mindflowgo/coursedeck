import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * Course image optimizer (server-side, Bun runtime).
 *
 * - Clamps any raster image wider than MAX_IMAGE_WIDTH to that width
 *   (aspect preserved) and re-encodes it as JPEG.
 * - Rewrites markdown image references to the new filenames and adds a
 *   `|50%` size spec to images that would otherwise display wider than
 *   half of the reading column.
 *
 * Uses Bun.Image — a runtime builtin — so the compiled sidecar binary
 * (`bun build --compile`) stays self-contained with zero native deps.
 * Runs as part of CourseIngest (every import/re-parse) and via the
 * maintenance endpoint / CLI script for already-imported courses.
 */

export const MAX_IMAGE_WIDTH = 512;
export const JPEG_QUALITY = 82;
/** Approximate CSS width of the lesson reading column the viewer renders into. */
export const READING_COLUMN_PX = 720;
/** Images displaying wider than this fraction of the column get an explicit 50% spec. */
export const MAX_DISPLAY_FRACTION = 0.5;

const RASTER_RE = /\.(jpe?g|png)$/i;
const CONCURRENCY = 8;

// Minimal structural types so both the root (bun) and app tsconfigs check
// cleanly without requiring @types/bun in the app package.
interface BunImageInstance {
  metadata(): Promise<{ width: number; height: number; format?: string }>;
  resize(width: number): BunImageInstance;
  jpeg(options?: { quality?: number; progressive?: boolean }): BunImageInstance;
  buffer(): Promise<Buffer>;
}
type BunImageConstructor = new (input: Buffer | Uint8Array | ArrayBuffer | string) => BunImageInstance;

export function isImageOptimizerAvailable(): boolean {
  return typeof (globalThis as { Bun?: { Image?: BunImageConstructor } }).Bun?.Image === 'function';
}

function getImageCtor(): BunImageConstructor | null {
  const ctor = (globalThis as { Bun?: { Image?: BunImageConstructor } }).Bun?.Image;
  return ctor ?? null;
}

export interface ImageOptimizeSummary {
  scanned: number;
  converted: number;
  skippedSmall: number;
  bytesBefore: number;
  bytesAfter: number;
  markdownFilesUpdated: number;
  markdownRefsUpdated: number;
}

interface Conversion {
  /** assets-relative key, e.g. 'img/foo.png' */
  from: string;
  to: string;
  samePath: boolean;
}

/** Named sizes and unit forms mirror MarkdownViewer.parseImageSpec. */
function specDisplayWidthPx(spec: string): number | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  if (s === 'xs' || s === 'thumb') return 160;
  if (s === 'sm' || s === 'small') return 280;
  if (s === 'md' || s === 'medium') return 480;
  if (s === 'lg' || s === 'large') return 720;
  if (s === 'full' || s === 'xl') return READING_COLUMN_PX;

  const wm = s.match(/(?:width|w)=([0-9]+(?:\.\d+)?)(%|px|rem)?/);
  if (wm) {
    if (wm[2] === '%') return (parseFloat(wm[1]) / 100) * READING_COLUMN_PX;
    return parseFloat(wm[1]) * (wm[2] === 'rem' ? 16 : 1);
  }
  const wh = s.match(/^(\d+(?:px|%|rem)?)\s*x\s*\d+/);
  if (wh) {
    const v = wh[1];
    if (v.endsWith('%')) return READING_COLUMN_PX; // rare; treat as full
    return parseFloat(v) * (v.endsWith('rem') ? 16 : 1);
  }
  if (/^\d+(?:\.\d+)?%$/.test(s)) return (parseFloat(s) / 100) * READING_COLUMN_PX;
  if (/^\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  return null;
}

/** Rewrites `![alt|spec](url)` (plus the Pandoc `{width=..}` suffix). */
const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)\)(\s*\{([^}]*)\})?/g;

function optimizeMarkdownText(
  markdown: string,
  renameMap: Map<string, string>,
  widths: Map<string, number>
): { text: string; refsUpdated: number } {
  let refsUpdated = 0;

  const next = markdown.replace(IMAGE_REF_RE, (_m, rawAlt: string, url: string, _attrWrap: string, attr: string | undefined) => {
    // Only relative course-asset refs are managed here
    const assetMatch = url.match(/^(?:\.\/)?assets\/([^?#]+)$/i);
    if (!assetMatch) return _m;

    const key = assetMatch[1].replace(/\\/g, '/');

    // Split an existing pipe spec out of the alt text
    let alt = rawAlt;
    let spec: string | null = null;
    const pipeIndex = alt.lastIndexOf('|');
    if (pipeIndex !== -1) {
      spec = alt.slice(pipeIndex + 1).trim();
      alt = alt.slice(0, pipeIndex).trim();
    }

    // Fold a Pandoc attribute suffix ({width=50%}) into the spec
    if (attr) {
      const wm = attr.match(/width\s*=\s*['"]?([\d.]+)(%|px)?/i);
      if (wm) {
        spec = wm[2] === '%' ? `${parseFloat(wm[1])}%` : `${parseFloat(wm[1])}px`;
      }
    }

    // Apply file rename (png → jpg etc.)
    const renamedKey = renameMap.get(key.toLowerCase()) ?? key;
    const urlChanged = renamedKey !== key;
    const finalUrl = urlChanged ? `./assets/${renamedKey}` : url;

    // 50% rule: effective display width vs the reading column
    const naturalWidth = widths.get(renamedKey.toLowerCase()) ?? null;
    const displayPx = spec ? specDisplayWidthPx(spec) : naturalWidth;
    let specChanged = false;
    if (displayPx !== null && displayPx > READING_COLUMN_PX * MAX_DISPLAY_FRACTION) {
      const newSpec = '50%';
      if (spec !== newSpec) {
        spec = newSpec;
        specChanged = true;
      }
    }

    if (!urlChanged && !specChanged && !attr) return _m;
    refsUpdated++;
    return `![${alt}${spec ? `|${spec}` : ''}](${finalUrl})`;
  });

  return { text: next, refsUpdated };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function optimizeCourseImagesViaBun(courseDir: string, summary: ImageOptimizeSummary): ImageOptimizeSummary {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const script = `import(${JSON.stringify(currentFilePath)}).then(m => m.optimizeCourseImages(${JSON.stringify(courseDir)})).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exit(1); })`;
    const res = spawnSync('bun', ['-e', script], {
      encoding: 'utf8',
      timeout: 120000,
      env: process.env
    });

    if (res.error || res.status !== 0) {
      console.warn('[ImageOptimizer] Bun fallback failed or Bun is not installed; skipping image optimization.', res.error?.message || res.stderr);
      return summary;
    }

    const lines = res.stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    return JSON.parse(lastLine) as ImageOptimizeSummary;
  } catch (err) {
    console.warn('[ImageOptimizer] Bun invocation failed, continuing without optimization:', err instanceof Error ? err.message : err);
    return summary;
  }
}

/**
 * Optimizes all raster images in `<courseDir>/assets/img` and rewrites
 * markdown references in the course's `*.md` files to match.
 */
export async function optimizeCourseImages(courseDir: string): Promise<ImageOptimizeSummary> {
  const summary: ImageOptimizeSummary = {
    scanned: 0,
    converted: 0,
    skippedSmall: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    markdownFilesUpdated: 0,
    markdownRefsUpdated: 0
  };

  const imgDir = path.join(courseDir, 'assets', 'img');
  if (!fs.existsSync(imgDir)) return summary;

  if (!isImageOptimizerAvailable()) {
    return optimizeCourseImagesViaBun(courseDir, summary);
  }

  const Image = getImageCtor();
  if (!Image) {
    return summary;
  }
  const files = fs.readdirSync(imgDir).filter((f) => RASTER_RE.test(f) && !f.startsWith('.'));
  summary.scanned = files.length;

  /** Final pixel width per assets-relative key (lowercased). */
  const widths = new Map<string, number>();
  const conversions: Conversion[] = [];
  const renameMap = new Map<string, string>(); // lowercase from-key -> to-key

  await mapLimit(files, CONCURRENCY, async (file) => {
    const filePath = path.join(imgDir, file);
    try {
      const bytesBefore = fs.statSync(filePath).size;
      const img = new Image(fs.readFileSync(filePath));
      const meta = await img.metadata();
      if (!meta.width || !meta.height) return;

      if (meta.width <= MAX_IMAGE_WIDTH) {
        widths.set(`img/${file}`.toLowerCase(), meta.width);
        summary.skippedSmall++;
        return;
      }

      const output = await img
        .resize(MAX_IMAGE_WIDTH)
        .jpeg({ quality: JPEG_QUALITY, progressive: true })
        .buffer();

      // Target name: same basename with .jpg extension, avoiding collisions
      const base = file.replace(/\.[^.]+$/, '');
      let target = `${base}.jpg`;
      for (let n = 2; fs.existsSync(path.join(imgDir, target)) && target !== file; n++) {
        target = `${base}-${n}.jpg`;
      }
      const samePath = target === file;

      fs.writeFileSync(path.join(imgDir, target), output);
      widths.set(`img/${target}`.toLowerCase(), Math.min(meta.width, MAX_IMAGE_WIDTH));

      summary.converted++;
      summary.bytesBefore += bytesBefore;
      summary.bytesAfter += output.length;

      const fromKey = `img/${file}`.toLowerCase();
      if (!samePath) {
        renameMap.set(fromKey, `img/${target}`);
        conversions.push({ from: fromKey, to: `img/${target}`, samePath: false });
      } else {
        conversions.push({ from: fromKey, to: fromKey, samePath: true });
      }
    } catch (err) {
      console.warn(`[ImageOptimizer] Skipping ${file}:`, err instanceof Error ? err.message : err);
    }
  });

  // Pass 2: rewrite markdown references, then delete replaced originals
  const mdFiles = fs
    .readdirSync(courseDir)
    .filter((f) => f.endsWith('.md') && fs.statSync(path.join(courseDir, f)).isFile());

  for (const mdFile of mdFiles) {
    const mdPath = path.join(courseDir, mdFile);
    const original = fs.readFileSync(mdPath, 'utf8');
    const { text, refsUpdated } = optimizeMarkdownText(original, renameMap, widths);
    if (text !== original) {
      fs.writeFileSync(mdPath, text, 'utf8');
      summary.markdownFilesUpdated++;
      summary.markdownRefsUpdated += refsUpdated;
    }
  }

  // Pass 2b: rewrite presentation HTML references so images match optimized formats
  const htmlFiles = fs
    .readdirSync(courseDir)
    .filter((f) => f.endsWith('.lesson.html') && fs.statSync(path.join(courseDir, f)).isFile());

  for (const htmlFile of htmlFiles) {
    const htmlPath = path.join(courseDir, htmlFile);
    let htmlText = fs.readFileSync(htmlPath, 'utf8');
    let changed = false;
    for (const [fromKey, toKey] of renameMap.entries()) {
      const fromBase = path.basename(fromKey);
      const toBase = path.basename(toKey);
      if (fromBase !== toBase && htmlText.includes(fromBase)) {
        htmlText = htmlText.replaceAll(fromBase, toBase);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(htmlPath, htmlText, 'utf8');
    }
  }

  // Only remove originals after every markdown and HTML file was rewritten successfully
  for (const conv of conversions) {
    if (!conv.samePath) {
      const originalPath = path.join(courseDir, 'assets', conv.from);
      if (fs.existsSync(path.join(courseDir, 'assets', conv.to)) && fs.existsSync(originalPath)) {
        fs.unlinkSync(originalPath);
      }
    }
  }

  return summary;
}
