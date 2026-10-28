<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import {
    PanelRightOpen,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    Maximize2,
    Maximize,
    Minimize,
    Check,
    Hand,
    Search as SearchIcon,
    Loader2
  } from 'lucide-svelte';
  import type { PdfDocumentInfo } from '$lib/pdfClient';
  import { pdfRenderPage, pdfRenderThumbnail, getCoursePdfState, setCoursePdfState } from '$lib/pdfClient';
  import { canUndo, flushNow, loadAnnotations } from '$lib/markup/annotationStore.svelte';
  import { getPdfPageFileKey } from '$lib/markup/pdfMarkup';
  import MarkupMenu from '$lib/components/MarkupMenu.svelte';
  import PageRenderer from './PageRenderer.svelte';
  import Search from './Search.svelte';
  import ReadingGuideOverlay from './ReadingGuideOverlay.svelte';

  interface Props {
    docPath: string;
    docInfo: PdfDocumentInfo;
    title?: string;
    courseId?: string;
    lessonTitle?: string;
    pageRange?: string;
    readingDescription?: string;
    sideBarThumbnails?: boolean;
    sideBarSearch?: boolean;
  }

  let {
    docPath,
    docInfo,
    title = 'Course Book',
    courseId = '',
    lessonTitle = '',
    pageRange = '',
    readingDescription = '',
    sideBarThumbnails = $bindable(false),
    sideBarSearch = $bindable(false)
  }: Props = $props();

  let currentPage = $state(1);
  let pageInputValue = $state('1');
  let zoomScale = $state(1.0);
  let isPanMode = $state(false);

  // Resolve courseId from prop or path fallback
  const resolvedCourseId = $derived(
    courseId || docPath?.match(/\/api\/courses\/([^/]+)\//)?.[1] || ''
  );

  // Active markup file tracking for Undo/Redo/Clear scope
  let lastDrawnFile = $state<string | null>(null);
  const currentFile = $derived(getPdfPageFileKey(docPath, currentPage - 1));
  const activeMarkupFile = $derived(
    lastDrawnFile && resolvedCourseId && canUndo(resolvedCourseId, lastDrawnFile)
      ? lastDrawnFile
      : currentFile
  );

  // Load annotations on mount or when resolvedCourseId changes
  $effect(() => {
    if (resolvedCourseId) {
      void loadAnnotations(resolvedCourseId);
    }
  });

  let viewerRootEl: HTMLDivElement | undefined;
  let isZoomMenuOpen = $state(false);
  let isFullscreen = $state(false);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      viewerRootEl?.requestFullscreen().catch((err) => {
        console.warn('[PDF] Fullscreen failed:', err);
      });
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  function handleFullscreenChange() {
    isFullscreen = Boolean(document.fullscreenElement);
  }

  // Active search highlight mapping: pageIndex -> array of rects
  let activeSearchPage = $state<number | null>(null);
  let activeSearchRects = $state<[number, number, number, number][]>([]);

  let viewportContainerEl = $state<HTMLDivElement>();
  let pageElements = new Map<number, HTMLDivElement>();
  let thumbnailUrls = $state<Record<number, string>>({});

  function registerPage(el: HTMLDivElement, pageIdx: number) {
    pageElements.set(pageIdx, el);
    return {
      destroy() {
        pageElements.delete(pageIdx);
      }
    };
  }

  const totalPages = $derived(docInfo.pages.length);

  // Sync page input value with currentPage
  $effect(() => {
    pageInputValue = String(currentPage);
  });

  // ── Central Lookahead Page Scheduler & Two-Tier LRU Cache ──────────────────
  const MAX_CONCURRENT_RENDERS = 2;
  const MAX_CACHED_PAGES = 12;

  let pageBlobUrls = $state<Record<number, string>>({});
  let pageScales = $state<Record<number, number>>({});
  let pageLoading = $state<Record<number, boolean>>({});

  const visiblePageIndices = new Set<number>();
  const activeRenders = new Set<number>();

  interface QueueItem {
    pageIndex: number;
    priority: number;
    scale: number;
    epoch: number;
  }
  let renderQueue: QueueItem[] = [];
  let isQueueRunning = false;
  let zoomEpoch = 0;

  let lastScrollTop = 0;
  let lastScrollTime = 0;
  let scrollDirection: 'down' | 'up' | 'idle' = 'idle';
  let isFlinging = false;
  let flingTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let zoomDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  let sharedPageObserver: IntersectionObserver | undefined;
  let isProgrammaticScroll = false;
  let programmaticScrollTimer: ReturnType<typeof setTimeout> | undefined;

  function updateCurrentPage() {
    if (isProgrammaticScroll || !viewportContainerEl || totalPages === 0) return;
    const containerRect = viewportContainerEl.getBoundingClientRect();
    // Focal line: 110px below container top (just under floating toolbar and guide)
    const focalY = containerRect.top + 110;

    // Fast check: is currentPage already correct?
    const currentEl = pageElements.get(currentPage - 1);
    if (currentEl) {
      const r = currentEl.getBoundingClientRect();
      if (r.top <= focalY && r.bottom > focalY) {
        return;
      }
    }

    let bestPage = -1;
    let minDistance = Infinity;

    for (let i = 0; i < totalPages; i++) {
      const el = pageElements.get(i);
      if (!el) continue;
      const rect = el.getBoundingClientRect();

      if (rect.top <= focalY && rect.bottom > focalY) {
        bestPage = i + 1;
        break;
      }

      const dist = Math.abs(rect.top - focalY);
      if (dist < minDistance) {
        minDistance = dist;
        bestPage = i + 1;
      }
    }

    if (bestPage > 0 && bestPage !== currentPage) {
      currentPage = bestPage;
    }
  }

  function initPageObserver() {
    if (sharedPageObserver) {
      sharedPageObserver.disconnect();
      sharedPageObserver = undefined;
    }
    if (!viewportContainerEl) return;

    sharedPageObserver = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (Number.isFinite(idx)) {
            if (entry.isIntersecting) {
              if (!visiblePageIndices.has(idx)) {
                visiblePageIndices.add(idx);
                changed = true;
              }
            } else {
              if (visiblePageIndices.has(idx)) {
                visiblePageIndices.delete(idx);
                changed = true;
              }
            }
          }
        }
        if (changed) {
          updateCurrentPage();
          scheduleLookahead();
        }
      },
      {
        root: viewportContainerEl,
        rootMargin: '250px 0px 250px 0px',
        threshold: 0.01
      }
    );

    for (const el of pageElements.values()) {
      sharedPageObserver.observe(el);
    }
  }

  function observePage(node: HTMLElement, pageIdx: number) {
    node.dataset.pageIndex = String(pageIdx);
    pageElements.set(pageIdx, node as HTMLDivElement);
    sharedPageObserver?.observe(node);

    return {
      destroy() {
        sharedPageObserver?.unobserve(node);
        pageElements.delete(pageIdx);
        visiblePageIndices.delete(pageIdx);
      }
    };
  }

  function handleCanvasScroll() {
    if (!viewportContainerEl) return;
    const currentScrollTop = viewportContainerEl.scrollTop;
    const dy = currentScrollTop - lastScrollTop;

    if (Math.abs(dy) > 4) {
      scrollDirection = dy > 0 ? 'down' : 'up';
    }

    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      scrollDirection = 'idle';
      scheduleLookahead();
    }, 250);

    lastScrollTop = currentScrollTop;
    updateCurrentPage();
    scheduleLookahead();
  }

  async function drainQueue() {
    if (isQueueRunning) return;
    isQueueRunning = true;

    try {
      while (renderQueue.length > 0 && activeRenders.size < MAX_CONCURRENT_RENDERS) {
        const anchor = currentPage - 1;
        // Priority 1 first, tie-broken by distance to viewport anchor page
        renderQueue.sort((a, b) => {
          if (a.priority !== b.priority) {
            return a.priority - b.priority;
          }
          return Math.abs(a.pageIndex - anchor) - Math.abs(b.pageIndex - anchor);
        });

        const item = renderQueue.shift();
        if (!item) break;

        const { pageIndex, scale, epoch } = item;
        // Drop obsolete in-flight renders if user has changed zoom scale
        if (epoch !== zoomEpoch) {
          continue;
        }

        const currentScale = pageScales[pageIndex] || 0;
        // Tight 10% tolerance prevents soft/blurry text on small zoom steps
        const hasFreshScale = pageBlobUrls[pageIndex] && Math.abs(currentScale - scale) < 0.10 * scale;

        if (hasFreshScale) {
          continue;
        }

        activeRenders.add(pageIndex);
        pageLoading = { ...pageLoading, [pageIndex]: true };

        // Asynchronously render page on native thread pool
        void (async () => {
          try {
            const url = await pdfRenderPage(docPath, pageIndex, scale, 85);
            // Drop stale render if zoom scale changed while in flight
            if (epoch !== zoomEpoch) {
              URL.revokeObjectURL(url);
              return;
            }
            const oldUrl = pageBlobUrls[pageIndex];
            pageBlobUrls = { ...pageBlobUrls, [pageIndex]: url };
            pageScales = { ...pageScales, [pageIndex]: scale };
            if (oldUrl && oldUrl !== url) {
              URL.revokeObjectURL(oldUrl);
            }
          } catch (err) {
            console.error(`[ViewerToolbar] Error rendering page ${pageIndex + 1}:`, err);
          } finally {
            pageLoading = { ...pageLoading, [pageIndex]: false };
            activeRenders.delete(pageIndex);
            pruneCache();
            if (epoch !== zoomEpoch) {
              scheduleLookahead();
            } else {
              void drainQueue();
            }
          }
        })();
      }
    } finally {
      isQueueRunning = false;
    }
  }

  function pruneCache() {
    const loaded = Object.keys(pageBlobUrls).map(Number);
    if (loaded.length <= MAX_CACHED_PAGES) return;

    const visible = Array.from(visiblePageIndices);
    if (visible.length === 0) return;
    const minVis = Math.min(...visible);
    const maxVis = Math.max(...visible);

    const scored = loaded.map((idx) => {
      const dist = idx < minVis ? (minVis - idx) : idx > maxVis ? (idx - maxVis) : 0;
      return { idx, dist };
    });

    scored.sort((a, b) => b.dist - a.dist);

    for (const { idx, dist } of scored) {
      if (Object.keys(pageBlobUrls).length <= MAX_CACHED_PAGES) break;
      if (dist >= 4 && !activeRenders.has(idx)) {
        const url = pageBlobUrls[idx];
        if (url) {
          URL.revokeObjectURL(url);
          const nextUrls = { ...pageBlobUrls };
          delete nextUrls[idx];
          pageBlobUrls = nextUrls;
          const nextScales = { ...pageScales };
          delete nextScales[idx];
          pageScales = nextScales;
        }
      }
    }
  }

  function scheduleLookahead() {
    if (totalPages === 0) return;

    let minVis: number;
    let maxVis: number;

    if (visiblePageIndices.size > 0) {
      const visible = Array.from(visiblePageIndices);
      minVis = Math.min(...visible);
      maxVis = Math.max(...visible);
    } else {
      // Fallback anchor to currentPage if observer hasn't yet reported entries
      const anchor = Math.max(0, Math.min(totalPages - 1, currentPage - 1));
      minVis = anchor;
      maxVis = anchor;
    }

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const targetScale = Math.min(3.0, Math.max(0.75, zoomScale * dpr));

    // Retain only requests matching the current zoom epoch
    renderQueue = renderQueue.filter((q) => q.epoch === zoomEpoch);

    const needed: { pageIndex: number; priority: number }[] = [];

    // 1. Visible pages: Priority 1 (CRITICAL)
    for (let i = minVis; i <= maxVis; i++) {
      if (i >= 0 && i < totalPages) {
        needed.push({ pageIndex: i, priority: 1 });
      }
    }

    // 2. Lookahead pages (scroll direction aware)
    if (scrollDirection === 'down') {
      if (maxVis + 1 < totalPages) needed.push({ pageIndex: maxVis + 1, priority: 2 });
      if (maxVis + 2 < totalPages) needed.push({ pageIndex: maxVis + 2, priority: 3 });
      if (maxVis + 3 < totalPages) needed.push({ pageIndex: maxVis + 3, priority: 3 });
      if (minVis - 1 >= 0) needed.push({ pageIndex: minVis - 1, priority: 4 });
    } else if (scrollDirection === 'up') {
      if (minVis - 1 >= 0) needed.push({ pageIndex: minVis - 1, priority: 2 });
      if (minVis - 2 >= 0) needed.push({ pageIndex: minVis - 2, priority: 3 });
      if (minVis - 3 >= 0) needed.push({ pageIndex: minVis - 3, priority: 3 });
      if (maxVis + 1 < totalPages) needed.push({ pageIndex: maxVis + 1, priority: 4 });
    } else {
      if (minVis - 1 >= 0) needed.push({ pageIndex: minVis - 1, priority: 2 });
      if (maxVis + 1 < totalPages) needed.push({ pageIndex: maxVis + 1, priority: 2 });
      if (maxVis + 2 < totalPages) needed.push({ pageIndex: maxVis + 2, priority: 3 });
      if (minVis - 2 >= 0) needed.push({ pageIndex: minVis - 2, priority: 3 });
    }

    for (const req of needed) {
      const currentScale = pageScales[req.pageIndex] || 0;
      const alreadyLoaded = pageBlobUrls[req.pageIndex] &&
        Math.abs(currentScale - targetScale) < 0.10 * targetScale;
      const inQueue = renderQueue.some((q) => q.pageIndex === req.pageIndex && q.epoch === zoomEpoch);
      const inFlight = activeRenders.has(req.pageIndex);

      if (!alreadyLoaded && !inQueue && !inFlight) {
        renderQueue.push({ pageIndex: req.pageIndex, priority: req.priority, scale: targetScale, epoch: zoomEpoch });
      }
    }

    void drainQueue();
  }

  let previousZoomScale = 1.0;

  // Bump zoomEpoch, clear obsolete queue, adjust scroll focal point, and schedule re-render
  $effect(() => {
    const currentZoom = zoomScale;
    if (currentZoom !== previousZoomScale) {
      const oldZoom = previousZoomScale;
      previousZoomScale = currentZoom;
      zoomEpoch++;
      renderQueue = [];

      // Proportional focal adjustment so zooming keeps current viewport center
      if (viewportContainerEl && oldZoom > 0) {
        const ratio = currentZoom / oldZoom;
        const currentCenter = viewportContainerEl.scrollTop + viewportContainerEl.clientHeight / 2;
        const newCenter = currentCenter * ratio;
        viewportContainerEl.scrollTop = Math.max(0, newCenter - viewportContainerEl.clientHeight / 2);
      }

      clearTimeout(zoomDebounceTimer);
      zoomDebounceTimer = setTimeout(() => {
        scheduleLookahead();
      }, 60);
    }
  });

  let saveStateTimer: ReturnType<typeof setTimeout> | undefined;

  // Persist scroll position, zoom level, and thumbnail sidebar visibility per course document
  $effect(() => {
    const p = currentPage;
    const z = zoomScale;
    const thumbs = sideBarThumbnails;
    if (docPath && p > 0 && z > 0) {
      clearTimeout(saveStateTimer);
      saveStateTimer = setTimeout(() => {
        setCoursePdfState(docPath, {
          page: p,
          zoomScale: z,
          sideBarThumbnails: thumbs
        });
      }, 200);
    }
  });

  function scrollToPage(pageNum: number, instant = false) {
    const clamped = Math.max(1, Math.min(totalPages, pageNum));
    currentPage = clamped;

    // Prevent observer/scroll events during smooth scroll animation from overriding currentPage
    isProgrammaticScroll = true;
    clearTimeout(programmaticScrollTimer);
    programmaticScrollTimer = setTimeout(() => {
      isProgrammaticScroll = false;
      updateCurrentPage();
    }, instant ? 50 : 450);

    // Fast-path: immediately queue target page at Priority 1 without contaminating
    // visiblePageIndices (which is strictly managed by sharedPageObserver).
    const targetIdx = clamped - 1;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const targetScale = Math.min(3.0, Math.max(0.75, zoomScale * dpr));
    const currentScale = pageScales[targetIdx] || 0;
    const alreadyLoaded = pageBlobUrls[targetIdx] &&
      Math.abs(currentScale - targetScale) < 0.10 * targetScale;

    if (!alreadyLoaded && !activeRenders.has(targetIdx)) {
      renderQueue = renderQueue.filter((q) => q.pageIndex !== targetIdx);
      renderQueue.unshift({ pageIndex: targetIdx, priority: 1, scale: targetScale, epoch: zoomEpoch });
      void drainQueue();
    }

    const targetEl = pageElements.get(targetIdx);
    if (targetEl && viewportContainerEl) {
      targetEl.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function handlePageInputChange(e: KeyboardEvent | FocusEvent) {
    const target = e.currentTarget as HTMLInputElement | null;
    const key = e instanceof KeyboardEvent ? e.key : undefined;
    if (key === 'Escape') {
      target?.blur();
      pageInputValue = String(currentPage);
      return;
    }
    if (!key || key === 'Enter') {
      const parsed = parseInt(target?.value || '', 10);
      if (Number.isFinite(parsed)) {
        scrollToPage(parsed);
      }
      target?.blur();
    }
  }

  const ZOOM_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];

  function setZoom(scale: number) {
    zoomScale = Math.max(0.4, Math.min(3.5, Math.round(scale * 100) / 100));
    isZoomMenuOpen = false;
  }

  function zoomIn() {
    zoomScale = Math.min(3.5, Math.round((zoomScale + 0.15) * 100) / 100);
  }

  function zoomOut() {
    zoomScale = Math.max(0.4, Math.round((zoomScale - 0.15) * 100) / 100);
  }

  function fitWidth() {
    if (!viewportContainerEl || docInfo.pages.length === 0) return;
    const containerWidth = viewportContainerEl.clientWidth - 64; // horizontal margin
    const firstPageWidth = docInfo.pages[0].width || 612;
    zoomScale = Math.max(0.4, Math.min(3.0, Math.round((containerWidth / firstPageWidth) * 100) / 100));
  }

  function fitPage() {
    if (!viewportContainerEl || docInfo.pages.length === 0) return;
    const containerHeight = viewportContainerEl.clientHeight - 96; // vertical margin for toolbar
    const firstPageHeight = docInfo.pages[0].height || 792;
    zoomScale = Math.max(0.4, Math.min(2.5, Math.round((containerHeight / firstPageHeight) * 100) / 100));
  }

  function handleJumpToSearchResult(pageIdx: number, rects: [number, number, number, number][]) {
    activeSearchPage = pageIdx;
    activeSearchRects = rects;
    scrollToPage(pageIdx + 1);
  }

  // Grab / Pan drag handling
  let isDragging = $state(false);
  let startX = 0;
  let startY = 0;
  let scrollLeftStart = 0;
  let scrollTopStart = 0;

  function handleMouseDown(e: MouseEvent) {
    if (!isPanMode || !viewportContainerEl) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    scrollLeftStart = viewportContainerEl.scrollLeft;
    scrollTopStart = viewportContainerEl.scrollTop;
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isDragging || !viewportContainerEl) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    viewportContainerEl.scrollLeft = scrollLeftStart - dx;
    viewportContainerEl.scrollTop = scrollTopStart - dy;
  }

  function handleMouseUp() {
    isDragging = false;
  }

  // Ctrl+Wheel or Pinch zoom
  function handleWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      zoomScale = Math.max(0.4, Math.min(3.5, Math.round((zoomScale + delta) * 100) / 100));
    }
  }

  // Fetch thumbnail for sidebar
  async function loadThumbnail(pageIdx: number) {
    if (thumbnailUrls[pageIdx]) return;
    try {
      const url = await pdfRenderThumbnail(docPath, pageIdx, 120);
      thumbnailUrls = { ...thumbnailUrls, [pageIdx]: url };
    } catch (err) {
      console.error(`[Thumbnail] Failed page ${pageIdx + 1}:`, err);
    }
  }

  let thumbnailObserver: IntersectionObserver | undefined;

  function observeThumbnail(node: HTMLElement, pageIdx: number) {
    node.dataset.thumbIndex = String(pageIdx);
    if (!thumbnailObserver) {
      thumbnailObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            thumbnailObserver?.unobserve(entry.target);
            const idx = Number((entry.target as HTMLElement).dataset.thumbIndex);
            if (Number.isFinite(idx)) {
              void loadThumbnail(idx);
            }
          }
        },
        { rootMargin: '300px 0px 300px 0px' }
      );
    }
    thumbnailObserver.observe(node);
    return {
      destroy() {
        thumbnailObserver?.unobserve(node);
      }
    };
  }

  onMount(() => {
    initPageObserver();

    const remembered = getCoursePdfState(docPath);
    if (remembered) {
      previousZoomScale = remembered.zoomScale;
      zoomScale = remembered.zoomScale;
      sideBarThumbnails = remembered.sideBarThumbnails;
      const targetPage = Math.max(1, Math.min(totalPages, remembered.page));
      currentPage = targetPage;
      tick().then(() => {
        scrollToPage(targetPage, true);
      });
    } else {
      // First open: compute fitWidth synchronously before triggering lookahead
      // to eliminate the double-render flash
      if (viewportContainerEl && docInfo.pages.length > 0) {
        const containerWidth = viewportContainerEl.clientWidth - 64;
        const firstPageWidth = docInfo.pages[0].width || 612;
        const initialZoom = Math.max(0.4, Math.min(3.0, Math.round((containerWidth / firstPageWidth) * 100) / 100));
        previousZoomScale = initialZoom;
        zoomScale = initialZoom;
      }
      tick().then(() => {
        scrollToPage(1, true);
      });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('fullscreenchange', handleFullscreenChange);
    }
  });

  onDestroy(() => {
    flushNow();
    if (typeof document !== 'undefined') {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }
    sharedPageObserver?.disconnect();
    thumbnailObserver?.disconnect();
    clearTimeout(flingTimer);
    clearTimeout(idleTimer);
    clearTimeout(zoomDebounceTimer);
    clearTimeout(programmaticScrollTimer);
    clearTimeout(saveStateTimer);
    for (const url of Object.values(pageBlobUrls)) {
      URL.revokeObjectURL(url);
    }
    for (const url of Object.values(thumbnailUrls)) {
      URL.revokeObjectURL(url);
    }
  });
