import { CONTENT_WIDTH, MAX_IMAGE_HEIGHT } from './theme';
import type { EmbeddedImage, ImageEmbedder, ImageSettler, ImageSpec } from './types';

const PT_PER_PX = 0.75;
const CONCURRENCY = 6;

/**
 * Formats the PDF spec can carry byte-for-byte. Everything else (SVG, GIF,
 * WebP, AVIF, BMP…) has to be decoded and re-encoded to PNG, which is the
 * only place a canvas is used in the whole export path.
 */
const DIRECT_TYPES = new Set(['image/png', 'image/jpeg']);

/**
 * Supersample factor for re-encoded assets. 2× the *display* size is ~192 dpi
 * at print scale — crisp without embedding a full-size bitmap for something
 * that renders at 24pt.
 */
const RASTER_SCALE = 2;
/** Hard cap on either raster side, bounding memory on pathological assets. */
const MAX_RASTER_PX = 4096;

interface LoadJob {
  url: string;
  spec: ImageSpec;
  mode: 'block' | 'inline';
  placeholders: EmbeddedImage[];
}

interface DecodedSource {
  blob: Blob;
  width: number;
  height: number;
  /** Populated when the bytes had to be decoded through an <img>. */
  element?: HTMLImageElement;
}

/**
 * Session-level caches, shared by every export in the page session.
 *
 * - `sourceCache` avoids re-fetching and re-decoding the same asset.
 * - `embedCache` avoids re-rasterizing the same asset at the same display
 *   size, so re-exporting a document (or exporting a second tab that shares
 *   icons) skips the canvas entirely.
 */
const sourceCache = new Map<string, Promise<DecodedSource>>();
const embedCache = new Map<string, EmbeddedImage>();

/**
 * Browser image pipeline for the PDF compiler.
 *
 * - PNG/JPEG bytes are embedded directly (no re-encode, no canvas).
 * - GIF/SVG/WebP are decoded once and rasterized at their *display* size,
 *   because the PDF format only accepts raster images. The canvas is
 *   per-asset, sized to what actually lands on the page, and cached.
 * - Failures degrade to a text placeholder.
 */
export interface BrowserImageStore {
  embed(url: string, spec: ImageSpec, mode: 'block' | 'inline'): EmbeddedImage;
  settle(): Promise<void>;
  stats: { unique: number; resolved: number; failed: number };
}

export function createBrowserImageStore(): BrowserImageStore {
  const jobs = new Map<string, LoadJob>();
  const pending: Promise<void>[] = [];
  let active = 0;
  let resolvedCount = 0;
  let failedCount = 0;
  const queue: (() => void)[] = [];

  function pump(): void {
    while (active < CONCURRENCY && queue.length > 0) {
      const task = queue.shift()!;
      active++;
      task();
    }
  }

  function schedule<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve) => {
      queue.push(() => {
        work().then(resolve, resolve as (value: T) => void);
      });
      pump();
    });
  }

  /** Fetch + decode an asset once per session, memoized by URL. */
  function loadSource(url: string): Promise<DecodedSource> {
    let cached = sourceCache.get(url);
    if (!cached) {
      cached = fetchAndDecode(url).catch((err) => {
        // Don't poison the cache with a transient failure.
        sourceCache.delete(url);
        throw err;
      });
      sourceCache.set(url, cached);
    }
    return cached;
  }

  async function fetchAndDecode(url: string): Promise<DecodedSource> {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();

    // Formats that get re-encoded need an <img> anyway — decode once and
    // keep it, instead of decoding for dimensions and then again to draw.
    if (!DIRECT_TYPES.has(blob.type)) {
      try {
        const element = await loadViaImgElement(blob);
        return {
          blob,
          width: element.naturalWidth || 24,
          height: element.naturalHeight || 24,
          element
        };
      } catch (err) {
        // A handful of bundled SVGs are stored quoted-printable encoded but
        // served as `image/svg+xml`, so the browser rejects them and the
        // figure silently disappears. Decode and retry before giving up.
        const repaired = await tryRepairSvg(blob);
        if (!repaired) throw err;
        const element = await loadViaImgElement(repaired);
        return {
          blob: repaired,
          width: element.naturalWidth || 24,
          height: element.naturalHeight || 24,
          element
        };
      }
    }

    try {
      const bitmap = await createImageBitmap(blob);
      const meta = { blob, width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return meta;
    } catch {
      // Some hosts lack createImageBitmap for certain inputs — fall back.
      const element = await loadViaImgElement(blob);
      return {
        blob,
        width: element.naturalWidth || 24,
        height: element.naturalHeight || 24,
        element
      };
    }
  }

  /**
   * Detects and reverses quoted-printable encoding on an SVG that failed to
   * decode. Only applied on the failure path, and only when the document
   * really looks quoted-printable, so a valid SVG is never rewritten.
   */
  async function tryRepairSvg(blob: Blob): Promise<Blob | null> {
    if (!blob.type.includes('svg')) return null;
    const text = await blob.text();
    if (!looksQuotedPrintable(text)) return null;
    return new Blob([decodeQuotedPrintable(text)], { type: 'image/svg+xml' });
  }

  function loadViaImgElement(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        // Safe to release the URL once the image has loaded; the decoded
        // frame stays usable for later drawImage calls.
        URL.revokeObjectURL(objectUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('image decode failed'));
      };
      img.src = objectUrl;
    });
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Rasterize an already-decoded image at a size derived from where it will
   * actually be placed on the page — not its natural resolution. Icons shown
   * at 24pt become ~64px bitmaps instead of full-size artwork.
   */
  async function rasterizeElement(
    img: HTMLImageElement,
    targetWidthPx: number,
    targetHeightPx: number
  ): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = targetWidthPx;
    canvas.height = targetHeightPx;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  async function runJob(job: LoadJob): Promise<void> {
    try {
      const source = await loadSource(job.url);
      const size = computeSize(job.spec, source.width, source.height, job.mode);

      const key = embedKey(job.url, job.mode, size.width, size.height);
      let resolved = embedCache.get(key);

      if (!resolved) {
        let data: string;
        if (DIRECT_TYPES.has(source.blob.type)) {
          data = await blobToDataUrl(source.blob);
        } else {
          const element = source.element ?? (await loadViaImgElement(source.blob));
          const raster = rasterDimensions(
            size.width,
            size.height,
            source.width,
            source.height
          );
          data = await rasterizeElement(element, raster.width, raster.height);
        }
        resolved = { image: data, width: size.width, height: size.height };
        embedCache.set(key, resolved);
      }

      resolvedCount++;
      for (const ph of job.placeholders) {
        ph.image = resolved.image;
        ph.width = resolved.width;
        ph.height = resolved.height;
      }
    } catch (err) {
      console.warn(`[PDF Export] Image failed to load: ${job.url}`, err);
      failedCount++;
      for (const ph of job.placeholders) {
        ph.text = `[image unavailable${job.spec.alt ? `: ${job.spec.alt}` : ''}]`;
        ph.color = '#a8a29e';
        ph.fontSize = 8;
        ph.italics = true;
      }
    }
  }

  return {
    embed(url: string, spec: ImageSpec, mode: 'block' | 'inline'): EmbeddedImage {
      const placeholder: EmbeddedImage = {};

      const jobKey = `${url}|${mode}|${spec.widthPt ?? ''}|${spec.widthPct ?? ''}|${spec.heightPt ?? ''}`;
      let job = jobs.get(jobKey);
      if (!job) {
        job = { url, spec, mode, placeholders: [] };
        jobs.set(jobKey, job);
        const p = schedule(() => runJob(job!)).then(() => {
          active--;
          pump();
        });
        pending.push(p);
      }
      job.placeholders.push(placeholder);
      return placeholder;
    },

    async settle(): Promise<void> {
      await Promise.all(pending.splice(0));
    },

    stats: {
      get unique() {
        return jobs.size;
      },
      get resolved() {
        return resolvedCount;
      },
      get failed() {
        return failedCount;
      }
    }
  };
}

