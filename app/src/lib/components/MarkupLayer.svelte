<script lang="ts">
  import {
    addStroke,
    createStroke,
    eraseStrokesAt,
    flushNow,
    loadAnnotations,
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
  import type { MarkupStroke } from '$lib/markup/types';

  /**
   * Free-hand SVG overlay for document markup.
   *
   * Coordinates are stored in author pixels relative to the document
   * top-left. Dimensions are explicitly synced with the markdown content
   * element so the SVG canvas bounds match the full document scroll height.
   */
  let {
    courseId,
    file,
    scrollerEl,
    containerEl
  }: {
    courseId: string;
    file: string;
    scrollerEl?: HTMLElement | null;
    containerEl?: HTMLElement | null;
  } = $props();

  let overlayEl: HTMLDivElement;
  let svgEl: SVGSVGElement;
  let livePathEl: SVGPathElement;

  let svgWidth = $state(0);
  let svgHeight = $state(0);
  let ready = $state(false);
  let isDark = $state(false);

  function syncDimensions(): void {
    const target = containerEl || svgEl?.parentElement || svgEl;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const w = Math.round(rect.width);
    const targetHeight = 'offsetHeight' in target ? target.offsetHeight : 0;
    const h = Math.round(target.scrollHeight || targetHeight || rect.height);
    if (w > 0) svgWidth = w;
    if (h > 0) svgHeight = h;
    isDark = document.documentElement.classList.contains('dark');
  }

  $effect(() => {
    if (!svgEl) return;
    ready = true;
    syncDimensions();

    const target = containerEl || svgEl.parentElement || svgEl;
    const ro = new ResizeObserver(() => {
      syncDimensions();
    });
    ro.observe(target);
    if (containerEl && containerEl !== target) {
      ro.observe(containerEl);
    }
    window.addEventListener('resize', syncDimensions);

    // Watch for dark mode changes
    const mo = new MutationObserver(() => {
      isDark = document.documentElement.classList.contains('dark');
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', syncDimensions);
    };
  });

  $effect(() => {
    void loadAnnotations(courseId);
  });

  const strokes = $derived(visibleStrokes(courseId, file));
  const active = $derived(markupUi.mode && markupUi.show);

  let drawingPointerId: number | null = null;
  let erasing = false;
  let currentPoints: number[] = [];
  let authorWidth = 1;
  let strokeCancelled = false;
  let isPanning = false;
  let panLast = { x: 0, y: 0 };
  const activeTouchIds = new Set<number>();
  let penSeen = false;
  try {
    penSeen = localStorage.getItem('markup_pen_seen') === 'true';
  } catch {}

  function scaleOf(stroke: MarkupStroke): number {
    const w = svgWidth || svgEl?.getBoundingClientRect().width;
    return w && stroke.authorWidth ? w / stroke.authorWidth : 1;
  }

  function liveStroke(tool: MarkupStroke['tool'], color: MarkupStroke['color']): MarkupStroke {
    return { id: 'live', file, tool, color, points: currentPoints, authorWidth, date: '' };
  }

  function updateLivePath(): void {
    if (!livePathEl) return;
    const rect = svgEl.getBoundingClientRect();
    const scale = (rect.width || authorWidth) / authorWidth;
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
    const rect = svgEl.getBoundingClientRect();
    const scale = (rect.width || authorWidth) / authorWidth;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const p = e.pointerType === 'pen' ? Math.min(1, Math.max(0.1, e.pressure || 0.5)) : 0.5;
    currentPoints.push(x, y, p);
    updateLivePath();
  }

  function eraseAt(e: PointerEvent): void {
    const rect = svgEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hits = strokes.filter((s) => hitTestStroke(s, scaleOf(s), x, y, 12));
    if (hits.length > 0) eraseStrokesAt(courseId, file, hits);
  }

  function startPan(e: PointerEvent): void {
    cancelStroke();
    isPanning = true;
    panLast = { x: e.clientX, y: e.clientY };
  }

  function onPointerDown(e: PointerEvent): void {
    if (!active) return;
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
      // If "Pencil only" box is checked, touch only scrolls (only if not drawing):
      if (markupUi.pencilOnly) {
        if (drawingPointerId === null) {
          startPan(e);
        }
        return;
      }
      // Default: finger OR pencil draws. If 2 fingers touch down, cancel stroke and pan (double-touch scroll):
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

    const rect = svgEl.getBoundingClientRect();
    authorWidth = rect.width || svgWidth || 1;
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
        createStroke(courseId, file, markupUi.tool, markupUi.color, currentPoints, authorWidth)
      );
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
        createStroke(courseId, file, markupUi.tool, markupUi.color, currentPoints, authorWidth)
      );
    }
    clearLive();
  }
</script>

<svelte:window onbeforeunload={flushNow} onvisibilitychange={() => (document.hidden ? flushNow() : undefined)} />

<!-- Pointer handlers, pointer capture, and touch-action live on this HTML
     wrapper: WebKit's handling of all three on SVG elements is unreliable. -->
<div
  bind:this={overlayEl}
  class="markup-overlay"
  class:active
  role="presentation"
  aria-label="Markup annotations"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
>
  <svg
    bind:this={svgEl}
    width={svgWidth ? `${svgWidth}px` : '100%'}
    height={svgHeight ? `${svgHeight}px` : '100%'}
    viewBox={svgWidth && svgHeight ? `0 0 ${svgWidth} ${svgHeight}` : undefined}
    class="block h-full w-full overflow-visible"
    role="presentation"
  >
  {#if ready && markupUi.show}
    {#each strokes as stroke (stroke.id)}
      {#if stroke.tool === 'marker'}
        <path
          class="markup-marker"
          fill={MARKUP_PRESETS[stroke.color].color}
          stroke="none"
          d={strokeToMarkerPath(stroke, scaleOf(stroke))}
        />
      {:else}
        <path
          class="markup-highlighter"
          fill={MARKUP_PRESETS[stroke.color].color}
          fill-opacity={isDark ? '0.5' : '0.4'}
          stroke="none"
          d={strokeToHighlightPath(stroke, scaleOf(stroke))}
        />
      {/if}
    {/each}
  {/if}
  <path bind:this={livePathEl} class="markup-live" />
  </svg>
</div>

<style>
  div.markup-overlay {
    position: absolute;
    inset: 0;
    overflow: visible;
    z-index: 5;
    pointer-events: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  div.markup-overlay.active {
    pointer-events: auto;
    touch-action: none;
    cursor: crosshair;
  }
  div.markup-overlay svg {
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
