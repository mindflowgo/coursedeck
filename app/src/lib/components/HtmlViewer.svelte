<script lang="ts">
  import { tick } from 'svelte';
  import { getApiBaseUrl } from '$lib/api';
  import { getCheckpointColor } from '$lib/checkpoint';
  import {
    iframeClientYToViewportSpace,
    iframePageYToScrollerContent
  } from '$lib/checkpoint/coordinates';
  import MarkupLayer from './MarkupLayer.svelte';

  interface Props {
    courseId: string;
    lessonId: string;
    markupFile?: string;
    title?: string;
    /** Scroll container the iframe lives in (document-absolute anchors resolve against it). */
    scrollerEl?: HTMLElement | null;
    checkpoints?: import('$lib/checkpoint').Checkpoint[];
    onOpenDocument?: (url: string, title?: string) => void;
    onNavigateLesson?: (rawTarget: string, isAssignment?: boolean) => void;
    /** Live pointer position (mousemove or touch release) inside the iframe. */
    onMouseMove?: (coords: { cursorY: number; scrollTop: number; anchor?: import('$lib/checkpoint').Anchor }) => void;
    onMouseLeave?: () => void;
    onTextSelected?: (params: {
      text: string;
      anchor: import('$lib/checkpoint').Anchor;
      selection: import('$lib/checkpoint').SelectionRange;
      verticalPosition: number;
    }) => void;
    onSelectionCleared?: () => void;
    onResolveAnchors?: (positions: Record<string, number>) => void;
  }
  let {
    courseId,
    lessonId,
    markupFile,
    title = 'Lesson',
    scrollerEl = null,
    checkpoints = [],
    onOpenDocument,
    onNavigateLesson,
    onMouseMove,
    onMouseLeave,
    onTextSelected,
    onSelectionCleared,
    onResolveAnchors
  }: Props = $props();

  let iframeEl: HTMLIFrameElement | null = $state(null);
  let surfaceEl: HTMLDivElement | null = $state(null);
  let iframeHeight = $state(800);
  let isLoading = $state(true);
  let geometryReady = $state(false);
  let bridgeFailed = $state(false);

  // Sketch blocks extension for HTML lessons
  function getSketchStorageKey(cid: string, lid: string) {
    return `coursedeck_html_sketch_count_${cid.toLowerCase()}_${lid.toLowerCase()}`;
  }

  let extraSketchBlocks = $state(0);

  $effect(() => {
    if (courseId && lessonId && typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(getSketchStorageKey(courseId, lessonId));
      extraSketchBlocks = raw ? Math.max(0, parseInt(raw, 10) || 0) : 0;
    }
  });

  export function addSketchBlock() {
    extraSketchBlocks += 1;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(getSketchStorageKey(courseId, lessonId), String(extraSketchBlocks));
    }
  }

  /**
   * Session token bound to the currently loaded document. The bridge stamps
   * every message with its own token; the first message after each iframe
   * load adopts it, later mismatches are stale/foreign and dropped.
   */
  let bridgeSession: string | null = null;

  const contentUrl = $derived(
    `${getApiBaseUrl()}/api/courses/${encodeURIComponent(courseId)}/${encodeURIComponent(lessonId)}/content`
  );

  const surfaceIdentity = $derived(
    `${courseId}:${markupFile || lessonId}:${contentUrl}`
  );

  $effect(() => {
    // Re-trigger loading state when navigating between lessons or files
    if (surfaceIdentity) {
      bridgeSession = null;
      isLoading = true;
      geometryReady = false;
      bridgeFailed = false;
      iframeHeight = 800;
    }
  });

  function activeScroller(): HTMLElement | null {
    if (scrollerEl) return scrollerEl;
    return (iframeEl?.closest('.overflow-y-auto') as HTMLElement | null) ?? null;
  }

  function getIframeOffsetInScroller() {
    if (!iframeEl) return { offsetTop: 0, scrollerTop: 0, scrollerRect: null, iframeRect: null };
    const scroller = activeScroller();
    const scrollerRect = scroller ? scroller.getBoundingClientRect() : null;
    const iframeRect = iframeEl.getBoundingClientRect();
    const scrollerTop = scroller ? scroller.scrollTop : 0;
    const offsetTop = (iframeRect.top - (scrollerRect ? scrollerRect.top : 0)) + scrollerTop;
    return { offsetTop, scrollerTop, scrollerRect, iframeRect };
  }

  function sendToBridge(message: Record<string, unknown>) {
    if (!iframeEl?.contentWindow) return;
    iframeEl.contentWindow.postMessage(JSON.parse(JSON.stringify({ ...message, session: bridgeSession })), '*');
  }

  function queryAnchors() {
    if (!iframeEl || !checkpoints.length) return;
    sendToBridge({ type: 'courseDeck:queryAnchorPositions', checkpoints: checkpoints.map(cp => ({ id: cp.id, anchor: cp.anchor, selection: cp.selection })) });
  }

  /** Syncs saved highlights into the iframe (the bridge paints/removes them). */
  function syncHighlights() {
    if (!iframeEl || isLoading) return;
    const highlights = checkpoints
      .filter((cp) => cp.type === 'highlight' && !cp.deleted && cp.selection?.text)
      .map((cp) => ({
        id: cp.id,
        color: getCheckpointColor(cp.color).dot,
        selection: {
          text: cp.selection!.text,
          prefix: cp.selection!.prefix,
          suffix: cp.selection!.suffix,
          start: cp.selection!.start,
          end: cp.selection!.end
        }
      }));
    sendToBridge({ type: 'courseDeck:applyHighlights', highlights });
  }

  $effect(() => {
    if (checkpoints && !isLoading) {
      queryAnchors();
      syncHighlights();
    }
  });

  function handleMessage(event: MessageEvent) {
    if (event.source !== iframeEl?.contentWindow) return;
    if (!event.data || typeof event.data !== 'object') return;

    // Adopt the session on the first message after a document load; drop
    // everything that arrives under a different (stale) token afterwards.
    const msgSession = (event.data as Record<string, unknown>).session;
    if (typeof msgSession !== 'string' || !msgSession) return;
    if (bridgeSession === null) bridgeSession = msgSession;
    else if (msgSession !== bridgeSession) return;

    const data = event.data as Record<string, any>;

    if (data.type === 'courseDeck:lessonHeight' && typeof data.height === 'number') {
      if (Number.isFinite(data.height) && data.height > 100) {
        iframeHeight = Math.max(Math.round(data.height), 600);
        isLoading = false;
        bridgeFailed = false;

        // Verify geometry readiness after layout has been updated
        void tick().then(() => {
          if (!surfaceEl || !iframeEl) return;
          const rect = surfaceEl.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            geometryReady = true;
          }
        });
      }
      queryAnchors();
      syncHighlights();
    } else if (data.type === 'courseDeck:openDocument' && typeof data.url === 'string') {
      let finalUrl = data.url;
      if (finalUrl.startsWith('/')) {
        finalUrl = `${getApiBaseUrl()}${finalUrl}`;
      }
      onOpenDocument?.(finalUrl, data.title);
    } else if (data.type === 'courseDeck:navigateLesson' && typeof data.rawTarget === 'string') {
      onNavigateLesson?.(data.rawTarget, data.isAssignment);
    } else if (
      (data.type === 'courseDeck:iframeMouseMove' || data.type === 'courseDeck:iframePointerUp') &&
      typeof data.clientY === 'number'
    ) {
      const { scrollerTop } = getIframeOffsetInScroller();
      const cursorY = iframeClientYToViewportSpace(data.clientY, iframeEl, activeScroller() ?? iframeEl.parentElement!);
      onMouseMove?.({
        cursorY: Math.round(cursorY),
        scrollTop: scrollerTop,
        anchor: data.anchor?.blockId ? { ...data.anchor, verticalPosition: Math.round(cursorY + scrollerTop) } : undefined
      });
    } else if (data.type === 'courseDeck:iframeMouseLeave') {
      onMouseLeave?.();
    } else if (data.type === 'courseDeck:textSelected' && typeof data.text === 'string') {
      if (!data.start?.anchorId || !data.end?.anchorId || typeof data.iframePageY !== 'number') return;
      const iframePageY = data.iframePageY;
      const verticalPosition = Math.round(iframePageYToScrollerContent(iframePageY, iframeEl, activeScroller() ?? iframeEl.parentElement!));

      const selection: import('$lib/checkpoint').SelectionRange = {
        text: data.text,
        ...(data.prefix && typeof data.prefix === 'string' ? { prefix: data.prefix } : {}),
        ...(data.suffix && typeof data.suffix === 'string' ? { suffix: data.suffix } : {}),
        ...(data.start && typeof data.start === 'object' ? { start: data.start } : {}),
        ...(data.end && typeof data.end === 'object' ? { end: data.end } : {})
      };

      const anchor: import('$lib/checkpoint').Anchor = {
        type: 'block',
        blockId: selection.start?.anchorId,
        verticalPosition,
      };

      onTextSelected?.({
        text: data.text,
        anchor,
        selection,
        verticalPosition
      });
    } else if (data.type === 'courseDeck:selectionCleared') {
      onSelectionCleared?.();
    } else if (data.type === 'courseDeck:anchorPositions' && data.positions) {
      const { offsetTop } = getIframeOffsetInScroller();
      const rawPositions = data.positions as Record<string, number>;
      const resolved: Record<string, number> = {};
      for (const [k, v] of Object.entries(rawPositions)) {
        if (typeof v === 'number') {
          resolved[k] = Math.round(offsetTop + v);
        }
      }
      onResolveAnchors?.(resolved);
    }
  }

  $effect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });

  let resizeObserver: ResizeObserver | null = null;
  $effect(() => {
    const target = surfaceEl;
    if (!target) return;
    resizeObserver = new ResizeObserver(() => {
      if (isLoading) return;
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        geometryReady = true;
        queryAnchors();
        syncHighlights();
      }
    });
    resizeObserver.observe(target);
    return () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
    };
  });
