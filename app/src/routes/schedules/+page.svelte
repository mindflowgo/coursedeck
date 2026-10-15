<script lang="ts">
  import Header from '$lib/components/Header.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    CalendarDays,
    Loader2,
    LayoutGrid,
    CalendarRange,
    ArrowRight,
    AlertCircle
  } from 'lucide-svelte';
  import { apiFetch } from '$lib/api';
  import {
    ScheduleParser,
    toggleEventDone,
    eventHref,
    type ScheduleEvent
  } from '$lib/parser/scheduleParser';
  import { scheduleTypeClasses, getScheduleEndDateLabel } from '$lib/schedule';

  interface CourseSchedule {
    courseId: string;
    courseTitle: string;
    exists: boolean;
    markdown: string;
    parsed: { title: string; summaryLine?: string; events: ScheduleEvent[] };
  }

  let schedules: CourseSchedule[] = $state([]);
  let isLoading = $state(true);
  let loadFailed = $state(false);
  let viewMode: 'week' | 'courses' = $state('courses');
  let togglingLine: number | null = $state(null);

  const todayIso = new Date().toISOString().split('T')[0];
  const weekEndIso = new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0];

  $effect(() => {
    const stored = localStorage.getItem('ilc_schedule_view');
    if (stored === 'week' || stored === 'courses') viewMode = stored;
  });

  function setViewMode(mode: 'week' | 'courses') {
    viewMode = mode;
    try {
      localStorage.setItem('ilc_schedule_view', mode);
    } catch {}
  }

  function parseAll(raw: Array<{ courseId: string; courseTitle: string; exists: boolean; markdown: string }>) {
    schedules = raw.map((s) => ({
      ...s,
      parsed: ScheduleParser.parseMarkdown(s.markdown)
    }));
  }

  async function loadSchedules() {
    isLoading = true;
    loadFailed = false;
    try {
      const res = await apiFetch('/api/schedules');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      parseAll(data.schedules || []);
    } catch (e) {
      console.error('Failed to load schedules:', e);
      loadFailed = true;
    } finally {
      isLoading = false;
    }
  }

  onMount(loadSchedules);

  async function handleToggle(course: CourseSchedule, event: ScheduleEvent) {
    togglingLine = event.lineIndex;
    try {
      const updated = toggleEventDone(course.markdown, event.lineIndex);
      const res = await apiFetch(`/api/courses/${course.courseId}/course-docs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'schedule', content: updated })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      course.markdown = updated;
      course.parsed = ScheduleParser.parseMarkdown(updated);
      schedules = [...schedules];
    } catch (e) {
      console.error('Failed to update schedule:', e);
      alert('Could not save the change — please try again.');
    } finally {
      togglingLine = null;
    }
  }

  function openCourseSchedule(courseId: string) {
    goto(`/courses/${courseId.toLowerCase()}/course/schedule`);
  }

  // ---- Week view: every dated event in [today, today+7] across courses ----
  const weekGroups = $derived.by(() => {
    const byDate = new Map<string, Array<{ course: CourseSchedule; event: ScheduleEvent }>>();
    for (const course of schedules) {
      for (const event of course.parsed.events) {
        if (!event.date || event.date < todayIso || event.date > weekEndIso) continue;
        const list = byDate.get(event.date) || [];
        list.push({ course, event });
        byDate.set(event.date, list);
      }
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({
        date,
        label: new Date(`${date}T00:00:00`).toLocaleDateString('en-CA', {
          weekday: 'long',
          month: 'short',
          day: 'numeric'
        }),
        isToday: date === todayIso,
        items
      }));
  });

  function doneRatio(events: ScheduleEvent[]): { done: number; total: number } {
    const dated = events.filter((e) => e.date);
    return { done: dated.filter((e) => e.done).length, total: dated.length };
  }

  function upcomingEvents(events: ScheduleEvent[], count: number): ScheduleEvent[] {
    return events
      .filter((e) => e.date && !e.done && e.date >= todayIso)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, count);
  }
</script>

<Header
  onLessonUpdated={(_lId, tab) => {
    if (tab === 'schedule') {
      loadSchedules();
    }
  }}
/>

<main class="flex-1 overflow-y-auto px-4 sm:px-6 py-8 max-w-5xl mx-auto w-full space-y-6">
    <!-- Page header + view toggle -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center space-x-2.5">
        <div class="p-2 rounded-xl bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200 shadow-2xs">
          <CalendarDays class="w-4 h-4" />
        </div>
        <div>
          <h1 class="text-lg font-semibold text-stone-900 dark:text-stone-100">Schedules</h1>
          <p class="text-xs text-stone-500 dark:text-stone-400">
            Upcoming study sessions across your courses — tick them off as you go
          </p>
        </div>
      </div>

      <div class="inline-flex rounded-lg border border-stone-200 dark:border-stone-800 p-0.5 bg-stone-100 dark:bg-stone-800/70 text-xs font-medium">
        <button
          onclick={() => setViewMode('week')}
          class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition cursor-pointer {viewMode === 'week' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
        >
          <CalendarRange class="w-3.5 h-3.5" />
          <span>This Week</span>
        </button>
        <button
          onclick={() => setViewMode('courses')}
          class="flex items-center space-x-1.5 px-3 py-1 rounded-md transition cursor-pointer {viewMode === 'courses' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'}"
        >
          <LayoutGrid class="w-3.5 h-3.5" />
          <span>By Course</span>
        </button>
      </div>
    </div>

    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-20 space-y-3 text-stone-400">
        <Loader2 class="w-6 h-6 animate-spin" />
        <p class="text-xs">Loading schedules…</p>
      </div>
    {:else if loadFailed}
      <div class="flex flex-col items-center justify-center py-20 space-y-3 text-center">
        <AlertCircle class="w-6 h-6 text-rose-400" />
        <p class="text-sm text-stone-600 dark:text-stone-300">Could not load schedules.</p>
        <button
          onclick={loadSchedules}
          class="px-3.5 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          Try Again
        </button>
      </div>
    {:else if schedules.length === 0}
      <div class="py-20 text-center space-y-2">
        <p class="text-sm text-stone-600 dark:text-stone-300">No courses yet.</p>
        <p class="text-xs text-stone-400">Upload a course first, then build its schedule from the course page.</p>
      </div>
    {:else if viewMode === 'week'}
      <!-- This Week: chronological across courses -->
      {#if weekGroups.length === 0}
        <div class="py-16 text-center space-y-2">
          <p class="text-sm text-stone-600 dark:text-stone-300">Nothing scheduled in the next 7 days.</p>
          <p class="text-xs text-stone-400">Build or rebuild a schedule from a course page to fill your week.</p>
        </div>
      {:else}
        <div class="space-y-5">
          {#each weekGroups as group (group.date)}
            <section class="space-y-2">
              <div class="flex items-center space-x-2 {group.isToday ? 'text-stone-900 dark:text-stone-100' : 'text-stone-500 dark:text-stone-400'}">
                <h2 class="text-xs font-semibold uppercase tracking-wide">{group.label}</h2>
                {#if group.isToday}
                  <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-semibold">TODAY</span>
                {/if}
              </div>
              <div class="space-y-1.5">
                {#each group.items as { course, event } (event.lineIndex)}
                  <div class="flex items-center space-x-3 p-3 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
                    <button
                      onclick={() => handleToggle(course, event)}
                      disabled={togglingLine === event.lineIndex}
                      title={event.done ? 'Mark as not done' : 'Mark as done'}
                      class="w-4 h-4 shrink-0 rounded border flex items-center justify-center transition cursor-pointer {event.done
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'border-stone-300 dark:border-stone-600 hover:border-stone-500'}"
                    >
                      {#if event.done}
                        <svg class="w-3 h-3" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5L5 9l4.5-5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      {/if}
                    </button>
                    <span class="px-1.5 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide shrink-0 {scheduleTypeClasses(event.type)}">{event.type}</span>
                    <button
                      type="button"
                      onclick={() => goto(eventHref(course.courseId, event))}
                      class="text-sm font-medium hover:underline hover:text-indigo-600 dark:hover:text-indigo-400 transition cursor-pointer text-left truncate {event.done ? 'line-through text-stone-400 dark:text-stone-500' : 'text-stone-900 dark:text-stone-100'}"
                      title="Open {event.lessonId}{event.section ? ` (${event.section})` : ''}"
                    >{event.title}</button>
                    <button
                      type="button"
                      onclick={() => goto(eventHref(course.courseId, event))}
                      class="font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition shrink-0 cursor-pointer"
                      title="Open {event.lessonId}{event.section ? ` (${event.section})` : ''}"
                    >{event.lessonId}{event.section ? `/${event.section}` : ''}</button>
                    {#if event.durationMin}
                      <span class="text-[10px] text-stone-400 whitespace-nowrap shrink-0">{event.durationMin}m</span>
                    {/if}
                    <span class="ml-auto text-[10px] font-semibold text-stone-400 dark:text-stone-500 uppercase tracking-wide shrink-0">
                      {course.courseId}
                    </span>
                  </div>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      {/if}
    {:else}
      <!-- By Course: cards with progress + upcoming sessions -->
      <div class="grid gap-4 sm:grid-cols-2">
        {#each schedules as course (course.courseId)}
          {@const endDate = course.exists ? getScheduleEndDateLabel(course.parsed.events, course.markdown, course.parsed.summaryLine) : null}
          <div class="rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 space-y-4 shadow-2xs">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <button
                  type="button"
                  onclick={() => goto(`/courses/${course.courseId}`)}
                  class="text-sm font-semibold text-stone-900 dark:text-stone-100 hover:underline truncate block text-left cursor-pointer"
                >{course.courseTitle}</button>
                <p class="text-[11px] text-stone-400">
                  <span class="font-mono uppercase tracking-wide">{course.courseId}</span>{#if endDate}<span> - until {endDate}</span>{/if}
                </p>
              </div>
              {#if course.exists}
                {@const ratio = doneRatio(course.parsed.events)}
                <div class="text-right shrink-0">
                  <div class="text-xs font-semibold text-stone-900 dark:text-stone-100">{ratio.done} / {ratio.total}</div>
                  <div class="w-24 h-1.5 rounded-full bg-stone-200 dark:bg-stone-700 overflow-hidden mt-1">
                    <div class="h-full bg-emerald-500 transition-all" style="width: {ratio.total ? Math.round((ratio.done / ratio.total) * 100) : 0}%"></div>
                  </div>
                </div>
              {/if}
            </div>

            {#if !course.exists}
              <p class="text-xs text-stone-500 dark:text-stone-400">No schedule yet.</p>
              <button
                onclick={() => openCourseSchedule(course.courseId)}
                class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-sm cursor-pointer"
              >
                <CalendarDays class="w-3.5 h-3.5" />
                <span>Build one</span>
              </button>
            {:else}
              {@const upcoming = upcomingEvents(course.parsed.events, 5)}
              {#if upcoming.length === 0}
                <p class="text-xs text-stone-500 dark:text-stone-400">
                  {course.parsed.events.length === 0
                    ? 'Schedule exists but no sessions could be parsed.'
                    : 'All caught up — no upcoming sessions left.'}
                </p>
              {:else}
                <div class="space-y-1.5">
                  {#each upcoming as event (event.lineIndex)}
                    <div class="flex items-center space-x-2.5 text-xs">
                      <button
                        onclick={() => handleToggle(course, event)}
                        disabled={togglingLine === event.lineIndex}
                        title="Mark as done"
                        class="w-3.5 h-3.5 shrink-0 rounded border border-stone-300 dark:border-stone-600 hover:border-stone-500 transition cursor-pointer"
                      ></button>
                      <span class="font-mono text-[10px] text-stone-400 shrink-0">
                        {new Date(`${event.date}T00:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                      </span>
                      <span class="px-1.5 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide shrink-0 {scheduleTypeClasses(event.type)}">{event.type}</span>
                      <span class="text-stone-700 dark:text-stone-200 truncate">{event.title}</span>
                    </div>
                  {/each}
                </div>
              {/if}
              <button
                onclick={() => openCourseSchedule(course.courseId)}
                class="flex items-center space-x-1 text-xs font-medium text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer"
              >
                <span>Open schedule</span>
                <ArrowRight class="w-3.5 h-3.5" />
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </main>
