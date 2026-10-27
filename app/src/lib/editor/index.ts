import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdown,
} from "@codemirror/lang-markdown";
import { type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { listIndent } from "./listIndent";
import { continueListItem, insertNewLine } from "./lists";
import { liveMarkdownPreview } from "./livePreview";
import { courseIdFacet } from "./sources";
import { liveMarkdownTheme } from "./theme";

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform || "");
}

/**
 * Mod-click (Cmd-click on Mac, Ctrl-click on other OS) opens a link in a new tab.
 * Plain click keeps the caret in the editor so you can edit the link.
 */
const openLinkOnModClick = EditorView.domEventHandlers({
  mousedown(event) {
    if (event.button !== 0) return false;
    const isMod = isMac() ? event.metaKey : event.ctrlKey;
    if (!isMod) return false;

    const target = event.target as HTMLElement | null;
    const href = target?.closest<HTMLElement>("[data-href]")?.dataset.href;
    if (!href) return false;

    event.preventDefault();
    window.open(href, "_blank", "noopener,noreferrer");
    return true;
  },
});

/**
 * Enter continues a bullet, numbered list, or task;
 * Enter on an empty item exits the list.
 * Shift+Enter creates a continuation line under the current item.
 */
const markdownEditingKeymap = Prec.high(
  keymap.of([
    {
      key: "Enter",
      run: insertNewLine(insertNewlineContinueMarkupCommand({ nonTightLists: false })),
      shift: continueListItem,
    },
    { key: "Backspace", run: deleteMarkupBackward },
  ])
);

export interface LiveMarkdownOptions {
  courseId?: string;
}

/**
 * Complete Obsidian-style Live Preview extension for CodeMirror:
 * - In-place live rendering of headings, bold, italic, code, quotes, lists, tasks, tables, rules, and images.
 * - Markdown syntax markers hide when the cursor is away, and reveal when the cursor lands on the line.
 * - Interactive task checkboxes that update the markdown document on click.
 * - Interactive GFM tables with cell click-to-edit.
 * - Automatic list continuation and renumbering on Enter.
 * - Beautiful typography matching the study tool reader.
 */
export function liveMarkdown(options?: LiveMarkdownOptions): Extension {
  return [
    markdown({ extensions: GFM, addKeymap: false }),
    courseIdFacet.of(options?.courseId || ""),
    markdownEditingKeymap,
    EditorView.lineWrapping,
    liveMarkdownTheme,
    liveMarkdownPreview,
    listIndent,
    openLinkOnModClick,
  ];
}

export { courseIdFacet } from "./sources";
export { liveMarkdownPreview } from "./livePreview";
export { liveMarkdownTheme } from "./theme";
export { imagePasteHandler } from "./imagePaste";
export { generateLockerDocFilename, compressImageToJpeg } from "./imageProcessor";
