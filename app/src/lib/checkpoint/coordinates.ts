/**
 * Shared coordinate-space conversions for reader surfaces.
 *
 * Two spaces matter for checkpoints:
 *  - viewport space: 0..visibleHeight, what the user's pointer lives in
 *  - content space:  0..scrollHeight, where markers and anchors are stored
 *
 * All helpers are document-safe (no module-scope DOM access) so both the
 * browser components and the SSR-adjacent modules can import this file.
 */

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Clamps a candidate trigger Y (viewport space, center of the control) so the
 * control stays inside the visible reader, below the tab/toolbar clearance
 * and above the bottom edge.
 */
export function clampTriggerY(
  candidateY: number,
  viewport: { height: number },
  opts: { topClearance: number; controlHalfHeight: number }
): number {
  const top = Math.max(opts.topClearance, opts.controlHalfHeight);
  const bottom = Math.max(top + 1, viewport.height - opts.controlHalfHeight);
  return clamp(candidateY, top, bottom);
}

/** True when the pointer Y is inside the reader's visible band (with margin). */
export function isWithinVerticalBounds(
  clientY: number,
  scrollerRect: { top: number; bottom: number },
  margin = 24
): boolean {
  return clientY >= scrollerRect.top - margin && clientY <= scrollerRect.bottom + margin;
}

/**
 * Document-absolute top of an element relative to a scroller's content
 * (stable under scrolling, unlike offsetTop which depends on offset parents).
 */
export function elementTopInScroller(el: Element, scroller: HTMLElement): number {
  const elRect = el.getBoundingClientRect();
  const scRect = scroller.getBoundingClientRect();
  return elRect.top - scRect.top + scroller.scrollTop;
}

/** Viewport Y → scroller content Y for pointer-following controls. */
export function clientYToScrollerContent(clientY: number, scroller: HTMLElement): number {
  const scRect = scroller.getBoundingClientRect();
  return clientY - scRect.top + scroller.scrollTop;
}

/** Viewport Y → reader-viewport Y (0..height), the space the trigger floats in. */
export function clientYToViewportSpace(clientY: number, scroller: HTMLElement): number {
  const scRect = scroller.getBoundingClientRect();
  return clientY - scRect.top;
}

/** Reader-relative control center → stationary overlay-relative CSS top. */
export function readerYToOverlayY(
  readerY: number,
  readerRect: { top: number },
  overlayRect: { top: number }
): number {
  return readerRect.top + readerY - overlayRect.top;
}

/**
 * Y inside an iframe's own viewport → reader-viewport space of the parent
 * scroller that hosts the iframe.
 */
export function iframeClientYToViewportSpace(
  iframeClientY: number,
  iframeEl: HTMLElement,
  scroller: HTMLElement
): number {
  const iframeRect = iframeEl.getBoundingClientRect();
  const scRect = scroller.getBoundingClientRect();
  return iframeRect.top + iframeClientY - scRect.top;
}

/** Y inside an iframe's own document → parent scroller content space. */
export function iframePageYToScrollerContent(
  iframePageY: number,
  iframeEl: HTMLElement,
  scroller: HTMLElement
): number {
  return elementTopInScroller(iframeEl, scroller) + iframePageY;
}

/** Default resting position for the trigger before any pointer interaction. */
export function defaultTriggerY(viewport: { height: number }): number {
  return clamp(viewport.height * 0.45, 80, Math.max(120, viewport.height - 80));
}
