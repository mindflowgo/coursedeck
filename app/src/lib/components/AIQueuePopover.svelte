<script lang="ts">
  import { apiFetch } from '$lib/api';
  import { queueStatus } from '$lib/queueStatus.svelte';
  import { onMount, onDestroy } from 'svelte';
  import {
    Sparkles,
    Loader2,
    CheckCircle2,
    AlertCircle,
    Clock,
    Pause,
    Play,
    X,
    RotateCcw,
    Trash2
  } from 'lucide-svelte';
  import Elapsed from './Elapsed.svelte';
  import type { GenerationTask } from '$lib/server/queue';

  interface Props {
    courseId?: string;
    /** Called when a generation task for this course finishes so the page can refresh that lesson. */
    onLessonUpdated?: (lessonId: string, tab: string) => void;
  }

  let { courseId = '', onLessonUpdated }: Props = $props();

  let isOpen = $state(false);

  let releasePolling: (() => void) | null = null;
  let unsubscribeFinished: (() => void) | null = null;

  onMount(() => {
    // Shared poller: every consumer reads the same snapshot, so no duplicate requests.
    releasePolling = queueStatus.acquire();

    // Surface finished tasks to the hosting page (lesson content refresh).
    unsubscribeFinished = queueStatus.onTaskFinished((task: GenerationTask) => {
      if (task.status !== 'completed') return;
      if (courseId && task.courseId !== courseId.toLowerCase()) return;
      onLessonUpdated?.(task.lessonId, task.tab);
    });
  });

  onDestroy(() => {
    releasePolling?.();
    releasePolling = null;
    unsubscribeFinished?.();
    unsubscribeFinished = null;
  });

  let status = $derived(queueStatus.status);
  let reachable = $derived(queueStatus.reachable);

  // Scope counts to this course when the popover is mounted inside a course page.
  let scopedTasks = $derived.by(() => {
    if (!courseId) return status.tasks;
    const wanted = courseId.toLowerCase();
    return status.tasks.filter((t) => t.courseId === wanted);
  });

  let activeTask = $derived<GenerationTask | null>(status.activeTask);
  let pendingCount = $derived(scopedTasks.filter((t) => t.status === 'pending').length);
  let completedCount = $derived(scopedTasks.filter((t) => t.status === 'completed').length);
  let failedCount = $derived(scopedTasks.filter((t) => t.status === 'failed').length);
  let isGenerating = $derived(activeTask !== null);
  let totalGeneratingCount = $derived.by(() => {
    const activeCount = activeTask ? (courseId ? (activeTask.courseId === courseId.toLowerCase() ? 1 : 0) : 1) : 0;
    const total = activeCount + pendingCount;
    return total > 0 ? total : (activeTask ? 1 : 0);
  });
  let isBusy = $derived(status.pendingCount > 0 || activeTask !== null);

  let progressPercent = $derived.by(() => {
    const total = pendingCount + completedCount + (activeTask ? 1 : 0);
    if (total === 0) return 0;
    return Math.round((completedCount / total) * 100);
  });

  async function sendAction(action: 'pause' | 'resume' | 'cancel' | 'retry') {
    try {
      await apiFetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, courseId })
      });
      await queueStatus.refresh();
    } catch (e) {
      console.error('Queue action failed:', e);
    }
  }

  async function enqueueMissing() {
    if (!courseId) return;
    try {
      await apiFetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enqueue',
          courseId,
          tabs: ['summary', 'cheatsheet', 'test']
        })
      });
      await queueStatus.refresh();
    } catch (e) {
      console.error('Enqueue missing failed:', e);
    }
  }
</script>

