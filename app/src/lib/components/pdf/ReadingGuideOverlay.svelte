<script lang="ts">
  import { BookOpen, ChevronUp, ChevronDown, Compass, ExternalLink } from 'lucide-svelte';
  import { parsePageNumbers } from '$lib/tabs';

  interface Props {
    lessonTitle?: string;
    pageRange?: string;
    readingDescription?: string;
    currentPage: number;
    totalPages: number;
    onJumpToPage: (page: number) => void;
  }

  let {
    lessonTitle = '',
    pageRange = '',
    readingDescription = '',
    currentPage,
    totalPages,
    onJumpToPage
  }: Props = $props();

  let isCollapsed = $state(false);

  const pageNumbers = $derived(parsePageNumbers(pageRange));
  const hasRangeOrDesc = $derived(Boolean(pageRange?.trim() || readingDescription?.trim()));
</script>

{#if hasRangeOrDesc || lessonTitle}
  <div class="absolute top-3 left-4 z-20 max-w-md select-none pointer-events-none">
    {#if isCollapsed}
      <!-- Collapsed Floating Pill -->
      <button
        type="button"
        onclick={() => (isCollapsed = false)}
        class="pointer-events-auto mx-auto flex items-center space-x-2 px-3 py-1.5 rounded-full bg-stone-900/90 dark:bg-stone-800/95 text-stone-100 shadow-md backdrop-blur-md border border-stone-700/60 hover:bg-stone-800 dark:hover:bg-stone-700 transition cursor-pointer text-xs"
        title="Expand Lesson Reading Guide"
      >
        <BookOpen class="w-3.5 h-3.5 text-amber-400" />
        <span class="font-medium truncate max-w-[260px] sm:max-w-md">
          {lessonTitle || 'Lesson Guide'}
          {#if pageRange}
            <span class="text-amber-300 font-mono text-3xs ml-1 font-bold">pp. {pageRange}</span>
          {/if}
        </span>
        <ChevronDown class="w-3.5 h-3.5 text-stone-400" />
      </button>
    {:else}
      <!-- Expanded Reading Guide Banner -->
      <div class="pointer-events-auto rounded-xl bg-white/95 dark:bg-stone-900/95 shadow-xl backdrop-blur-md border border-stone-200/90 dark:border-stone-800/90 p-3 text-stone-800 dark:text-stone-200 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center space-x-2 min-w-0">
            <span class="p-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
              <Compass class="w-4 h-4" />
            </span>
            <span class="text-xs font-bold truncate tracking-tight text-stone-900 dark:text-stone-100">
              {lessonTitle || 'Lesson Reading Guide'}
            </span>
            {#if pageRange}
              <span class="px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 font-mono text-3xs font-semibold shrink-0">
                Pages: {pageRange}
              </span>
            {/if}
          </div>

          <button
            type="button"
            onclick={() => (isCollapsed = true)}
            class="flex items-center space-x-1 px-2 py-1 rounded-md text-3xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer shrink-0"
            title="Collapse Guide"
          >
            <span>Hide</span>
            <ChevronUp class="w-3.5 h-3.5" />
          </button>
        </div>

        {#if readingDescription}
          <p class="text-xs text-stone-600 dark:text-stone-400 leading-relaxed font-normal">
            {readingDescription}
          </p>
        {/if}

        <!-- Quick Jump Buttons -->
        {#if pageNumbers.length > 0}
          <div class="flex flex-wrap items-center gap-1.5 pt-1 border-t border-stone-100 dark:border-stone-800/60">
            <span class="text-3xs font-semibold uppercase tracking-wider text-stone-400 shrink-0">
              Jump to:
            </span>
            {#each pageNumbers as pNum, idx}
              <button
                type="button"
                onclick={() => onJumpToPage(pNum)}
                class="inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg text-xs font-mono font-medium transition cursor-pointer {currentPage === pNum ? 'bg-amber-500 text-white font-bold shadow-xs' : 'bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400 border border-stone-200/60 dark:border-stone-700/60'}"
                title="Scroll to page {pNum}"
              >
                <span>Page {pNum}</span>
                {#if pageNumbers.length > 1 && idx === 0}
                  <span class="text-3xs opacity-75">(Start)</span>
                {:else if pageNumbers.length > 1 && idx === pageNumbers.length - 1}
                  <span class="text-3xs opacity-75">(End)</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