</script>

<div class="relative w-full rounded-2xl overflow-hidden bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-xs">
  {#if isLoading}
    <div class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-white/80 dark:bg-stone-900/80 backdrop-blur-xs min-h-[400px]">
      <div class="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" aria-label="Loading lesson…"></div>
      <span class="mt-3 text-xs text-stone-500 dark:text-stone-400 font-medium">Loading original presentation…</span>
    </div>
  {:else if bridgeFailed}
    <div class="p-8 text-center text-stone-500 dark:text-stone-400 text-sm">
      <p>Original presentation loaded without interactive bridge. Freehand drawing and text annotations are unavailable.</p>
    </div>
  {/if}

  {#key surfaceIdentity}
    <div bind:this={surfaceEl} class="relative w-full max-w-full">
      <iframe
        bind:this={iframeEl}
        src={contentUrl}
        {title}
        scrolling="no"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
        style="width: 100%; border: none; display: block; height: {iframeHeight}px; min-height: 600px;"
        onload={() => {
          setTimeout(() => {
            if (!bridgeSession && isLoading) {
              isLoading = false;
              bridgeFailed = true;
              geometryReady = false;
            }
          }, 3500);
        }}
      ></iframe>

      {#if extraSketchBlocks > 0}
        <div class="px-4 pb-4">
          {#each Array(extraSketchBlocks) as _, i (i)}
            <div class="sketch-block" aria-label="Sketch Area {i + 1}">&nbsp;</div>
          {/each}
        </div>
      {/if}

      {#if markupFile && geometryReady}
        <MarkupLayer
          {courseId}
          file={markupFile}
          containerEl={surfaceEl}
          {scrollerEl}
        />
      {/if}
    </div>
  {/key}
</div>

<style>
  :global(.sketch-block) {
    min-height: 850px;
    width: 100%;
    margin-top: 1.5rem;
    margin-bottom: 0.75rem;
    border-radius: 1rem;
    border: 1.5px dashed rgba(214, 211, 209, 0.85);
    background-color: rgba(250, 250, 249, 0.45);
    position: relative;
    box-sizing: border-box;
    display: block;
    user-select: none;
    -webkit-user-select: none;
  }

  :global(.dark .sketch-block) {
    border-color: rgba(87, 83, 78, 0.65);
    background-color: rgba(28, 25, 23, 0.35);
  }

  :global(.sketch-block::before) {
    content: 'Sketch Area';
    display: block;
    padding: 0.75rem 1rem;
    font-size: 0.75rem;
    font-weight: 500;
    letter-spacing: 0.025em;
    color: rgba(168, 162, 158, 0.7);
    pointer-events: none;
    user-select: none;
  }

  :global(.dark .sketch-block::before) {
    color: rgba(120, 113, 108, 0.7);
  }
</style>
