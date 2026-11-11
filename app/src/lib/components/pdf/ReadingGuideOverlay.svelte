<script lang="ts">
  import { ChevronDown, Compass, Check, BookMarked } from 'lucide-svelte';
  import { parsePageNumbers, parseStartPage } from '$lib/tabs';

  export interface BookmarkedLesson {
    id?: string;
    title: string;
    pageRange: string;
    readingDescription?: string;
  }

  interface Props {
    lessonTitle?: string;
    pageRange?: string;
    readingDescription?: string;
    bookmarkedLessons?: BookmarkedLesson[];
    currentPage: number;
    totalPages: number;
    onJumpToPage: (page: number) => void;
  }

  let {
    lessonTitle = '',
    pageRange = '',
    readingDescription = '',
    bookmarkedLessons = [],
    currentPage,
    totalPages,
    onJumpToPage
  }: Props = $props();

  let isDropdownOpen = $state(false);
  let activeBookmark = $state<BookmarkedLesson | null>(null);

  // Derived list of all bookmarks with page ranges
  const bookmarks = $derived.by<BookmarkedLesson[]>(() => {
    if (Array.isArray(bookmarkedLessons) && bookmarkedLessons.length > 0) {
      return bookmarkedLessons;
    }
    if (pageRange?.trim()) {
      return [
        {
          title: lessonTitle || 'Current Lesson',
          pageRange: pageRange.trim(),
          readingDescription: readingDescription?.trim()
        }
      ];
    }
    return [];
  });

  // Determine current active bookmark based on user selection or current lesson / current page
  const currentActive = $derived.by<BookmarkedLesson | null>(() => {
    if (activeBookmark) return activeBookmark;
    if (lessonTitle || pageRange) {
      const match = bookmarks.find(
        (b) => (b.title && b.title === lessonTitle) || (b.pageRange && b.pageRange === pageRange)
      );
      if (match) return match;
      if (pageRange) {
        return {
          title: lessonTitle || 'Current Lesson',
          pageRange,
          readingDescription
        };
      }
    }
    // Try to find a lesson whose page range contains currentPage
    const pageMatch = bookmarks.find((b) => {
      const nums = parsePageNumbers(b.pageRange);
      if (nums.length === 1) return nums[0] === currentPage;
      if (nums.length >= 2) return currentPage >= nums[0] && currentPage <= nums[nums.length - 1];
      return false;
    });
    return pageMatch || bookmarks[0] || null;
  });

  function selectBookmark(b: BookmarkedLesson) {
    activeBookmark = b;
    isDropdownOpen = false;
    const startPage = parseStartPage(b.pageRange);
    if (startPage) {
      onJumpToPage(startPage);
    }
  }

  function isPageInRange(rangeStr?: string | null, page?: number): boolean {
    if (!rangeStr || !page) return false;
    const nums = parsePageNumbers(rangeStr);
    if (nums.length === 1) return nums[0] === page;
    if (nums.length >= 2) return page >= nums[0] && page <= nums[nums.length - 1];
    return false;
  }
</script>

