<script lang="ts">
  import { pdfGetPageText, type TextSpan } from '$lib/pdfClient';
  import { Loader2 } from 'lucide-svelte';

  interface Props {
    docPath: string;
    pageIndex: number;
    pageWidth: number;
    pageHeight: number;
    zoomScale?: number;
    imgUrl?: string | null;
    isLoading?: boolean;
    searchRects?: [number, number, number, number][];
    isPanMode?: boolean;
  }

  let {
    docPath,
    pageIndex,
    pageWidth,
    pageHeight,
    zoomScale = 1.0,
    imgUrl = null,
    isLoading = false,
    searchRects = [],
    isPanMode = false
  }: Props = $props();

  let textSpans = $state<TextSpan[]>([]);
  let hasFetchedText = false;

  // Calculate target display dimensions based on PDF point size and zoom scale
  const displayWidth = $derived(Math.round(pageWidth * zoomScale));
  const displayHeight = $derived(Math.round(pageHeight * zoomScale));

  // Lazy text extraction: memoized on native backend, loaded once image is available
  $effect(() => {
    if (imgUrl && !hasFetchedText) {
      hasFetchedText = true;
      pdfGetPageText(docPath, pageIndex)
        .then((spans) => {
          textSpans = spans;
        })
        .catch(() => {});
    }
  });
</script>

<div
  data-page-index={pageIndex}
  class="relative bg-white dark:bg-stone-900 shadow-md rounded-xs overflow-hidden mx-auto transition-all duration-75 select-none shrink-0"
  style:width="{displayWidth}px"
  style:height="{displayHeight}px"
>
  {#if imgUrl}
    <img
      src={imgUrl}
      alt="Page {pageIndex + 1}"
      class="w-full h-full object-contain pointer-events-none block"
      loading="lazy"
    />

    <!-- Transparent Native Text Selection Layer -->
    {#if !isPanMode && textSpans.length > 0}
      <div class="absolute inset-0 select-text overflow-hidden pointer-events-auto leading-none">
        {#each textSpans as span}
          <span
            class="absolute text-transparent cursor-text selection:bg-amber-400/40 selection:text-transparent"
            style:left="{span.x * 100}%"
            style:top="{span.y * 100}%"
            style:width="{span.w * 100}%"
            style:height="{span.h * 100}%"
            style:font-size="{span.h * displayHeight * 0.85}px"
          >
            {span.text}
          </span>
        {/each}
      </div>
    {/if}

    <!-- Search Highlight Rects Overlay -->
    {#if searchRects.length > 0}
      <div class="absolute inset-0 pointer-events-none overflow-hidden">
        {#each searchRects as rect}
          <div
            class="absolute bg-amber-400/40 border border-amber-500/80 rounded-2xs mix-blend-multiply dark:mix-blend-screen animate-pulse"
            style:left="{rect[0] * 100}%"
            style:top="{rect[1] * 100}%"
            style:width="{rect[2] * 100}%"
            style:height="{rect[3] * 100}%"
          ></div>
        {/each}
      </div>
    {/if}
  {:else}
    <!-- Lightweight skeleton placeholder with exact dimensions to eliminate layout shifts -->
    <div class="w-full h-full flex flex-col items-center justify-center space-y-2 bg-stone-100 dark:bg-stone-900 border border-stone-200/60 dark:border-stone-800/60 text-stone-400">
      {#if isLoading}
        <Loader2 class="w-6 h-6 animate-spin text-amber-500/80" />
      {/if}
      <span class="text-3xs font-mono text-stone-400 dark:text-stone-500">Page {pageIndex + 1}</span>
    </div>
  {/if}
</div>
