<script lang="ts">
  import { Search as SearchIcon, X, ChevronUp, ChevronDown, Loader2 } from 'lucide-svelte';
  import { pdfSearch, type SearchHit } from '$lib/pdfClient';

  interface Props {
    docPath: string;
    onJumpToResult: (pageIndex: number, rects: [number, number, number, number][]) => void;
    onClose?: () => void;
  }

  let { docPath, onJumpToResult, onClose }: Props = $props();

  let query = $state('');
  let matchCase = $state(false);
  let isSearching = $state(false);
  let results = $state<SearchHit[]>([]);
  let activeHitIndex = $state<number | null>(null);

  let searchTimeout: ReturnType<typeof setTimeout> | undefined;

  function triggerSearch() {
    clearTimeout(searchTimeout);
    if (!query.trim()) {
      results = [];
      activeHitIndex = null;
      isSearching = false;
      return;
    }

    isSearching = true;
    searchTimeout = setTimeout(async () => {
      try {
        const hits = await pdfSearch(docPath, query, matchCase);
        results = hits;
        if (hits.length > 0) {
          activeHitIndex = 0;
          onJumpToResult(hits[0].page_index, hits[0].rects);
        } else {
          activeHitIndex = null;
        }
      } catch (err) {
        console.error('[PDFSearch] Search failed:', err);
        results = [];
      } finally {
        isSearching = false;
      }
    }, 250);
  }

  function handleHitClick(idx: number) {
    activeHitIndex = idx;
    const hit = results[idx];
    if (hit) {
      onJumpToResult(hit.page_index, hit.rects);
    }
  }

  function goToPrevious() {
    if (results.length === 0) return;
    const nextIdx =
      activeHitIndex === null || activeHitIndex <= 0
        ? results.length - 1
        : activeHitIndex - 1;
    handleHitClick(nextIdx);
  }

  function goToNext() {
    if (results.length === 0) return;
    const nextIdx =
      activeHitIndex === null || activeHitIndex >= results.length - 1
        ? 0
        : activeHitIndex + 1;
    handleHitClick(nextIdx);
  }
</script>

<div class="flex h-full flex-col bg-stone-50 dark:bg-stone-900 border-l border-stone-200 dark:border-stone-800 p-3 text-stone-800 dark:text-stone-200 select-none">
  <!-- Search Header -->
  <div class="flex items-center justify-between pb-2 mb-2 border-b border-stone-200 dark:border-stone-800">
    <div class="flex items-center space-x-1.5 text-xs font-semibold text-stone-700 dark:text-stone-300">
      <SearchIcon class="w-3.5 h-3.5 text-amber-500" />
      <span>Search Document</span>
    </div>

    {#if onClose}
      <button
        type="button"
        onclick={onClose}
        class="p-1 rounded-md text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 hover:bg-stone-200/50 dark:hover:bg-stone-800 transition cursor-pointer"
        title="Close Search"
      >
        <X class="w-3.5 h-3.5" />
      </button>
    {/if}
  </div>

  <!-- Search Input Area -->
  <div class="space-y-2 mb-3">
    <div class="relative flex items-center">
      <input
        type="text"
        bind:value={query}
        oninput={triggerSearch}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            if (e.shiftKey) goToPrevious();
            else goToNext();
          }
        }}
        placeholder="Find in document..."
        class="w-full pl-8 pr-16 py-1.5 text-xs rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-hidden focus:ring-1 focus:ring-amber-500"
      />
      <SearchIcon class="absolute left-2.5 w-3.5 h-3.5 text-stone-400 pointer-events-none" />

      {#if query}
        <button
          type="button"
          onclick={() => {
            query = '';
            triggerSearch();
          }}
          class="absolute right-7 p-1 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 cursor-pointer"
        >
          <X class="w-3 h-3" />
        </button>
      {/if}

      {#if isSearching}
        <div class="absolute right-2.5">
          <Loader2 class="w-3.5 h-3.5 animate-spin text-amber-500" />
        </div>
      {/if}
    </div>

    <!-- Match Case & Controls Row -->
    <div class="flex items-center justify-between text-2xs text-stone-500 dark:text-stone-400 px-0.5">
      <label class="inline-flex items-center space-x-1.5 cursor-pointer">
        <input
          type="checkbox"
          bind:checked={matchCase}
          onchange={triggerSearch}
          class="rounded border-stone-300 text-amber-500 focus:ring-0 focus:ring-offset-0"
        />
        <span>Match Case</span>
      </label>

      {#if results.length > 0}
        <div class="flex items-center space-x-1">
          <span class="font-mono">
            {activeHitIndex !== null ? activeHitIndex + 1 : 0} of {results.length}
          </span>
          <button
            type="button"
            onclick={goToPrevious}
            class="p-0.5 rounded hover:bg-stone-200 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300 cursor-pointer"
            title="Previous Match"
          >
            <ChevronUp class="w-3 h-3" />
          </button>
          <button
            type="button"
            onclick={goToNext}
            class="p-0.5 rounded hover:bg-stone-200 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300 cursor-pointer"
            title="Next Match"
          >
            <ChevronDown class="w-3 h-3" />
          </button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Results List -->
  <div class="flex-1 overflow-y-auto space-y-1 pr-0.5 text-xs">
    {#if isSearching && results.length === 0}
      <div class="py-8 text-center text-stone-400 text-xs">
        Searching entire document...
      </div>
    {:else if query && results.length === 0 && !isSearching}
      <div class="py-8 text-center text-stone-400 text-xs">
        No matches found for "{query}"
      </div>
    {:else}
      {#each results as hit, idx}
        <button
          type="button"
          onclick={() => handleHitClick(idx)}
          class="w-full text-left p-2 rounded-lg border transition cursor-pointer {activeHitIndex === idx ? 'bg-amber-500/10 border-amber-500/50 text-stone-900 dark:text-stone-100 font-medium' : 'border-stone-200 dark:border-stone-800/80 bg-white dark:bg-stone-950/40 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800/60'}"
        >
          <div class="flex items-center justify-between text-2xs mb-0.5">
            <span class="font-mono font-semibold text-amber-600 dark:text-amber-400">
              Page {hit.page_index + 1}
            </span>
          </div>
          <p class="text-xs line-clamp-2 leading-relaxed">
            {hit.snippet}
          </p>
        </button>
      {/each}
    {/if}
  </div>
</div>
