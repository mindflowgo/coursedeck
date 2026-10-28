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
    scrollerEl = null,
    onStrokeDrawn
  }: Props = $props();

  let overlayEl: HTMLDivElement | undefined;
  let svgEl: SVGSVGElement | undefined;
  let livePathEl: SVGPathElement | undefined;

  let isDark = $state(false);

  onMount(() => {
    isDark = document.documentElement.classList.contains('dark');
    const mo = new MutationObserver(() => {
      isDark = document.documentElement.classList.contains('dark');
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  });

  const strokes = $derived(visibleStrokes(courseId, file));
  const active = $derived(markupUi.mode && markupUi.show);
  // Scale derived strictly from actual geometry to eliminate rounding drift
  const scale = $derived(computePdfRenderScale(displayWidth, pageWidth));

  let drawingPointerId: number | null = null;
  let erasing = false;
  let currentPoints: number[] = [];
  let strokeCancelled = false;
  let isPanning = false;
  let panLast = { x: 0, y: 0 };
  const activeTouchIds = new Set<number>();

  let penSeen = false;
  try {
    penSeen = localStorage.getItem('markup_pen_seen') === 'true';
  } catch {}

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
    const preset = MARKUP_PRESETS[markupUi.color];
    const stroke = liveStroke(markupUi.tool, markupUi.color);
    const d = isMarker
      ? strokeToMarkerPath(stroke, scale, { live: true })
      : strokeToHighlightPath(stroke, scale, { live: true });
    livePathEl.setAttribute('d', d);

    livePathEl.setAttribute('fill', preset.color);
    livePathEl.setAttribute('stroke', 'none');
    livePathEl.removeAttribute('stroke-width');
    livePathEl.removeAttribute('stroke-opacity');

    if (isMarker) {
      livePathEl.removeAttribute('fill-opacity');
      livePathEl.style.mixBlendMode = 'normal';
    } else {
      livePathEl.setAttribute('fill-opacity', isDark ? '0.5' : '0.4');
      livePathEl.style.mixBlendMode = isDark ? 'screen' : 'multiply';
    }
  }

  function clearLive(): void {
    currentPoints = [];
    livePathEl?.setAttribute('d', '');
    livePathEl?.style.removeProperty('mix-blend-mode');
  }

  function cancelStroke(): void {
    strokeCancelled = true;
    clearLive();
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

  function startPan(e: PointerEvent): void {
    cancelStroke();
    isPanning = true;
    panLast = { x: e.clientX, y: e.clientY };
  }

  function onPointerDown(e: PointerEvent): void {
    if (!active || !overlayEl) return;
    e.preventDefault();

    // Palm rejection: if already drawing with a pointer (e.g. Apple Pencil),
    // ignore secondary touches (palm/fingers hitting the screen).
    if (drawingPointerId !== null && drawingPointerId !== e.pointerId) {
      return;
    }

    // Only set pointer capture for mouse; touch/pen are implicitly captured
    // and calling setPointerCapture on pen causes gesture conflicts on iOS WebKit.
    if (e.pointerType === 'mouse') {
      try {
        overlayEl.setPointerCapture(e.pointerId);
      } catch {}
    }

    if (e.pointerType === 'pen' && !penSeen) {
      penSeen = true;
      try {
        localStorage.setItem('markup_pen_seen', 'true');
      } catch {}
    }

    if (e.pointerType === 'touch') {
      activeTouchIds.add(e.pointerId);
      // If "Pencil only" mode is active, touch pan-scrolls (only if not drawing):
      if (markupUi.pencilOnly) {
        if (drawingPointerId === null) {
          startPan(e);
        }
        return;
      }
      // If 2 fingers touch down, cancel stroke and pan (two-finger scroll):
      if (activeTouchIds.size >= 2) {
        drawingPointerId = null;
        erasing = false;
        startPan(e);
        return;
      }
    }

    if (isPanning) return;

    if (markupUi.eraser) {
      erasing = true;
      drawingPointerId = e.pointerId;
      strokeCancelled = false;
      eraseAt(e);
      return;
    }

    drawingPointerId = e.pointerId;
    strokeCancelled = false;
    currentPoints = [];
    appendPoint(e);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!active) return;
    e.preventDefault();

    if (isPanning) {
      if (scrollerEl) {
        scrollerEl.scrollTop -= e.clientY - panLast.y;
        scrollerEl.scrollLeft -= e.clientX - panLast.x;
      }
      panLast = { x: e.clientX, y: e.clientY };
      return;
    }
    if (drawingPointerId !== e.pointerId) return;

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
    if (e.pointerType === 'touch') {
      activeTouchIds.delete(e.pointerId);
      if (activeTouchIds.size === 0) {
        isPanning = false;
      }
    }
    if (isPanning) return;
    if (drawingPointerId !== e.pointerId) return;
    drawingPointerId = null;

    if (erasing) {
      erasing = false;
      return;
    }

    if (!strokeCancelled && isCommittableStroke(currentPoints)) {
      addStroke(
        courseId,
        createStroke(courseId, file, markupUi.tool, markupUi.color, currentPoints, pageWidth)
      );
      onStrokeDrawn?.(file);
    }
    clearLive();
  }

  function onPointerCancel(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      activeTouchIds.delete(e.pointerId);
      if (activeTouchIds.size === 0) {
        isPanning = false;
      }
    }
    if (drawingPointerId !== e.pointerId) return;
    drawingPointerId = null;
    erasing = false;
    // Commit any valid committable stroke so an OS interrupt doesn't discard user drawing
    if (!strokeCancelled && isCommittableStroke(currentPoints)) {
      addStroke(
        courseId,
        createStroke(courseId, file, markupUi.tool, markupUi.color, currentPoints, pageWidth)
      );
      onStrokeDrawn?.(file);
    }
    clearLive();
  }
</script>

<!-- Pointer handlers, pointer capture, and touch-action live on this HTML
     wrapper: WebKit's handling of all three on SVG elements is unreliable,
     which let the iPad's scroll recognizer steal pen gestures mid-stroke. -->
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
            fill={MARKUP_PRESETS[stroke.color].color}
            stroke="none"
            d={strokeToMarkerPath(stroke, scale)}
          />
        {:else}
          <path
            class="markup-highlighter"
            fill={MARKUP_PRESETS[stroke.color].color}
            fill-opacity={isDark ? '0.5' : '0.4'}
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
    -webkit-touch-callout: none;
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
  :global(.dark) .markup-highlighter {
    mix-blend-mode: screen;
  }
  .markup-live {
    pointer-events: none;
  }
</style>
