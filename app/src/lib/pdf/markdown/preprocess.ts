/**
 * Markdown normalization shared with MarkdownViewer.svelte so the PDF
 * compiler sees exactly the same content the on-screen viewer renders:
 * frontmatter stripping, Pandoc image attributes, asset path rewriting,
 * GFM callouts and AI post-it extraction.
 *
 * Callouts and post-its are extracted into typed records and replaced with
 */

import { repairMarkdownTables } from '../../markdown/tableRepair';

export interface ExtractedCallout {
  kind: 'callout';
  type: string; // note | tip | important | warning | caution
  bodyMarkdown: string;
}

export interface ExtractedPostit {
  kind: 'postit';
  query: string;
  targetText: string;
  bodyMarkdown: string;
}

export type ExtractedBox = ExtractedCallout | ExtractedPostit;

export interface PreprocessedMarkdown {
  markdown: string;
  boxes: ExtractedBox[];
}

export const BOX_MARKER = /%%%PDFBOX_(\d+)%%%/;

export function normalizeMarkdown(raw: string, courseId: string): PreprocessedMarkdown {
  const boxes: ExtractedBox[] = [];

  // 1. Strip YAML frontmatter
  let md = raw.replace(/^---[\s\S]*?---\s*/, '');

  // 2. Normalize Pandoc attribute syntax: ![alt](url){width=300px} -> ![alt|width=300px](url)
  md = md.replace(/!\[(.*?)\]\((.*?)\)\{([^}]+)\}/g, (_m, alt, url, attr) => `![${alt}|${attr.trim()}](${url})`);

  // 3. Rewrite relative asset paths to API endpoints (same rules as the viewer)
  md = md.replace(
    /(?:src|href)=["'](?:\.\/)?assets\/(.*?)["']/gi,
    (_m, p) => `src="/api/courses/${courseId}/assets/${p}"`
  );
  md = md.replace(/!\[(.*?)\]\((?:\.\/)?assets\/(.*?)\)/gi, (_m, alt, p) => `![${alt}](/api/courses/${courseId}/assets/${p})`);
  md = md.replace(/\[(.*?)\]\((?:\.\/)?assets\/(.*?)\)/gi, (_m, text, p) => `[${text}](/api/courses/${courseId}/assets/${p})`);

  // 4. GFM callouts: > [!NOTE] etc. -> marker + record
  md = md.replace(
    /> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n((?:>.*(?:\n|$))*)/gi,
    (_m, type: string, content: string) => {
      const body = content.replace(/^>\s?/gm, '');
      boxes.push({ kind: 'callout', type: type.toLowerCase(), bodyMarkdown: repairMarkdownTables(body) });
      return `\n\n%%%PDFBOX_${boxes.length - 1}%%%\n\n`;
    }
  );

  // 5. AI post-it notes: > [!USERNOTE] query + <!-- target: "..." --> + body
  md = md.replace(
    />\s*\[!USERNOTE\]([^\n]*)\n((?:>.*(?:\n|$))*)/gi,
    (_m, queryMatch: string, content: string) => {
      const query = (queryMatch || '').trim();
      const block = content.replace(/^>\s?/gm, '');

      let targetText = '';
      const targetMatch = block.match(/<!--\s*target:\s*"([\s\S]*?)"\s*-->/i);
      if (targetMatch) {
        targetText = targetMatch[1].replace(/\\"/g, '"').trim();
      }
      const bodyMarkdown = block.replace(/<!--\s*target:\s*[\s\S]*?-->/gi, '').trim();

      boxes.push({ kind: 'postit', query, targetText, bodyMarkdown: repairMarkdownTables(bodyMarkdown) });
      return `\n\n%%%PDFBOX_${boxes.length - 1}%%%\n\n`;
    }
  );

  // 6. Repair multiline tables so they conform to GFM single-line table specifications
  md = repairMarkdownTables(md);

  return { markdown: md, boxes };
}
