<script lang="ts">
  import Header from '$lib/components/Header.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    BookOpen,
    FlagTriangleRight,
    Loader2,
    Search,
    Trash2,
    ArrowRight,
    X
  } from 'lucide-svelte';
  import { apiFetch } from '$lib/api';
  import {
    CHECKPOINT_COLORS,
    getCheckpointColor,
    getCheckpointHref,
    type Checkpoint
  } from '$lib/checkpoint';
  import { parseDocFileName, customTabDisplayName } from '$lib/tabs';
  import { parsePdfPageFileKey } from '$lib/markup/pdfMarkup';
  import { clearFile, flushNow } from '$lib/markup/annotationStore.svelte';

  interface CourseManifestBrief {
    id: string;
    title: string;
    archived?: boolean;
  }

  interface CheckpointWithMeta extends Checkpoint {
    courseId: string;
    courseTitle: string;
  }

  interface CourseCardData {
    courseId: string;
    courseTitle: string;
    checkpoints: CheckpointWithMeta[];
    filteredCheckpoints: CheckpointWithMeta[];
    latestDate: number;
  }

  let courses: CourseManifestBrief[] = $state([]);
  let checkpoints: CheckpointWithMeta[] = $state([]);
  let isLoading: boolean = $state(true);
  let loadFailed: boolean = $state(false);
  let searchQuery: string = $state('');
  let selectedColorFilter: string = $state('all');
  let deletingId: string | null = $state(null);

  async function loadData() {
    isLoading = true;
    loadFailed = false;
    try {
      const [coursesRes, checkpointsRes] = await Promise.all([
        apiFetch('/api/courses'),
        apiFetch('/api/checkpoints')
      ]);

      if (!coursesRes.ok || !checkpointsRes.ok) {
        throw new Error(`Failed to load data: courses=${coursesRes.status}, checkpoints=${checkpointsRes.status}`);
      }

      const coursesData = await coursesRes.json();
      const checkpointsData = await checkpointsRes.json();

      courses = (coursesData.courses || []).filter((c: CourseManifestBrief) => !c.archived);
      checkpoints = checkpointsData.checkpoints || [];
    } catch (e) {
      console.error('Failed to load checkpoints:', e);
      loadFailed = true;
    } finally {
      isLoading = false;
    }
  }

  onMount(loadData);

  async function handleDelete(courseId: string, id: string) {
    deletingId = id;
    try {
      const target = checkpoints.find((c) => c.id === id);
      if (target?.type === 'markup') {
        clearFile(courseId, target.file);
        await flushNow();
      } else {
        const res = await apiFetch(`/api/courses/${courseId}/checkpoints/${id}`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      checkpoints = checkpoints.filter((c) => c.id !== id);
    } catch (e) {
      console.error('Failed to delete checkpoint:', e);
      alert('Could not delete checkpoint note.');
    } finally {
      deletingId = null;
    }
  }

  function getShortFileLabel(file: string): string {
    const pdfKey = parsePdfPageFileKey(file);
    if (pdfKey) {
      return `p ${pdfKey.pageNumber}`;
    }
    const parsed = parseDocFileName(file);
    if (!parsed) return file;
    if (parsed.isCourseScope) {
      return customTabDisplayName(parsed.tab);
    }
    const parts = parsed.lessonId.split('.');
    if (parts.length === 2 && !Number.isNaN(Number(parts[0])) && !Number.isNaN(Number(parts[1]))) {
      return `${Number(parts[0])}.${Number(parts[1])}`;
    }
    return parsed.lessonId;
  }

  function getFullFileLabel(file: string): string {
    const pdfKey = parsePdfPageFileKey(file);
    if (pdfKey) {
      return `Book · Page ${pdfKey.pageNumber}`;
    }
    const parsed = parseDocFileName(file);
    if (!parsed) return file;
    const tabLabel = customTabDisplayName(parsed.tab);
    if (parsed.isCourseScope) {
      return `Course · ${tabLabel}`;
    }
    return `Lesson ${parsed.lessonId} · ${tabLabel}`;
  }

  let totalCheckpointsCount = $derived(checkpoints.length);

  let courseCards = $derived.by(() => {
    const courseMap = new Map<string, { id: string; title: string }>();
    for (const c of courses) {
      courseMap.set(c.id.toLowerCase(), { id: c.id, title: c.title || c.id.toUpperCase() });
    }
    for (const cp of checkpoints) {
      if (cp.courseId && !courseMap.has(cp.courseId.toLowerCase())) {
        courseMap.set(cp.courseId.toLowerCase(), {
          id: cp.courseId,
          title: cp.courseTitle || cp.courseId.toUpperCase()
        });
      }
    }

    const q = searchQuery.trim().toLowerCase();
    const cards: CourseCardData[] = [];

    for (const [lowerId, meta] of courseMap.entries()) {
      // Checkpoints for this course, strictly sorted from most recent date to oldest
      const courseCps = checkpoints
        .filter((cp) => (cp.courseId || '').toLowerCase() === lowerId)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      let filtered = courseCps;
      if (selectedColorFilter !== 'all') {
        filtered = filtered.filter(
          (cp) => (cp.color || 'yellow').toLowerCase() === selectedColorFilter.toLowerCase()
        );
      }
      if (q) {
        filtered = filtered.filter(
          (cp) =>
            (cp.noteText || '').toLowerCase().includes(q) ||
            cp.file.toLowerCase().includes(q)
        );
      }

      const latestDate = courseCps[0]?.date ? new Date(courseCps[0].date).getTime() : 0;

      cards.push({
        courseId: meta.id,
        courseTitle: meta.title,
        checkpoints: courseCps,
        filteredCheckpoints: filtered,
        latestDate
      });
    }

    const compareAlphabetical = (a: CourseCardData, b: CourseCardData) => {
      const aKey = a.courseTitle || a.courseId;
      const bKey = b.courseTitle || b.courseId;
      return aKey.localeCompare(bKey, undefined, { numeric: true, sensitivity: 'base' });
    };

    // When filtering by search or color, only show courses that have matching checkpoints
    if (q || selectedColorFilter !== 'all') {
      return cards
        .filter((c) => c.filteredCheckpoints.length > 0)
        .sort(compareAlphabetical);
    }

    // Default: show courses organized alphabetically
    return cards.sort(compareAlphabetical);
  });

  let totalFilteredCount = $derived.by(() => {
    return courseCards.reduce((sum, c) => sum + c.filteredCheckpoints.length, 0);
  });
</script>

<Header />

<main class="flex-1 overflow-y-auto px-4 py-8 sm:px-8 max-w-6xl mx-auto w-full space-y-6">
  <!-- Top Header & Subtitle -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
    <div>
      <div class="flex items-center space-x-2">
        <FlagTriangleRight class="w-6 h-6 text-stone-700 dark:text-stone-300" />
        <h1 class="text-2xl font-bold tracking-tight text-stone-900 dark:text-stone-100">Checkpoints</h1>
      </div>
      <p class="text-xs text-stone-500 dark:text-stone-400 mt-1">
        Post-it notes and bookmarked positions across all your courses
      </p>
    </div>

    <!-- Stats Pill -->
    {#if !isLoading && totalCheckpointsCount > 0}
      <div class="inline-flex items-center space-x-2 px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 text-xs font-medium text-stone-600 dark:text-stone-400 self-start sm:self-auto shadow-2xs">
        <FlagTriangleRight class="w-3.5 h-3.5 text-stone-400" />
        <span>{totalCheckpointsCount} {totalCheckpointsCount === 1 ? 'note' : 'notes'} saved</span>
      </div>
    {/if}
  </div>

  <!-- Search & Color Filter Bar -->
  <div class="flex flex-wrap items-center gap-2.5 p-3 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xs">
    <!-- Search text -->
    <div class="relative flex-1 min-w-[200px]">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="Search notes across courses..."
        class="w-full pl-9 pr-8 py-1.5 rounded-lg text-xs bg-stone-50 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:outline-hidden focus:ring-1 focus:ring-stone-400"
      />
      {#if searchQuery}
        <button
          type="button"
          onclick={() => (searchQuery = '')}
          class="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 cursor-pointer"
          aria-label="Clear search"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      {/if}
    </div>

    <!-- Color Palette Filter Buttons -->
    <div class="flex items-center space-x-1.5 pl-1.5 border-l border-stone-200 dark:border-stone-800 overflow-x-auto">
      <button
        type="button"
        onclick={() => (selectedColorFilter = 'all')}
        class="px-2 py-1 rounded-md text-[11px] font-medium transition cursor-pointer {selectedColorFilter === 'all' ? 'bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-500 hover:text-stone-800 dark:hover:text-stone-200'}"
      >
        All
      </button>

      <!-- Set 1: Pastel Tones -->
      <div class="flex items-center space-x-1 p-0.5 rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-200/50 dark:border-stone-700/50">
        {#each CHECKPOINT_COLORS.filter((c) => c.set === 1) as color (color.id)}
          <button
            type="button"
            onclick={() => (selectedColorFilter = color.id)}
            title={`Filter: ${color.label}`}
            aria-label={`Filter by ${color.label}`}
            class="relative w-4 h-4 rounded-full shrink-0 transition-transform hover:scale-125 cursor-pointer focus:outline-hidden ring-1 ring-black/10 dark:ring-white/10 {selectedColorFilter === color.id ? 'ring-2 ring-stone-900 dark:ring-white scale-110' : ''}"
            style="background-color: {color.dot};"
          ></button>
        {/each}
      </div>

      <!-- Set 2: Vibrant Tones -->
      <div class="flex items-center space-x-1 p-0.5 rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-200/50 dark:border-stone-700/50">
        {#each CHECKPOINT_COLORS.filter((c) => c.set === 2) as color (color.id)}
          <button
            type="button"
            onclick={() => (selectedColorFilter = color.id)}
            title={`Filter: ${color.label}`}
            aria-label={`Filter by ${color.label}`}
            class="relative w-4 h-4 rounded-full shrink-0 transition-transform hover:scale-125 cursor-pointer focus:outline-hidden ring-1 ring-black/10 dark:ring-white/10 {selectedColorFilter === color.id ? 'ring-2 ring-stone-900 dark:ring-white scale-110' : ''}"
            style="background-color: {color.dot};"
          ></button>
        {/each}
      </div>
    </div>
  </div>

  <!-- Content State -->
  {#if isLoading}
    <div class="flex flex-col items-center justify-center py-24 space-y-3 text-stone-400">
      <Loader2 class="w-6 h-6 animate-spin" />
      <p class="text-xs">Loading checkpoints…</p>
    </div>
  {:else if loadFailed}
    <div class="py-20 text-center space-y-3">
      <p class="text-sm text-stone-600 dark:text-stone-300">Could not load checkpoints.</p>
      <button
        type="button"
        onclick={loadData}
        class="px-3.5 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
      >
        Try Again
      </button>
    </div>
  {:else if courses.length === 0 && checkpoints.length === 0}
    <div class="py-24 text-center space-y-3 rounded-2xl border border-dashed border-stone-200 dark:border-stone-800 p-8">
      <div class="w-12 h-12 rounded-full bg-stone-100 dark:bg-stone-800 flex items-center justify-center mx-auto text-stone-400">
        <FlagTriangleRight class="w-6 h-6" />
      </div>
      <h2 class="text-base font-semibold text-stone-800 dark:text-stone-200">No checkpoints yet</h2>
      <p class="text-xs text-stone-500 dark:text-stone-400 max-w-sm mx-auto leading-relaxed">
        While reading through any lesson or course page, move your cursor down the page and click the subtle <span class="font-mono font-medium text-stone-700 dark:text-stone-300">[+ 🚩]</span> button to add a post-it note at that exact point.
      </p>
    </div>
  {:else if courseCards.length === 0}
    <div class="py-16 text-center space-y-2">
      <p class="text-sm text-stone-600 dark:text-stone-300">No checkpoints match your filter.</p>
      <button
        type="button"
        onclick={() => {
          searchQuery = '';
          selectedColorFilter = 'all';
        }}
        class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
      >
        Clear filters
      </button>
    </div>
  {:else}
    <!-- Courses Cards Grid (like /schedules) -->
    <div class="grid gap-4 sm:grid-cols-2">
      {#each courseCards as card (card.courseId)}
        <div class="rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 space-y-4 shadow-2xs flex flex-col justify-between">
          <div class="space-y-3">
            <!-- Course Card Header -->
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <button
                  type="button"
                  onclick={() => goto(`/courses/${card.courseId.toLowerCase()}`)}
                  class="text-sm font-semibold text-stone-900 dark:text-stone-100 hover:underline truncate block text-left cursor-pointer"
                >
                  {card.courseTitle}
                </button>
                <p class="text-[11px] text-stone-400">
                  <span class="font-mono uppercase tracking-wide">{card.courseId}</span>
                </p>
              </div>

              <!-- Course Notes Count -->
              {#if card.checkpoints.length > 0}
                <span class="text-xs text-stone-500 dark:text-stone-400 shrink-0">
                  {card.checkpoints.length} {card.checkpoints.length === 1 ? 'note' : 'notes'}
                </span>
              {/if}
            </div>

            <!-- Checkpoints list inside course card (scrollable if too many items, sorted newest to oldest) -->
            {#if card.filteredCheckpoints.length === 0}
              <p class="text-xs text-stone-400 dark:text-stone-500 italic py-2">
                {card.checkpoints.length === 0 ? 'No checkpoints yet.' : 'No matching checkpoints.'}
              </p>
            {:else}
              <div class="max-h-60 overflow-y-auto space-y-1.5 pr-1 focus:outline-hidden">
                {#each card.filteredCheckpoints as cp (cp.id)}
                  {@const color = getCheckpointColor(cp.color)}
                  {@const href = getCheckpointHref(card.courseId, cp)}
                  {@const shortLabel = getShortFileLabel(cp.file)}
                  {@const fullLabel = getFullFileLabel(cp.file)}

                  <div
                    class="group flex items-center justify-between p-1.5 -mx-1.5 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800/70 transition cursor-pointer gap-2"
                    onclick={() => goto(href)}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goto(href); } }}
                    role="button"
                    tabindex="0"
                  >
                    <!-- Book icon (markup) or Color-dot (note) and small font part of written text -->
                    <div class="flex items-center space-x-2 min-w-0 flex-1">
                      {#if cp.type === 'markup'}
                        <span class="shrink-0 flex items-center justify-center" title="PDF Annotations">
                          <BookOpen class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                        </span>
                      {:else}
                        <span
                          class="w-2.5 h-2.5 rounded-full shrink-0 shadow-2xs ring-1 ring-black/10 dark:ring-white/10"
                          style="background-color: {color.dot};"
                          title={color.label}
                        ></span>
                      {/if}

                      <!-- Short Lesson / Tab / Page Tag -->
                      {#if shortLabel}
                        <span class="font-mono text-[10px] px-1.5 py-0.2 rounded bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 shrink-0 border border-stone-200/60 dark:border-stone-700/60">
                          {shortLabel}
                        </span>
                      {/if}

                      <!-- Written Text (small font, truncated snippet, no date) -->
                      <span
                        class="text-xs text-stone-700 dark:text-stone-300 group-hover:text-stone-900 dark:group-hover:text-stone-100 truncate flex-1 min-w-0"
                        title="{fullLabel}: {cp.noteText || '(no note text)'}"
                      >
                        {cp.noteText || fullLabel}
                      </span>
                    </div>

                    <!-- Quick Delete Action on hover -->
                    <button
                      type="button"
                      onclick={(e) => {
                        e.stopPropagation();
                        handleDelete(card.courseId, cp.id);
                      }}
                      disabled={deletingId === cp.id}
                      title="Delete checkpoint"
                      aria-label="Delete checkpoint"
                      class="opacity-0 group-hover:opacity-100 p-1 text-stone-400 hover:text-rose-600 dark:hover:text-rose-400 rounded transition cursor-pointer shrink-0"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</main>
