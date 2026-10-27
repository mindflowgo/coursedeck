<script lang="ts">
  import type { CourseManifest } from '$lib/parser/courseIngest';
  import { ChevronDown, Check, Search, FileText, Bookmark, Layers, GraduationCap } from 'lucide-svelte';
  import { isCourseTab, isUnitScopeId, parseUnitNumber, formatUnitScopeId } from '$lib/tabs';

  interface Props {
    course: CourseManifest;
    selectedLessonId: string;
    activeTab?: string;
    onSelectLesson: (lessonId: string) => void;
  }

  let {
    course,
    selectedLessonId,
    activeTab = 'lesson',
    onSelectLesson
  }: Props = $props();

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

  let isUnitMode = $derived(
    isUnitScopeId(selectedLessonId)
  );

  let currentUnitNumber = $derived(
    parseUnitNumber(selectedLessonId)
  );

  let currentUnit = $derived(
    currentUnitNumber !== null
      ? course.units.find((u) => u.number === currentUnitNumber) || null
      : null
  );

  function toggleDropdown() {
    isOpen = !isOpen;
    if (isOpen) searchQuery = '';
  }

  function selectAndClose(id: string) {
    console.log(`[NAV] dropdown pick "${id}" (current "${selectedLessonId}")`);
    onSelectLesson(id);
    isOpen = false;
  }

  function matchesUnitItem(query: string): boolean {
    const q = query.toLowerCase().trim();
    if (!q) return true;
    return (
      'unit test / assignment'.includes(q) ||
      'unit test'.includes(q) ||
      'assignment'.includes(q) ||
      'test'.includes(q) ||
      'unit'.includes(q)
    );
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
      .filter((u) => u.lessons.length > 0 || matchesUnitItem(searchQuery))
  );
</script>

<div class="relative flex items-center space-x-1.5 text-xs">
  <!-- Dropdown Trigger -->
  <div class="relative">
    <button
      onclick={toggleDropdown}
      class="flex items-center space-x-2 px-2.5 sm:px-3 py-1.5 rounded border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-stone-800 dark:text-stone-100 font-medium transition shadow-2xs max-w-[155px] min-[390px]:max-w-[190px] xs:max-w-[250px] sm:max-w-md"
    >
      {#if selectedLessonId === 'course'}
        <GraduationCap class="w-3.5 h-3.5 text-stone-700 dark:text-stone-300 shrink-0" />
        <span class="truncate">Course Wide</span>
      {:else if isUnitMode && currentUnit}
        <Layers class="w-3.5 h-3.5 text-stone-700 dark:text-stone-300 shrink-0" />
        <span class="truncate">Unit {currentUnit.number}: Unit Test / Assignment</span>
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
        class="fixed inset-0 z-40"
        onclick={() => (isOpen = false)}
        role="presentation"
      ></div>

      <div class="absolute left-0 mt-1 w-80 sm:w-96 max-w-[calc(100vw-16px)] rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 overflow-hidden flex flex-col max-h-[480px]">
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

        <!-- Course Wide option -->
        <div class="p-1 border-b border-stone-100 dark:border-stone-800">
          <button
            type="button"
            onclick={() => selectAndClose('course')}
            class="w-full text-left px-2.5 py-1.5 rounded flex items-center justify-between text-xs transition cursor-pointer {selectedLessonId === 'course' ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-medium' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
          >
            <div class="flex items-center space-x-2 truncate pr-2">
              <span class="text-[10px] px-1.5 py-0.5 rounded font-mono uppercase font-semibold {selectedLessonId === 'course' ? 'bg-indigo-800 text-indigo-200 dark:bg-indigo-300 dark:text-indigo-950' : 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-800 dark:text-indigo-300'}">
                Course
              </span>
              <span class="truncate font-medium">Course Wide (Tests & Logs)</span>
            </div>
            {#if selectedLessonId === 'course'}
              <Check class="w-3.5 h-3.5 shrink-0" />
            {/if}
          </button>
        </div>

        <!-- Lessons list by Unit -->
        <div class="overflow-y-auto divide-y divide-stone-100 dark:divide-stone-800/60 p-1">
          {#each filteredUnits as unit}
            {@const unitScopeId = formatUnitScopeId(unit.number)}
            {@const isUnitSelected = selectedLessonId === unitScopeId}
            <div class="py-1">
              <!-- Unit Section Header (Static, non-clickable) -->
              <div class="px-2.5 py-1.5 flex items-center space-x-1.5 text-stone-500 dark:text-stone-400 select-none">
                <Layers class="w-3.5 h-3.5 shrink-0 text-stone-400 dark:text-stone-500" />
                <span class="text-[11px] font-semibold uppercase tracking-wider truncate">
                  Unit {unit.number}: {unit.title}
                </span>
              </div>
              <div class="space-y-0.5 mt-0.5 pl-2">
                {#each unit.lessons as lesson}
                  {@const isSelected = lesson.id === selectedLessonId}
                  <button
                    type="button"
                    onclick={() => selectAndClose(lesson.id)}
                    class="w-full text-left px-2.5 py-1.5 rounded flex items-center justify-between text-xs transition cursor-pointer {isSelected ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-medium' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
                  >
                    <div class="flex items-center space-x-2 truncate pr-2">
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

                <!-- Unit Test / Assignment (after the last lesson) -->
                {#if matchesUnitItem(searchQuery)}
                  <button
                    type="button"
                    onclick={() => selectAndClose(unitScopeId)}
                    class="w-full text-left px-2.5 py-1.5 rounded flex items-center justify-between text-xs transition cursor-pointer {isUnitSelected ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-medium' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
                  >
                    <div class="flex items-center space-x-2 truncate pr-2">
                      <span class="text-[10px] px-1.5 py-0.5 rounded font-mono uppercase font-semibold {isUnitSelected ? 'bg-amber-800 text-amber-200 dark:bg-amber-300 dark:text-amber-950' : 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300'}">
                        Unit
                      </span>
                      <span class="truncate font-medium">Unit Test / Assignment</span>
                    </div>
                    {#if isUnitSelected}
                      <Check class="w-3.5 h-3.5 shrink-0" />
                    {/if}
                  </button>
                {/if}
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
</div>
