import { describe, expect, it } from 'bun:test';
import { findBestQuoteSpan, resolveCheckpointTop } from './selection';
import { clamp, clampTriggerY, defaultTriggerY, isWithinVerticalBounds, readerYToOverlayY, iframeClientYToViewportSpace } from './coordinates';

describe('findBestQuoteSpan', () => {
  const text = 'The quadratic formula yields roots. Later, the quadratic formula appears again.';

  it('returns the unique occurrence directly', () => {
    const span = findBestQuoteSpan(text, 'yields roots');
    expect(span).toEqual({ start: text.indexOf('yields roots'), end: text.indexOf('yields roots') + 12 });
  });

  it('returns null when the quote is absent', () => {
    expect(findBestQuoteSpan(text, 'not present')).toBeNull();
  });

  it('returns null on an empty quote', () => {
    expect(findBestQuoteSpan(text, '')).toBeNull();
  });

  it('disambiguates repeated quotes using prefix', () => {
    const span = findBestQuoteSpan(text, 'the quadratic formula', 'Later, ');
    expect(span).not.toBeNull();
    expect(span!.start).toBe(text.indexOf('the quadratic formula', 30));
  });

  it('disambiguates repeated quotes using suffix', () => {
    const span = findBestQuoteSpan(text, 'the quadratic formula', undefined, ' appears');
    expect(span).not.toBeNull();
    expect(span!.start).toBe(text.indexOf('the quadratic formula', 30));
  });

  it('refuses to guess when repeats are ambiguous', () => {
    const repeated = 'alpha beta alpha beta alpha';
    expect(findBestQuoteSpan(repeated, 'beta')).toBeNull();
    // Symmetric framing cannot pick a side.
    expect(findBestQuoteSpan(repeated, 'beta', 'alpha ', ' alpha')).toBeNull();

    const asymmetric = 'alpha beta alpha beta gamma';
    expect(findBestQuoteSpan(asymmetric, 'beta', undefined, ' alpha')).toEqual({
      start: asymmetric.indexOf('beta'),
      end: asymmetric.indexOf('beta') + 4
    });
    expect(findBestQuoteSpan(asymmetric, 'beta', 'alpha ', ' gamma')).toEqual({
      start: asymmetric.indexOf('beta', 10),
      end: asymmetric.indexOf('beta', 10) + 4
    });
  });
});

describe('coordinate clamps', () => {
  it('keeps the rendered center at the pointer across repeated movements and different reader/overlay offsets', () => {
    const reader = { top: 180 };
    const overlay = { top: 80 };
    for (const clientY of [400, 450, 451, 449, 500, 400]) {
      const cssTop = readerYToOverlayY(clientY - reader.top, reader, overlay);
      expect(overlay.top + cssTop).toBe(clientY);
    }
  });

  it('uses the same overlay coordinates for a scrolled iframe and parent mouse events', () => {
    const reader = { top: 180 };
    const overlay = { top: 80 };
    const iframe = { top: -250 };
    const readerY = iframeClientYToViewportSpace(
      700,
      { getBoundingClientRect: () => iframe } as HTMLElement,
      { getBoundingClientRect: () => reader } as HTMLElement
    );
    expect(overlay.top + readerYToOverlayY(readerY, reader, overlay)).toBe(450);
  });

  it('clamp constrains to the bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(14, 0, 10)).toBe(10);
  });

  it('clampTriggerY respects toolbar clearance and control size', () => {
    const viewport = { height: 600 };
    const opts = { topClearance: 56, controlHalfHeight: 18 };
    expect(clampTriggerY(300, viewport, opts)).toBe(300);
    expect(clampTriggerY(10, viewport, opts)).toBe(56);
    expect(clampTriggerY(599, viewport, opts)).toBe(582);
  });

  it('clampTriggerY stays sane on tiny viewports', () => {
    const span = clampTriggerY(50, { height: 60 }, { topClearance: 56, controlHalfHeight: 18 });
    expect(span).toBeGreaterThanOrEqual(56);
    expect(span).toBeLessThanOrEqual(60);
  });

  it('defaultTriggerY lands in the middle of the reader', () => {
    expect(defaultTriggerY({ height: 800 })).toBe(360);
    expect(defaultTriggerY({ height: 200 })).toBe(90);
  });

  it('isWithinVerticalBounds allows a small margin outside the reader', () => {
    const rect = { top: 100, bottom: 700 };
    expect(isWithinVerticalBounds(101, rect)).toBe(true);
    expect(isWithinVerticalBounds(710, rect)).toBe(true);
    expect(isWithinVerticalBounds(70, rect)).toBe(false);
  });
});

describe('resolveCheckpointTop', () => {
  it('resolves block anchor by blockId with yRatio', () => {
    const scroller = {
      scrollTop: 100,
      getBoundingClientRect: () => ({ top: 50 })
    } as unknown as HTMLElement;
    const block = {
      dataset: { anchorId: 'a-123' },
      getBoundingClientRect: () => ({ top: 350, height: 60 })
    };
    const root = {
      querySelectorAll: () => [block]
    } as unknown as HTMLElement;

    const cp: any = {
      id: 'note-1',
      type: 'note',
      verticalPosition: 200,
      anchor: { blockId: 'a-123', yRatio: 0.5 }
    };
    // Expected top: rect.top (350) - scroller.top (50) + scroller.scrollTop (100) + height (60) * 0.5 = 430
    const top = resolveCheckpointTop(cp, root, scroller);
    expect(top).toBe(430);
  });

  it('falls back to verticalPosition when blockId is not found in root', () => {
    const scroller = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0 })
    } as unknown as HTMLElement;
    const root = {
      querySelectorAll: () => []
    } as unknown as HTMLElement;

    const cp: any = {
      id: 'note-2',
      type: 'note',
      verticalPosition: 539,
      anchor: { blockId: 'a-nonexistent' }
    };
    const top = resolveCheckpointTop(cp, root, scroller);
    expect(top).toBe(539);
  });

  it('falls back to blockId when selection text resolution is missing or invalid', () => {
    const scroller = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0 })
    } as unknown as HTMLElement;
    const block = {
      dataset: { anchorId: 'a-block-fallback' },
      getBoundingClientRect: () => ({ top: 800, height: 40 })
    };
    const root = {
      querySelectorAll: () => [block],
      textContent: 'Completely different text'
    } as unknown as HTMLElement;

    const cp: any = {
      id: 'ai-1',
      type: 'ai',
      verticalPosition: 539,
      selection: { text: 'Some deleted passage' },
      anchor: { blockId: 'a-block-fallback', yRatio: 0 }
    };
    const top = resolveCheckpointTop(cp, root, scroller);
    expect(top).toBe(800);
  });
});
