import { describe, expect, it } from 'bun:test';
import { annotationSourceFile, assertAnnotationAnchorIds, instrumentMarkdownAnchors, stripMarkdownAnchorMetadata } from './sourceAnchors';
import { instrumentHtmlAnchors, preservesHtmlAnchorIds, stripHtmlAnchorMetadata } from './htmlSourceAnchors';

describe('file-local source anchor migration', () => {
  it('preserves Markdown frontmatter, existing IDs, fenced code and repeatability', () => {
    const prefix = '---\ntitle: Example\n---\n';
    const body = '# Heading\n\n<!--coursedeck-anchor:old-id-->\nParagraph.\n\n```html\n<p>code</p>\n```\n\n- item one\n- item two\n';
    const output = instrumentMarkdownAnchors(prefix + body);
    expect(output.startsWith(prefix)).toBe(true);
    expect(output).toContain('<!--coursedeck-anchor:old-id-->\nParagraph.');
    expect(output).toContain('```html\n<p>code</p>\n```');
    expect(instrumentMarkdownAnchors(output)).toBe(output);
    expect(output.slice(prefix.length)).toBe(instrumentMarkdownAnchors(body));
    expect(instrumentMarkdownAnchors(body.trim())).toBe(instrumentMarkdownAnchors(body).trim());
  });

  it('gives identical paragraphs distinct stable IDs', () => {
    const output = instrumentMarkdownAnchors('Same.\n\nSame.\n');
    const ids = Array.from(output.matchAll(/coursedeck-anchor:([^>]+)-->/g), (m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(instrumentMarkdownAnchors('Same.\n\nSame.\n')).toBe(output);
  });

  it('preserves CRLF source and strips metadata without deleting fenced examples', () => {
    const source = '---\r\ntitle: Example\r\n---\r\n# Heading\r\n\r\n```md\r\n<!--coursedeck-anchor:example-->\r\n```\r\n';
    const output = instrumentMarkdownAnchors(source);
    expect(output.replace(/<!--coursedeck-anchor:a-[a-f0-9]+-->\r\n/g, '')).toBe(source);
    expect(stripMarkdownAnchorMetadata(output)).toBe(source);
    expect(instrumentMarkdownAnchors(output)).toBe(output);
  });

  it('rejects IDs from stale rendered content', () => {
    const rendered = instrumentMarkdownAnchors('Old paragraph.');
    const id = /coursedeck-anchor:([^>]+)-->/g.exec(rendered)![1];
    expect(() => assertAnnotationAnchorIds(rendered, 'markdown', [id])).not.toThrow();
    expect(() => assertAnnotationAnchorIds(instrumentMarkdownAnchors('New paragraph.'), 'markdown', [id])).toThrow('source changed');
  });

  it('only adds HTML attributes and leaves comments, quoted attributes and raw text intact', () => {
    const source = '<!doctype html><html><head><script>if (a < b) { const x = "<p>not markup</p>"; }</script><style>.x:before {content:"<div>"}</style></head><body><!-- <p>comment</p> --><p title="a > b">One</p><p data-anchor-id="keep">Two</p><textarea><p>plain</p></textarea><p>Three</p></body></html>';
    const output = instrumentHtmlAnchors(source);
    expect(output.replace(/ data-anchor-id="a-[a-f0-9]+"/g, '')).toBe(source);
    expect(output.match(/data-anchor-id=/g)).toHaveLength(3);
    expect(instrumentHtmlAnchors(output)).toBe(output);
    expect(instrumentHtmlAnchors(source)).toBe(output);
  });

  it('compares only real HTML anchor attributes and preserves IDs on their existing elements', () => {
    const source = '<script>const example = \'<p data-anchor-id="example">\';</script><p>One</p><p>Two</p>';
    const migrated = instrumentHtmlAnchors(source);
    expect(stripHtmlAnchorMetadata(migrated)).toBe(source);
    expect(preservesHtmlAnchorIds(source, migrated)).toBe(true);
    expect(preservesHtmlAnchorIds(migrated, source)).toBe(false);
    const current = '<p data-anchor-id="one">One</p><p data-anchor-id="two">Two</p>';
    const swapped = '<p data-anchor-id="two">One</p><p data-anchor-id="one">Two</p>';
    expect(stripHtmlAnchorMetadata(current)).toBe(stripHtmlAnchorMetadata(swapped));
    expect(preservesHtmlAnchorIds(current, swapped)).toBe(false);
  });

  it('keeps original HTML, companion Markdown and ordinary tabs in separate file scopes', () => {
    expect(annotationSourceFile('01.01.lesson.md', 'html', true)).toBe('01.01.lesson.html');
    expect(annotationSourceFile('01.01.lesson.md', 'markdown', true)).toBe('01.01.lesson.companion.md');
    expect(annotationSourceFile('01.01.lesson.md', 'markdown', false)).toBe('01.01.lesson.md');
    expect(annotationSourceFile('01.01.summary.md', 'markdown', true)).toBe('01.01.summary.md');
    expect(() => annotationSourceFile('../course.schedule.md', 'markdown')).toThrow();
    expect(() => annotationSourceFile('C:\\course.schedule.md', 'markdown')).toThrow();
    expect(() => annotationSourceFile('course.schedule.md', 'html')).toThrow();
  });
});
