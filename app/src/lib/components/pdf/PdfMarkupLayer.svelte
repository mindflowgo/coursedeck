<script lang="ts">
  import { onMount } from 'svelte';
  import {
    addStroke,
    createStroke,
    eraseStrokesAt,
    markupUi,
    visibleStrokes
  } from '$lib/markup/annotationStore.svelte';
  import {
    MARKUP_PRESETS,
    hitTestStroke,
    isCommittableStroke,
    strokeToHighlightPath,
    strokeToMarkerPath
  } from '$lib/markup/render';
  import {
    computePdfRenderScale,
    normalizePdfPoint
  } from '$lib/markup/pdfMarkup';
  import type { MarkupStroke } from '$lib/markup/types';
  import { isPencilKitAvailable } from '$lib/markup/pencilKit';

  interface Props {
    courseId: string;
    file: string;
    pageWidth: number;
    pageHeight: number;
    displayWidth: number;
    displayHeight: number;
    scrollerEl?: HTMLElement | null;
    onStrokeDrawn?: (file: string) => void;
  }

  let {
    courseId,
    file,
    pageWidth,
    pageHeight,
    displayWidth,
    displayHeight,
    scrollerEl,
    onStrokeDrawn
  }: Props = $props();

  let overlayEl: HTMLDivElement | undefined;
  let svgEl: SVGSVGElement | undefined;
  let livePathEl: SVGPathElement | undefined;

  let isDark = $state(false);

  function getScroller(): HTMLElement | null {
    if (scrollerEl) return scrollerEl;
    let el: HTMLElement | null = overlayEl?.parentElement ?? null;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        return el;
      }
      el = el.parentElement;
    }
    return (document.scrollingElement as HTMLElement) || document.documentElement;
  }

  onMount(() => {
    isDark = document.documentElement.classList.contains('dark');
    const mo = new MutationObserver(() => {
      isDark = document.documentElement.classList.contains('dark');
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const handleWindowPointerUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && activeTouches.has(e.pointerId)) {
        activeTouches.delete(e.pointerId);
        if (activeTouches.size > 0) {
          panLastCentroid = computeCentroid();
        } else {
          isPanning = false;
        }
      }
    };
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    return () => {
      stopInertia();
      mo.disconnect();
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
    };
  });

  const strokes = $derived(visibleStrokes(courseId, file));
  const active = $derived(markupUi.mode && markupUi.show);
  // Scale derived strictly from actual geometry to eliminate rounding drift
  const scale = $derived(computePdfRenderScale(displayWidth, pageWidth));

  let drawingPointerId: number | null = null;
  let erasing = false;
  let currentPoints: number[] = [];

  // Multi-touch panning & palm rejection state
  let activeTouches = new Map<number, { x: number; y: number }>();
  let isPanning = false;
  let strokeCancelled = false;
  let panLastCentroid = { x: 0, y: 0 };
  let velocityX = 0;
  let velocityY = 0;
  let lastMoveTime = 0;
  let inertiaRafId: number | null = null;

  function stopInertia(): void {
    if (inertiaRafId !== null) {
      cancelAnimationFrame(inertiaRafId);
      inertiaRafId = null;
    }
    velocityX = 0;
    velocityY = 0;
  }

  function computeCentroid(): { x: number; y: number } {
    let sumX = 0;
    let sumY = 0;
    for (const pt of activeTouches.values()) {
      sumX += pt.x;
      sumY += pt.y;
    }
    const count = activeTouches.size || 1;
    return { x: sumX / count, y: sumY / count };
  }

  function cancelStroke(): void {
    strokeCancelled = true;
    drawingPointerId = null;
    erasing = false;
    clearLive();
  }

  function startPan(): void {
    stopInertia();
    cancelStroke();
    isPanning = true;
    panLastCentroid = computeCentroid();
    lastMoveTime = performance.now();
  }

  function triggerInertia(): void {
    const scroller = getScroller();
    const speed = Math.hypot(velocityX, velocityY);
    if (!scroller || speed <= 0.15 || performance.now() - lastMoveTime >= 80) return;

    let curVx = velocityX;
    let curVy = velocityY;
    let prevT = performance.now();

    const step = (t: number) => {
      const frameDt = Math.min(32, t - prevT);
      prevT = t;
      const decay = Math.pow(0.92, frameDt / 16.67);
      curVx *= decay;
      curVy *= decay;
      scroller.scrollLeft -= curVx * frameDt;
      scroller.scrollTop -= curVy * frameDt;
      if (Math.hypot(curVx, curVy) > 0.05) {
        inertiaRafId = requestAnimationFrame(step);
      } else {
        inertiaRafId = null;
      }
    };
    inertiaRafId = requestAnimationFrame(step);
  }

  function liveStroke(tool: MarkupStroke['tool'], color: MarkupStroke['color']): MarkupStroke {
    return {
      id: 'live',
      file,
      tool,
      color,
      points: currentPoints,
      authorWidth: pageWidth,
      date: ''
    };
  }

  function updateLivePath(): void {
    if (!livePathEl) return;
    const isMarker = markupUi.tool === 'marker';
    const fillColor = MARKUP_PRESETS[markupUi.color]?.color ?? markupUi.color;
    const stroke = liveStroke(markupUi.tool, markupUi.color);
    if (markupUi.width !== undefined) stroke.width = markupUi.width;
    if (markupUi.opacity !== undefined) stroke.opacity = markupUi.opacity;
    const d = isMarker
      ? strokeToMarkerPath(stroke, scale, { live: true })
      : strokeToHighlightPath(stroke, scale, { live: true });
    livePathEl.setAttribute('d', d);
    livePathEl.setAttribute('fill', fillColor);
    livePathEl.setAttribute('stroke', 'none');
    livePathEl.removeAttribute('stroke-width');
    livePathEl.removeAttribute('stroke-opacity');

    if (isMarker) {
      if (markupUi.opacity !== undefined && markupUi.opacity < 1) {
        livePathEl.setAttribute('fill-opacity', String(markupUi.opacity));
      } else {
        livePathEl.removeAttribute('fill-opacity');
      }
      livePathEl.style.mixBlendMode = 'normal';
    } else {
      const baseOpacity = markupUi.opacity !== undefined ? markupUi.opacity : 1.0;
      // Highlighters simulate Apple Pencil / physical ink translucency (~0.42) with multiply blend
      const opacity = String(baseOpacity <= 0.5 ? baseOpacity : baseOpacity * 0.42);
      livePathEl.setAttribute('fill-opacity', opacity);
      livePathEl.style.mixBlendMode = 'multiply';
    }
  }

  function clearLive(): void {
    currentPoints = [];
    livePathEl?.setAttribute('d', '');
    livePathEl?.style.removeProperty('mix-blend-mode');
  }

  function appendPoint(e: PointerEvent): void {
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const pt = normalizePdfPoint(e.clientX, e.clientY, rect, pageWidth, pageHeight);
    const p = e.pointerType === 'pen' ? Math.min(1, Math.max(0.1, e.pressure || 0.5)) : 0.5;
    currentPoints.push(pt.x, pt.y, p);
    updateLivePath();
  }

  function eraseAt(e: PointerEvent): void {
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hits = strokes.filter((s) => hitTestStroke(s, scale, x, y, 12));
    if (hits.length > 0) eraseStrokesAt(courseId, file, hits);
  }

  // Clean W3C standard pointer handling with multi-touch panning
  function onPointerDown(e: PointerEvent): void {
    if (!active || !overlayEl) return;

    stopInertia();

    // Prevent default browser touch gestures (pinch-zoom, swipe gestures)
    // so multi-touch panning and drawing are completely responsive
    e.preventDefault();

    // Track active touches
    if (e.pointerType === 'touch') {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // In Pencil Mode, any finger touch initiates panning/scrolling
      if (markupUi.pencilOnly) {
        startPan();
        return;
      }

      // In normal mode, two or more fingers initiate panning/scrolling
      if (activeTouches.size >= 2) {
        startPan();
        return;
      }
    }

    if (isPanning) return;

    // When Apple Pencil is drawing on iPad, it is handled natively by PKCanvasView if Pencil Mode is enabled.
    // When erasing, pencil touches pass through to erase vector strokes directly.
    if (isPencilKitAvailable() && markupUi.pencilOnly && e.pointerType === 'pen' && !markupUi.eraser) return;

    // Palm rejection: if already drawing with one pointer, ignore secondary inputs
    if (drawingPointerId !== null && drawingPointerId !== e.pointerId) {
      return;
    }

    if (e.pointerType === 'mouse') {
      try {
        overlayEl.setPointerCapture(e.pointerId);
      } catch {}
    }

    drawingPointerId = e.pointerId;
    strokeCancelled = false;

    if (markupUi.eraser) {
      erasing = true;
      eraseAt(e);
      return;
    }

    currentPoints = [];
    appendPoint(e);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!active) return;

    if (e.pointerType === 'touch') {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!isPanning && (markupUi.pencilOnly || activeTouches.size >= 2)) {
        startPan();
        return;
      }
    }

    if (isPanning) {
      e.preventDefault();
      const now = performance.now();
      const dt = now - lastMoveTime;
      const scroller = getScroller();
      const centroid = computeCentroid();
      if (scroller) {
        const dx = centroid.x - panLastCentroid.x;
        const dy = centroid.y - panLastCentroid.y;
        scroller.scrollTop -= dy;
        scroller.scrollLeft -= dx;
        if (dt > 0 && dt < 100) {
          const instantVx = dx / dt;
          const instantVy = dy / dt;
          velocityX = velocityX * 0.4 + instantVx * 0.6;
          velocityY = velocityY * 0.4 + instantVy * 0.6;
        }
      }
      lastMoveTime = now;
      panLastCentroid = centroid;
      return;
    }

    if (drawingPointerId !== e.pointerId) return;
    e.preventDefault();

    if (erasing) {
      eraseAt(e);
      return;
    }

    const coalesced = e.getCoalescedEvents?.() ?? [];
    if (coalesced.length > 0) {
      for (const ce of coalesced) appendPoint(ce);
    } else {
      appendPoint(e);
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const wasPanning = isPanning;
    if (e.pointerType === 'touch') {
      activeTouches.delete(e.pointerId);
      if (activeTouches.size > 0) {
        panLastCentroid = computeCentroid();
      } else {
        isPanning = false;
      }
    }

    if (e.pointerType === 'mouse') {
      try {
        overlayEl?.releasePointerCapture(e.pointerId);
      } catch {}
    }

    if (wasPanning) {
      if (activeTouches.size === 0) {
        triggerInertia();
      }
      return;
    }

    if (drawingPointerId !== e.pointerId) return;
    drawingPointerId = null;

    if (erasing) {
      erasing = false;
      return;
    }

    if (!strokeCancelled && isCommittableStroke(currentPoints)) {
      addStroke(
        courseId,
        createStroke(courseId, file, markupUi.tool, markupUi.color, currentPoints, pageWidth, markupUi.width, markupUi.opacity)
      );
      onStrokeDrawn?.(file);
    }
    clearLive();
  }

  function onPointerCancel(e: PointerEvent): void {
    const wasPanning = isPanning;
    if (e.pointerType === 'touch') {
      activeTouches.delete(e.pointerId);
      if (activeTouches.size > 0) {
        panLastCentroid = computeCentroid();
      } else {
        isPanning = false;
      }
    }

    if (e.pointerType === 'mouse') {
      try {
        overlayEl?.releasePointerCapture(e.pointerId);
      } catch {}
    }

    if (wasPanning) return;

    if (drawingPointerId !== e.pointerId) return;
    drawingPointerId = null;
    erasing = false;

    if (!strokeCancelled && isCommittableStroke(currentPoints)) {
      addStroke(
        courseId,
        createStroke(courseId, file, markupUi.tool, markupUi.color, currentPoints, pageWidth, markupUi.width, markupUi.opacity)
      );
      onStrokeDrawn?.(file);
    }
    clearLive();
  }