{#if bookmarks.length > 0 || pageRange || readingDescription || lessonTitle}
  <div class="absolute top-3 left-4 z-30 select-none">
    <!-- Click outside handler when dropdown is open -->
    {#if isDropdownOpen}
      <div
        class="fixed inset-0 z-40 bg-transparent"
        onclick={() => (isDropdownOpen = false)}
        aria-hidden="true"
      ></div>
    {/if}

    <!-- Compact Compass Pill Trigger -->
    <div class="relative z-50">
      <button
        type="button"
        onclick={() => (isDropdownOpen = !isDropdownOpen)}
        class="flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-white/95 dark:bg-stone-900/95 text-stone-800 dark:text-stone-100 shadow-md backdrop-blur-md border border-stone-200/90 dark:border-stone-800/90 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer text-xs group"
        title="Lesson Bookmarks & Reading Guides"
      >
        <span class="p-1 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0">
          <Compass class="w-4 h-4" />
        </span>

        <span class="font-medium truncate max-w-[170px] sm:max-w-[260px] text-left">
          {currentActive?.title || lessonTitle || 'Lesson Bookmarks'}
        </span>

        {#if currentActive?.pageRange || pageRange}
          <span class="px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 font-mono text-3xs font-semibold shrink-0">
            p. {currentActive?.pageRange || pageRange}
          </span>
        {/if}

        <ChevronDown
          class="w-3.5 h-3.5 text-stone-400 group-hover:text-stone-600 dark:group-hover:text-stone-200 transition-transform duration-150 {isDropdownOpen ? 'rotate-180' : ''}"
        />
      </button>

      <!-- Dropdown Menu of Bookmarked Lessons -->
      {#if isDropdownOpen}
        <div
          class="absolute left-0 top-full mt-1.5 w-84 max-h-[75vh] flex flex-col rounded-2xl bg-white dark:bg-stone-900 shadow-2xl border border-stone-200 dark:border-stone-800 overflow-hidden divide-y divide-stone-100 dark:divide-stone-800 animate-in fade-in zoom-in-95 duration-100"
        >
          <!-- Header -->
          <div class="px-3.5 py-2.5 bg-stone-50/80 dark:bg-stone-950/80 flex items-center justify-between">
            <div class="flex items-center space-x-2">
              <BookMarked class="w-4 h-4 text-amber-500" />
              <span class="text-xs font-semibold text-stone-900 dark:text-stone-100">
                Bookmarked Pages
              </span>
            </div>
            <span class="text-3xs font-mono font-medium text-stone-500">
              {bookmarks.length} lesson{bookmarks.length === 1 ? '' : 's'}
            </span>
          </div>

          <!-- List of Bookmarks -->
          <div class="overflow-y-auto max-h-64 py-1 divide-y divide-stone-100/60 dark:divide-stone-800/40">
            {#if bookmarks.length === 0}
              <div class="p-4 text-center text-xs text-stone-400">
                No lessons have bookmarked page ranges yet.
              </div>
            {:else}
              {#each bookmarks as b}
                {@const isViewing = isPageInRange(b.pageRange, currentPage)}
                {@const isSelected = (currentActive?.title === b.title && currentActive?.pageRange === b.pageRange)}
                <button
                  type="button"
                  onclick={() => selectBookmark(b)}
                  class="w-full px-3.5 py-2 text-left flex items-start justify-between gap-2.5 hover:bg-stone-50 dark:hover:bg-stone-800/70 transition cursor-pointer {isSelected ? 'bg-amber-50/60 dark:bg-amber-950/30' : ''}"
                >
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-medium text-stone-800 dark:text-stone-200 truncate {isSelected ? 'text-amber-700 dark:text-amber-300 font-semibold' : ''}">
                      {b.title}
                    </div>
                    {#if b.readingDescription}
                      <div class="text-3xs text-stone-500 dark:text-stone-400 line-clamp-1 mt-0.5">
                        {b.readingDescription}
                      </div>
                    {/if}
                  </div>

                  <div class="flex items-center space-x-1.5 shrink-0 pt-0.5">
                    {#if isViewing}
                      <span class="px-1.5 py-0.5 rounded text-3xs font-semibold bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300">
                        Current
                      </span>
                    {/if}
                    <span class="px-1.5 py-0.5 rounded font-mono text-3xs font-semibold bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300">
                      p. {b.pageRange}
                    </span>
                  </div>
                </button>
              {/each}
            {/if}
          </div>

          <!-- Active Bookmark Reading Guide Preview / Quick Jump -->
          {#if currentActive && (currentActive.readingDescription || currentActive.pageRange)}
            {@const pNums = parsePageNumbers(currentActive.pageRange)}
            <div class="p-3 bg-stone-50/90 dark:bg-stone-950/90 space-y-2 text-xs">
              <div class="flex items-center justify-between">
                <span class="text-3xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                  Active Reading Guide
                </span>
                <span class="text-3xs font-mono text-amber-600 dark:text-amber-400 font-bold">
                  pp. {currentActive.pageRange}
                </span>
              </div>

              {#if currentActive.readingDescription}
                <p class="text-2xs text-stone-600 dark:text-stone-300 leading-relaxed font-normal">
                  {currentActive.readingDescription}
                </p>
              {/if}

              {#if pNums.length > 0}
                <div class="flex flex-wrap items-center gap-1.5 pt-1">
                  {#each pNums as pNum, pIdx}
                    <button
                      type="button"
                      onclick={() => {
                        onJumpToPage(pNum);
                        isDropdownOpen = false;
                      }}
                      class="px-2 py-0.5 rounded text-3xs font-mono font-medium transition cursor-pointer {currentPage === pNum ? 'bg-amber-500 text-white font-bold' : 'bg-stone-200 dark:bg-stone-800 text-stone-700 dark:text-stone-300 hover:bg-amber-500/20'}"
                    >
                      Page {pNum}
                      {#if pNums.length > 1 && pIdx === 0}
                        <span class="opacity-75">(Start)</span>
                      {:else if pNums.length > 1 && pIdx === pNums.length - 1}
                        <span class="opacity-75">(End)</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
