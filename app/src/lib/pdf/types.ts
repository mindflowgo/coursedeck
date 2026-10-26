import type { Content } from 'pdfmake/build/pdfmake';

/** Which study-workspace tab is being exported — fixed tabs or a custom tab slug. */
export type ExportTab = 'lesson' | 'summary' | 'studysheet' | 'test' | 'schedule' | (string & {});

export interface PdfExportOptions {
  courseCode: string;
  courseTitle: string;
  lessonId: string;
  lessonTitle: string;
  tab: ExportTab;
  tabDisplayName: string;
  /** Raw markdown of the active document (test tabs use the KICA quiz format). */
  rawMarkdown: string;
}

/** Display label used in the document header for each tab type. */
export function tabBadgeLabel(tab: ExportTab): string {
  switch (tab) {
    case 'lesson':
      return 'Course Notes • Full Lesson';
    case 'summary':
      return 'High-Yield Study Summary';
    case 'studysheet':
      return 'Quick Reference Cheatsheet';
    case 'test':
      return 'Ontario Curriculum Practice Test';
    case 'schedule':
      return 'Study Schedule';
    default:
      // Custom tabs: title-case the slug ("assignment" -> "Assignment").
      return tab
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
  }
}

/** Parsed `![alt|spec](url)` sizing spec, mirroring MarkdownViewer.parseImageSpec. */
export interface ImageSpec {
  alt: string;
  /** Requested width in pt, or % of content width (0-1), or null. */
  widthPt: number | null;
  widthPct: number | null;
  heightPt: number | null;
  isCustom: boolean;
}

/**
 * A mutable content node standing in for an image. The embedder fills
 * `image`/`width`/`height` synchronously or resolves them before `settle()`
 * completes; on failure it degrades to a text placeholder.
 */
export interface EmbeddedImage {
  image?: string;
  width?: number;
  height?: number;
  text?: string;
  [key: string]: unknown;
}

/**
 * Enqueues an image for embedding and returns its mutable placeholder node.
 * Implementations: browser fetch+decode store, or a stub for tests/CLI use.
 */
export type ImageEmbedder = (
  url: string,
  spec: ImageSpec,
  mode: 'block' | 'inline'
) => EmbeddedImage;

/** Awaits all outstanding image loads placed by an ImageEmbedder. */
export interface ImageSettler {
  settle(): Promise<void>;
}

/** Context threaded through the markdown → pdfmake compiler. */
export interface CompileContext {
  /** Used to resolve relative `assets/...` paths to `/api/courses/{id}/assets/...`. */
  courseId: string;
  embedImage: ImageEmbedder;
  /** Optional handle awaited once compilation finishes. */
  images?: ImageSettler;
}

/** A compiled block sequence, ready to drop into a pdfmake doc definition. */
export type PdfContent = Content[];
