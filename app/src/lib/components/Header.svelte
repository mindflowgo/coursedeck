<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    BookOpen,
    Sparkles,
    Settings,
    GraduationCap,
    ChevronLeft,
    ChevronRight,
    CalendarDays
  } from 'lucide-svelte';
  import AIQueuePopover from './AIQueuePopover.svelte';
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

<header class="h-14 border-b border-stone-200 dark:border-stone-800 bg-white/95 dark:bg-stone-900/95 px-4 backdrop-blur flex items-center justify-between z-40 shrink-0">
  <!-- Left: Back button, Home, & Breadcrumbs -->
  <div class="flex items-center space-x-2 overflow-hidden">
    <button
      type="button"
      onclick={handleBack}
      aria-label="Back"
      title="Back"
      class="w-8 h-8 rounded-lg flex items-center justify-center text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 transition shrink-0 cursor-pointer"
    >
      <ChevronLeft class="w-4 h-4" />
    </button>

    <button
      type="button"
      onclick={() => goto('/')}
      aria-label="Home"
      title="Home"
      class="flex items-center text-stone-900 dark:text-stone-100 hover:text-stone-700 dark:hover:text-stone-300 transition font-medium shrink-0 cursor-pointer"
    >
      <div class="w-8 h-8 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 flex items-center justify-center shadow-sm">
        <GraduationCap class="w-4 h-4" />
      </div>
    </button>

    {#if displayCourseCode}
      <div class="flex items-center space-x-1.5 text-xs text-stone-400 dark:text-stone-500 overflow-hidden whitespace-nowrap">
        <ChevronRight class="w-3.5 h-3.5 shrink-0" />
        <button
          type="button"
          onclick={() => goto(`/courses/${courseId.toLowerCase()}`)}
          class="hover:text-stone-900 dark:hover:text-stone-100 transition font-mono font-medium text-stone-600 dark:text-stone-400 cursor-pointer"
          title={courseTitle || displayCourseCode}
        >
          {displayCourseCode}
        </button>
        {#if activeLessonCode}
          <ChevronRight class="w-3.5 h-3.5 shrink-0" />
          <span
            class="text-stone-800 dark:text-stone-200 font-mono font-medium"
            title={lessonTitle || activeLessonCode}
          >
            {activeLessonCode}
          </span>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Right: Top-Level Navigation & Background AI Queue -->
  <nav class="flex items-center space-x-1.5 shrink-0">
    <AIQueuePopover {courseId} {onLessonUpdated} />

    <button
      type="button"
      onclick={() => goto('/')}
      class="flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition cursor-pointer {activePath === '/' || activePath.startsWith('/courses') ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100' : 'text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60 hover:text-stone-900 dark:hover:text-stone-100'}"
    >
      <BookOpen class="w-3.5 h-3.5" />
      <span>Courses</span>
    </button>

    <button
      type="button"
      onclick={() => goto('/schedules')}
      class="flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition cursor-pointer {activePath.startsWith('/schedules') ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100' : 'text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60 hover:text-stone-900 dark:hover:text-stone-100'}"
    >
      <CalendarDays class="w-3.5 h-3.5" />
      <span>Schedules</span>
    </button>

    <button
      type="button"
      onclick={() => goto('/prompts')}
      class="flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition cursor-pointer {activePath.startsWith('/prompts') ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100' : 'text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60 hover:text-stone-900 dark:hover:text-stone-100'}"
    >
      <Sparkles class="w-3.5 h-3.5" />
      <span>Prompts</span>
    </button>

    <button
      type="button"
      onclick={() => goto('/settings')}
      aria-label="Settings"
      title="Settings"
      class="flex items-center justify-center w-8 h-8 rounded-md text-xs font-medium transition cursor-pointer {activePath.startsWith('/settings') ? 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100' : 'text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60 hover:text-stone-900 dark:hover:text-stone-100'}"
    >
      <Settings class="w-4 h-4" />
    </button>
  </nav>
</header>
