<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    BookOpen,
    Settings,
    GraduationCap,
    ChevronLeft,
    ChevronRight,
    CalendarDays,
    FlagTriangleRight,
    Tablet
  } from 'lucide-svelte';
  import AIQueuePopover from './AIQueuePopover.svelte';
  import DeviceSyncDropdown from './DeviceSyncDropdown.svelte';
  import { openConnectIpadModal } from '$lib/modalState.svelte';
  import { isMobileDevice } from '$lib/api';
  import { goBackOrHome } from '$lib/navHistory';

  interface Props {
    courseId?: string;
    courseCode?: string;
    courseTitle?: string;
    lessonId?: string;
    lessonCode?: string;
    lessonTitle?: string;
    onLessonUpdated?: (lessonId: string, tab: string) => void;
  }

  let {
    courseId = '',
    courseCode = '',
    courseTitle = '',
    lessonId = '',
    lessonCode = '',
    lessonTitle = '',
    onLessonUpdated
  }: Props = $props();

  let isMobile = $state(typeof window !== 'undefined' ? isMobileDevice() : false);

  onMount(() => {
    isMobile = isMobileDevice();
  });

  let activePath = $derived($page.url.pathname);
  let displayCourseCode = $derived((courseCode || courseId || '').toUpperCase());
  let activeLessonCode = $derived.by(() => {
    const code = lessonCode || lessonId;
    if (code) return code;
    if (lessonTitle && lessonTitle !== 'Complete Course') {
      const match = lessonTitle.match(/^(\d{1,2}\.\d{1,2}(?:_assign\d+)?)/);
      if (match) return match[1];
    }
    return '';
  });

  function handleBack() {
    goBackOrHome();
  }
</script>

<header class="h-14 border-b border-stone-200 dark:border-stone-800 bg-white/95 dark:bg-stone-900/95 px-2.5 sm:px-4 backdrop-blur flex items-center justify-between z-40 shrink-0 w-full max-w-full">
  <!-- Left: Back button, Home, & Breadcrumbs -->
  <div class="flex items-center space-x-1 sm:space-x-2 overflow-hidden min-w-0 shrink-0">
    <button
      type="button"
      onclick={handleBack}
      aria-label="Back"
      title="Back"
      class="w-10 h-10 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 active:bg-stone-200 dark:active:bg-stone-700 transition shrink-0 cursor-pointer"
    >
      <ChevronLeft class="w-5 h-5 sm:w-4 sm:h-4 stroke-[2.2]" />
    </button>

    <button
      type="button"
      onclick={() => goto('/')}
      aria-label="Home"
      title="Home"
      class="w-10 h-10 sm:w-8 sm:h-8 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 flex items-center justify-center shadow-xs shrink-0 cursor-pointer hover:bg-stone-800 dark:hover:bg-stone-200 transition"
    >
      <GraduationCap class="w-5 h-5 sm:w-4 sm:h-4" />
    </button>

    {#if displayCourseCode && !isMobile}
      <div class="hidden sm:flex items-center space-x-1.5 text-xs text-stone-400 dark:text-stone-500 overflow-hidden whitespace-nowrap min-w-0">
        <ChevronRight class="w-3.5 h-3.5 shrink-0" />
        <button
          type="button"
          onclick={() => goto(`/courses/${courseId.toLowerCase()}`)}
          class="hover:text-stone-900 dark:hover:text-stone-100 transition font-mono font-medium text-stone-600 dark:text-stone-400 cursor-pointer truncate max-w-[120px] md:max-w-none"
          title={courseTitle || displayCourseCode}
        >
          {displayCourseCode}
        </button>
        {#if activeLessonCode}
          <ChevronRight class="w-3.5 h-3.5 shrink-0" />
          <span
            class="text-stone-800 dark:text-stone-200 font-mono font-medium truncate max-w-[100px] md:max-w-none"
            title={lessonTitle || activeLessonCode}
          >
            {activeLessonCode}
          </span>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Right: Top-Level Navigation & Background AI Queue -->
  <nav class="flex items-center space-x-1 sm:space-x-1.5 shrink-0 ml-auto">
    <button
      type="button"
      onclick={() => goto('/')}
      aria-label="Courses"
      title="Courses"
      class="{isMobile ? 'w-10 h-10' : 'w-10 h-10 sm:w-auto sm:px-3 sm:py-1.5'} rounded-lg flex items-center justify-center sm:space-x-1.5 text-xs font-medium transition cursor-pointer shrink-0 {activePath === '/' || activePath.startsWith('/courses') ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60 hover:text-stone-900 dark:hover:text-stone-100'}"
    >
      <BookOpen class="{isMobile ? 'w-5 h-5' : 'w-5 h-5 sm:w-3.5 sm:h-3.5'} shrink-0" />
      {#if !isMobile}
        <span class="hidden sm:inline">Courses</span>
      {/if}
    </button>

    <button
      type="button"
      onclick={() => goto('/checkpoints')}
      aria-label="Checkpoints"
      title="Checkpoints"
      class="{isMobile ? 'w-10 h-10' : 'w-10 h-10 sm:w-auto sm:px-3 sm:py-1.5'} rounded-lg flex items-center justify-center sm:space-x-1.5 text-xs font-medium transition cursor-pointer shrink-0 {activePath.startsWith('/checkpoint') ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60 hover:text-stone-900 dark:hover:text-stone-100'}"
    >
      <FlagTriangleRight class="{isMobile ? 'w-5 h-5' : 'w-5 h-5 sm:w-3.5 sm:h-3.5'} shrink-0" />
      {#if !isMobile}
        <span class="hidden sm:inline">Checkpoints</span>
      {/if}
    </button>

    <button
      type="button"
      onclick={() => goto('/schedules')}
      aria-label="Schedules"
      title="Schedules"
      class="{isMobile ? 'w-10 h-10' : 'w-10 h-10 sm:w-auto sm:px-3 sm:py-1.5'} rounded-lg flex items-center justify-center sm:space-x-1.5 text-xs font-medium transition cursor-pointer shrink-0 {activePath.startsWith('/schedules') ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold' : 'text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60 hover:text-stone-900 dark:hover:text-stone-100'}"
    >
      <CalendarDays class="{isMobile ? 'w-5 h-5' : 'w-5 h-5 sm:w-3.5 sm:h-3.5'} shrink-0" />
      {#if !isMobile}
        <span class="hidden sm:inline">Schedules</span>
      {/if}
    </button>

    <AIQueuePopover {courseId} {onLessonUpdated} />

    {#if !isMobile}
      <button
        type="button"
        onclick={openConnectIpadModal}
        aria-label="Connect iPad"
        title="Connect iPad"
        class="flex items-center justify-center w-8 h-8 rounded-md text-xs font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer shrink-0"
      >
        <Tablet class="w-4 h-4" />
      </button>
    {:else}
      <DeviceSyncDropdown />
    {/if}

    <button
      type="button"
      onclick={() => goto('/settings')}
      aria-label="Settings"
      title="Settings"
      class="w-10 h-10 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-xs font-medium transition cursor-pointer shrink-0 {activePath.startsWith('/settings') || activePath.startsWith('/prompts') ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100' : 'text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60 hover:text-stone-900 dark:hover:text-stone-100'}"
    >
      <Settings class="w-5 h-5 sm:w-4 sm:h-4 shrink-0" />
    </button>
  </nav>
</header>
