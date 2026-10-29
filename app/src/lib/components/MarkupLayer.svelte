<script lang="ts">
  import { onMount } from 'svelte';
  import {
    addStroke,
    canRedo,
    canUndo,
    createStroke,
    eraseStrokesAt,
    flushNow,
    loadAnnotations,
    markupUi,
    redo,
    undo,
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
  import {
    isPencilKitAvailable,
    onPencilKitRedo,
    onPencilKitStroke,
    onPencilKitUndo,
    setPencilKitActive,
    setPencilKitTool,
    syncPencilKitUndoRedo
  } from '$lib/markup/pencilKit';

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
    containerEl,
    scrollerEl
  }: {
    courseId: string;
    file: string;
    containerEl?: HTMLElement | null;
    scrollerEl?: HTMLElement | null;
  } = $props();

  let overlayEl: HTMLDivElement | undefined;
  let svgEl = $state<SVGSVGElement>();
  let livePathEl = $state<SVGPathElement>();

  let svgWidth = $state(0);
  let svgHeight = $state(0);
  let ready = $state(false);
  let isDark = $state(false);

  function getScroller(): HTMLElement | null {
    if (scrollerEl) return scrollerEl;
    let el: HTMLElement | null = overlayEl?.parentElement ?? containerEl ?? null;
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
    if (file && containerEl) {
      ready = false;
      requestAnimationFrame(() => {
        syncDimensions();
        ready = true;
      });
    }
  });

  onMount(() => {
    syncDimensions();
    ready = true;

    const ro = new ResizeObserver(() => syncDimensions());
    if (containerEl) ro.observe(containerEl);

    const mo = new MutationObserver(() => syncDimensions());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', syncDimensions);

    // Listen for strokes drawn via native Apple PencilKit on iPad
    const unsubPencil = onPencilKitStroke((stroke) => {
      if (!active || !overlayEl) return;
      const pts = stroke.viewportPoints;
      if (!pts || pts.length < 2) return;

      const rect = overlayEl.getBoundingClientRect();
      const authorW = rect.width || svgWidth || 800;
      const scale = (rect.width || authorW) / authorW;

      const authorPoints: number[] = [];
      for (let i = 0; i < pts.length; i += 3) {
        authorPoints.push(
          (pts[i] - rect.left) / scale,
          (pts[i + 1] - rect.top) / scale,
          pts[i + 2] ?? 0.5
        );
      }

      addStroke(courseId, {
        id: stroke.id || crypto.randomUUID(),
        file,
        tool: stroke.tool,
        color: stroke.color,
        points: authorPoints,
        authorWidth: authorW,
        date: stroke.date || new Date().toISOString(),
        width: stroke.width,
        opacity: stroke.opacity
      });
    });

    // Wire Apple Pencil toolbar reverse/forward buttons into web undo/redo
    const unsubUndo = onPencilKitUndo(() => {
      if (active && markupUi.pencilOnly) {
        undo(courseId, file);
      }
    });

    const unsubRedo = onPencilKitRedo(() => {
      if (active && markupUi.pencilOnly) {
        redo(courseId, file);
      }
    });

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
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', syncDimensions);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
      unsubPencil();
      unsubUndo();
      unsubRedo();
      if (isPencilKitAvailable()) {
        setPencilKitActive({ active: false });
      }
    };
  });

  $effect(() => {
    void loadAnnotations(courseId);
  });

  const strokes = $derived(visibleStrokes(courseId, file));
  const active = $derived(markupUi.mode && markupUi.show);

  function computeTopCutoff(): number {
    const bar = typeof document !== 'undefined' ? document.querySelector('[data-markdown-floating-bar]') : null;
    if (bar) {
      const bottom = bar.getBoundingClientRect().bottom;
      if (bottom > 0) return Math.ceil(bottom + 6);
    }
    const subHeader = typeof document !== 'undefined' ? document.querySelector('[data-sub-header]') : null;
    if (subHeader) {
      const bottom = subHeader.getBoundingClientRect().bottom;
      if (bottom > 0) return Math.ceil(bottom + 48);
    }
    return 140;
  }

  // Sync native PencilKit active state and tool selection (only when Pencil Mode is enabled)
  $effect(() => {
    if (isPencilKitAvailable()) {
      const shouldActivate = active && markupUi.pencilOnly;
      if (shouldActivate) {
        const topHeight = computeTopCutoff();
        setPencilKitActive({
          active: true,
          topHeight,
          canUndo: canUndo(courseId, file),
          canRedo: canRedo(courseId, file)
        });
        setPencilKitTool(markupUi.eraser ? 'eraser' : markupUi.tool, markupUi.color);
      } else {
        setPencilKitActive({ active: false });
      }
    }
  });

  // Keep native Apple Pencil toolbar undo/redo button enabled states synced with web stroke stack
  $effect(() => {
    if (isPencilKitAvailable() && active && markupUi.pencilOnly) {
      const u = canUndo(courseId, file);
      const r = canRedo(courseId, file);
      void syncPencilKitUndoRedo(u, r);
    }
  });

  let drawingPointerId: number | null = null;
  let erasing = false;
  let currentPoints: number[] = [];
  let authorWidth = $state(1);

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
    return { id: 'live', file, tool, color, points: currentPoints, authorWidth, date: '' };
  }

  function updateLivePath(): void {
    if (!livePathEl || !svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const scale = (rect.width || authorWidth) / authorWidth;
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
      const opacity = markupUi.opacity !== undefined ? String(markupUi.opacity) : (isDark ? '0.5' : '0.4');
      livePathEl.setAttribute('fill-opacity', opacity);
      livePathEl.style.mixBlendMode = isDark ? 'screen' : 'multiply';
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
    const scale = (rect.width || authorWidth) / authorWidth;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const p = e.pointerType === 'pen' ? Math.min(1, Math.max(0.1, e.pressure || 0.5)) : 0.5;
    currentPoints.push(x, y, p);
    updateLivePath();
  }

  function eraseAt(e: PointerEvent): void {
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const scale = (rect.width || authorWidth) / authorWidth;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const hits = strokes.filter((s) => hitTestStroke(s, scale, x * scale, y * scale, 12));
    if (hits.length > 0) eraseStrokesAt(courseId, file, hits);
  }

  // Clean W3C standard pointer handling with multi-touch panning
  function onPointerDown(e: PointerEvent): void {
    if (!active || !overlayEl || !svgEl) return;

    // Disallow drawing above the cut-off point (into header/tabs)
    const cutoff = computeTopCutoff();
    if (e.clientY <= cutoff) return;

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

    // If currently panning with multiple fingers, ignore secondary taps
    if (isPanning) return;

    // When Apple Pencil is drawing natively on iPad in Pencil Mode, ignore pen drawing in webview
    if (isPencilKitAvailable() && markupUi.pencilOnly && e.pointerType === 'pen' && !markupUi.eraser) {
      return;
    }

    // Palm rejection: if already drawing with one pointer, ignore secondary touches
    if (drawingPointerId !== null && drawingPointerId !== e.pointerId) {
      return;
    }

    // Only set pointer capture for mouse; touch/pen are routed natively on WebKit
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

    const rect = svgEl.getBoundingClientRect();
    authorWidth = rect.width || svgWidth || 1;
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
        createStroke(courseId, file, markupUi.tool, markupUi.color, currentPoints, authorWidth, markupUi.width, markupUi.opacity)
      );
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
        createStroke(courseId, file, markupUi.tool, markupUi.color, currentPoints, authorWidth, markupUi.width, markupUi.opacity)
      );
    }
    clearLive();
  }
