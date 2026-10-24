import { syntaxTree } from "@codemirror/language";
import { EditorState, Range, StateField, Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { type FrontmatterRange, frontmatterRange, readFrontmatter } from "./frontmatter";
import { rendersAnything, sanitizeHtml } from "./sanitize";
import { courseIdFacet, resolveImageSource, safeExternalHref } from "./sources";
import {
  BulletWidget,
  HtmlWidget,
  ImageWidget,
  PropertiesWidget,
  RuleWidget,
  type TableAlignment,
  type TableCell,
  type TableRow,
  TableWidget,
  TaskWidget,
} from "./widgets";

/** Markup that is out of the way entirely: replaced with nothing at all. */
const HIDDEN = Decoration.replace({});
/** Markup on the line being edited: still there, just stepped back. */
const DIMMED = Decoration.mark({ class: "cm-md-mark" });
const SETEXT_MARK = Decoration.mark({ class: "cm-md-setext-mark" });
const CODE_INFO = Decoration.mark({ class: "cm-md-code-info" });
const ORDERED_MARK = Decoration.mark({ class: "cm-md-ordered-mark" });

const QUOTE_LINE = Decoration.line({ class: "cm-md-quote" });
const TASK_DONE = Decoration.mark({ class: "cm-md-task-done" });
const RULE_LINE = Decoration.line({ class: "cm-md-mark" });
const FRONTMATTER_LINE = Decoration.line({ class: "cm-md-frontmatter" });

const INLINE_CLASSES: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: "cm-md-strong" }),
  Emphasis: Decoration.mark({ class: "cm-md-em" }),
  Strikethrough: Decoration.mark({ class: "cm-md-strike" }),
  InlineCode: Decoration.mark({ class: "cm-md-inline-code" }),
};

const HEADING_LEVELS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

