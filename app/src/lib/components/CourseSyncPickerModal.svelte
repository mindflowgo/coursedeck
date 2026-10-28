<!-- CourseSyncPickerModal: choose which desktop courses to sync onto this device -->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    syncState,
    syncFromDesktop,
    pushToDesktop,
    fetchDesktopCourses,
    type DesktopCourseSummary
  } from '$lib/syncState.svelte';
  import { listCachedCourses } from '$lib/storage/clientStore';
  import { confirmDialog } from '$lib/dialog';
  import { RefreshCw, X, Download, BookOpen, FileText, Monitor, Loader2 } from 'lucide-svelte';

  let { onClose }: { onClose: () => void } = $props();

  let courses = $state<DesktopCourseSummary[] | null>(null);
  let loadError = $state<string | null>(null);
  let syncError = $state<string | null>(null);
  let selected = $state<Record<string, boolean>>({});
  let onDevice = $state<Set<string>>(new Set());

  const selectedIds = $derived(Object.entries(selected).filter(([, v]) => v).map(([id]) => id));
  const allSelected = $derived(
    courses !== null && courses.length > 0 && selectedIds.length === courses.length
  );

  onMount(() => {
    load();
  });

  async function load() {
    loadError = null;
    try {
      const [list, cached] = await Promise.all([fetchDesktopCourses(), listCachedCourses()]);
      courses = list;
      onDevice = new Set(cached.map((c) => c.id.toLowerCase()));
      const next: Record<string, boolean> = {};
      for (const course of list) next[course.id] = true;
      selected = next;
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Could not reach the desktop app';
    }
  }

  function toggle(id: string) {
    if (syncState.isSyncing) return;
    selected[id] = !selected[id];
  }

  function toggleAll() {
    if (syncState.isSyncing || !courses) return;
    const shouldSelect = !allSelected;
    const next: Record<string, boolean> = {};
    for (const c of courses) {
      next[c.id] = shouldSelect;
    }
    selected = next;
  }

  async function handleSync() {
    if (syncState.isSyncing || selectedIds.length === 0) return;

    if (syncState.pendingPushCount > 0) {
      const proceed = await confirmDialog(
        `You have ${syncState.pendingPushCount} note or checkpoint change(s) that haven't been pushed to your computer yet.\n\nSyncing now will replace local data with the computer's current copy. Would you like to push your changes first?`,
        'Sync Warning'
      );
      if (proceed) {
        try {
          await pushToDesktop();
        } catch {
          return;
        }
      }
    }

    syncError = null;
    try {
      await syncFromDesktop({ courseIds: selectedIds });
      onClose();
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch (e) {
      syncError = e instanceof Error ? e.message : 'Sync failed';
    }
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
  <!-- Backdrop -->
  <div
    class="absolute inset-0 bg-stone-950/50 backdrop-blur-sm"
    onclick={onClose}
    aria-hidden="true"
  ></div>

  <div
    class="relative w-full max-w-sm max-h-[80vh] flex flex-col rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
  >
    <!-- Header -->
    <div class="flex items-center space-x-2.5 px-4 py-3 border-b border-stone-200 dark:border-stone-800">
      <Monitor class="w-4 h-4 text-stone-500 dark:text-stone-400 shrink-0" />
      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">Choose Courses</h2>
        <p class="text-[11px] text-stone-500 dark:text-stone-400">
          Pick which courses to download from your computer
        </p>
      </div>
      <button
        type="button"
        onclick={onClose}
        aria-label="Close"
        class="p-1.5 rounded-lg text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-700 dark:hover:text-stone-200 transition cursor-pointer"
      >
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto p-2">
      {#if courses !== null && courses.length > 0}
        <div class="flex items-center justify-between px-2 pb-1.5 text-xs text-stone-500 dark:text-stone-400">
          <span>{selectedIds.length} of {courses.length} selected</span>
          <button
            type="button"
            onclick={toggleAll}
            class="font-medium text-amber-600 dark:text-amber-400 hover:underline cursor-pointer"
          >
            {allSelected ? 'Deselect All' : 'Select All'}
          </button>
        </div>
      {/if}

      {#if courses === null && !loadError}
        <div class="py-10 flex flex-col items-center justify-center space-y-3">
          <Loader2 class="w-6 h-6 animate-spin text-stone-400" />
          <p class="text-xs text-stone-500 dark:text-stone-400">Loading courses from desktop...</p>
        </div>
      {:else if loadError}
        <div class="py-8 px-4 flex flex-col items-center justify-center space-y-3 text-center">
          <p class="text-xs text-red-600 dark:text-red-400">{loadError}</p>
          <p class="text-[11px] text-stone-500 dark:text-stone-400">
            Make sure the desktop app is open on the same Wi-Fi.
          </p>
          <button
            type="button"
            onclick={load}
            class="px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Try Again
          </button>
        </div>
      {:else if courses !== null && courses.length === 0}
        <div class="py-8 px-4 text-center">
          <p class="text-xs text-stone-500 dark:text-stone-400">No courses found on your desktop.</p>
        </div>
      {:else if courses !== null}
        {#each courses as course (course.id)}
          <button
            type="button"
            onclick={() => toggle(course.id)}
            class="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-left hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            <span
              class="w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition
                {selected[course.id]
                  ? 'bg-stone-900 dark:bg-stone-100 border-stone-900 dark:border-stone-100'
                  : 'border-stone-300 dark:border-stone-600'}"
            >
              {#if selected[course.id]}
                <svg class="w-3 h-3 text-white dark:text-stone-900" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              {/if}
            </span>

            <span class="flex-1 min-w-0">
              <span class="block text-xs font-medium text-stone-900 dark:text-stone-100 truncate">
                {course.title}
              </span>
              <span class="flex items-center gap-2 text-[10px] text-stone-500 dark:text-stone-400 mt-0.5">
                <span class="inline-flex items-center gap-1">
                  <BookOpen class="w-3 h-3" />
                  {course.lessonCount} lesson{course.lessonCount === 1 ? '' : 's'}
                </span>
                {#if course.coursePDF}
                  <span class="inline-flex items-center gap-1">
                    <FileText class="w-3 h-3" /> Textbook
                  </span>
                {/if}
                {#if onDevice.has(course.id)}
                  <span class="text-emerald-600 dark:text-emerald-400 font-medium">On device</span>
                {/if}
              </span>
            </span>
          </button>
        {/each}
      {/if}
    </div>

    <!-- Footer -->
    {#if courses !== null && courses.length > 0}
      <div class="px-4 py-3 border-t border-stone-200 dark:border-stone-800 space-y-2">
        {#if syncError}
          <p class="text-[11px] text-red-600 dark:text-red-400 text-center">{syncError}</p>
        {/if}
        <div class="flex space-x-2">
          <button
            type="button"
            onclick={onClose}
            disabled={syncState.isSyncing}
            class="flex-1 py-2.5 rounded-xl border border-stone-200 dark:border-stone-700 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onclick={handleSync}
            disabled={syncState.isSyncing || selectedIds.length === 0}
            class="flex-1 py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center space-x-2 disabled:opacity-50"
          >
            {#if syncState.isSyncing}
              <RefreshCw class="w-4 h-4 animate-spin" />
              <span>Syncing...</span>
            {:else}
              <Download class="w-4 h-4" />
              <span>Sync {selectedIds.length} course{selectedIds.length === 1 ? '' : 's'}</span>
            {/if}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>
