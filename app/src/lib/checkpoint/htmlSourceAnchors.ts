import { sourceAnchorId } from './sourceAnchors';

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'td', 'th', 'dt', 'dd', 'figcaption', 'div', 'section', 'article', 'table', 'ul', 'ol', 'dl', 'figure']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

function transformStartTags(source: string, transform: (tag: string, name: string) => string): string {
  const tags = /<!--[\s\S]*?-->|<(?:(?:"[^"]*")|(?:'[^']*')|[^'">])*>/g;
  let result = '';
  let cursor = 0;
  for (let token = tags.exec(source); token; token = tags.exec(source)) {
    let tag = token[0];
    result += source.slice(cursor, token.index);
    cursor = tags.lastIndex;
    if (tag.startsWith('<!--')) { result += tag; continue; }
    const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b/.exec(tag);
    if (!match) { result += tag; continue; }
    const name = match[2].toLowerCase();
    if (!match[1]) tag = transform(tag, name);
    result += tag;
    if (!match[1] && RAW_TEXT.has(name)) {
      const closing = new RegExp(`</${name}\\s*>`, 'gi');
      closing.lastIndex = cursor;
      const end = closing.exec(source);
      const next = end ? closing.lastIndex : source.length;
      result += source.slice(cursor, next);
      cursor = tags.lastIndex = next;
    }
  }
  return result + source.slice(cursor);
}

/** Insert attributes without reserializing the document or touching script text. */
export function instrumentHtmlAnchors(source: string): string {
  const used = new Set(Array.from(source.matchAll(/\bdata-anchor-id\s*=\s*["']([^"']+)["']/gi), (m) => m[1]));
  const counts = new Map<string, number>();
  return transformStartTags(source, (tag, name) => {
    if (BLOCKS.has(name) && !/\sdata-anchor-id(?:\s|=|\/?>)/i.test(tag)) {
      const occurrence = counts.get(tag) || 0;
      counts.set(tag, occurrence + 1);
      let suffix = occurrence;
      let id = sourceAnchorId(tag, suffix);
      while (used.has(id)) id = sourceAnchorId(tag, ++suffix);
      used.add(id);
      tag = tag.replace(/\s*\/?>$/, (end) => ` data-anchor-id="${id}"${end}`);
    }
    return tag;
  });
}

/** Used for compare-and-swap sync: anchor metadata is the only allowed difference. */
export function stripHtmlAnchorMetadata(source: string): string {
  return transformStartTags(source, (tag) => tag.replace(/\s+data-anchor-id(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|\/?>)/gi, ''));
}

/** Existing server anchors must remain on the same source elements. */
export function preservesHtmlAnchorIds(current: string, incoming: string): boolean {
  const collect = (source: string) => {
    const values: Array<string | null> = [];
    transformStartTags(source, (tag) => {
      const match = /\sdata-anchor-id(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?(?=\s|\/?>)/i.exec(tag);
      values.push(match ? (match[1] ?? match[2] ?? match[3] ?? '') : null);
      return tag;
    });
    return values;
  };
  const existing = collect(current);
  const next = collect(incoming);
  return existing.length === next.length && existing.every((id, index) => id === null || id === next[index]);
}
