<script lang="ts">
  import type { CourseManifest } from '$lib/parser/courseIngest';
  import { ChevronRight, ChevronDown, Check, Search, FileText, Bookmark, GraduationCap, Flag } from 'lucide-svelte';
  import { isCourseTab } from '$lib/tabs';
  import { MAX_FLAGS_SHOWN, CURRENT_CHECKPOINT_COLOR, getCheckpointColor } from '$lib/checkpoints';
  import type { Checkpoint } from '$lib/studyStateTypes';

  interface Props {
    course: CourseManifest;
    selectedLessonId: string;
    activeTab?: string;
    isCourseMode?: boolean;
    /** Every checkpoint for this course; lesson-level ones are flagged in the list. */
    checkpoints?: Checkpoint[];
    /** Lesson the auto "Current" checkpoint points at. */
    currentLessonId?: string | null;
    onSelectLesson: (lessonId: string) => void;
    onSelectCourseMode?: () => void;
  }

  let {
    course,
    selectedLessonId,
    activeTab = 'lesson',
    isCourseMode = false,
    checkpoints = [],
    currentLessonId = null,
    onSelectLesson,
    onSelectCourseMode
  }: Props = $props();

  let currentColor = $derived(getCheckpointColor(CURRENT_CHECKPOINT_COLOR));

  function flagsForLesson(lessonId: string): Checkpoint[] {
    return checkpoints.filter((c) => c.lessonId === lessonId).slice(0, MAX_FLAGS_SHOWN);
  }

  let isOpen = $state(false);
  let searchQuery = $state('');

  // Flatten lessons for previous / next navigation
  let allLessons = $derived(
    course.units.flatMap((u) => u.lessons)
  );

  let currentIndex = $derived(
    allLessons.findIndex((l) => l.id === selectedLessonId)
  );

  let currentLesson = $derived(
    currentIndex !== -1 ? allLessons[currentIndex] : allLessons[0]
  );

  let hasNext = $derived(currentIndex < allLessons.length - 1 && currentIndex !== -1);

  function nextLesson() {
    if (hasNext) {
      onSelectLesson(allLessons[currentIndex + 1].id);
    }
  }

  function toggleDropdown() {
    isOpen = !isOpen;
    if (isOpen) searchQuery = '';
  }

  function selectAndClose(id: string) {
    console.log(`[NAV] dropdown pick "${id}" (current "${selectedLessonId}")`);
    onSelectLesson(id);
    isOpen = false;
  }

  // Filtered units based on search
  let filteredUnits = $derived(
    course.units
      .map((u) => ({
        ...u,
        lessons: u.lessons.filter((l) =>
          l.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          l.id.includes(searchQuery)
        )
      }))
      .filter((u) => u.lessons.length > 0)
  );
</script>

