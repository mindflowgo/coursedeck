/**
 * Markdown/DOM selection capture and re-resolution.
 *
 * Captured selections store stable source block IDs, character offsets within
 * block text content, the exact quote, and short
 * disambiguation context. Resolution prefers the offsets and falls back to a
 * context-disambiguated quote search when the document has changed (edited,
 * re-rendered). Resolution is scoped to the file where the annotation belongs.
 *
 * DOM helpers are only called from browser code paths.
 */
import type { Anchor, Checkpoint, SelectionRange } from '../checkpoint';

/** Convert source-only metadata to attributes before the sanitizer drops comments. */
export function attachMarkdownAnchorIds(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) comments.push(node as Comment);
  for (const comment of comments) {
    const match = comment.data.trim().match(/^coursedeck-anchor:([a-zA-Z0-9_-]+)$/);
    if (!match) continue;
    let next = comment.nextSibling;
    while (next && (next.nodeType === Node.COMMENT_NODE || (next.nodeType === Node.TEXT_NODE && !next.textContent?.trim()))) next = next.nextSibling;
    if (next instanceof Element) next.setAttribute('data-anchor-id', match[1]);
    comment.remove();
  }
  return doc.body.innerHTML;
}

export function findAnchorBlock(root: Element, id: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-anchor-id]')).find(el => el.dataset.anchorId === id) ?? null;
}

export function anchorAtReaderY(root: Element, scroller: HTMLElement, contentY: number): Anchor {
  const clientY = contentY - scroller.scrollTop + scroller.getBoundingClientRect().top;
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-anchor-id]'));
  let best: HTMLElement | null = null;
  let distance = Infinity;
  for (const block of blocks) {
    const r = block.getBoundingClientRect();
    if (!r.height) continue;
    const d = Math.max(r.top - clientY, clientY - r.bottom, 0);
    if (d < distance) { best = block; distance = d; }
  }
  if (!best) return { type: 'pixel', verticalPosition: contentY };
  const rect = best.getBoundingClientRect();
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const x = rect.left + Math.min(8, rect.width / 2);
  const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, clientY));
  const caret = doc.caretPositionFromPoint?.(x, y);
  const range = caret ? null : doc.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset ?? 0;
  const charOffset = node ? offsetWithinBlock(best, node, offset) : null;
  return { type: 'block', blockId: best.dataset.anchorId, verticalPosition: contentY,
    ...(charOffset !== null ? { charOffset } : {}),
    yRatio: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)) };
}

export function resolveCheckpointTop(cp: Checkpoint, root: HTMLElement, scroller: HTMLElement): number {
  if (cp.selection?.text) {
    const range = resolveMarkdownRange(root, cp.selection);
    const rect = range?.getBoundingClientRect();
    if (rect && rect.height) return rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }
  const block = cp.anchor?.blockId ? findAnchorBlock(root, cp.anchor.blockId) : null;
  if (!block) return cp.verticalPosition;
  if (cp.anchor?.charOffset !== undefined) {
    const point = pointFromOffset(block, cp.anchor.charOffset);
    if (point) {
      const range = document.createRange();
      range.setStart(point.node, point.offset);
      range.setEnd(point.node, Math.min(point.node.length, point.offset + 1));
      const rect = range.getBoundingClientRect();
      if (rect.height) return rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    }
  }
  const rect = block.getBoundingClientRect();
  return rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop + rect.height * (cp.anchor?.yRatio ?? 0);
}

export const MARKDOWN_BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table, dd, dt';

/** Finds the closest ancestor (or self) matching the block selector. */
export function closestBlock(node: Node | null): HTMLElement | null {
  const el =
    node?.nodeType === Node.TEXT_NODE
      ? node.parentElement
      : node instanceof HTMLElement
        ? node
        : null;
  return el?.closest<HTMLElement>(MARKDOWN_BLOCK_SELECTOR) ?? null;
}

// ── text measurement ────────────────────────────────────────────────────────

function nodeTextLength(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n as Text).data.length;
  let total = 0;
  for (const child of Array.from(n.childNodes)) total += nodeTextLength(child);
  return total;
}

/** Total length of all text inside `root` that appears before `target`. */
function textBeforeNode(root: Node, target: Node): number {
  let total = 0;
  const walk = (current: Node): boolean => {
    if (current === target) return true;
    if (current.nodeType === Node.TEXT_NODE) {
      total += (current as Text).data.length;
      return false;
    }
    for (const child of Array.from(current.childNodes)) {
      if (walk(child)) return true;
    }
    return false;
  };
  walk(root);
  return total;
}

/**
 * Character offset of a DOM boundary point (node, offset) within the text
 * content of `block`, or null when the boundary is outside the block.
 */
