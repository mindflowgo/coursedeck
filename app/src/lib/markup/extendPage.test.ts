import { describe, it, expect } from 'bun:test';
import {
  SKETCH_BLOCK_MARKDOWN,
  buildPageExtensionMarkdown,
  extendMarkdownContent
} from './extendPage';
import { parseFrontmatter } from '../parser/frontmatter';

describe('Page Extension Sketch Block Builder', () => {
  it('builds a clean semantic sketch block div for markdown', () => {
    const ext = buildPageExtensionMarkdown();
    expect(ext).toContain(SKETCH_BLOCK_MARKDOWN);
    expect(ext).toContain('<div class="sketch-block">');
  });

  it('extends raw lesson tab content with sketch block directly', () => {
    const rawLesson = '# Lesson 1\n\nIntroduction to Calculus.';
    const extended = extendMarkdownContent(rawLesson, true);
    expect(extended.startsWith(rawLesson)).toBe(true);
    expect(extended).toContain('<div class="sketch-block">&nbsp;</div>');
  });

  it('extends generated tab content while preserving frontmatter intact', () => {
    const content = `---
prompt: Generate summary
updatedAt: "2026-10-28"
---

# Summary

Here is the lesson summary.`;

    const extended = extendMarkdownContent(content, false);
    const parsed = parseFrontmatter(extended);
    expect(parsed.frontmatter.prompt).toBe('Generate summary');
    expect(parsed.frontmatter.updatedAt).toBe('2026-10-28');
    expect(parsed.body.startsWith('# Summary')).toBe(true);
    expect(parsed.body).toContain('<div class="sketch-block">&nbsp;</div>');
  });

  it('supports multiple sequential sketch blocks cumulatively', () => {
    const initial = '# Notes\n';
    const first = extendMarkdownContent(initial, true);
    const second = extendMarkdownContent(first, true);
    const matches = second.match(/class="sketch-block"/g);
    expect(matches?.length).toBe(2);
  });
});
