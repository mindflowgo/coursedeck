import { docFileName, parseDocFileName, courseTabHref } from './tabs';
import { parsePdfPageFileKey } from './markup/pdfMarkup';
import type { MarkupStroke } from './markup/types';

/**
 * Checkpoint domain models, color palette, and routing utilities.
 */

export type CheckpointType = 'note' | 'position' | 'markup';

export interface Checkpoint {
  id: string;
  courseId?: string;
  file: string; // e.g. "01.01.lesson.md", "course.summary.md"
  verticalPosition: number;
  type: CheckpointType;
  color?: string; // color id: 'coral' | 'orange' | 'amber' | 'yellow' | 'lime' | 'mint' | 'teal' | 'sky' | 'blue' | 'indigo' | 'purple' | 'pink'
  noteText?: string;
  date: string; // ISO 8601
}

export interface CheckpointColor {
  id: string;
  label: string;
  dot: string;
  set: 1 | 2;
  isLight: boolean;
  bgLight: string;
  bgDark: string;
  borderLight: string;
  borderDark: string;
  textLight: string;
  textDark: string;
}

/**
 * 10-color palette grouped into two distinct 5-color sets:
 * - Set 1 (Pastel Tones): Aqua (#a7f8ef), Canary Yellow (#f7fa6d), Soft Lavender (#d5b3ff), Golden Yellow (#ffd000), Pastel Pink (#f086be)
 * - Set 2 (Vibrant Tones): Tangerine Orange (#ffa417), Electric Blue (#0055ff), Coral Red (#ff5a3c), Electric Cyan (#3ce1ff), Neon Green (#48ff40)
 */
export const CHECKPOINT_COLORS: CheckpointColor[] = [
  // --- Set 1: Pastel / Soft Tones ---
  {
    id: 'aqua',
    label: 'Aqua Mint',
    dot: '#a7f8ef',
    set: 1,
    isLight: true,
    bgLight: '#e6fcf8',
    bgDark: '#0c2f2b',
    borderLight: '#7eece0',
    borderDark: '#13635b',
    textLight: '#0d524b',
    textDark: '#bdfbf3'
  },
  {
    id: 'yellow',
    label: 'Canary Yellow',
    dot: '#f7fa6d',
    set: 1,
    isLight: true,
    bgLight: '#fefee4',
    bgDark: '#2e2e07',
    borderLight: '#e8ec53',
    borderDark: '#64640c',
    textLight: '#4a4a06',
    textDark: '#fbfcbe'
  },
  {
    id: 'lavender',
    label: 'Soft Lavender',
    dot: '#d5b3ff',
    set: 1,
    isLight: true,
    bgLight: '#f6f0ff',
    bgDark: '#281945',
    borderLight: '#be94fd',
    borderDark: '#5f379e',
    textLight: '#441d7d',
    textDark: '#ecd9ff'
  },
  {
    id: 'gold',
    label: 'Golden Yellow',
    dot: '#ffd000',
    set: 1,
    isLight: true,
    bgLight: '#fff9df',
    bgDark: '#382b00',
    borderLight: '#fed21e',
    borderDark: '#856400',
    textLight: '#543d00',
    textDark: '#ffeab0'
  },
  {
    id: 'pink',
    label: 'Pastel Pink',
    dot: '#f086be',
    set: 1,
    isLight: true,
    bgLight: '#fdf0f7',
    bgDark: '#3b1528',
    borderLight: '#ec72b0',
    borderDark: '#8a2157',
    textLight: '#6e1241',
    textDark: '#fccee4'
  },

  // --- Set 2: Vibrant Tones ---
  {
    id: 'orange',
    label: 'Tangerine Orange',
    dot: '#ffa417',
    set: 2,
    isLight: true,
    bgLight: '#fff4e5',
    bgDark: '#3b1f00',
    borderLight: '#ff9b05',
    borderDark: '#8f4900',
    textLight: '#693000',
    textDark: '#ffddad'
  },
  {
    id: 'blue',
    label: 'Electric Blue',
    dot: '#0055ff',
    set: 2,
    isLight: false,
    bgLight: '#ebf2ff',
    bgDark: '#0a1f5c',
    borderLight: '#85afff',
    borderDark: '#1a52db',
    textLight: '#002b8a',
    textDark: '#d4e3ff'
  },
  {
    id: 'coral',
    label: 'Coral Red',
    dot: '#ff5a3c',
    set: 2,
    isLight: false,
    bgLight: '#ffedea',
    bgDark: '#3d1109',
    borderLight: '#ff7b63',
    borderDark: '#942410',
    textLight: '#731707',
    textDark: '#ffd3cb'
  },
  {
    id: 'cyan',
    label: 'Electric Cyan',
    dot: '#3ce1ff',
    set: 2,
    isLight: true,
    bgLight: '#e8fbff',
    bgDark: '#06303d',
    borderLight: '#5fe6ff',
    borderDark: '#0e6f8a',
    textLight: '#084f63',
    textDark: '#bdf4ff'
  },
  {
    id: 'green',
    label: 'Neon Green',
    dot: '#48ff40',
    set: 2,
    isLight: true,
    bgLight: '#eaffea',
    bgDark: '#0a3608',
    borderLight: '#62ff5b',
    borderDark: '#177a13',
    textLight: '#0d590a',
    textDark: '#caffc6'
  }
];

