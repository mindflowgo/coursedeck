import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const ink = {
  text: "var(--cm-text, #1c1917)",
  heading: "var(--cm-heading, #0c0a09)",
  mark: "var(--cm-mark, #78716c)",
  muted: "var(--cm-muted, #a8a29e)",
  accent: "var(--cm-accent, #d97706)",
  accentHover: "var(--cm-accent-hover, #b45309)",
  code: "var(--cm-code, #b45309)",
  caret: "var(--cm-caret, #d97706)",
  selection: "var(--cm-selection, rgba(251, 191, 36, 0.28))",
  selectionInactive: "var(--cm-selection-inactive, rgba(231, 229, 228, 0.6))",
  hairline: "var(--cm-hairline, #e7e5e4)",
  surface: "var(--cm-surface, #f5f5f4)",
  surfaceStrong: "var(--cm-surface-strong, #e7e5e4)",
  quote: "var(--cm-quote, #44403c)",
  link: "var(--cm-link, #2563eb)",
  linkHover: "var(--cm-link-hover, #1d4ed8)",
};

const CHECK_MARK =
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHBhdGggZD0i" +
  "TTMuNSA4LjRsMy4xIDMuMUwxMi41IDUiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIy" +
  "LjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvc3ZnPg==";

export const CODE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const PROSE_FONT_FAMILY =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const editorTheme = EditorView.theme({
  "&": {
    color: ink.text,
    backgroundColor: "var(--cm-bg, #ffffff)",
    height: "100%",
    fontFamily: PROSE_FONT_FAMILY,
    fontSize: "15px",
  },
  "&.cm-focused": { outline: "none" },

  ".cm-scroller": {
    padding: "0 1.5rem",
    lineHeight: "1.7",
    fontFamily: PROSE_FONT_FAMILY,
  },

  ".cm-content": {
    maxWidth: "52rem",
    width: "100%",
    margin: "0 auto",
    padding: "2rem 0 30vh",
    caretColor: ink.caret,
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-line > *": {
    textIndent: "0",
  },

  "&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor, .cm-cursor, .cm-dropCursor": {
    borderLeft: `2.2px solid ${ink.caret}`,
  },
  "&:not(.cm-focused) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: ink.selectionInactive,
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection": {
    background: ink.selection,
  },
  ".cm-activeLine": { backgroundColor: "transparent" },

  /* ---- Markdown syntax markup (stepped back) ------------------------ */
  ".cm-md-mark": {
    color: ink.mark,
    opacity: "0.85",
    fontWeight: "600",
  },

  /* ---- Headings ----------------------------------------------------- */
  ".cm-md-heading": {
    color: ink.heading,
    fontWeight: "650",
    lineHeight: "1.3",
  },
  ".cm-md-heading .cm-md-mark": {
    color: ink.mark,
    opacity: "0.9",
  },
  ".cm-md-h1": { fontSize: "1.85em", padding: "0.6em 0 0.25em" },
  ".cm-md-h2": { fontSize: "1.48em", padding: "0.6em 0 0.2em", borderBottom: `1px solid ${ink.hairline}` },
  ".cm-md-h3": { fontSize: "1.25em", padding: "0.55em 0 0.15em" },
  ".cm-md-h4": { fontSize: "1.1em", padding: "0.5em 0 0.15em" },
  ".cm-md-h5": { fontSize: "1em", padding: "0.45em 0 0.15em" },
  ".cm-md-h6": {
    fontSize: "0.92em",
    padding: "0.45em 0 0.15em",
    color: ink.muted,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  ".cm-md-setext-mark": {
    color: ink.hairline,
    opacity: "0.8",
  },

  /* ---- Lists & Tasks ------------------------------------------------ */
  ".cm-md-bullet": {
    color: ink.accent,
    display: "inline-block",
    fontSize: "1.2em",
    lineHeight: "1",
    verticalAlign: "-0.05em",
    fontWeight: "700",
  },
  ".cm-md-ordered-mark": {
    color: ink.accent,
    fontWeight: "600",
  },
  ".cm-md-task": {
    appearance: "none",
    WebkitAppearance: "none",
    position: "relative",
    display: "inline-block",
    boxSizing: "border-box",
    width: "1.1em",
    height: "1.1em",
    margin: "0 0.3em 0 0",
    verticalAlign: "-0.2em",
    border: `1.5px solid ${ink.muted}`,
    borderRadius: "0.3em",
    background: "transparent",
    cursor: "pointer",
    transition: "background-color 140ms ease, border-color 140ms ease",
  },
  ".cm-md-task:hover": { borderColor: ink.accent },
  ".cm-md-task:checked": {
    backgroundColor: ink.accent,
    borderColor: ink.accent,
  },
  ".cm-md-task::after": {
    content: '""',
    position: "absolute",
    inset: "0",
    backgroundImage: `url("data:image/svg+xml;base64,${CHECK_MARK}")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
    backgroundSize: "75%",
    opacity: "0",
    transform: "scale(0.5)",
    transition: "opacity 110ms ease-out, transform 180ms cubic-bezier(0.34, 1.5, 0.64, 1)",
  },
  ".cm-md-task:checked::after": {
    opacity: "1",
    transform: "scale(1)",
  },
  ".cm-md-task-done": {
    color: ink.muted,
    textDecoration: "line-through",
    transition: "color 160ms ease",
  },

  /* ---- Inline formatting -------------------------------------------- */
  ".cm-md-strong": { fontWeight: "700", color: ink.heading },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": {
    textDecoration: "line-through",
    color: ink.muted,
  },
  ".cm-md-inline-code": {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: "0.88em",
    color: ink.code,
    backgroundColor: ink.surface,
    border: `1px solid ${ink.hairline}`,
    borderRadius: "0.3em",
    padding: "0.1em 0.35em",
  },
  ".cm-md-link": {
    color: ink.link,
    textDecoration: "underline",
    textUnderlineOffset: "0.2em",
    cursor: "pointer",
    transition: "color 140ms ease",
  },
  ".cm-md-link:hover": {
    color: ink.linkHover,
  },

  /* ---- Blocks ------------------------------------------------------- */
  ".cm-md-quote": {
    borderLeft: `3.5px solid ${ink.accent}`,
    backgroundColor: "rgba(254, 243, 199, 0.2)",
    paddingLeft: "1em",
    borderRadius: "0 0.3em 0.3em 0",
    color: ink.quote,
  },
  ".cm-md-code-line": {
    backgroundColor: ink.surface,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: "0.9em",
    padding: "0 0.9em",
  },
  ".cm-md-code-info": {
    color: ink.muted,
    fontSize: "0.8em",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  ".cm-md-code-first": {
    borderTopLeftRadius: "0.5em",
    borderTopRightRadius: "0.5em",
    paddingTop: "0.5em",
  },
  ".cm-md-code-last": {
    borderBottomLeftRadius: "0.5em",
    borderBottomRightRadius: "0.5em",
    paddingBottom: "0.5em",
  },
  ".cm-md-hr-wrap": {
    display: "block",
    padding: "0.85em 0",
  },
  ".cm-md-hr": {
    border: "none",
    borderTop: `1px solid ${ink.hairline}`,
    margin: "0",
  },

  /* ---- Tables ------------------------------------------------------- */
  ".cm-md-table-wrap": {
    display: "block",
    overflowX: "auto",
    padding: "0.6em 0",
    whiteSpace: "normal",
  },
  ".cm-md-table": {
    borderCollapse: "collapse",
    emptyCells: "show",
    width: "100%",
    fontSize: "0.92em",
    lineHeight: "1.5",
  },
  ".cm-md-table th, .cm-md-table td": {
    border: `1px solid ${ink.hairline}`,
    padding: "0.45em 0.8em",
    minWidth: "1.5em",
    textAlign: "left",
    verticalAlign: "top",
  },
  ".cm-md-table th": {
    color: ink.heading,
    fontWeight: "600",
    backgroundColor: ink.surface,
  },
  ".cm-md-table tbody tr:hover td": {
    backgroundColor: "rgba(0, 0, 0, 0.015)",
  },
  ".cm-md-cell": {
    width: "100%",
    border: "none",
    outline: `1.5px solid ${ink.accent}`,
    borderRadius: "2px",
    padding: "2px 4px",
    background: "var(--cm-cell-bg, #fff)",
    font: "inherit",
    color: "inherit",
  },

  /* ---- Frontmatter Properties --------------------------------------- */
  ".cm-md-props": {
    margin: "0 0 1.5em",
    padding: "0.8em 1em",
    borderRadius: "0.6em",
    backgroundColor: "var(--cm-surface, #fafaf9)",
    border: `1px solid ${ink.hairline}`,
    fontSize: "0.88em",
  },
  ".cm-md-prop": {
    display: "grid",
    gridTemplateColumns: "minmax(0, 8em) 1fr auto",
    gap: "0 1em",
    alignItems: "baseline",
    padding: "0.2em 0.4em",
    borderRadius: "0.3em",
  },
  ".cm-md-prop:hover, .cm-md-prop:focus-within": { backgroundColor: "var(--cm-surface-strong, #f5f5f4)" },
  ".cm-md-prop-remove": {
    width: "1.3em",
    border: "none",
    background: "none",
    color: ink.muted,
    opacity: "0",
    cursor: "pointer",
    transition: "opacity 120ms ease, color 120ms ease",
    fontSize: "1.1em",
  },
  ".cm-md-prop:hover .cm-md-prop-remove, .cm-md-prop:focus-within .cm-md-prop-remove": {
    opacity: "1",
  },
  ".cm-md-prop-remove:hover": { color: "#dc2626" },
  ".cm-md-props input, .cm-md-props textarea": {
    width: "100%",
    border: "none",
    outline: "none",
    background: "transparent",
    font: "inherit",
    color: "inherit",
  },
  ".cm-md-prop-key": { color: ink.muted, fontWeight: "500" },
  ".cm-md-prop-value": { color: ink.text, fontWeight: "500" },
  ".cm-md-prop-add": {
    display: "inline-block",
    margin: "0.4em 0 0",
    padding: "0.2em 0.5em",
    border: `1px dashed ${ink.hairline}`,
    borderRadius: "0.3em",
    background: "none",
    font: "inherit",
    fontSize: "0.88em",
    color: ink.muted,
    cursor: "pointer",
    transition: "all 120ms ease",
  },
  ".cm-md-prop-add:hover": { color: ink.accent, borderColor: ink.accent },
  ".cm-md-frontmatter": {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: "0.85em",
    color: ink.muted,
  },

  /* ---- Images ------------------------------------------------------- */
  ".cm-md-image": {
    display: "inline-block",
    maxWidth: "100%",
    margin: "0.6em auto",
    textAlign: "center",
  },
  ".cm-md-image img": {
    maxWidth: "100%",
    borderRadius: "0.6em",
    border: `1px solid ${ink.hairline}`,
    boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)",
    display: "block",
    opacity: "0",
    transition: "opacity 200ms ease",
  },
  ".cm-md-image-loaded img": { opacity: "1" },
  ".cm-md-image-broken": {
    color: ink.muted,
    fontStyle: "italic",
    border: `1px dashed ${ink.hairline}`,
    borderRadius: "0.4em",
    padding: "0.3em 0.8em",
  },

  /* ---- HTML --------------------------------------------------------- */
  ".cm-md-html": { whiteSpace: "normal" },
  ".cm-md-html-block": { display: "block", padding: "0.3em 0" },
});

const markdownHighlighting = HighlightStyle.define([
  { tag: t.heading, color: ink.heading, fontWeight: "650" },
  { tag: t.strong, fontWeight: "700", color: ink.heading },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: ink.link },
  { tag: [t.monospace, t.special(t.string)], color: ink.code },
  { tag: t.quote, color: ink.quote },
  { tag: t.contentSeparator, color: ink.hairline },
  { tag: [t.processingInstruction, t.meta], color: ink.muted },

  { tag: [t.keyword, t.moduleKeyword], color: "var(--cm-keyword, #7c3aed)" },
  { tag: [t.controlKeyword, t.operatorKeyword], color: ink.accent },
  { tag: [t.string, t.regexp], color: "var(--cm-string, #15803d)" },
  { tag: [t.number, t.bool, t.null], color: ink.code },
  { tag: [t.variableName, t.propertyName], color: ink.text },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: ink.link },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--cm-type, #0891b2)" },
  { tag: t.comment, color: ink.muted, fontStyle: "italic" },
]);

export const liveMarkdownTheme = [editorTheme, syntaxHighlighting(markdownHighlighting)];