export function offsetWithinBlock(block: Element, node: Node, offset: number): number | null {
  if (!block.contains(node) && node !== block) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    return textBeforeNode(block, node) + Math.min(offset, (node as Text).data.length);
  }
  // Element boundary: `offset` is a child index — count text strictly before it.
  if (node.nodeType === Node.ELEMENT_NODE || node === block) {
    const before = node === block ? 0 : textBeforeNode(block, node);
    const kids = Array.from(node.childNodes).slice(0, Math.max(0, Math.min(offset, node.childNodes.length)));
    let inner = 0;
    for (const kid of kids) inner += nodeTextLength(kid);
    return before + inner;
  }
  return null;
}

/** Inverse of offsetWithinBlock: boundary point for a char offset in a block. */
export function pointFromOffset(
  block: Element,
  charOffset: number
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, Math.floor(charOffset));
  let lastText: Text | null = null;
  let n = walker.nextNode() as Text | null;
  while (n) {
    lastText = n;
    if (remaining <= n.data.length) return { node: n, offset: remaining };
    remaining -= n.data.length;
    n = walker.nextNode() as Text | null;
  }
  return lastText ? { node: lastText, offset: lastText.data.length } : null;
}

// ── capture ─────────────────────────────────────────────────────────────────

/** Disambiguation context length captured on each side of a quote. */
const CONTEXT_CHARS = 32;

/**
 * Serializes the live selection into a stored SelectionRange plus block
 * identities. Returns null when the selection does not intersect the root's
 * blocks, is collapsed, or has no text (e.g. 1-char selections are kept —
 * math tokens can be a single character).
 */
