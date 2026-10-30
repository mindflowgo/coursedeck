/**
 * Pure in-memory store for idle-prewarmed PDF page renders — no Tauri or
 * DOM dependencies, so it stays importable from tests and non-Tauri builds.
 */

export interface PrewarmedPageBlob {
  pageIndex: number;
  url: string;
  scale: number;
}

// One prewarmed page per document — the remembered reading position,
// rendered during idle time so the first visible page is often already in
// hand when the user opens the book tab. Keyed lowercased because the
// prewarm site (route param) and the viewer (manifest course id) may differ
// in casing.
const prewarmedPages = new Map<string, PrewarmedPageBlob>();

function prewarmKey(docPath: string): string {
  return docPath.toLowerCase();
}

function revokeQuietly(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {}
}

/** True when a prewarmed blob matches the wanted page and scale (±10%). */
export function shouldAdoptPrewarmedPage(
  entry: PrewarmedPageBlob,
  pageIndex: number,
  wantedScale: number
): boolean {
  return (
    entry.pageIndex === pageIndex && Math.abs(entry.scale - wantedScale) < 0.10 * wantedScale
  );
}

/** Stores the prewarmed page for a document, replacing any previous one. */
export function storePrewarmedPage(docPath: string, entry: PrewarmedPageBlob): void {
  const key = prewarmKey(docPath);
  const previous = prewarmedPages.get(key);
  if (previous && previous.url !== entry.url) {
    revokeQuietly(previous.url);
  }
  prewarmedPages.set(key, entry);
}

/**
 * Takes the prewarmed page for a document if it matches; returns its blob
 * URL and removes it from the store, or returns null (entry untouched).
 * The caller becomes the blob URL's owner and must revoke it eventually.
 */
export function consumePrewarmedPage(
  docPath: string,
  pageIndex: number,
  wantedScale: number
): string | null {
  const key = prewarmKey(docPath);
  const entry = prewarmedPages.get(key);
  if (!entry || !shouldAdoptPrewarmedPage(entry, pageIndex, wantedScale)) return null;
  prewarmedPages.delete(key);
  return entry.url;
}

/** Drops and revokes the prewarmed page for a document, if any. */
export function discardPrewarmedPages(docPath: string): void {
  const key = prewarmKey(docPath);
  const entry = prewarmedPages.get(key);
  if (entry) {
    revokeQuietly(entry.url);
    prewarmedPages.delete(key);
  }
}
