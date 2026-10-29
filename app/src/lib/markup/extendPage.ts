import { parseFrontmatter, serializeWithFrontmatter } from '../parser/frontmatter';

/**
 * HTML/Markdown sketch block inserted into the document.
 * Rendered by MarkdownViewer as a designated high-canvas sketching area.
 */
export const SKETCH_BLOCK_MARKDOWN = '<div class="sketch-block">&nbsp;</div>';

/**
 * Generates the sketch block markdown extension.
 */
export function buildPageExtensionMarkdown(): string {
  return '\n\n' + SKETCH_BLOCK_MARKDOWN + '\n';
}

/**
 * Extends markdown document content by appending a sketch block workspace.
 * Preserves YAML frontmatter for generated and custom tabs,
 * while extending raw text for pure lesson tabs.
 */
export function extendMarkdownContent(
  rawContent: string,
  isLessonTab: boolean
): string {
  const extension = buildPageExtensionMarkdown();
  if (isLessonTab) {
    return (rawContent || '') + extension;
  }
  const parsed = parseFrontmatter(rawContent || '');
  const newBody = (parsed.body || '') + extension;
  return serializeWithFrontmatter(parsed.frontmatter, newBody);
}
