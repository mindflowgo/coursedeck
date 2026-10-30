import { DOMMatrix, DOMPoint } from '@napi-rs/canvas/geometry.js';

// Polyfill DOMMatrix and DOMPoint for environments (Node/Bun/packaged desktop)
// where browser canvas geometry globals are not available natively.
if (typeof globalThis.DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = DOMMatrix;
}
if (typeof globalThis.DOMPoint === 'undefined') {
  (globalThis as any).DOMPoint = DOMPoint;
}

/**
 * Extracts plain text from a PDF buffer safely across both development
 * and packaged desktop (Bun compiled binary) runtimes.
 */
export async function extractTextFromPdf(data: Uint8Array | ArrayBuffer | Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as any;
  const worker = (await import('pdf-parse/worker')) as any;

  // Use embedded worker data URL to avoid physical worker file resolution in compiled binaries
  if (worker && typeof worker.getData === 'function' && typeof PDFParse.setWorker === 'function') {
    PDFParse.setWorker(worker.getData());
  }

  let uint8: Uint8Array;
  if (data instanceof Uint8Array) {
    uint8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    uint8 = new Uint8Array(data);
  }
  const parser = new PDFParse(uint8);
  const parsed = await parser.getText();
  return parsed?.text?.trim() || '';
}
