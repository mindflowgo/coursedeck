import { describe, expect, it, mock } from 'bun:test';
import type { MarkupStroke } from './types';

(globalThis as any).$state = (v: any) => v;
(globalThis as any).$derived = (v: any) => v;

await mock.module('$app/environment', () => ({
  browser: true
}));

let mockFetchHandler: (url: string, opts?: any) => Promise<any> = async () => ({
  ok: true,
  json: async () => ({ strokes: [] })
});

await mock.module('$lib/api', () => ({
  apiFetch: (url: string, opts?: any) => mockFetchHandler(url, opts)
}));

const {
  loadAnnotations,
  addStroke,
  createStroke,
  eraseStrokesAt,
  visibleStrokes,
  flushNow,
  exitMarkupMode,
  enterMarkupMode,
  markupUi
} = await import('./annotationStore.svelte');

describe('Annotation Store Resilience & Surface Ownership', () => {
  it('does not poison loadedCourses on failed GET /annotations, permitting retry', async () => {
    const courseId = 'retry-course';

    // 1. Initial attempt fails (e.g. 500 or offline)
    mockFetchHandler = async () => ({
      ok: false,
      status: 500
    });

    await loadAnnotations(courseId);
    expect(visibleStrokes(courseId, '01.01.lesson.html')).toEqual([]);

    // 2. Second attempt succeeds and loads strokes
    const stroke: MarkupStroke = {
      id: 'loaded-s1',
      file: '01.01.lesson.html',
      tool: 'marker',
      color: 'yellow',
      points: [10, 20, 0.5, 30, 40, 0.5],
      authorWidth: 800,
      date: '2026-11-12T01:00:00.000Z'
    };

    mockFetchHandler = async () => ({
      ok: true,
      json: async () => ({ strokes: [stroke] })
    });

    await loadAnnotations(courseId);
    const visible = visibleStrokes(courseId, '01.01.lesson.html');
    expect(visible.map((s) => s.id)).toEqual(['loaded-s1']);
  });

  it('reconciles retry queues so failed saves do not resurrect deleted strokes', async () => {
    const courseId = 'lww-course';
    const file = '01.01.lesson.html';

    const s1 = createStroke(courseId, file, 'marker', 'red', [10, 10, 0.5, 50, 50, 0.5], 800);

    // Initial save fails (e.g. network offline)
    mockFetchHandler = async () => {
      throw new Error('Network offline');
    };

    addStroke(courseId, s1);
    await flushNow();

    // While offline/requeueing, user erases the stroke
    eraseStrokesAt(courseId, file, [s1]);
    expect(visibleStrokes(courseId, file).length).toBe(0);

    // Network restores and flush succeeds
    let savedPayload: any = null;
    mockFetchHandler = async (_url, opts) => {
      savedPayload = JSON.parse(opts.body);
      return { ok: true };
    };

    await flushNow();

    // Verify stroke is still erased and tombstone has priority
    expect(visibleStrokes(courseId, file).length).toBe(0);
    expect(savedPayload.upserts.some((u: any) => u.id === s1.id && u.deleted)).toBe(true);
  });

  it('turns off markup mode cleanly when exiting or switching surfaces', () => {
    enterMarkupMode();
    expect(markupUi.mode).toBe(true);
    expect(markupUi.show).toBe(true);

    exitMarkupMode();
    expect(markupUi.mode).toBe(false);
    expect(markupUi.eraser).toBe(false);
  });
});