export function serializeMarkdownSelection(
  sel: Selection,
  root: Element
): { selection: SelectionRange } | null {
  if (sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  const text = sel.toString().replace(/\s+$/g, '');
  if (!text.trim()) return null;

  const startElement = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer as Element;
  const endElement = range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.parentElement : range.endContainer as Element;
  const startBlock = startElement?.closest<HTMLElement>('[data-anchor-id]');
  const endBlock = endElement?.closest<HTMLElement>('[data-anchor-id]');
  if (!startBlock?.dataset.anchorId || !endBlock?.dataset.anchorId) return null;

  const charStart =
    startBlock !== null ? offsetWithinBlock(startBlock, range.startContainer, range.startOffset) : null;
  const charEnd =
    endBlock !== null ? offsetWithinBlock(endBlock, range.endContainer, range.endOffset) : null;

  const startText = startBlock?.textContent ?? '';
  const endText = endBlock?.textContent ?? '';
  const safeStart = charStart ?? 0;
  const safeEnd = charEnd ?? endText.length;

  const serialized: SelectionRange = {
    text,
    ...(startBlock?.dataset.anchorId ? { startAnchorId: startBlock.dataset.anchorId } : {}),
    ...(endBlock?.dataset.anchorId ? { endAnchorId: endBlock.dataset.anchorId } : {}),
    ...(charStart !== null ? { charStart } : {}),
    ...(charEnd !== null ? { charEnd } : {}),
    prefix: startText.slice(Math.max(0, safeStart - CONTEXT_CHARS), safeStart).slice(-CONTEXT_CHARS),
    suffix: endText.slice(safeEnd, safeEnd + CONTEXT_CHARS)
  };
  return { selection: serialized };
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * Finds the best character span for `quote` inside `fullText`.
 *  - exactly one occurrence → that span
 *  - multiple occurrences → the unique one framed by prefix/suffix, else null
 *    (ambiguous quotes must not paint an unrelated occurrence)
 *  - no occurrence → null
 */
export function findBestQuoteSpan(
  fullText: string,
  quote: string,
  prefix?: string,
  suffix?: string
): { start: number; end: number } | null {
  if (!quote) return null;
  const occurrences: number[] = [];
  let idx = fullText.indexOf(quote);
  while (idx !== -1 && occurrences.length < 50) {
    occurrences.push(idx);
    idx = fullText.indexOf(quote, idx + 1);
  }
  if (occurrences.length === 0) return null;
  if (occurrences.length === 1) return { start: occurrences[0], end: occurrences[0] + quote.length };

  const scored = occurrences
    .map((start) => {
      let score = 0;
      if (prefix) {
        const actual = fullText.slice(Math.max(0, start - prefix.length), start);
        if (actual.endsWith(prefix)) score++;
      }
      if (suffix) {
        const actual = fullText.slice(start + quote.length, start + quote.length + suffix.length);
        if (actual.startsWith(suffix)) score++;
      }
      return { start, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored[0].score === 0) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return { start: scored[0].start, end: scored[0].start + quote.length };
}

interface TextIndex {
  text: string;
  /** char i of `text` lives in points[i].node at points[i].offset */
  points: Array<{ node: Text; offset: number } | null>;
}

function buildTextIndex(root: Element): TextIndex {
  const chars: string[] = [];
  const points: TextIndex['points'] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    for (let i = 0; i < n.data.length; i++) {
      chars.push(n.data[i]);
      points.push({ node: n, offset: i });
    }
    n = walker.nextNode() as Text | null;
  }
  return { text: chars.join(''), points };
}

function rangeFromSpan(root: Element, index: TextIndex, start: number, end: number): Range | null {
  if (start < 0 || end > index.points.length || start >= end) return null;
  const sp = index.points[start] ?? null;
  const ep = index.points[end - 1] ?? null;
  if (!sp || !ep) return null;
  try {
    const r = document.createRange();
    r.setStart(sp.node, sp.offset);
    r.setEnd(ep.node, ep.offset + 1);
    return r;
  } catch {
    return null;
  }
}

/**
 * Re-creates a DOM Range for a stored selection inside `root`.
 * Offset-based first; falls back to quote + context search. Returns null when
 * the selection can no longer be located unambiguously.
 */
export function resolveMarkdownRange(root: Element, sel: SelectionRange): Range | null {
  if (typeof document === 'undefined') return null;
  const startBlock = sel.startAnchorId ? findAnchorBlock(root, sel.startAnchorId) : null;
  const endBlock = sel.endAnchorId ? findAnchorBlock(root, sel.endAnchorId) : null;

  if (startBlock && endBlock) {
    const sp = pointFromOffset(startBlock, sel.charStart ?? 0);
    const ep = pointFromOffset(endBlock, sel.charEnd ?? endBlock.textContent?.length ?? 0);
    if (sp && ep) {
      try {
        const r = document.createRange();
        const order = startBlock === endBlock || Boolean(startBlock.compareDocumentPosition(endBlock) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (order) {
          r.setStart(sp.node, sp.offset);
          r.setEnd(ep.node, ep.offset);
        } else {
          r.setStart(ep.node, ep.offset);
          r.setEnd(sp.node, sp.offset);
        }
        const resolvedText = r.toString();
        // Offsets match only when the document is unchanged since capture.
        if (resolvedText.trim() && textsEquivalent(resolvedText, sel.text)) return r;
      } catch {
        // fall through to quote search
      }
    }
  }

  const index = buildTextIndex(root);
  // Collapsed whitespace in textContent vs selection strings makes exact
  // matching brittle; search the raw text first, then a whitespace-relaxed pass.
  let span = findBestQuoteSpan(index.text, sel.text, sel.prefix, sel.suffix);
  if (!span && /\s/.test(sel.text)) {
    // Build the whitespace-normalized text and remember where each normalized
    // char came from so a match can be mapped back to raw char positions.
    const relaxedChars: string[] = [];
    const rawStartOfRelaxed: number[] = [];
    let pendingSpace = false;
    for (let i = 0; i < index.text.length; i++) {
      const ch = index.text[i];
      if (/\s/.test(ch)) {
        if (relaxedChars.length > 0 && !pendingSpace) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        relaxedChars.push(' ');
        rawStartOfRelaxed.push(i);
        pendingSpace = false;
      }
      relaxedChars.push(ch);
      rawStartOfRelaxed.push(i);
    }
    const relaxed = relaxedChars.join('');
    const relaxedSpan = findBestQuoteSpan(relaxed, sel.text.replace(/\s+/g, ' '));
    if (relaxedSpan && rawStartOfRelaxed[relaxedSpan.start] !== undefined) {
      const rawStart = rawStartOfRelaxed[relaxedSpan.start];
      let rawEnd = rawStartOfRelaxed[relaxedSpan.end - 1] + 1;
      const nextRaw =
        relaxedSpan.end < rawStartOfRelaxed.length
          ? rawStartOfRelaxed[relaxedSpan.end]
          : index.text.length;
      while (rawEnd < nextRaw) rawEnd++; // swallow the raw whitespace run
      span = { start: rawStart, end: rawEnd };
    }
  }
  if (!span) return null;
  return rangeFromSpan(root, index, span.start, span.end);
}

function textsEquivalent(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/**
 * Rectangles for a resolved range in the reader's content space, so callers
 * can paint highlight overlays without touching the source DOM.
 */
export function rangeRectsInScroller(
  range: Range,
  scroller: HTMLElement
): Array<{ top: number; left: number; width: number; height: number }> {
  const scRect = scroller.getBoundingClientRect();
  const rects: Array<{ top: number; left: number; width: number; height: number }> = [];
  const domRects = range.getClientRects();
  for (const r of domRects) {
    if (r.width < 1 || r.height < 1) continue;
    rects.push({
      top: r.top - scRect.top + scroller.scrollTop,
      left: r.left - scRect.left + scroller.scrollLeft,
      width: r.width,
      height: r.height
    });
  }
  if (rects.length === 0) {
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      rects.push({
        top: r.top - scRect.top + scroller.scrollTop,
        left: r.left - scRect.left + scroller.scrollLeft,
        width: r.width,
        height: r.height
      });
    }
  }
  return rects;
}