/** Heuristic: `=3D` (an encoded `=`) plus soft line breaks. */
export function looksQuotedPrintable(text: string): boolean {
  return text.slice(0, 400).includes('=3D') && /=\r?\n/.test(text);
}

export function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function embedKey(
  url: string,
  mode: 'block' | 'inline',
  width: number,
  height: number
): string {
  return `${url}|${mode}|${width.toFixed(2)}x${height.toFixed(2)}`;
}

/**
 * Pixel dimensions for a re-encoded image.
 *
 * The bitmap is sized to where the image actually lands on the page — at most
 * `RASTER_SCALE` (2×) the display size for print crispness — but never larger
 * than the source's own resolution, so this can only ever shrink an embed
 * relative to rasterizing at natural size. Pure, so it is unit-testable.
 */
export function rasterDimensions(
  displayWidthPt: number,
  displayHeightPt: number,
  naturalWidthPx: number,
  naturalHeightPx: number
): { width: number; height: number } {
  const displayPxW = Math.max(1, displayWidthPt / PT_PER_PX);
  const displayPxH = Math.max(1, displayHeightPt / PT_PER_PX);
  const scales = [RASTER_SCALE];
  if (naturalWidthPx > 0) scales.push(naturalWidthPx / displayPxW);
  if (naturalHeightPx > 0) scales.push(naturalHeightPx / displayPxH);
  const scale = Math.max(1 / 64, Math.min(...scales));

  let width = Math.max(1, Math.round(displayPxW * scale));
  let height = Math.max(1, Math.round(displayPxH * scale));
  const shrink = Math.max(width / MAX_RASTER_PX, height / MAX_RASTER_PX, 1);
  if (shrink > 1) {
    width = Math.max(1, Math.round(width / shrink));
    height = Math.max(1, Math.round(height / shrink));
  }
  return { width, height };
}

function computeSize(
  spec: ImageSpec,
  naturalWidthPx: number,
  naturalHeightPx: number,
  mode: 'block' | 'inline'
): { width: number; height: number } {
  const naturalW = naturalWidthPx * PT_PER_PX;
  const naturalH = naturalHeightPx * PT_PER_PX;

  if (mode === 'inline') {
    // Icons: cap height, preserve ratio
    const h = Math.min(naturalH, 24);
    return { width: (h / naturalH) * naturalW || h, height: h };
  }

  let targetW: number | null = spec.widthPt;
  if (spec.widthPct !== null) targetW = spec.widthPct * CONTENT_WIDTH;

  if (targetW && spec.heightPt) {
    return fitWithin(targetW, spec.heightPt, naturalW, naturalH);
  }
  if (targetW) {
    const h = (targetW / naturalW) * naturalH;
    if (h > MAX_IMAGE_HEIGHT) {
      targetW = (MAX_IMAGE_HEIGHT / h) * targetW;
    }
    return { width: targetW, height: (targetW / naturalW) * naturalH };
  }
  if (spec.heightPt) {
    return { width: (spec.heightPt / naturalH) * naturalW, height: spec.heightPt };
  }

  // Default: viewer-like fit — full content width, capped at 480px (360pt) tall
  return fitWithin(CONTENT_WIDTH, 360, naturalW, naturalH);
}

function fitWithin(
  maxW: number,
  maxH: number,
  naturalW: number,
  naturalH: number
): { width: number; height: number } {
  const scale = Math.min(maxW / naturalW, maxH / naturalH, 1);
  return { width: naturalW * scale, height: naturalH * scale };
}
