/**
 * Strips out images, pictures, and inaccessible links from lesson markdown
 * before posting content to an LLM.
 *
 * LLMs cannot view local asset images (e.g. `./assets/img/...`) or navigate local
 * file references (e.g. `./assets/lockerdocs/...`). Including them wastes prompt tokens,
 * distracts generation, and may cause the model to emit broken image syntax or hallucinations.
 *
 * Rules:
 * 1. Pictures/Images: Completely removed (markdown `![alt|spec](url)`, pandoc attributes,
 *    linked images `[![alt](img)](url)`, HTML `<img>`, and `<picture>` tags).
 *    Standalone image lines are eliminated without leaving orphan blank lines, list bullets,
 *    or blockquote markers.
 * 2. Links: Inaccessible link URLs are stripped. If the link contains meaningful anchor prose
 *    (e.g. `[Charter of Rights](https://...)`), the readable text is preserved (`Charter of Rights`).
 *    If the link anchor is a bare URL, file path/name, generic label, or empty, the entire link
 *    is stripped.
 * 3. Preserves: Fenced code blocks, LaTeX math blocks (`$[0, 1]$`, `$$...$$`), YAML frontmatter,
 *    tables, headers, and formatted prose.
 */

export function stripLessonMedia(markdown: string | null | undefined): string {
  if (!markdown) return '';

  const protectedBlocks: string[] = [];
  const protect = (match: string): string => {
    protectedBlocks.push(match);
    return `%%%PROTECTED_BLOCK_${protectedBlocks.length - 1}%%%`;
  };

  let text = markdown;

  // 1. Protect YAML frontmatter at document start
  text = text.replace(/^---[\s\S]*?---\s*\n?/m, protect);

  // 2. Protect fenced code blocks (``` and ~~~)
  text = text.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, protect);

  // 3. Protect LaTeX math formulas: $$...$$, $...$, \[...\], \(...\)
  text = text.replace(/(\$\$[\s\S]*?\$\$|\$[^\n$]+?\$|\\\[[\s\S]*?\\\]|\\\(.*?\\\))/g, protect);

  // 4. Strip HTML picture, figure, and img tags
  text = text.replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '');
  text = text.replace(/<img\b[^>]*>(?:[\s\S]*?<\/img>)?/gi, '');
  text = text.replace(/<img\b[^>]*\/?>/gi, '');
  text = text.replace(/<\/img>/gi, '');

  // 5. Strip linked images: [![alt](img)](url)
  text = text.replace(/\[\s*!\[[^\]]*\]\([^)]*\)\s*\]\([^)]*\)/g, '');

  // 6. Strip lines that contain ONLY markdown image tags (with optional blockquote or list markers)
  // E.g.: ![alt|50%](./assets/img/foo.jpg), > ![icon](./assets/icons/think.svg), - ![photo](./assets/img/photo.jpg)
  const isImageOnlyLine = (line: string): boolean => {
    const stripped = line.replace(/^\s*(?:>+\s*|[-*+]\s+|\d+\.\s*)?/, '').trim();
    return /^(!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?\s*)+$/.test(stripped);
  };

  const isPrefixLine = (line: string): boolean => {
    return /^\s*(?:>+|[-*+]|\d+\.)/.test(line);
  };

  text = text
    .split('\n')
    .map((line) => {
      if (isImageOnlyLine(line)) {
        // If it's a blockquote or list line, drop it entirely so we don't leave empty marker lines
        if (isPrefixLine(line)) {
          return null;
        }
        // If it's a standalone image line between content, leave an empty line to preserve block separation
        return '';
      }
      return line;
    })
    .filter((line): line is string => line !== null)
    .join('\n');

  // 7. Strip any remaining inline markdown image tags (including obsidian sizing and pandoc attributes)
  text = text.replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '');
  text = text.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '');

  // 8. Strip reference-style link definitions that point to images or assets
  text = text.replace(/^[ \t]*\[[^\]]+\]:\s*\S*(?:\.(?:jpe?g|png|gif|svg|webp|bmp|ico)|assets\/)\S*.*$/gim, '');

  // 9. Process markdown links: [text](url)
  // Check if target points to an image/icon file
  const isImageOrAssetTarget = (url: string): boolean => {
    const cleanUrl = url.trim().split(/\s+/)[0];
    return (
      /\.(?:jpe?g|png|gif|svg|webp|bmp|ico)(?:\?.*)?$/i.test(cleanUrl) ||
      /(?:^|[\\/])assets\/(?:img|icons)[\\/]/i.test(cleanUrl)
    );
  };

  // Check if link anchor text is purely a URL, file path, or non-informative label
  const isUrlOrFileText = (t: string): boolean => {
    const s = t.trim().toLowerCase();
    if (!s) return true;
    if (/^(?:https?:\/\/|www\.|\/|(?:\.\.?[\\/]))/i.test(s)) return true;
    if (/\.(?:jpe?g|png|gif|svg|webp|pdf|docx?|html?|zip)$/i.test(s)) return true;
    if (/^(?:image|picture|photo|icon|figure|fig\.?)$/i.test(s)) return true;
    return false;
  };

  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_match, linkText, url) => {
    if (isImageOrAssetTarget(url)) {
      return '';
    }
    if (isUrlOrFileText(linkText)) {
      return '';
    }
    return linkText;
  });

  // 10. Process HTML <a> tags
  text = text.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, url, linkText) => {
    if (isImageOrAssetTarget(url)) {
      return '';
    }
    const cleanText = linkText.replace(/<[^>]+>/g, '').trim();
    if (isUrlOrFileText(cleanText)) {
      return '';
    }
    return cleanText;
  });

  // 11. Strip bare autolinks: <http://...> or <https://...> or <mailto:...>
  text = text.replace(/<(?:https?|ftp|mailto):[^>]+>/gi, '');

  // 12. Cleanup empty markers and spacing:
  // - Remove lines left with only orphan list bullets or blockquote markers
  // - Collapse redundant horizontal spaces within lines
  text = text
    .split('\n')
    .map((line) => {
      const leadingSpaces = line.match(/^\s*/)?.[0] || '';
      const rest = line.slice(leadingSpaces.length).replace(/[ \t]{2,}/g, ' ');
      return leadingSpaces + rest;
    })
    .filter((line) => {
      // Discard lines that contain only whitespace and empty list/quote markers
      if (/^\s*(?:[-*+]|\d+\.|\>+)\s*$/.test(line)) {
        return false;
      }
      return true;
    })
    .join('\n');

  // 13. Normalize excessive blank lines (3 or more newlines become 2)
  text = text.replace(/\n{3,}/g, '\n\n');

  // 14. Restore protected blocks (frontmatter, code blocks, math)
  text = text.replace(/%%%PROTECTED_BLOCK_(\d+)%%%/g, (_match, idx) => {
    return protectedBlocks[parseInt(idx, 10)] ?? '';
  });

  return text.trim();
}
