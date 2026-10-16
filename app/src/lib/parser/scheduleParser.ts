import { parseFrontmatter } from './frontmatter';
import { TAB_SLUG_PATTERN } from '../tabs';
import { Marked } from 'marked';

export interface ScheduleEvent {
  done: boolean;
  /** YYYY-MM-DD from the enclosing `###` day header ('' when none seen yet). */
  date: string;
  dayLabel?: string;
  /** Lowercase activity token: study | review | practice | assignment | submit | exam | catchup (free-form tolerated). */
  type: string;
  /** Lesson id, e.g. 01.05 or 01.05_assign1. */
  lessonId: string;
  /** Optional sub-artifact: summary | cheatsheet | test | study | research | … */
  section?: string;
  title: string;
  /** Joined indented lines directly under the entry. */
  description?: string;
  durationMin?: number;
  /** Line of the checkbox in the raw markdown — used by toggleEventDone. */
  lineIndex: number;
}

export interface ParsedSchedule {
  title: string;
  summaryLine?: string;
  events: ScheduleEvent[];
}

/** Tolerates `### 2026-10-13 · Tue`, `### 2026-10-13 - Tuesday`, `### 2026-10-13 (Wed)`, `### 2026-10-13` */
function matchDayHeader(line: string): { date: string; dayLabel?: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('###')) return null;

  // Look for ISO date YYYY-MM-DD
  const isoMatch = trimmed.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (!isoMatch) return null;

  const date = isoMatch[1];
  const dayMatch = trimmed.match(
    /\b(Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b/i
  );
  const dayLabel = dayMatch ? dayMatch[1].slice(0, 3) : undefined;

  return { date, dayLabel };
}

/** Tolerates `- [ ]`, `* [ ]`, hyphens, em-dashes, en-dashes, colons, and optional lesson ids. */
const ENTRY_RE =
  /^[-*]\s*\[([ xX])\]\s+\*\*([A-Za-z]+)\*\*(?:\s+([0-9a-zA-Z._-]+)(?:\/([A-Za-z0-9_-]+))?)?(?:\s*(?:[—–\-:]|--)\s*(.*)|\s+(.*))?$/;

/** Trailing `(60m)`, `(60 min)`, `(1h)`, `(1.5h)`, `(2 hrs)` on the title. */
const DURATION_RE = /\((\d+(?:\.\d+)?)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)\)\s*$/i;

/** Course-level document tabs only — custom tabs never exist at course scope. */
const COURSE_DOC_TABS = ['summary', 'cheatsheet', 'test'];

/**
 * Sections that resolve to a lesson tab page: built-in tabs and any custom
 * tab slug (assignment, research, …). Dashed or otherwise non-slug sections
 * stay free-form labels.
 */
export function isLinkableSection(section: string): boolean {
  return TAB_SLUG_PATTERN.test(section);
}