const HEADING_LINES = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-md-heading cm-md-h${level}` })
);

/**
 * Whether the raw markdown for this range should be shown rather than rendered.
 * The test is by line, not by character: put the caret anywhere on a line and
 * that whole line opens up to reveal the raw markdown.
 */
function isBeingEdited(state: EditorState, from: number, to: number): boolean {
  const first = state.doc.lineAt(from);
  const last = to <= first.to ? first : state.doc.lineAt(to);
  return state.selection.ranges.some((range) => range.from <= last.to && range.to >= first.from);
}

function eachLine(
  doc: Text,
  from: number,
  to: number,
  visit: (lineStart: number, isFirst: boolean, isLast: boolean) => void
) {
  let position = from;
  let first = true;

  for (;;) {
    const line = doc.lineAt(position);
    const isLast = line.to >= to;
    visit(line.from, first, isLast);
    if (isLast || line.to >= doc.length) break;
    position = line.to + 1;
    first = false;
  }
}

function findChild(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
  }
  return null;
}

function hasAncestor(node: SyntaxNode, ...names: string[]): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (names.includes(parent.name)) return true;
  }
  return false;
}

function listDepth(list: SyntaxNode): number {
  let depth = 0;
  for (let parent = list.parent; parent; parent = parent.parent) {
    if (parent.name === "BulletList" || parent.name === "OrderedList") depth++;
  }
  return depth;
}

function parseAlignment(delimiterRow: string): TableAlignment[] {
  return delimiterRow
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell, index, cells) => !(cell === "" && (index === 0 || index === cells.length - 1)))
    .map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return null;
    });
}

function extractRowCells(
  state: EditorState,
  rowNode: SyntaxNode,
  origin: number,
  expectedCols: number
): TableCell[] {
  const delimiters: { from: number; to: number }[] = [];
  const tableCells: { from: number; to: number; text: string }[] = [];

  for (let child = rowNode.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableDelimiter") {
      delimiters.push({ from: child.from, to: child.to });
    } else if (child.name === "TableCell") {
      tableCells.push({
        from: child.from,
        to: child.to,
        text: state.doc.sliceString(child.from, child.to),
      });
    }
  }

  // If no delimiters found, fall back to whatever TableCells exist
  if (delimiters.length === 0) {
    const fallback = tableCells.map((c) => ({ text: c.text, offset: c.from - origin }));
    if (expectedCols > 0) {
      while (fallback.length < expectedCols) {
        fallback.push({ text: "", offset: rowNode.to - origin });
      }
      if (fallback.length > expectedCols) fallback.splice(expectedCols);
    }
    return fallback;
  }

  const cells: TableCell[] = [];

  // 1. Content before first delimiter (e.g. `col1 | col2` without leading pipe)
  const cellBeforeFirst = tableCells.find((c) => c.to <= delimiters[0].from);
  if (cellBeforeFirst) {
    cells.push({
      text: cellBeforeFirst.text,
      offset: cellBeforeFirst.from - origin,
    });
  }

  // 2. Cells between consecutive delimiters (including empty cells like `||` or `|   |`)
  for (let i = 0; i < delimiters.length - 1; i++) {
    const start = delimiters[i].to;
    const end = delimiters[i + 1].from;
    const existing = tableCells.find((c) => c.from >= start && c.to <= end);

    if (existing) {
      cells.push({
        text: existing.text,
        offset: existing.from - origin,
      });
    } else {
      const raw = state.doc.sliceString(start, end);
      cells.push({
        text: raw.trim(),
        offset: start - origin,
      });
    }
  }

  // 3. Content after last delimiter (e.g. `col1 | col2` without trailing pipe)
  const lastDelim = delimiters[delimiters.length - 1];
  const cellAfterLast = tableCells.find((c) => c.from >= lastDelim.to);
  if (cellAfterLast) {
    cells.push({
      text: cellAfterLast.text,
      offset: cellAfterLast.from - origin,
    });
  }

  // 4. Pad or trim to expected column count
  if (expectedCols > 0) {
    while (cells.length < expectedCols) {
      const padOffset = (lastDelim ? lastDelim.from : rowNode.to) - origin;
      cells.push({ text: "", offset: padOffset });
    }
    if (cells.length > expectedCols) {
      cells.splice(expectedCols);
    }
  }

  return cells;
}

function readTable(state: EditorState, table: SyntaxNode, origin: number) {
  if (hasAncestor(table, "Blockquote", "ListItem")) return null;

  // Resolve alignment and expected column count upfront
  let alignment: TableAlignment[] = [];
  const delimNode = findChild(table, "TableDelimiter");
  if (delimNode) {
    alignment = parseAlignment(state.doc.sliceString(delimNode.from, delimNode.to));
  }

  const rows: TableRow[] = [];
  const expectedCols = alignment.length;

  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableDelimiter") continue;
    if (child.name !== "TableHeader" && child.name !== "TableRow") continue;

    const cells = extractRowCells(state, child, origin, expectedCols);
    rows.push({ cells, header: child.name === "TableHeader" });
  }

  if (!rows.length) return null;

  const key = [
    alignment.join(","),
    ...rows.map((row) => `${row.header}:${row.cells.map((cell) => `${cell.offset}=${cell.text}`).join("|")}`),
  ].join("//");

  return { rows, alignment, key };
}

function imageAltText(doc: Text, image: SyntaxNode): string {
  const marks: SyntaxNode[] = [];
  for (let child = image.firstChild; child && marks.length < 2; child = child.nextSibling) {
    if (child.name === "LinkMark") marks.push(child);
  }
  return marks.length === 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

type Build = {
  state: EditorState;
  courseId: string;
  out: Range<Decoration>[];
  frontmatterEnd: number;
  coveredUntil: number;
};

function findClosingTag(doc: Text, open: SyntaxNode, tag: string): number {
  const opening = new RegExp(`^<${tag}(\\s|>|/)`, "i");
  const closing = new RegExp(`^</${tag}\\s*>$`, "i");
  let depth = 1;

  for (let sibling = open.nextSibling; sibling; sibling = sibling.nextSibling) {
    if (sibling.name !== "HTMLTag") continue;
    const text = doc.sliceString(sibling.from, sibling.to);

    if (closing.test(text)) {
      depth--;
      if (depth === 0) return sibling.to;
    } else if (opening.test(text) && !text.endsWith("/>")) {
      depth++;
    }
  }

  return -1;
}

function decorateNode(node: SyntaxNodeRef, build: Build): boolean | undefined {
  const { state, courseId, out } = build;
  const { name, from, to } = node;
  const doc = state.doc;

  if (to <= build.frontmatterEnd) return false;
  if (from < build.coveredUntil) return false;

  const headingLevel = HEADING_LEVELS[name];
  if (headingLevel) {
    if (name.startsWith("Setext")) {
      const underline = findChild(node.node, "HeaderMark");
      if (underline && isBeingEdited(state, underline.from, underline.to)) return;
    }
    out.push(HEADING_LINES[headingLevel - 1].range(doc.lineAt(from).from));
    return;
  }

  if (name === "HeaderMark") {
    if (hasAncestor(node.node, "SetextHeading1", "SetextHeading2")) {
      if (!isBeingEdited(state, from, to)) out.push(SETEXT_MARK.range(from, to));
      return;
    }
    if (isBeingEdited(state, from, to)) {
      out.push(DIMMED.range(from, to));
      return;
    }

    const line = doc.lineAt(from);
    const leading = doc.sliceString(line.from, from).trim() === "";
    let start = from;
    let end = to;

    if (leading) {
      start = line.from;
      while (end < line.to && doc.sliceString(end, end + 1) === " ") end++;
    } else {
      while (start > line.from && doc.sliceString(start - 1, start) === " ") start--;
    }

    if (start < end) out.push(HIDDEN.range(start, end));
    return;
  }

  if (name === "Blockquote") {
    eachLine(doc, from, to, (lineStart) => out.push(QUOTE_LINE.range(lineStart)));
    return;
  }

  if (name === "QuoteMark") {
    if (isBeingEdited(state, from, to)) {
      out.push(DIMMED.range(from, to));
      return;
    }
    const line = doc.lineAt(from);
    const end = to < line.to && doc.sliceString(to, to + 1) === " " ? to + 1 : to;
    out.push(HIDDEN.range(from, end));
    return;
  }

  if (name === "ListMark") {
    const item = node.node.parent;
    const list = item?.parent;
    if (list?.name !== "BulletList") {
      out.push(ORDERED_MARK.range(from, to));
      return;
    }
    if (item && findChild(item, "Task")) out.push(HIDDEN.range(from, to));
    else out.push(Decoration.replace({ widget: new BulletWidget(listDepth(list)) }).range(from, to));
    return;
  }

  if (name === "TaskMarker") {
    const checked = /^\[[xX]\]$/.test(doc.sliceString(from, to));
    out.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(from, to));

    const task = node.node.parent;
    const textFrom = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
    if (checked && task && task.to > textFrom) out.push(TASK_DONE.range(textFrom, task.to));
    return;
  }

  if (
    name === "EmphasisMark" ||
    name === "StrikethroughMark" ||
    name === "LinkMark" ||
    name === "LinkTitle"
  ) {
    out.push((isBeingEdited(state, from, to) ? DIMMED : HIDDEN).range(from, to));
    return;
  }

  if (name === "CodeMark") {
    out.push((isBeingEdited(state, from, to) ? DIMMED : HIDDEN).range(from, to));
    return;
  }

  if (name === "CodeInfo") {
    out.push(CODE_INFO.range(from, to));
    return;
  }

  if (name === "URL") {
    const parent = node.node.parent?.name;
    if (parent === "Link" || parent === "Image") {
      out.push((isBeingEdited(state, from, to) ? DIMMED : HIDDEN).range(from, to));
    }
    return;
  }

  if (name === "Link" || name === "Autolink") {
    const urlNode = name === "Link" ? findChild(node.node, "URL") : null;
    const target = urlNode
      ? doc.sliceString(urlNode.from, urlNode.to)
      : doc.sliceString(from, to).replace(/^<|>$/g, "");
    const href = safeExternalHref(target);
    out.push(
      Decoration.mark({
        class: "cm-md-link",
        attributes: href ? { "data-href": href } : undefined,
      }).range(from, to)
    );
    return;
  }

  if (name === "Image") {
    if (isBeingEdited(state, from, to)) return;
    const urlNode = findChild(node.node, "URL");
    const source = urlNode && resolveImageSource(doc.sliceString(urlNode.from, urlNode.to), courseId);
    if (!source) return;
    out.push(
      Decoration.replace({
        widget: new ImageWidget(source, imageAltText(doc, node.node)),
      }).range(from, to)
    );
    return false;
  }

  if (name === "FencedCode" || name === "CodeBlock") {
    eachLine(doc, from, to, (lineStart, isFirst, isLast) => {
      const classes = ["cm-md-code-line"];
      if (isFirst) classes.push("cm-md-code-first");
      if (isLast) classes.push("cm-md-code-last");
      out.push(Decoration.line({ class: classes.join(" ") }).range(lineStart));
    });
    return;
  }

  if (name === "HorizontalRule") {
    const line = doc.lineAt(from);
    if (isBeingEdited(state, from, to)) {
      out.push(RULE_LINE.range(line.from));
      return;
    }
    out.push(Decoration.replace({ widget: new RuleWidget(), block: true }).range(line.from, line.to));
    return false;
  }

  if (name === "HTMLBlock") {
    if (isBeingEdited(state, from, to)) return false;

    const html = doc.sliceString(from, to);
    if (!rendersAnything(sanitizeHtml(html, courseId))) return false;

    out.push(
      Decoration.replace({
        widget: new HtmlWidget(html, courseId, true),
        block: true,
      }).range(doc.lineAt(from).from, doc.lineAt(to).to)
    );
    return false;
  }

  if (name === "HTMLTag") {
    const source = doc.sliceString(from, to);
    const tag = /^<([a-zA-Z][\w-]*)/.exec(source)?.[1]?.toLowerCase();
    if (!tag) return;

    const end = source.endsWith("/>") || VOID_TAGS.has(tag) ? to : findClosingTag(doc, node.node, tag);
    if (end < 0 || isBeingEdited(state, from, end)) return;

    const html = doc.sliceString(from, end);
    if (!rendersAnything(sanitizeHtml(html, courseId))) return;

    out.push(Decoration.replace({ widget: new HtmlWidget(html, courseId, false) }).range(from, end));
    build.coveredUntil = end;
    return false;
  }

  if (name === "Comment" || name === "CommentBlock") {
    out.push(DIMMED.range(from, to));
    return false;
  }

  if (name === "Table") {
    const table = readTable(state, node.node, doc.lineAt(from).from);
    if (!table || isBeingEdited(state, from, to)) return;

    out.push(
      Decoration.replace({
        widget: new TableWidget(table.rows, table.alignment, table.key),
        block: true,
      }).range(doc.lineAt(from).from, doc.lineAt(to).to)
    );
    return false;
  }

  const inlineClass = INLINE_CLASSES[name];
  if (inlineClass) out.push(inlineClass.range(from, to));
  return;
}

function decorateFrontmatter(state: EditorState, range: FrontmatterRange, out: Range<Decoration>[]) {
  const properties = readFrontmatter(state.doc, range);

  if (!properties) {
    eachLine(state.doc, range.from, range.to, (lineStart) => out.push(FRONTMATTER_LINE.range(lineStart)));
    return;
  }

  const key = properties.map((property) => `${property.key}=${property.value}`).join("|");

  out.push(
    Decoration.replace({
      widget: new PropertiesWidget(properties, `${properties.length}//${key}`),
      block: true,
    }).range(range.from, range.to)
  );
}