<div class="relative shrink-0">
  <!-- Trigger Button in Header: grey, shows queue count beside icon when generating -->
  <button
    type="button"
    onclick={() => { isOpen = !isOpen; if (isOpen) queueStatus.refresh(); }}
    class="relative flex items-center justify-center h-10 sm:h-8 rounded-lg text-xs font-medium transition cursor-pointer text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 {isGenerating ? 'px-2.5 space-x-1.5' : 'w-10 sm:w-8'} {isOpen ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100' : ''}"
    title={isGenerating ? `Background AI Generation Queue (${totalGeneratingCount} active/queued)` : 'Background AI Generation Queue'}
    aria-label="Background AI Generation Queue"
    aria-expanded={isOpen}
  >
    {#if isGenerating}
      <Loader2 class="w-5 h-5 sm:w-4 sm:h-4 text-stone-600 dark:text-stone-300 animate-spin shrink-0" />
      <span
        class="inline-flex items-center justify-center min-w-[17px] h-4 px-1 text-[10px] font-bold rounded-full bg-stone-200 dark:bg-stone-700 text-stone-700 dark:text-stone-200 tabular-nums shadow-2xs"
      >
        {totalGeneratingCount}
      </span>
    {:else if !reachable}
      <AlertCircle class="w-5 h-5 sm:w-4 sm:h-4 text-rose-500 shrink-0" />
    {:else}
      <Sparkles class="w-5 h-5 sm:w-4 sm:h-4 text-stone-500 dark:text-stone-400 shrink-0" />
    {/if}
  </button>

  <!-- Popover Menu -->
  {#if isOpen}
    <div
      class="fixed inset-0 z-40"
      onclick={() => (isOpen = false)}
      aria-hidden="true"
    ></div>

    <div
      class="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-xl z-50 p-4 space-y-3 animate-in fade-in zoom-in-95 duration-150 text-xs"
    >
      <!-- Header -->
      <div class="flex items-center justify-between pb-2 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2">
          <div class="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400">
            <Sparkles class="w-4 h-4" />
          </div>
          <div>
            <h3 class="font-semibold text-stone-900 dark:text-stone-100">AI Generation Queue</h3>
            <p class="text-[11px] text-stone-400 dark:text-stone-500">
              {#if !reachable}
                Backend queue unreachable
              {:else if status.isPaused}
                Queue paused
              {:else if activeTask}
                Generating in background...
              {:else if pendingCount > 0}
                {pendingCount} tasks queued
              {:else}
                All tasks completed
              {/if}
            </p>
          </div>
        </div>

        <button
          onclick={() => (isOpen = false)}
          class="p-1 rounded-md text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      {#if !reachable}
        <div class="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200/60 dark:border-rose-800/60 text-[11px] text-rose-800 dark:text-rose-200 leading-relaxed">
          Could not reach the background queue, so live status is unavailable. Check that the local backend is running.
        </div>
      {/if}

      <!-- Active Task Card -->
      {#if activeTask}
        <div class="p-2.5 rounded-xl bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200/60 dark:border-amber-800/60 space-y-1.5">
          <div class="flex items-center justify-between text-[11px] font-medium text-amber-800 dark:text-amber-300">
            <div class="flex items-center space-x-1.5">
              <Loader2 class="w-3.5 h-3.5 animate-spin text-amber-600 dark:text-amber-400" />
              <span>Generating {activeTask.tab.replace(/-\d+$/, '').toUpperCase()}</span>
            </div>
            <span class="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-200/60 dark:bg-amber-900/60 text-amber-900 dark:text-amber-200">
              Active
            </span>
          </div>
          <p class="text-xs font-semibold text-stone-900 dark:text-stone-100 truncate">
            {#if !courseId}{activeTask.courseId.toUpperCase()} · {/if}{activeTask.tab === 'schedule' ? 'Course Schedule' : `${activeTask.lessonId} — ${activeTask.lessonTitle}`}
          </p>
        </div>
      {/if}

      <!-- Progress Stats -->
      {#if pendingCount > 0 || completedCount > 0}
        <div class="space-y-1">
          <div class="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400">
            <span>Progress ({completedCount} completed)</span>
            <span class="font-semibold text-stone-800 dark:text-stone-200">{pendingCount} remaining</span>
          </div>
          <div class="w-full h-1.5 bg-stone-100 dark:bg-stone-800 rounded-full overflow-hidden">
            <div
              class="h-full bg-amber-500 rounded-full transition-all duration-300"
              style="width: {progressPercent}%"
            ></div>
          </div>
        </div>
      {/if}

      <!-- Queue Controls Toolbar -->
      <div class="flex items-center justify-between pt-1 text-[11px]">
        <div class="flex items-center space-x-1.5">
          {#if status.isPaused}
            <button
              onclick={() => sendAction('resume')}
              class="flex items-center space-x-1 px-2.5 py-1 rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 font-medium transition cursor-pointer"
            >
              <Play class="w-3 h-3" />
              <span>Resume</span>
            </button>
          {:else if isBusy}
            <button
              onclick={() => sendAction('pause')}
              class="flex items-center space-x-1 px-2.5 py-1 rounded-md border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700 font-medium transition cursor-pointer"
            >
              <Pause class="w-3 h-3" />
              <span>Pause</span>
            </button>
          {/if}

          {#if failedCount > 0}
            <button
              onclick={() => sendAction('retry')}
              class="flex items-center space-x-1 px-2 py-1 rounded-md border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/50 font-medium transition cursor-pointer"
            >
              <RotateCcw class="w-3 h-3" />
              <span>Retry ({failedCount})</span>
            </button>
          {/if}

          {#if pendingCount > 0}
            <button
              onclick={() => sendAction('cancel')}
              class="flex items-center space-x-1 px-2 py-1 rounded-md border border-stone-200 dark:border-stone-700 text-stone-500 dark:text-stone-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition cursor-pointer"
              title="Cancel all pending tasks"
            >
              <Trash2 class="w-3 h-3" />
              <span>Cancel</span>
            </button>
          {/if}
        </div>

        {#if courseId && pendingCount === 0 && !activeTask}
          <button
            onclick={enqueueMissing}
            class="flex items-center space-x-1 text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 font-medium cursor-pointer"
          >
            <Sparkles class="w-3 h-3" />
            <span>Generate Missing</span>
          </button>
        {/if}
      </div>

      <!-- Recent / Queued Tasks List -->
      {#if scopedTasks.length > 0}
        <div class="max-h-48 overflow-y-auto divide-y divide-stone-100 dark:divide-stone-800 border-t border-stone-100 dark:border-stone-800 pt-2 space-y-1">
          {#each scopedTasks.slice(0, 15) as task (task.id)}
            <div class="py-1.5 px-1 text-[11px]">
              <div class="flex items-center justify-between">
                <div class="flex items-center space-x-2 min-w-0 pr-2">
                  {#if task.status === 'processing'}
                    <Loader2 class="w-3.5 h-3.5 animate-spin text-amber-500 shrink-0" />
                  {:else if task.status === 'completed'}
                    <CheckCircle2 class="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  {:else if task.status === 'failed'}
                    <AlertCircle class="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  {:else}
                    <Clock class="w-3.5 h-3.5 text-stone-400 dark:text-stone-500 shrink-0" />
                  {/if}

                  <span class="truncate font-medium text-stone-700 dark:text-stone-300">
                    {#if !courseId}{task.courseId.toUpperCase()} · {/if}{task.tab === 'schedule' ? 'Course Schedule' : task.lessonId}
                  </span>

                  <span class="uppercase text-[9px] font-semibold px-1 py-0.2 rounded bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 shrink-0">
                    {task.tab.replace(/-\d+$/, '')}
                  </span>
                  {#if /-\d+$/.test(task.tab)}
                    <span class="text-[9px] font-semibold px-1 py-0.2 rounded bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 shrink-0">
                      v{task.tab.split('-').pop()}
                    </span>
                  {/if}
                </div>

                <div class="shrink-0 text-[10px] text-stone-400 dark:text-stone-500 flex items-center space-x-1">
                  {#if task.status === 'processing'}
                    <span class="text-amber-600 dark:text-amber-400 font-medium">Running</span>
                    <Elapsed since={task.startedAt} />
                  {:else if task.status === 'completed'}
                    <span class="text-emerald-600 dark:text-emerald-400 font-medium">Done</span>
                  {:else if task.status === 'failed'}
                    <span class="text-rose-600 dark:text-rose-400 font-medium">Failed</span>
                  {:else}
                    <span>Pending</span>
                  {/if}
                </div>
              </div>

              {#if task.status === 'failed' && task.error}
                <div class="mt-1 text-[10px] text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/50 border border-rose-100 dark:border-rose-900 p-1.5 rounded font-mono break-all leading-tight">
                  {task.error}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="py-4 text-center text-stone-400 dark:text-stone-500 text-[11px]">
          No active or pending AI generation tasks.
        </div>
      {/if}
    </div>
  {/if}
</div>
