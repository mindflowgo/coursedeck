import { describe, expect, it } from 'bun:test';
import { annotationSourceFile } from '../checkpoint/sourceAnchors';
import { isMarkupStroke, type MarkupStroke } from './types';
import { hitTestStroke, mergeStrokes } from './render';
import { indexStrokesByFile } from './pdfMarkup';
import { buildLessonBridgeScript } from '../server/lessonBridge';

describe('HTML Markup & File Scoping', () => {
  it('correctly maps physical file identities via annotationSourceFile', () => {
    // Original HTML lesson
    expect(annotationSourceFile('01.01.lesson.md', 'html', true)).toBe('01.01.lesson.html');
    // Companion Markdown for that same lesson
    expect(annotationSourceFile('01.01.lesson.md', 'markdown', true)).toBe('01.01.lesson.companion.md');
    // Pure Markdown lesson (no original HTML)
    expect(annotationSourceFile('01.01.lesson.md', 'markdown', false)).toBe('01.01.lesson.md');
    // Summary tab
    expect(annotationSourceFile('01.01.summary.md', 'markdown', true)).toBe('01.01.summary.md');
    // Course document
    expect(annotationSourceFile('course.schedule.md', 'markdown', false)).toBe('course.schedule.md');
  });

  it('validates freehand MarkupStroke records with HTML file identities', () => {
    const validHtmlStroke: MarkupStroke = {
      id: 'html-stroke-1',
      file: '01.01.lesson.html',
      tool: 'marker',
      color: 'red',
      points: [100, 150, 0.5, 120, 180, 0.8],
      authorWidth: 900,
      date: new Date().toISOString()
    };
    expect(isMarkupStroke(validHtmlStroke)).toBe(true);

    // Rejects non-finite coordinates
    expect(
      isMarkupStroke({
        ...validHtmlStroke,
        points: [100, NaN, 0.5]
      })
    ).toBe(false);

    expect(
      isMarkupStroke({
        ...validHtmlStroke,
        points: [100, Infinity, 0.5]
      })
    ).toBe(false);
  });

  it('isolates HTML strokes from companion Markdown strokes in indexing and merge', () => {
    const htmlFile = '01.01.lesson.html';
    const companionFile = '01.01.lesson.companion.md';

    const strokeHtml: MarkupStroke = {
      id: 'h1',
      file: htmlFile,
      tool: 'marker',
      color: 'yellow',
      points: [10, 20, 0.5, 30, 40, 0.5],
      authorWidth: 800,
      date: '2026-11-12T00:00:00.000Z'
    };
    const strokeCompanion: MarkupStroke = {
      id: 'c1',
      file: companionFile,
      tool: 'highlighter',
      color: 'hl-green',
      points: [50, 60, 0.5, 70, 80, 0.5],
      authorWidth: 800,
      date: '2026-11-12T00:00:00.000Z'
    };

    const merged = mergeStrokes([], [strokeHtml, strokeCompanion]);
    const indexed = indexStrokesByFile(merged.strokes);

    expect(indexed[htmlFile]?.map((s) => s.id)).toEqual(['h1']);
    expect(indexed[companionFile]?.map((s) => s.id)).toEqual(['c1']);

    // Merging tombstone for HTML stroke clears it without affecting companion
    const tombstoneHtml: MarkupStroke = {
      ...strokeHtml,
      date: '2026-11-12T00:01:00.000Z',
      deleted: '2026-11-12T00:01:00.000Z'
    };

    const mergedAfterDelete = mergeStrokes(merged.strokes, [tombstoneHtml]);
    const indexedAfterDelete = indexStrokesByFile(mergedAfterDelete.strokes);

    expect(indexedAfterDelete[htmlFile]).toBeUndefined();
    expect(indexedAfterDelete[companionFile]?.map((s) => s.id)).toEqual(['c1']);
  });

  it('hit tests strokes accurately under author-width scaling', () => {
    const stroke: MarkupStroke = {
      id: 'scale-test',
      file: '01.01.lesson.html',
      tool: 'marker',
      color: 'blue',
      points: [100, 200, 0.5, 150, 200, 0.5],
      authorWidth: 500,
      date: new Date().toISOString()
    };

    // Scale 1 (width 500)
    expect(hitTestStroke(stroke, 1, 125, 200, 10)).toBe(true);
    expect(hitTestStroke(stroke, 1, 300, 300, 10)).toBe(false);

    // Scale 2 (rendered width 1000)
    // author x=125, y=200 -> rendered x=250, y=400
    expect(hitTestStroke(stroke, 2, 250, 400, 10)).toBe(true);
    // Old unscaled coordinate should miss
    expect(hitTestStroke(stroke, 2, 125, 200, 10)).toBe(false);
  });

  it('injected lesson bridge computes intrinsic content height and avoids locking to iframe viewport', () => {
    const script = buildLessonBridgeScript('test-course');
    expect(script).toContain('courseDeck:lessonHeight');
    expect(script).toContain('height: auto !important;');
    expect(script).toContain('min-height: auto !important;');
    // Ensure viewport dimensions are not used in sendHeight to prevent viewport height locking
    const sendHeightSection = script.slice(script.indexOf('function sendHeight()'), script.indexOf('function scheduleHeight'));
    expect(sendHeightSection).not.toContain('html.clientHeight');
    expect(sendHeightSection).not.toContain('html.scrollHeight');
    expect(sendHeightSection).toContain('body.scrollHeight');
    expect(sendHeightSection).toContain('body.offsetHeight');
  });
});