function decorationsIn(state: EditorState, from: number, to: number): Range<Decoration>[] {
  const build: Build = {
    state,
    courseId: state.facet(courseIdFacet),
    out: [],
    coveredUntil: -1,
    frontmatterEnd: -1,
  };

  const front = frontmatterRange(state.doc);
  if (front) {
    build.frontmatterEnd = front.to;
    if (from <= front.to) decorateFrontmatter(state, front, build.out);
  }

  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => decorateNode(node, build),
  });

  return build.out;
}

function buildDecorations(state: EditorState): DecorationSet {
  return Decoration.set(decorationsIn(state, 0, state.doc.length), true);
}

type Span = { from: number; to: number };

function enclosingBlock(tree: Tree, pos: number): Span {
  let node = tree.resolveInner(pos, 1);
  while (node.parent && node.parent.parent) node = node.parent;
  return node.parent ? { from: node.from, to: node.to } : { from: pos, to: pos };
}

function widen(state: EditorState, tree: Tree, span: Span): Span {
  const length = state.doc.length;
  const start = state.doc.lineAt(Math.max(0, Math.min(span.from, length)));
  const end = state.doc.lineAt(Math.max(0, Math.min(span.to, length)));
  const head = enclosingBlock(tree, start.from);
  const tail = enclosingBlock(tree, end.to);

  return {
    from: Math.max(0, Math.min(start.from, head.from)),
    to: Math.min(length, Math.max(end.to, tail.to)),
  };
}

