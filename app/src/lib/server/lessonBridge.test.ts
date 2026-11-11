import { describe, expect, it } from 'bun:test';
import { buildLessonBridgeScript } from './lessonBridge';

describe('buildLessonBridgeScript', () => {
  it('injects the courseId and speaks the full message contract', () => {
    const script = buildLessonBridgeScript('mhf4u');
    expect(script).toContain('courseDeck:lessonHeight');
    expect(script).toContain('courseDeck:iframeMouseMove');
    expect(script).toContain('courseDeck:iframePointerUp');
    expect(script).toContain('courseDeck:iframeMouseLeave');
    expect(script).toContain('courseDeck:textSelected');
    expect(script).toContain('courseDeck:selectionCleared');
    expect(script).toContain('courseDeck:anchorPositions');
    expect(script).toContain('courseDeck:applyHighlights');
    expect(script).toContain('courseDeck:queryAnchorPositions');
    // courseId arrives as a JSON literal, not a template hole
    expect(script).toContain('"mhf4u"');
    // session token validation is present
    expect(script).toContain('session');
  });

  it('emits a syntactically valid script', () => {
    const script = buildLessonBridgeScript('baf3m');
    const start = script.indexOf('<script>');
    const end = script.lastIndexOf('</script>');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const js = script.slice(start + '<script>'.length, end);
    // Throws on syntax errors only — nothing is executed.
    expect(() => new Function(js)).not.toThrow();
  });

  it('escapes backslashes in regexes so they survive injection', () => {
    const script = buildLessonBridgeScript('mcr3u');
    // The whitespace-normalization regexes must reach the browser intact.
    expect(script).toContain('/\\s+/g');
    expect(script).toContain('/\\s/.test(sel.text)');
  });
});
