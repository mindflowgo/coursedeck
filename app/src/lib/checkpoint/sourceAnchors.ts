import { lexer } from 'marked';

export type AnnotationRenderer = 'html' | 'markdown';

export class AnnotationSourceConflictError extends Error {}

export function requiredAnnotationAnchorIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16 || value.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) {
    throw new Error('Invalid required annotation anchor IDs');
  }
  return value;
}

export function assertAnnotationAnchorIds(content: string, renderer: AnnotationRenderer, ids: string[]): void {
  const pattern = renderer === 'markdown' ? /<!--coursedeck-anchor:([A-Za-z0-9_-]+)-->/g : /\bdata-anchor-id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  const searchable = renderer === 'markdown' ? markdownBlocks(content).filter((token) => token.type === 'html').map((token) => token.raw).join('\n') : content;
  const actual = new Set(Array.from(searchable.matchAll(pattern), (m) => m[1] || m[2] || m[3]));
  if (ids.some((id) => !actual.has(id))) throw new AnnotationSourceConflictError('Annotation source changed; select the passage again');
}

function markdownBlocks(source: string) {
  // Marked normalizes CRLF internally. Map token offsets back to the source
  // so a lazy migration preserves its original line endings byte for byte.
  const offsets = [0];
  let normalized = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\r') {
      if (source[i + 1] === '\n') i++;
      normalized += '\n';
    } else normalized += source[i];
    offsets.push(i + 1);
  }
  let cursor = 0;
  return lexer(normalized).map((token) => {
    const start = cursor;
    cursor += token.raw.length;
    return { type: token.type, raw: token.raw, original: source.slice(offsets[start], offsets[cursor]) };
  });
}

/** Deterministic, file-local IDs let an in-memory render match a later migration. */
export function sourceAnchorId(text: string, occurrence: number): string {
  let a = 2166136261;
  let b = 2246822519;
  const input = `${occurrence}\0${text}`;
  for (let i = 0; i < input.length; i++) {
    a = Math.imul(a ^ input.charCodeAt(i), 16777619);
    b = Math.imul(b ^ input.charCodeAt(i), 3266489917);
  }
  return `a-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function instrumentMarkdownAnchors(source: string): string {
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source)?.[0] || '';
  const body = source.slice(frontmatter.length);
  const used = new Set(Array.from(source.matchAll(/<!--coursedeck-anchor:([A-Za-z0-9_-]+)-->/g), (m) => m[1]));
  const counts = new Map<string, number>();
  let anchored = false;
  let result = frontmatter;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  for (const token of markdownBlocks(body)) {
    const raw = token.raw;
    if (token.type === 'space' || token.type === 'def') {
      result += token.original;
      continue;
    }
    if (/^\s*<!--coursedeck-anchor:[A-Za-z0-9_-]+-->\s*$/.test(raw)) {
      anchored = true;
      result += token.original;
      continue;
    }
    const key = raw.trim();
    const occurrence = counts.get(key) || 0;
    counts.set(key, occurrence + 1);
    if (!anchored) {
      let suffix = occurrence;
      let id = sourceAnchorId(key, suffix);
      while (used.has(id)) id = sourceAnchorId(key, ++suffix);
      used.add(id);
      result += `<!--coursedeck-anchor:${id}-->${newline}`;
    }
    anchored = false;
    result += token.original;
  }
  return result;
}

/** Keep code examples intact while removing private source metadata from AI context. */
export function stripMarkdownAnchorMetadata(source: string): string {
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source)?.[0] || '';
  return frontmatter + markdownBlocks(source.slice(frontmatter.length)).map((token) => token.type === 'html'
    ? token.original.replace(/^<!--coursedeck-anchor:[A-Za-z0-9_-]+-->\r?\n?/gm, '')
    : token.original).join('');
}

export function validateAnnotationSourceFile(file: unknown): string {
  if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.(?:md|html)$/.test(file)) {
    throw new Error('Invalid annotation source filename');
  }
  return file;
}

/** The original and its companion deliberately have different file identities. */
export function annotationSourceCandidates(file: unknown, renderer: AnnotationRenderer): string[] {
  const name = validateAnnotationSourceFile(file);
  if (renderer === 'html') {
    if (!/\.lesson\.(?:md|html)$/.test(name)) throw new Error('HTML annotations require a lesson HTML source');
    return [name.replace(/\.lesson\.(?:md|html)$/, '.lesson.html')];
  }
  if (renderer !== 'markdown') throw new Error('Invalid annotation renderer');
  if (/\.lesson\.(?:md|html)$/.test(name)) {
    return [name.replace(/\.lesson\.(?:md|html)$/, '.lesson.companion.md'), name.replace(/\.html$/, '.md')];
  }
  if (!name.endsWith('.md')) throw new Error('Markdown annotations require a Markdown source');
  return [name];
}

export function annotationSourceFile(file: unknown, renderer: AnnotationRenderer, hasOriginal = false): string {
  const candidates = annotationSourceCandidates(file, renderer);
  return candidates.length > 1 && !hasOriginal ? candidates[1] : candidates[0];
}