export class ScheduleParser {
  static parseMarkdown(markdown: string): ParsedSchedule {
    // Line indices must reference the RAW markdown (toggleEventDone operates on
    // it), so the frontmatter block is skipped by offset instead of stripped.
    const lines = markdown.split('\n');
    let start = 0;
    if (lines[0]?.trim() === '---') {
      const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
      if (end > 0) start = end + 1;
    }

    let title = '';
    let summaryLine: string | undefined;
    let currentDate = '';
    let currentDay: string | undefined;
    const events: ScheduleEvent[] = [];
    let openEvent: ScheduleEvent | null = null;
    let descLines: string[] = [];

    const closeDescription = () => {
      if (openEvent && descLines.length > 0) {
        openEvent.description = descLines.join(' ');
      }
      descLines = [];
    };

    for (let i = start; i < lines.length; i++) {
      const line = lines[i];

      const dayMatch = matchDayHeader(line);
      if (dayMatch) {
        closeDescription();
        currentDate = dayMatch.date;
        currentDay = dayMatch.dayLabel;
        openEvent = null;
        continue;
      }

      const entryMatch = line.match(ENTRY_RE);
      if (entryMatch) {
        closeDescription();
        const [, box, rawType, rawRef, section, rest1, rest2] = entryMatch;
        let titleText = (rest1 || rest2 || '').trim();
        let durationMin: number | undefined;
        const durMatch = titleText.match(DURATION_RE);
        if (durMatch) {
          const val = parseFloat(durMatch[1]);
          const unit = durMatch[2].toLowerCase();
          durationMin = unit.startsWith('h') ? Math.round(val * 60) : Math.round(val);
          titleText = titleText.slice(0, durMatch.index).trim();
        }

        // Normalize lesson reference if single-digit (e.g. 1.01 -> 01.01)
        let ref = rawRef || rawType.toLowerCase();
        if (/^\d\.\d{2}/.test(ref)) {
          ref = `0${ref}`;
        }

        openEvent = {
          done: box.toLowerCase() === 'x',
          date: currentDate,
          dayLabel: currentDay,
          type: rawType.toLowerCase(),
          lessonId: ref,
          section,
          title: titleText || rawType,
          durationMin,
          lineIndex: i
        };
        events.push(openEvent);
        continue;
      }

      // Indented line directly under an entry continues its description.
      if (openEvent && line.trim() && /^\s{2,}|^\t/.test(line)) {
        descLines.push(line.trim());
        continue;
      }

      // Anything else (blank line, prose, week heading) ends description
      // collection; headings we care about are captured along the way.
      closeDescription();
      if (!title && /^#\s+(.+)$/.test(line)) {
        title = line.replace(/^#\s+/, '').trim();
      } else if (!summaryLine && /^\*(.+)\*$/.test(line.trim())) {
        summaryLine = line.trim().replace(/^\*/, '').replace(/\*$/, '');
      }
    }
    closeDescription();

    // Fallback: If no checklist events were recognized, check if the LLM produced a markdown table
    if (events.length === 0) {
      const tableEvents = this.parseTableFallback(lines, start);
      if (tableEvents.length > 0) {
        return {
          title: title || 'Study Schedule',
          summaryLine,
          events: tableEvents
        };
      }
    }

    return { title, summaryLine, events };
  }

  /**
   * Fallback parser for when an LLM emits a Markdown table instead of checkboxes.
   */
  private static parseTableFallback(lines: string[], startLine: number): ScheduleEvent[] {
    const tableRows: { text: string; lineIndex: number }[] = [];
    for (let i = startLine; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('|') && !trimmed.includes('---')) {
        tableRows.push({ text: trimmed, lineIndex: i });
      }
    }
    if (tableRows.length < 2) return [];

    const headers = tableRows[0].text
      .split('|')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const dateCol = headers.findIndex((h) => h.includes('date'));
    const dayCol = headers.findIndex((h) => h.includes('day'));
    const focusCol = headers.findIndex(
      (h) => h.includes('focus') || h.includes('topic') || h.includes('lesson')
    );
    const notesCol = headers.findIndex((h) => h.includes('note') || h.includes('review'));

    if (focusCol === -1) return [];

    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };

