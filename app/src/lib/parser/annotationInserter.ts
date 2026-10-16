/**
 * Utilities for formatting, inserting, and managing > [!USERNOTE] annotations in Markdown.
 */

export interface UserNoteData {
  query: string;
  targetText: string;
  answer: string;
}

/** Opens an AI study note callout. */
const NOTE_START_PATTERN = /^\s*>\s*\[!USERNOTE\]/i;
const TARGET_COMMENT_PATTERN = /<!--\s*target:\s*"([\s\S]*?)"\s*-->/i;
/** Shorter matches than this are too ambiguous for the looser comparison. */
const MIN_PARTIAL_ANCHOR_LENGTH = 4;

/**
 * A note is one blockquote run: every line whose first character is `>` belongs
 * to it, so a marker quoted inside an answer (`> [!NOTE]`, even `> [!USERNOTE]`)
 * never splits the block, and adjacent notes must be blank-line separated —
 * which `insertAnnotationAfterText` always produces. The reader's note regex
 * consumes that same run, so a deletion removes the answer whole. (The reader's
 * callout pass runs first, so a marker-only line inside an answer may also
 * render as its own callout card; that text is part of the stored answer and is
 * removed with the note.)
 */
function isNoteBodyLine(line: string): boolean {
  return line.startsWith('>');
}

