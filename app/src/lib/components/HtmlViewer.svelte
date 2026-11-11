<script lang="ts">
  import { getApiBaseUrl } from '$lib/api';
  import { getCheckpointColor } from '$lib/checkpoint';
  import {
    iframeClientYToViewportSpace,
    iframePageYToScrollerContent
  } from '$lib/checkpoint/coordinates';

  interface Props {
    courseId: string;
    lessonId: string;
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
  let iframeHeight = $state(800);
  let isLoading = $state(true);

  /**
   * Session token bound to the currently loaded document. The bridge stamps
   * every message with its own token; the first message after each iframe
   * load adopts it, later mismatches are stale/foreign and dropped.
   */
  let bridgeSession: string | null = null;

  const contentUrl = $derived(
    `${getApiBaseUrl()}/api/courses/${encodeURIComponent(courseId)}/${encodeURIComponent(lessonId)}/content`
  );

  $effect(() => {
    // Re-trigger loading state when navigating between lessons
    if (contentUrl) {
      bridgeSession = null;
      isLoading = true;
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
      if (data.height > 100) {
        // The bridge includes the iframe viewport in its document height.
        // Adding padding here feeds that padding back into the next report
        // and grows the frame on every resize even when content is unchanged.
        iframeHeight = Math.max(data.height, 600);
      }
      isLoading = false;
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

  // Re-sync anchors and highlights when the reader scrolls the iframe into a
  // new offset (document-absolute positions are stable, but the parent-facing
  // cache is measured against the scroller).
  let resizeObserver: ResizeObserver | null = null;
  $effect(() => {
    const scroller = activeScroller();
    if (!scroller || !iframeEl) return;
    resizeObserver = new ResizeObserver(() => {
      if (isLoading) return;
      queryAnchors();
      syncHighlights();
    });
    resizeObserver.observe(iframeEl);
    return () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
    };
  });
</script>

<div class="relative w-full rounded-2xl overflow-hidden bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-xs">
  {#if isLoading}
    <div class="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/80 dark:bg-stone-900/80 backdrop-blur-xs min-h-[400px]">
      <div class="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" aria-label="Loading lesson…"></div>
      <span class="mt-3 text-xs text-stone-500 dark:text-stone-400 font-medium">Loading original presentation…</span>
    </div>
  {/if}
  {#key contentUrl}
  <iframe
    bind:this={iframeEl}
    src={contentUrl}
    {title}
    scrolling="no"
    sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
    style="width: 100%; border: none; display: block; height: {iframeHeight}px; min-height: 600px; transition: height 0.15s ease;"
    onload={() => {
      // A new URL gets a new iframe/window. Keep the session already adopted
      // from its early height message; resetting here rejects highlight sync.
      const loadedFrame = iframeEl;
      // Allow content script to post initial height before removing overlay
      setTimeout(() => {
        if (iframeEl !== loadedFrame) return;
        isLoading = false;
        queryAnchors();
        syncHighlights();
      }, 350);
    }}
  ></iframe>
  {/key}
</div>