</script>

<svelte:window onbeforeunload={flushNow} onvisibilitychange={() => (document.hidden ? flushNow() : undefined)} />

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
  {#if ready && markupUi.show}
    <svg
      bind:this={svgEl}
      width="{svgWidth}px"
      height="{svgHeight}px"
      viewBox="0 0 {svgWidth} {svgHeight}"
      class="markup-svg"
      role="presentation"
    >
      {#each strokes as stroke (stroke.id)}
        {@const s = (svgWidth || authorWidth) / (stroke.authorWidth || authorWidth || 1)}
        {#if stroke.tool === 'marker'}
          <path
            class="markup-marker"
            fill={MARKUP_PRESETS[stroke.color]?.color || stroke.color}
            fill-opacity={stroke.opacity !== undefined && stroke.opacity < 1 ? stroke.opacity : undefined}
            stroke="none"
            d={strokeToMarkerPath(stroke, s)}
          />
        {:else}
          <path
            class="markup-highlighter"
            fill={MARKUP_PRESETS[stroke.color]?.color || stroke.color}
            fill-opacity={stroke.opacity !== undefined ? stroke.opacity : (isDark ? '0.5' : '0.4')}
            stroke="none"
            d={strokeToHighlightPath(stroke, s)}
          />
        {/if}
      {/each}
      <path bind:this={livePathEl} class="markup-live" />
    </svg>
  {/if}
</div>

<style>
  .markup-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .markup-overlay.active {
    pointer-events: auto;
    touch-action: none;
    cursor: crosshair;
  }
  .markup-svg {
    display: block;
    pointer-events: none;
    overflow: visible;
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