</script>

<div
  bind:this={overlayEl}
  class="pdf-markup-overlay absolute inset-0"
  class:active
  role="presentation"
  aria-label="PDF page markup annotations"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
>
  <svg
    bind:this={svgEl}
    width="{displayWidth}px"
    height="{displayHeight}px"
    viewBox="0 0 {displayWidth} {displayHeight}"
    class="block h-full w-full overflow-visible"
    role="presentation"
  >
    {#if markupUi.show}
      {#each strokes as stroke (stroke.id)}
        {#if stroke.tool === 'marker'}
          <path
            class="markup-marker"
            fill={MARKUP_PRESETS[stroke.color]?.color || stroke.color}
            fill-opacity={stroke.opacity !== undefined && stroke.opacity < 1 ? stroke.opacity : undefined}
            stroke="none"
            d={strokeToMarkerPath(stroke, scale)}
          />
        {:else}
          <path
            class="markup-highlighter"
            fill={MARKUP_PRESETS[stroke.color]?.color || stroke.color}
            fill-opacity={stroke.opacity !== undefined && stroke.opacity <= 0.5 ? stroke.opacity : (stroke.opacity ? stroke.opacity * 0.42 : 0.42)}
            stroke="none"
            d={strokeToHighlightPath(stroke, scale)}
          />
        {/if}
      {/each}
    {/if}
    <path bind:this={livePathEl} class="markup-live" />
  </svg>
</div>

<style>
  div.pdf-markup-overlay {
    z-index: 10;
    pointer-events: none;
    -webkit-user-select: none;
    user-select: none;
  }
  div.pdf-markup-overlay.active {
    pointer-events: auto;
    touch-action: none;
    cursor: crosshair;
  }
  div.pdf-markup-overlay svg {
    pointer-events: none;
  }
  .markup-marker {
    pointer-events: none;
  }
  .markup-highlighter {
    mix-blend-mode: multiply;
    pointer-events: none;
  }
  .markup-live {
    pointer-events: none;
  }
</style>
