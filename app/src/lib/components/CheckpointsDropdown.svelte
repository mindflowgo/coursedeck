<script lang="ts">
  import type { CourseManifest, CourseManifestLesson } from '$lib/parser/courseIngest';
  import { CHECKPOINT_COLORS, CURRENT_CHECKPOINT_COLOR, MAX_FLAGS_SHOWN, getCheckpointColor } from '$lib/checkpoints';
  import type { Checkpoint, StudyState } from '$lib/studyStateTypes';
  import {
    ChevronDown,
    ChevronRight,
    Check,
    Flag,
    Pencil,
    Trash2
  } from 'lucide-svelte';

  interface Props {
    course: CourseManifest;
    studyState: StudyState | null;
    currentLessonId: string | null;
    onNavigate: (lessonId: string) => void;
    onRenameCheckpoint: (id: string, label: string) => Promise<boolean>;
    onRecolorCheckpoint: (id: string, color: string) => void;
    onDeleteCheckpoint: (id: string) => void;
    onRenameCurrent: (label: string) => Promise<boolean>;
  }

  let {
    course,
    studyState,
    currentLessonId,
    onNavigate,
    onRenameCheckpoint,
    onRecolorCheckpoint,
    onDeleteCheckpoint,
    onRenameCurrent
  }: Props = $props();

  let isOpen = $state(false);
  let expandedLessonId = $state<string | null>(null);
  let editingId = $state<string | null>(null);
  let editingValue = $state('');
  let paletteId = $state<string | null>(null);

  let currentColor = $derived(getCheckpointColor(CURRENT_CHECKPOINT_COLOR));

  function findLesson(lessonId: string): CourseManifestLesson | null {
    for (const unit of course.units) {
      const found = unit.lessons.find((l) => l.id === lessonId);
      if (found) return found;
    }
    return null;
  }

  let currentLesson = $derived(currentLessonId ? findLesson(currentLessonId) : null);

  /** Lessons that carry at least one checkpoint, in course order. */
  let lessonGroups = $derived.by(() => {
    if (!studyState) return [] as { lesson: CourseManifestLesson; checkpoints: Checkpoint[] }[];
    const groups: { lesson: CourseManifestLesson; checkpoints: Checkpoint[] }[] = [];
    for (const unit of course.units) {
      for (const lesson of unit.lessons) {
        const checkpoints = studyState.checkpoints.filter((c) => c.lessonId === lesson.id);
        if (checkpoints.length > 0) groups.push({ lesson, checkpoints });
      }
    }
    return groups;
  });

  let totalCount = $derived(lessonGroups.length + (currentLessonId ? 1 : 0));

  function toggle() {
    isOpen = !isOpen;
    if (!isOpen) {
      expandedLessonId = null;
      editingId = null;
      paletteId = null;
    }
  }

  function beginEdit(id: string, value: string) {
    editingId = id;
    editingValue = value;
    paletteId = null;
  }

  async function commitEdit() {
    const id = editingId;
    if (!id) return;
    const value = editingValue.trim();
    editingId = null;
    if (!value) return;
    if (id === '__current__') {
      await onRenameCurrent(value);
    } else {
      await onRenameCheckpoint(id, value);
    }
  }

  function openLesson(lessonId: string) {
    onNavigate(lessonId);
    isOpen = false;
  }
</script>