</script>

<svelte:window
  onbeforeunload={flushNow}
  onvisibilitychange={() => (document.hidden ? flushNow() : undefined)}
/>

<div bind:this={viewerRootEl} class="relative h-full w-full flex overflow-hidden bg-stone-100 dark:bg-stone-950 select-none">
  <!-- Left Thumbnails Sidebar (Slides out from left edge) -->
  {#if sideBarThumbnails}
    <div class="h-full w-[140px] flex-shrink-0 border-r border-stone-200 dark:border-stone-800 bg-white/95 dark:bg-stone-900/95 backdrop-blur-md z-30 overflow-y-auto p-2.5 space-y-3 shadow-md select-none">
      {#each docInfo.pages as page, idx}
        {@const isCurrent = currentPage === idx + 1}
        <button
          type="button"
          onclick={() => scrollToPage(idx + 1)}
          class="w-full flex flex-col items-center group cursor-pointer"
        >
          <div
            class="w-[110px] min-h-[140px] bg-white dark:bg-stone-950 rounded-md overflow-hidden transition-all flex items-center justify-center border {isCurrent ? 'ring-2 ring-amber-500 border-amber-500 shadow-sm' : 'border-stone-300 dark:border-stone-700 group-hover:border-stone-400'}"
          >
            {#if thumbnailUrls[idx]}
              <img
                src={thumbnailUrls[idx]}
                alt="Thumb {idx + 1}"
                class="w-full h-full object-contain pointer-events-none block"
                loading="lazy"
              />
            {:else}
              <div
                class="flex flex-col items-center justify-center space-y-1 text-stone-400 py-6"
                use:observeThumbnail={idx}
              >
                <Loader2 class="w-4 h-4 animate-spin text-amber-500/60" />
                <span class="text-3xs font-mono">{idx + 1}</span>
              </div>
            {/if}
          </div>
          <span class="text-3xs font-mono font-medium mt-1 {isCurrent ? 'text-amber-600 dark:text-amber-400 font-bold' : 'text-stone-500 dark:text-stone-400'}">
            {idx + 1}
          </span>
        </button>
      {/each}
    </div>
  {/if}

  <!-- Main Viewport Area -->
  <div class="relative flex-1 h-full w-full overflow-hidden">
    <!-- Top Floating Reading Guide Overlay (Center) -->
    <ReadingGuideOverlay
      {lessonTitle}
      {pageRange}
      {readingDescription}
      {currentPage}
      {totalPages}
      onJumpToPage={scrollToPage}
    />

    <!-- Top Floating Control Bar (Right-side, under tabs) -->
    <div class="absolute top-3 right-4 z-30 pointer-events-auto inline-flex items-center space-x-1.5 p-1 rounded-xl bg-white/90 dark:bg-stone-900/90 backdrop-blur-md border border-stone-200/90 dark:border-stone-800/90 shadow-lg text-stone-700 dark:text-stone-200">
      <!-- 1. Thumbnail Toggle -->
      <button
        type="button"
        onclick={() => (sideBarThumbnails = !sideBarThumbnails)}
        class="p-1.5 rounded-lg border transition cursor-pointer {sideBarThumbnails ? 'bg-amber-500/15 border-amber-500/50 text-amber-600 dark:text-amber-400' : 'border-stone-200 dark:border-stone-700/60 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300'}"
        title="Toggle Page Thumbnails"
        aria-label="Toggle Page Thumbnails"
      >
        <PanelRightOpen class="w-3.5 h-3.5" />
      </button>

      <!-- 2. Free-hand Markup Widget (squeezed immediately after thumbnail toggle) -->
      {#if resolvedCourseId}
        <div class="h-4 w-px bg-stone-200 dark:bg-stone-700/80"></div>
        <MarkupMenu courseId={resolvedCourseId} file={activeMarkupFile} />
      {/if}

      <div class="h-4 w-px bg-stone-200 dark:bg-stone-700/80"></div>

      <!-- 3. Zoom Dropdown -->
      <div class="relative">
        <button
          type="button"
          onclick={() => (isZoomMenuOpen = !isZoomMenuOpen)}
          class="flex items-center space-x-1 px-2 py-1 rounded-lg border border-stone-200 dark:border-stone-700/60 bg-stone-50 dark:bg-stone-950/70 hover:bg-stone-100 dark:hover:bg-stone-800/80 text-xs font-mono font-medium text-stone-700 dark:text-stone-200 transition cursor-pointer"
          title="Zoom and Display Options"
          aria-haspopup="true"
          aria-expanded={isZoomMenuOpen}
        >
          <span>{Math.round(zoomScale * 100)}%</span>
          <ChevronDown class="w-3 h-3 text-stone-400 transition-transform duration-150 {isZoomMenuOpen ? 'rotate-180' : ''}" />
        </button>

        {#if isZoomMenuOpen}
          <!-- Backdrop to close on click outside -->
          <button
            type="button"
            tabindex="-1"
            class="fixed inset-0 z-40 cursor-default bg-transparent border-0 outline-hidden"
            onclick={() => (isZoomMenuOpen = false)}
            aria-label="Close zoom menu"
          ></button>

          <!-- Dropdown popover -->
          <div class="absolute right-0 top-full mt-1.5 w-44 rounded-xl border border-stone-200/90 dark:border-stone-800/90 bg-white/95 dark:bg-stone-900/95 backdrop-blur-md shadow-xl py-1 z-50 text-xs text-stone-700 dark:text-stone-200 select-none">
            <div class="px-2.5 py-1 text-3xs font-semibold uppercase tracking-wider text-stone-400">
              Zoom
            </div>
            {#each ZOOM_PRESETS as preset}
              {@const isSelected = Math.round(zoomScale * 100) === Math.round(preset * 100)}
              <button
                type="button"
                onclick={() => setZoom(preset)}
                class="w-full flex items-center justify-between px-3 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800/80 font-mono text-left cursor-pointer transition {isSelected ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}"
              >
                <span>{Math.round(preset * 100)}%</span>
                {#if isSelected}
                  <Check class="w-3.5 h-3.5 text-amber-500" />
                {/if}
              </button>
            {/each}

            <div class="my-1 border-t border-stone-200 dark:border-stone-800"></div>

            <!-- Page Fit Options -->
            <button
              type="button"
              onclick={() => { fitWidth(); isZoomMenuOpen = false; }}
              class="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800/80 text-left cursor-pointer transition"
            >
              <Maximize2 class="w-3.5 h-3.5 text-stone-400" />
              <span>Fit Width</span>
            </button>
            <button
              type="button"
              onclick={() => { fitPage(); isZoomMenuOpen = false; }}
              class="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800/80 text-left cursor-pointer transition"
            >
              <Maximize class="w-3.5 h-3.5 text-stone-400" />
              <span>Fit Page</span>
            </button>

            <div class="my-1 border-t border-stone-200 dark:border-stone-800"></div>

            <!-- Fullscreen Toggle -->
            <button
              type="button"
              onclick={() => { toggleFullscreen(); isZoomMenuOpen = false; }}
              class="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800/80 text-left cursor-pointer transition"
            >
              {#if isFullscreen}
                <Minimize class="w-3.5 h-3.5 text-amber-500" />
                <span>Exit Fullscreen</span>
              {:else}
                <Maximize class="w-3.5 h-3.5 text-stone-400" />
                <span>Fullscreen</span>
              {/if}
            </button>
          </div>
        {/if}
      </div>

      <div class="h-4 w-px bg-stone-200 dark:bg-stone-700/80"></div>

      <!-- 3. Grip / Hand Toggle -->
      <button
        type="button"
        onclick={() => (isPanMode = !isPanMode)}
        class="p-1.5 rounded-lg border transition cursor-pointer {isPanMode ? 'bg-amber-500/15 border-amber-500/50 text-amber-600 dark:text-amber-400' : 'border-stone-200 dark:border-stone-700/60 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300'}"
        title={isPanMode ? 'Hand Grab active (drag canvas to scroll)' : 'Text Select mode active (click to enable Hand Grab)'}
        aria-label="Toggle Hand Grab / Pan Mode"
      >
        <Hand class="w-3.5 h-3.5" />
      </button>

      <!-- 4. Search Toggle -->
      <button
        type="button"
        onclick={() => (sideBarSearch = !sideBarSearch)}
        class="p-1.5 rounded-lg border transition cursor-pointer {sideBarSearch ? 'bg-amber-500/15 border-amber-500/50 text-amber-600 dark:text-amber-400' : 'border-stone-200 dark:border-stone-700/60 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300'}"
        title="Search Document"
        aria-label="Toggle Search Panel"
      >
        <SearchIcon class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Bottom Floating Page Selector (Bottom Middle) -->
    <div class="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 pointer-events-auto inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-full bg-white/95 dark:bg-stone-900/95 backdrop-blur-md border border-stone-200/90 dark:border-stone-800/90 shadow-xl text-stone-700 dark:text-stone-200 select-none">
      <button
        type="button"
        disabled={currentPage <= 1}
        onclick={() => scrollToPage(currentPage - 1)}
        class="p-1 rounded-full hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300 disabled:opacity-30 cursor-pointer transition"
        title="Previous Page"
        aria-label="Previous Page"
      >
        <ChevronLeft class="w-4 h-4" />
      </button>

      <div class="flex items-center space-x-1.5 font-mono text-xs px-1">
        <input
          type="text"
          value={pageInputValue}
          onkeydown={handlePageInputChange}
          onblur={handlePageInputChange}
          aria-label="Current Page Number"
          class="w-10 px-1 py-0.5 text-center font-mono font-medium rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 text-stone-900 dark:text-stone-100 focus:outline-hidden focus:ring-1 focus:ring-amber-500 text-xs shadow-xs"
        />
        <span class="text-stone-400 font-medium">/ {totalPages}</span>
      </div>

      <button
        type="button"
        disabled={currentPage >= totalPages}
        onclick={() => scrollToPage(currentPage + 1)}
        class="p-1 rounded-full hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300 disabled:opacity-30 cursor-pointer transition"
        title="Next Page"
        aria-label="Next Page"
      >
        <ChevronRight class="w-4 h-4" />
      </button>
    </div>

    <!-- Scrollable Canvas: Full Window Height & Width, Pages Always Centered -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      role="region"
      aria-label="PDF Document Pages"
      tabindex="-1"
      bind:this={viewportContainerEl}
      onscroll={handleCanvasScroll}
      onmousedown={handleMouseDown}
      onmousemove={handleMouseMove}
      onmouseup={handleMouseUp}
      onmouseleave={handleMouseUp}
      onwheel={handleWheel}
      class="absolute inset-0 overflow-auto pt-16 pb-20 {isPanMode ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}"
    >
      <div class="min-w-full w-max mx-auto flex flex-col items-center space-y-8 px-4">
        {#each docInfo.pages as page, idx}
          <div use:registerPage={idx} use:observePage={idx} class="flex justify-center w-full scroll-mt-20">
            <PageRenderer
              {docPath}
              pageIndex={idx}
              pageWidth={page.width}
              pageHeight={page.height}
              {zoomScale}
              {isPanMode}
              imgUrl={pageBlobUrls[idx]}
              isLoading={Boolean(pageLoading[idx])}
              searchRects={activeSearchPage === idx ? activeSearchRects : []}
              courseId={resolvedCourseId}
              scrollerEl={viewportContainerEl}
              onStrokeDrawn={(f) => (lastDrawnFile = f)}
            />
          </div>
        {/each}
      </div>
    </div>
  </div>

  <!-- Right Search Sidebar (Slides out from right edge) -->
  {#if sideBarSearch}
    <div class="h-full w-72 sm:w-80 flex-shrink-0 z-40 shadow-2xl border-l border-stone-200 dark:border-stone-800">
      <Search
        {docPath}
        onJumpToResult={handleJumpToSearchResult}
        onClose={() => {
          sideBarSearch = false;
          activeSearchPage = null;
          activeSearchRects = [];
        }}
      />
    </div>
  {/if}
</div>