<div class="relative flex items-center space-x-1.5 text-xs">
  <!-- Dropdown Trigger -->
  <div class="relative">
    <button
      onclick={toggleDropdown}
      class="flex items-center space-x-2 px-3 py-1.5 rounded border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-800 dark:text-stone-100 font-medium transition shadow-2xs max-w-[280px] sm:max-w-md"
    >
      {#if isCourseMode}
        <GraduationCap class="w-3.5 h-3.5 text-stone-700 dark:text-stone-300 shrink-0" />
        <span class="truncate">Complete Course</span>
      {:else}
        {#if currentLesson?.type === 'assignment'}
          <Bookmark class="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
        {:else}
          <FileText class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
        {/if}
        <span class="truncate">
          {currentLesson ? currentLesson.title : 'Select a lesson'}
        </span>
      {/if}
      <ChevronDown class="w-3.5 h-3.5 text-stone-400 dark:text-stone-500 shrink-0 ml-1" />
    </button>

    <!-- Dropdown Menu -->
    {#if isOpen}
      <div
        class="fixed inset-0 z-30"
        onclick={() => (isOpen = false)}
        role="presentation"
      ></div>

      <div class="absolute left-0 mt-1 w-80 sm:w-96 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-40 overflow-hidden flex flex-col max-h-[480px]">
        <!-- Complete Course Option -->
        <div class="p-1 border-b border-stone-100 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950">
          <button
            type="button"
            onclick={() => {
              if (onSelectCourseMode) onSelectCourseMode();
              isOpen = false;
            }}
            class="w-full text-left px-2.5 py-1.5 rounded flex items-center justify-between text-xs transition cursor-pointer {isCourseMode ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-medium' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
          >
            <div class="flex items-center space-x-2 truncate pr-2">
              <GraduationCap class="w-3.5 h-3.5 shrink-0 {isCourseMode ? 'text-white dark:text-stone-900' : 'text-stone-500 dark:text-stone-400'}" />
              <span class="font-medium">Complete Course</span>
            </div>
            {#if isCourseMode}
              <Check class="w-3.5 h-3.5 shrink-0" />
            {/if}
          </button>
        </div>

        <!-- Search bar -->
        <div class="p-2 border-b border-stone-100 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950 flex items-center space-x-2">
          <Search class="w-3.5 h-3.5 text-stone-400 dark:text-stone-500 shrink-0" />
          <input
            type="text"
            bind:value={searchQuery}
            placeholder="Search lessons..."
            class="w-full bg-transparent text-xs text-stone-800 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none"
          />
        </div>

        <!-- Lessons list by Unit -->
        <div class="overflow-y-auto divide-y divide-stone-100 dark:divide-stone-800/60 p-1">
          {#each filteredUnits as unit}
            <div class="py-1">
              <div class="px-2 py-1 text-[11px] font-semibold text-stone-400 dark:text-stone-500 uppercase tracking-wider">
                Unit {unit.number}: {unit.title}
              </div>
              <div class="space-y-0.5">
                {#each unit.lessons as lesson}
                  {@const isSelected = !isCourseMode && lesson.id === selectedLessonId}
                  <button
                    type="button"
                    onclick={() => selectAndClose(lesson.id)}
                    class="w-full text-left px-2.5 py-1.5 rounded flex items-center justify-between text-xs transition cursor-pointer {isSelected ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-medium' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
                  >
                    <div class="flex items-center space-x-2 truncate pr-2">
                      {#each flagsForLesson(lesson.id) as checkpoint (checkpoint.id)}
                        <Flag class="w-3.5 h-3.5 shrink-0 {getCheckpointColor(checkpoint.color).flag}" aria-label="Checkpoint" />
                      {/each}
                      {#if lesson.id === currentLessonId}
                        <Flag class="w-3.5 h-3.5 shrink-0 {currentColor.flag}" aria-label="Current checkpoint" />
                      {/if}
                      {#if lesson.type === 'assignment'}
                        <span class="text-[10px] px-1.5 py-0.5 rounded font-mono uppercase {isSelected ? 'bg-purple-800 text-purple-200 dark:bg-purple-300 dark:text-purple-950' : 'bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300'}">
                          Assign
                        </span>
                      {:else}
                        <span class="font-mono text-[11px] opacity-60">
                          {lesson.id}
                        </span>
                      {/if}
                      <span class="truncate">{lesson.title}</span>
                    </div>
                    {#if isSelected}
                      <Check class="w-3.5 h-3.5 shrink-0" />
                    {/if}
                  </button>
                {/each}
              </div>
            </div>
          {:else}
            <div class="p-4 text-center text-xs text-stone-400 dark:text-stone-500">
              No lessons match your search.
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Next Button (hidden in Complete Course mode) -->
  {#if !isCourseMode}
    <button
      onclick={nextLesson}
      disabled={!hasNext}
      title="Next lesson"
      class="p-1.5 rounded border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 disabled:opacity-30 disabled:cursor-not-allowed text-stone-700 dark:text-stone-300 transition"
    >
      <ChevronRight class="w-4 h-4" />
    </button>
  {/if}
</div>
