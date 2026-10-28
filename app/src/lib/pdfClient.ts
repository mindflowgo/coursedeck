import { invoke } from '@tauri-apps/api/core';

export interface PdfPageInfo {
  page_index: number;
  width: number;
  height: number;
}

export interface PdfDocumentInfo {
  page_count: number;
  pages: PdfPageInfo[];
}

export interface TextSpan {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SearchHit {
  page_index: number;
  rects: [number, number, number, number][];
  snippet: string;
}

export function isTauriEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

const docInfoCache = new Map<string, PdfDocumentInfo>();

export async function pdfGetInfo(path: string): Promise<PdfDocumentInfo> {
  const cached = docInfoCache.get(path);
  if (cached) return cached;
  const info = await invoke<PdfDocumentInfo>('pdf_get_info', { path });
  docInfoCache.set(path, info);
  return info;
}

export async function pdfCloseDocument(path: string): Promise<void> {
  docInfoCache.delete(path);
  if (!isTauriEnvironment()) return;
  try {
    await invoke('pdf_close_document', { path });
  } catch (err) {
    console.warn('[PDF] Failed to close document:', err);
  }
}

export async function pdfRenderPage(
  path: string,
  pageIndex: number,
  scale = 1.5,
  quality = 85
): Promise<string> {
  const rawBytes = await invoke<ArrayBuffer>('pdf_render_page', {
    path,
    pageIndex,
    scale,
    quality
  });
  const blob = new Blob([rawBytes], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}

export async function pdfRenderThumbnail(
  path: string,
  pageIndex: number,
  width = 140
): Promise<string> {
  const rawBytes = await invoke<ArrayBuffer>('pdf_render_thumbnail', {
    path,
    pageIndex,
    width
  });
  const blob = new Blob([rawBytes], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}

export async function pdfGetPageText(path: string, pageIndex: number): Promise<TextSpan[]> {
  return await invoke<TextSpan[]>('pdf_get_page_text', { path, pageIndex });
}

export async function pdfSearch(
  path: string,
  query: string,
  matchCase = false,
  maxResults = 200
): Promise<SearchHit[]> {
  return await invoke<SearchHit[]>('pdf_search', {
    path,
    query,
    matchCase,
    maxResults
  });
}

export interface CoursePdfState {
  page: number;
  zoomScale: number;
  sideBarThumbnails: boolean;
}

// Module-level persistent scroll, zoom, and sidebar state per document path,
// with LocalStorage backing so reloads, restarts, and A -> B -> A course round-trips
// restore the user's exact preferences.
export const coursePdfPositions = new Map<string, CoursePdfState>();

export function getCoursePdfState(docPath: string): CoursePdfState | null {
  const inMemory = coursePdfPositions.get(docPath);
  if (inMemory) return inMemory;

  if (typeof window === 'undefined' || !docPath) return null;
  try {
    const raw = localStorage.getItem(`coursedeck_pdf_state_${docPath}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.zoomScale === 'number' && typeof parsed?.page === 'number') {
        const state: CoursePdfState = {
          page: parsed.page,
          zoomScale: Math.max(0.4, Math.min(3.5, parsed.zoomScale)),
          sideBarThumbnails: Boolean(parsed.sideBarThumbnails)
        };
        coursePdfPositions.set(docPath, state);
        return state;
      }
    }
  } catch {}
  return null;
}

export function setCoursePdfState(docPath: string, state: CoursePdfState): void {
  coursePdfPositions.set(docPath, state);
  if (typeof window === 'undefined' || !docPath) return;
  try {
    localStorage.setItem(`coursedeck_pdf_state_${docPath}`, JSON.stringify(state));
  } catch {}
}

export function prewarmCourseBook(courseId: string): void {
  if (typeof window === 'undefined' || !isTauriEnvironment() || !courseId) return;
  const key = `coursedeck_opened_book_${courseId.toLowerCase()}`;
  try {
    if (localStorage.getItem(key)) {
      const url = `/api/courses/${courseId}/assets/locker_docs/course.pdf`;
      const idle = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1200));
      idle(() => {
        void pdfGetInfo(url).catch(() => {});
      });
    }
  } catch {
    // LocalStorage or environment access failure ignored
  }
}

export function recordCourseBookOpened(courseId: string): void {
  if (typeof window === 'undefined' || !courseId) return;
  try {
    localStorage.setItem(`coursedeck_opened_book_${courseId.toLowerCase()}`, '1');
  } catch {}
}
