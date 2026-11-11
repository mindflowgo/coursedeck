import { invoke, Channel } from '@tauri-apps/api/core';
import { isTauriEnvironment } from '$lib/pdfClient';

export interface CompanionResult {
  companion_path?: string;
  markdown: string;
  page_count: number;
  pdf_type: string;
  used_ocr: boolean;
  pages_needing_ocr: number[];
}

export interface CompanionProgress {
  current_page: number;
  total_pages: number;
  stage: 'inspecting' | 'extracting' | 'ocr' | 'done' | string;
  is_ocr: boolean;
  message: string;
}

export type ProgressCallback = (progress: CompanionProgress) => void;

/**
 * Generate companion markdown for a PDF file at `path` using the native Tauri backend
 * (`pdf-inspector` + OS native OCR if desktop and pages require OCR).
 * Saves to `<path>.companion.md` alongside the PDF.
 */
export async function generateCompanion(
  path: string,
  force: boolean = false,
  onProgress?: ProgressCallback
): Promise<CompanionResult | null> {
  if (!isTauriEnvironment()) return null;
  const channel = new Channel<CompanionProgress>();
  if (onProgress) {
    channel.onmessage = onProgress;
  }
  return await invoke<CompanionResult>('pdf_generate_companion', {
    path,
    force,
    onProgress: channel
  });
}

/**
 * Read the companion markdown for a PDF if it exists on disk.
 */
export async function readCompanion(path: string): Promise<string | null> {
  if (!isTauriEnvironment()) return null;
  return await invoke<string | null>('pdf_read_companion', { path });
}

/**
 * Extract companion markdown directly from raw in-memory PDF bytes.
 * If `pdfPath` is provided, the companion markdown will also be saved to `<pdfPath>.companion.md`.
 */
export async function extractCompanionFromBytes(
  bytes: Uint8Array | number[],
  pdfPath?: string,
  onProgress?: ProgressCallback
): Promise<CompanionResult | null> {
  if (!isTauriEnvironment()) return null;
  const byteArray = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
  const channel = new Channel<CompanionProgress>();
  if (onProgress) {
    channel.onmessage = onProgress;
  }
  return await invoke<CompanionResult>('pdf_extract_companion_from_bytes', {
    bytes: byteArray,
    pdfPath: pdfPath || null,
    onProgress: channel
  });
}
