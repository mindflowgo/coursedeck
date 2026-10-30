import type { Content } from 'pdfmake/build/pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { createBrowserImageStore } from './imageStore';
import { getPdfMake } from './pdfClient';
import { buildDocDefinition, buildFilename } from './document';
import { compileMarkdownContent } from './markdown/blocks';
import { compileQuizContent } from './quiz';
import type { CompileContext, ExportTab, PdfExportOptions } from './types';
import { isTauriEnvironment } from '$lib/api';

/**
 * Vector PDF export engine.
 *
 * Compiles the active study document (lessons / summary / notes /
 * practice test) from raw markdown into a pdfmake document definition and
 * downloads it as a real text PDF: selectable, searchable, and fast —
 * no full-page canvas rasterization, no html2canvas.
 *
 * The pieces are deliberately modular for reuse (e.g. course-booklet export):
 *   compileMarkdownContent(md, ctx)  — markdown → pdfmake content blocks
 *   compileQuizContent(md)           — KICA test → exam sheet + answer key
 *   buildDocDefinition(options, body)— full document with header/footer
 */
export async function exportDocumentToPdf(options: PdfExportOptions): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('PDF export can only be run in a browser environment');
  }
  if (!options.rawMarkdown || !options.rawMarkdown.trim()) {
    throw new Error('No content available for PDF generation');
  }

  const startedAt = performance.now();
  console.log(
    `[PDF] Export started: ${options.tab} • ${options.courseCode.toUpperCase()} ${options.lessonId}`
  );

  // Warm the engine + fonts in parallel with compilation (one-time cost)
  const enginePromise = getPdfMake();

  const store = createBrowserImageStore();
  const ctx: CompileContext = {
    courseId: options.courseCode,
    embedImage: store.embed,
    images: store
  };

  console.log('[PDF] Compiling markdown → vector content…');
  const compileStart = performance.now();
  const body: Content[] =
    options.tab === 'test'
      ? compileQuizContent(options.rawMarkdown)
      : compileMarkdownContent(options.rawMarkdown, ctx);
  console.log(
    `[PDF] Content compiled in ${(performance.now() - compileStart).toFixed(0)}ms (${body.length} blocks)`
  );

  // Resolve every embedded image before handing the tree to pdfmake
  if (store.stats.unique > 0) {
    console.log(`[PDF] Loading ${store.stats.unique} image(s)…`);
  }
  const imageStart = performance.now();
  await store.settle();
  if (store.stats.unique > 0) {
    console.log(
      `[PDF] Images done in ${(performance.now() - imageStart).toFixed(0)}ms — ${store.stats.resolved} loaded, ${store.stats.failed} failed`
    );
  }

  const doc = buildDocDefinition(options, body);

  console.log('[PDF] Rendering PDF document…');
  const renderStart = performance.now();
  const pdfMake = await enginePromise;
  const blob = await pdfMake.createPdf(doc).getBlob();
  console.log(`[PDF] Rendered ${(blob.size / 1024).toFixed(0)}KB in ${(performance.now() - renderStart).toFixed(0)}ms`);

  const filename = buildFilename(options);
  const outcome = await savePdfBlob(blob, filename);
  if (outcome === 'cancelled') {
    console.log('[PDF] ✖ Save cancelled by user');
  } else {
    console.log(`[PDF] ✔ Done in ${(performance.now() - startedAt).toFixed(0)}ms → ${outcome ?? filename}`);
  }
}

// ---------------------------------------------------------------------------
// Save destinations: native save dialog (Tauri) → File System Access API →
// plain browser download, whichever the host supports.
// ---------------------------------------------------------------------------

async function savePdfBlob(blob: Blob, filename: string): Promise<'cancelled' | string | null> {
  if (isTauriEnvironment()) {
    const [{ save }, { invoke }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/api/core')
    ]);
    const path: string | null = await save({
      defaultPath: filename,
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
    });
    if (!path) return 'cancelled';

    console.log(`[PDF] Saving to ${path}…`);
    const dataB64 = await blobToBase64(blob);
    await invoke('save_pdf_file', { path, dataB64 });
    return path;
  }

  // Plain browser: real save prompt where supported (Chromium)
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'PDF Document', accept: { 'application/pdf': ['.pdf'] } }]
      });
      console.log(`[PDF] Saving to ${handle.name}…`);
      const stream = await handle.createWritable();
      await stream.write(blob);
      await stream.close();
      return handle.name;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Other failures fall through to a plain download
    }
  }

  downloadBlob(blob, filename);
  return null;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Reusable building blocks for future exporters (booklets, DOCX, etc.)
// ---------------------------------------------------------------------------

export { compileMarkdownContent, compileQuizContent, buildDocDefinition, buildFilename };
export type { PdfExportOptions, ExportTab, CompileContext, Content, TDocumentDefinitions };