/** Mirrors the reader's own decode of the stored target text. */
function unescapeTargetText(text: string): string {
  return text.replace(/\\"/g, '"').trim();
}

/**
 * Formats a user note into standard GFM callout block.
 */
export function formatUserNote(query: string, targetText: string, answer: string): string {
  const cleanQuery = query.trim().replace(/\n+/g, ' ');
  const cleanTarget = targetText.trim().replace(/\r?\n+/g, ' ').replace(/"/g, '\\"');
  
  // Format body with leading blockquote prefix on each line
  const answerLines = answer.trim().split('\n').map((line) => {
    return line.length > 0 ? `> ${line}` : '>';
  }).join('\n');

  return `> [!USERNOTE] ${cleanQuery}\n> <!-- target: "${cleanTarget}" -->\n${answerLines}`;
}

/**
 * Escapes regex special characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inserts a noteBlock into markdown immediately after the paragraph containing selectedText.
 */
export function insertAnnotationAfterText(
  markdown: string,
  selectedText: string,
  noteBlock: string
): { updatedMarkdown: string; success: boolean } {
  if (!markdown || !selectedText) {
    return { updatedMarkdown: markdown, success: false };
  }

  const cleanTarget = selectedText.trim();
  if (!cleanTarget) {
    return { updatedMarkdown: markdown, success: false };
  }

  // 1. Try exact match first
  let matchIndex = markdown.indexOf(cleanTarget);

  // 2. If not found, try flexible whitespace match (markdown might have soft linebreaks)
  let matchedLength = cleanTarget.length;
  if (matchIndex === -1) {
    const tokens = cleanTarget.split(/\s+/).filter(Boolean).map(escapeRegex);
    if (tokens.length > 0) {
      const flexRegex = new RegExp(tokens.join('\\s+'), 'm');
      const m = markdown.match(flexRegex);
      if (m && m.index !== undefined) {
        matchIndex = m.index;
        matchedLength = m[0].length;
      }
    }
  }

  // 3. Fallback: if text still cannot be found (e.g. truncated or sanitized), append at end of file
  if (matchIndex === -1) {
    const updated = `${markdown.trimEnd()}\n\n${noteBlock.trim()}\n`;
    return { updatedMarkdown: updated, success: true };
  }

  // 4. Find the end of the paragraph containing the matched text
  const textAfterMatch = markdown.slice(matchIndex + matchedLength);
  const nextParagraphBreak = textAfterMatch.search(/\n\s*\n/);

  let insertionIndex: number;
  if (nextParagraphBreak !== -1) {
    insertionIndex = matchIndex + matchedLength + nextParagraphBreak;
  } else {
    // End of the document
    insertionIndex = markdown.length;
  }

  const before = markdown.slice(0, insertionIndex).trimEnd();
  const after = markdown.slice(insertionIndex).trimStart();

  const updatedMarkdown = `${before}\n\n${noteBlock.trim()}\n\n${after}`.trimEnd() + '\n';
  return { updatedMarkdown, success: true };
}

/**
 * Removes the `> [!USERNOTE]` callout matching `targetText` (the annotated
 * passage) and/or `query` (the student's question). Both are matched when both
 * are supplied, so two notes on the same passage are told apart by their
 * question; either alone falls back to whichever the note carries.
 *
 * Line-based on purpose: a regex over the whole document cannot match a target
 * that contains a `"` (the note stores it escaped as `\"`, see `formatUserNote`)
 * and its `$` terminator misses a note sitting at the end of the file — both
 * left the note in place. Scan note blocks, match, splice out exactly the
 * matched block plus the blank line that separated it, and leave every other
 * byte of the document untouched.
 */
export function removeAnnotation(
  markdown: string,
  targetText: string,
  query = ''
): { updatedMarkdown: string; removed: boolean } {
  const anchors = [targetText, query].map((anchor) => (anchor || '').trim()).filter(Boolean);
  if (!markdown || anchors.length === 0) {
    return { updatedMarkdown: markdown, removed: false };
  }

  // Split on '\n' alone so each line keeps its own '\r'; offsets are then the
  // only thing the splice needs and everything outside it stays byte-identical.
  const lines = markdown.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  let best: { start: number; end: number; score: number } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    if (!NOTE_START_PATTERN.test(lines[i])) continue;

    let end = i;
    while (end + 1 < lines.length && isNoteBodyLine(lines[end + 1])) {
      end += 1;
    }

    const blockQuery = lines[i].replace(NOTE_START_PATTERN, '').trim();
    const targetMatch = lines.slice(i, end + 1).join('\n').match(TARGET_COMMENT_PATTERN);
    const blockTarget = targetMatch ? unescapeTargetText(targetMatch[1]) : '';

    // Exact identity is what the reader's delete button always supplies; the
    // looser comparison only rescues notes whose stored text drifted (hand
    // edits, whitespace/collapse differences) and needs enough text on both
    // sides to be safe.
    let score = 0;
    for (const anchor of anchors) {
      if (blockTarget === anchor || blockQuery === anchor) {
        score += 2;
      } else if (
        anchor.length >= MIN_PARTIAL_ANCHOR_LENGTH &&
        ((blockQuery.includes(anchor)) ||
          (blockTarget.length >= MIN_PARTIAL_ANCHOR_LENGTH &&
            (blockTarget.includes(anchor) || anchor.includes(blockTarget))))
      ) {
        score += 1;
      }
    }

    // Strictly greater, so the first of equally good candidates wins.
    if (score > 0 && (best === null || score > best.score)) {
      best = { start: i, end, score };
      if (score === anchors.length * 2) break;
    }
    i = end;
  }

  if (!best) {
    return { updatedMarkdown: markdown, removed: false };
  }

  // Cut from the note's first character to the start of the line after it...
  const cutStart = lineStarts[best.start];
  let cutEnd = best.end + 1 < lines.length ? lineStarts[best.end + 1] : markdown.length;

  // ...plus the blank separator line the note was inserted with, but only when
  // real content follows it: a note that ends the document instead hands that
  // trailing whitespace back below so the file keeps a single final newline.
  const separator = lines[best.end + 1];
  if (separator !== undefined && separator.trim() === '' && best.end + 2 < lines.length) {
    cutEnd = lineStarts[best.end + 2];
  }

  const head = markdown.slice(0, cutStart);
  const tail = markdown.slice(cutEnd);
  if (tail.trim() === '') {
    const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
    return { updatedMarkdown: `${head.replace(/\s+$/, '')}${eol}`, removed: true };
  }

  return { updatedMarkdown: `${head}${tail}`, removed: true };
}
