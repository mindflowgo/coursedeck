import { describe, it, expect } from 'bun:test';
import { normalizeMarkdown } from './preprocess';
import { resolveImageSource } from '$lib/editor/sources';

describe('Asset path rewriting for locker docs and images', () => {
  it('rewrites ../assets/ links and images to API endpoints', () => {
    const markdown = [
      'Read through the [framework and the student considerations](../assets/locker_docs/transferable_skills.html).',
      '![Diagram](../assets/img/diagram.png)',
      '![Icon](./assets/icons/info.svg)',
      '<a href="../assets/locker_docs/sheet.html">Worksheet</a>',
      '<img src="../assets/img/photo.jpg" alt="Photo">'
    ].join('\n');

    const result = normalizeMarkdown(markdown, 'gwl3o');

    expect(result.markdown).toContain('[framework and the student considerations](/api/courses/gwl3o/assets/locker_docs/transferable_skills.html)');
    expect(result.markdown).toContain('![Diagram](/api/courses/gwl3o/assets/img/diagram.png)');
    expect(result.markdown).toContain('![Icon](/api/courses/gwl3o/assets/icons/info.svg)');
    expect(result.markdown).toContain('href="/api/courses/gwl3o/assets/locker_docs/sheet.html"');
    expect(result.markdown).toContain('src="/api/courses/gwl3o/assets/img/photo.jpg"');
  });

  it('resolves ../assets/ paths in resolveImageSource', () => {
    expect(resolveImageSource('../assets/img/test.png', 'gwl3o')).toBe('/api/courses/gwl3o/assets/img/test.png');
    expect(resolveImageSource('../../assets/img/test.png', 'gwl3o')).toBe('/api/courses/gwl3o/assets/img/test.png');
    expect(resolveImageSource('./assets/img/test.png', 'gwl3o')).toBe('/api/courses/gwl3o/assets/img/test.png');
    expect(resolveImageSource('assets/img/test.png', 'gwl3o')).toBe('/api/courses/gwl3o/assets/img/test.png');
  });
});