    const events: ScheduleEvent[] = [];
    for (let i = 1; i < tableRows.length; i++) {
      const row = tableRows[i];
      const cols = row.text
        .split('|')
        .map((s) => s.trim())
        .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (cols.length <= focusCol) continue;

      const rawFocus = cols[focusCol] || '';
      const rawDate = dateCol !== -1 ? cols[dateCol] || '' : '';
      const rawDay = dayCol !== -1 ? cols[dayCol] || '' : '';
      const rawNotes = notesCol !== -1 ? cols[notesCol] || '' : '';

      const lessonMatch = rawFocus.match(/\b(\d{1,2}\.\d{1,2}(?:_[A-Za-z0-9]+)?)\b/);
      let lessonId = lessonMatch ? lessonMatch[1] : '01.01';
      if (/^\d\.\d{2}/.test(lessonId)) {
        lessonId = `0${lessonId}`;
      }

      // Normalize date to YYYY-MM-DD
      let isoDate = '';
      const isoMatch = rawDate.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (isoMatch) {
        isoDate = isoMatch[1];
      } else {
        const monthMatch = rawDate.match(
          /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b[a-z]*\s+(\d{1,2})/i
        );
        if (monthMatch) {
          const m = months[monthMatch[1].toLowerCase().slice(0, 3)];
          const d = monthMatch[2].padStart(2, '0');
          const currentYear = new Date().getFullYear();
          const year = parseInt(m, 10) < 6 ? currentYear + 1 : currentYear;
          isoDate = `${year}-${m}-${d}`;
        }
      }

      const isDone = row.text.includes('[x]') || row.text.includes('[X]');
      const isReview = rawFocus.toLowerCase().includes('review');
      const isAssignment =
        rawFocus.toLowerCase().includes('summative') ||
        rawFocus.toLowerCase().includes('assignment') ||
        rawFocus.toLowerCase().includes('submit');
      const isCatchup = rawFocus.toLowerCase().includes('catch-up') || rawFocus.toLowerCase().includes('catchup');

      const type = isCatchup ? 'catchup' : isReview ? 'review' : isAssignment ? 'assignment' : 'study';
      const cleanTitle = rawFocus
        .replace(/\*\*/g, '')
        .replace(/^Orientation\s*\+\s*/i, '')
        .trim();

      events.push({
        done: isDone,
        date: isoDate,
        dayLabel: rawDay || undefined,
        type,
        lessonId,
        title: cleanTitle,
        description: rawNotes && rawNotes !== '—' && rawNotes !== '-' ? rawNotes : undefined,
        durationMin: 60,
        lineIndex: row.lineIndex
      });
    }

    return events;
  }
}

/**
 * Flips the checkbox on the given raw-markdown line and nothing else —
 * hand edits anywhere else in the file are preserved byte-for-byte.
 */
export function toggleEventDone(markdown: string, lineIndex: number): string {
  if (!Number.isInteger(lineIndex) || lineIndex < 0) return markdown;
  const lines = markdown.split('\n');
  const line = lines[lineIndex];
  if (line === undefined) return markdown;

  let flipped = line.replace(
    /^(\s*[-*]\s*\[)([ xX])(\])/,
    (_m, a: string, b: string, c: string) => a + (b === ' ' ? 'x' : ' ') + c
  );

  // Fallback for markdown table rows
  if (flipped === line && line.trim().startsWith('|')) {
    if (line.includes('[ ]')) {
      flipped = line.replace('[ ]', '[x]');
    } else if (line.includes('[x]') || line.includes('[X]')) {
      flipped = line.replace(/\[[xX]\]/, '[ ]');
    }
  }

  if (flipped === line) return markdown;
  lines[lineIndex] = flipped;
  return lines.join('\n');
}

/**
 * Deep link for an event:
 * Produces /courses/{courseId}/{lessonId}/{section} for linkable sections
 * (built-in or custom tabs — visiting one creates the tab if absent),
 * /courses/{courseId}/{lessonId} when section is omitted or free-form,
 * and /courses/{courseId}/course/{section} for course-level events.
 */
export function eventHref(
  courseId: string,
  event: Pick<ScheduleEvent, 'lessonId' | 'section'>
): string {
  const cId = (courseId || '').toLowerCase();
  const rawLesson = (event.lessonId || '').trim();

  if (rawLesson.toLowerCase() === 'schedule' || rawLesson.toLowerCase() === 'catchup') {
    return `/courses/${cId}/course/schedule`;
  }

  if (rawLesson.toLowerCase() === 'course') {
    const sec =
      event.section && COURSE_DOC_TABS.includes(event.section) ? `/${event.section}` : '';
    return `/courses/${cId}/course${sec}`;
  }

  const lesson = encodeURIComponent(rawLesson);
  if (event.section && isLinkableSection(event.section)) {
    return `/courses/${cId}/${lesson}/${event.section}`;
  }
  return `/courses/${cId}/${lesson}`;
}

/** Convenience re-export so callers can round-trip like other parsers. */
export { parseFrontmatter };

const inlineMarked = new Marked({ gfm: true, breaks: false });

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safely renders inline Markdown (such as **bold**, *italic*, `code`) into HTML,
 * escaping raw HTML tags to prevent XSS.
 */
export function renderInlineMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  const escaped = escapeHtml(text);
  try {
    return inlineMarked.parseInline(escaped) as string;
  } catch {
    return escaped;
  }
}