<div class="relative flex items-center text-xs">
  <button
    onclick={toggle}
    class="flex items-center space-x-2 px-3 py-1.5 rounded border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-800 dark:text-stone-100 font-medium transition shadow-2xs"
    title="Checkpoints — jump to a flagged lesson or location"
  >
    <Flag class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
    <span>Checkpoints</span>
    {#if totalCount > 0}
      <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 dark:bg-stone-700 text-stone-600 dark:text-stone-300 font-mono">{totalCount}</span>
    {/if}
    <ChevronDown class="w-3.5 h-3.5 text-stone-400 dark:text-stone-500 shrink-0" />
  </button>

  {#if isOpen}
    <div class="fixed inset-0 z-30" onclick={() => (isOpen = false)} role="presentation"></div>

    <div class="absolute left-0 mt-1 w-80 sm:w-96 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-40 overflow-hidden flex flex-col max-h-[480px]">
      {#if totalCount === 0}
        <div class="p-4 text-center text-xs text-stone-400 dark:text-stone-500">
          No checkpoints yet. Use <span class="font-medium">Add Checkpoint</span> to flag a lesson or location.
        </div>
      {:else}
        <!-- Current checkpoint -->
        {#if currentLesson}
          <div class="p-1 border-b border-stone-100 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950">
            <div class="w-full px-2.5 py-1.5 rounded flex items-center justify-between text-xs">
              <div class="flex items-center space-x-2 truncate pr-2 min-w-0">
                <Flag class="w-3.5 h-3.5 shrink-0 {currentColor.flag}" />
                <div class="min-w-0">
                  {#if editingId === '__current__'}
                    <input
                      class="w-full bg-transparent border-b border-stone-300 dark:border-stone-600 text-xs focus:outline-none"
                      bind:value={editingValue}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') commitEdit();
                        if (e.key === 'Escape') editingId = null;
                      }}
                      onblur={commitEdit}
                    />
                  {:else}
                    <div class="text-[11px] font-medium text-stone-900 dark:text-stone-100 truncate">
                      {studyState?.currentLabel || 'Current'}
                    </div>
                    <div class="text-[10px] text-stone-400 dark:text-stone-500 truncate">
                      {currentLesson.id} · {currentLesson.title}
                    </div>
                  {/if}
                </div>
              </div>
              <div class="flex items-center space-x-0.5 shrink-0">
                <button
                  onclick={() => beginEdit('__current__', studyState?.currentLabel || 'Current')}
                  class="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
                  title="Rename the Current checkpoint"
                >
                  <Pencil class="w-3 h-3" />
                </button>
                <button
                  onclick={() => openLesson(currentLesson!.id)}
                  class="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
                  title="Go to this lesson"
                >
                  <ChevronRight class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        {/if}

        <!-- Lessons with checkpoints -->
        <div class="overflow-y-auto divide-y divide-stone-100 dark:divide-stone-800/60 p-1">
          {#each lessonGroups as group (group.lesson.id)}
            {@const expanded = expandedLessonId === group.lesson.id}
            <div class="py-0.5">
              <div class="w-full px-2.5 py-1.5 rounded flex items-center justify-between text-xs hover:bg-stone-100 dark:hover:bg-stone-800 transition">
                <button
                  type="button"
                  onclick={() => openLesson(group.lesson.id)}
                  class="flex items-center space-x-1.5 truncate pr-2 min-w-0 cursor-pointer"
                >
                  {#each group.checkpoints.slice(0, MAX_FLAGS_SHOWN) as checkpoint (checkpoint.id)}
                    <Flag class="w-3.5 h-3.5 shrink-0 {getCheckpointColor(checkpoint.color).flag}" />
                  {/each}
                  <span class="truncate text-stone-700 dark:text-stone-300">{group.lesson.title}</span>
                </button>
                <button
                  type="button"
                  onclick={() => (expandedLessonId = expanded ? null : group.lesson.id)}
                  class="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition cursor-pointer shrink-0"
                  title={expanded ? 'Hide checkpoints' : 'Show checkpoints'}
                >
                  {#if expanded}
                    <ChevronDown class="w-3.5 h-3.5" />
                  {:else}
                    <ChevronRight class="w-3.5 h-3.5" />
                  {/if}
                </button>
              </div>

              {#if expanded}
                <div class="pl-7 pr-2 pb-1.5 space-y-1.5">
                  {#each group.checkpoints as checkpoint (checkpoint.id)}
                    <div class="space-y-1">
                      <div class="flex items-center space-x-1.5 text-[11px]">
                        <Flag class="w-3 h-3 shrink-0 {getCheckpointColor(checkpoint.color).flag}" />
                        {#if editingId === checkpoint.id}
                          <input
                            class="flex-1 bg-transparent border-b border-stone-300 dark:border-stone-600 focus:outline-none"
                            bind:value={editingValue}
                            onkeydown={(e) => {
                              if (e.key === 'Enter') commitEdit();
                              if (e.key === 'Escape') editingId = null;
                            }}
                            onblur={commitEdit}
                          />
                        {:else}
                          <span class="flex-1 truncate text-stone-700 dark:text-stone-300">{checkpoint.label}</span>
                          <span class="text-[10px] text-stone-400 dark:text-stone-500 shrink-0">
                            {checkpoint.kind === 'location' ? 'location' : 'lesson'}
                          </span>
                        {/if}
                        <button
                          onclick={() => {
                            paletteId = paletteId === checkpoint.id ? null : checkpoint.id;
                            editingId = null;
                          }}
                          class="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700 transition cursor-pointer shrink-0"
                          title="Change colour"
                        >
                          <span class="block w-3 h-3 rounded-full {getCheckpointColor(checkpoint.color).dot}"></span>
                        </button>
                        <button
                          onclick={() => beginEdit(checkpoint.id, checkpoint.label)}
                          class="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700 transition cursor-pointer shrink-0"
                          title="Rename"
                        >
                          <Pencil class="w-3 h-3" />
                        </button>
                        <button
                          onclick={() => onDeleteCheckpoint(checkpoint.id)}
                          class="p-1 rounded text-stone-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-stone-100 dark:hover:bg-stone-700 transition cursor-pointer shrink-0"
                          title="Delete"
                        >
                          <Trash2 class="w-3 h-3" />
                        </button>
                      </div>

                      {#if paletteId === checkpoint.id}
                        <div class="flex flex-wrap gap-1.5 pl-4">
                          {#each CHECKPOINT_COLORS as option (option.id)}
                            <button
                              type="button"
                              onclick={() => {
                                onRecolorCheckpoint(checkpoint.id, option.id);
                                paletteId = null;
                              }}
                              class="relative w-4 h-4 rounded-full {option.swatch} ring-offset-1 ring-offset-white dark:ring-offset-stone-900 cursor-pointer {checkpoint.color === option.id ? `ring-2 ${option.ring}` : 'hover:scale-110'}"
                              title={option.label}
                              aria-label={option.label}
                            >
                              {#if checkpoint.color === option.id}
                                <Check class="absolute inset-0 m-auto w-2.5 h-2.5 text-white" />
                              {/if}
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