function merge(spans: Span[]): Span[] {
  const sorted = spans.slice().sort((a, b) => a.from - b.from);
  const merged: Span[] = [];

  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }

  return merged;
}

export const liveMarkdownPreview = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),

  update(decorations, transaction) {
    const { startState, state, changes } = transaction;
    const oldTree = syntaxTree(startState);
    const newTree = syntaxTree(state);

    if (
      state.facet(courseIdFacet) !== startState.facet(courseIdFacet) ||
      (newTree !== oldTree && !transaction.docChanged)
    ) {
      return buildDecorations(state);
    }

    const selectionMoved = !state.selection.eq(startState.selection);
    if (!transaction.docChanged && !selectionMoved) return decorations;

    const spans: Span[] = [];
    const carryOver = (span: Span) => {
      const widened = widen(startState, oldTree, span);
      spans.push({ from: changes.mapPos(widened.from, -1), to: changes.mapPos(widened.to, 1) });
    };

    for (const range of startState.selection.ranges) carryOver(range);
    for (const range of state.selection.ranges) spans.push(widen(state, newTree, range));
    changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      carryOver({ from: fromA, to: toA });
      spans.push(widen(state, newTree, { from: fromB, to: toB }));
    });

    const before = frontmatterRange(startState.doc);
    const after = frontmatterRange(state.doc);
    const frontEnd = Math.max(after ? after.to : -1, before ? changes.mapPos(before.to, 1) : -1);
    if (frontEnd >= 0 && spans.some((span) => span.from <= frontEnd)) {
      spans.push({ from: 0, to: Math.min(frontEnd, state.doc.length) });
    }

    let updated = decorations.map(changes);
    for (const span of merge(spans)) {
      updated = updated.update({
        filter: () => false,
        filterFrom: span.from,
        filterTo: span.to,
        add: decorationsIn(state, span.from, span.to),
        sort: true,
      });
    }

    return updated;
  },

  provide: (field) => EditorView.decorations.from(field),
});
