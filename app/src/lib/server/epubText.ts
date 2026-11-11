import { unzipSync } from 'fflate';
import * as cheerio from 'cheerio';

export interface EpubExtractionResult {
  markdown: string;
  chapterCount: number;
  title?: string;
}

/**
 * Extracts clean, chapter-delimited text from an EPUB buffer.
 * Each chapter is annotated with `<!-- page: N -->` so downstream LLM
 * curriculum builders can correlate lesson topics to book chapters/pages.
 */
export function extractTextFromEpub(buffer: Buffer | Uint8Array): EpubExtractionResult {
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const unzipped = unzipSync(uint8);
  const textDecoder = new TextDecoder('utf-8');

  const htmlEntries: Array<{ name: string; content: string }> = [];

  for (const [filename, fileBytes] of Object.entries(unzipped)) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.xhtml') || lower.endsWith('.html') || lower.endsWith('.htm')) {
      // Exclude pure navigation/toc boilerplate if standalone
      if (!lower.includes('nav.xhtml') && !lower.includes('toc.xhtml')) {
        htmlEntries.push({
          name: filename,
          content: textDecoder.decode(fileBytes)
        });
      }
    }
  }

  // Natural sort by file path
  htmlEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const chapters: string[] = [];
  let pageIdx = 1;

  for (const entry of htmlEntries) {
    const $ = cheerio.load(entry.content);
    $('script, style, nav, footer, noscript').remove();

    // Extract headings if present
    const h1 = $('h1').first().text().trim();
    const h2 = $('h2').first().text().trim();
    const heading = h1 || h2 || '';

    const text = $('body').text().trim() || $.text().trim();
    if (text.length > 40) {
      const headerPrefix = heading ? `## ${heading}\n\n` : '';
      chapters.push(`<!-- page: ${pageIdx} -->\n\n${headerPrefix}${text}`);
      pageIdx++;
    }
  }

  return {
    markdown: chapters.join('\n\n'),
    chapterCount: chapters.length
  };
}