export const DEFAULT_CHECKPOINT_COLOR = 'yellow';

const LEGACY_COLOR_MAP: Record<string, string> = {
  amber: 'gold',
  lime: 'green',
  mint: 'aqua',
  teal: 'aqua',
  sky: 'cyan',
  indigo: 'lavender',
  purple: 'lavender',
  rose: 'pink'
};

export function getCheckpointColor(colorId?: string): CheckpointColor {
  const fallback = CHECKPOINT_COLORS.find((c) => c.id === DEFAULT_CHECKPOINT_COLOR) || CHECKPOINT_COLORS[1];
  if (!colorId) return fallback;
  const normalized = colorId.toLowerCase();
  const alias = LEGACY_COLOR_MAP[normalized] || normalized;
  const found = CHECKPOINT_COLORS.find(
    (c) => c.id.toLowerCase() === alias || c.dot.toLowerCase() === normalized
  );
  return found || fallback;
}

/**
 * Re-export canonical filename resolution from `$lib/tabs`.
 */
export const resolveFileFromRoute = docFileName;

/**
 * Parses a disk filename back into its scope, lessonId, and tab slug.
 * Kept for backwards compatibility, delegating to `parseDocFileName` in `$lib/tabs`.
 */
export function resolveRouteFromFile(file: string): { isCourseScope: boolean; isUnitScope: boolean; lessonId: string; tab: string; unitNumber?: number } {
  const parsed = parseDocFileName(file);
  return parsed ?? {
    isCourseScope: false,
    isUnitScope: false,
    lessonId: '',
    tab: 'lesson'
  };
}

/**
 * Builds the URL to jump to a checkpoint on a course page.
 */
export function getCheckpointHref(courseId: string, checkpoint: Checkpoint): string {
  const pdfKey = parsePdfPageFileKey(checkpoint.file);
  if (pdfKey) {
    const cId = (courseId || checkpoint.courseId || '').trim().toLowerCase();
    return `/courses/${cId}/course/book?page=${pdfKey.pageNumber}`;
  }
  const parsed = parseDocFileName(checkpoint.file);
  const base = parsed
    ? courseTabHref(courseId, parsed.lessonId, parsed.tab, parsed.isCourseScope)
    : `/courses/${(courseId || '').toLowerCase()}`;
  return `${base}?checkpoint=${encodeURIComponent(checkpoint.id)}`;
}

/**
 * Synthesizes checkpoint items for each PDF page that contains active (non-deleted) annotations.
 * Aggregates all strokes on the same page into a single entry labeled "Annotations" for "p X".
 */
export function derivePdfMarkupCheckpoints(
  courseId: string,
  courseTitle: string,
  strokes: MarkupStroke[]
): Array<Checkpoint & { courseId: string; courseTitle: string }> {
  const byPage = new Map<number, { pageNumber: number; file: string; date: string }>();

  for (const s of strokes) {
    if (s.deleted) continue;
    const pdfKey = parsePdfPageFileKey(s.file);
    if (!pdfKey) continue;

    const existing = byPage.get(pdfKey.pageNumber);
    if (!existing || new Date(s.date || 0).getTime() > new Date(existing.date || 0).getTime()) {
      byPage.set(pdfKey.pageNumber, {
        pageNumber: pdfKey.pageNumber,
        file: s.file,
        date: s.date || new Date().toISOString()
      });
    }
  }

  const list: Array<Checkpoint & { courseId: string; courseTitle: string }> = [];
  for (const item of byPage.values()) {
    list.push({
      id: `markup_${courseId.toLowerCase()}_p${item.pageNumber}`,
      courseId,
      courseTitle,
      file: item.file,
      verticalPosition: 0,
      type: 'markup',
      noteText: 'Annotations',
      date: item.date,
      color: 'gold'
    });
  }

  return list;
}

/**
 * Formats a checkpoint timestamp in a friendly, concise format.
 */
export function formatCheckpointDate(isoDate: string): string {
  if (!isoDate) return '';
  try {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const isThisYear = d.getFullYear() === now.getFullYear();

    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(isThisYear ? {} : { year: 'numeric' })
    });
  } catch {
    return '';
  }
}
