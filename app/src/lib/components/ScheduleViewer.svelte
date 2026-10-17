<script lang="ts">
  import { goto } from '$app/navigation';
  import { CalendarDays, RotateCcw, Loader2 } from 'lucide-svelte';
  import {
    ScheduleParser,
    toggleEventDone,
    eventHref,
    isLinkableSection,
    renderInlineMarkdown,
    type ScheduleEvent
  } from '$lib/parser/scheduleParser';
  import { scheduleTypeClasses } from '$lib/schedule';

  interface Props {
    courseId: string;
    /** Raw course.schedule.md contents, frontmatter included. */
    markdown: string;
    /** Receives the full markdown with one checkbox flipped; caller persists it. */
    onToggle: (updatedMarkdown: string) => void;
    onRebuild: () => void;
    onEditMarkdown?: () => void;
    isGenerating?: boolean;
  }

  let { courseId, markdown, onToggle, onRebuild, onEditMarkdown, isGenerating = false }: Props = $props();

  const parsed = $derived(ScheduleParser.parseMarkdown(markdown));
  const doneCount = $derived(parsed.events.filter((e) => e.done).length);

  interface DayGroup {
    date: string;
    label: string;
    isToday: boolean;
    events: ScheduleEvent[];
  }

  const todayIso = new Date().toISOString().split('T')[0];

  const dayGroups = $derived.by<DayGroup[]>(() => {
    const groups: DayGroup[] = [];
    for (const e of parsed.events) {
      let group = groups.find((g) => g.date === e.date);
      if (!group) {
        let label = 'Unscheduled';
        let isToday = false;
        if (e.date) {
          const d = new Date(`${e.date}T00:00:00`);
          label = d.toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });
          isToday = e.date === todayIso;
        }
        group = { date: e.date, label, isToday, events: [] };
        groups.push(group);
      }
      group.events.push(e);
    }
    return groups;
  });

  function handleToggle(event: ScheduleEvent) {
    onToggle(toggleEventDone(markdown, event.lineIndex));
  }
</script>

<div class="space-y-5">
  <!-- Header -->
  <div class="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-stone-200 dark:border-stone-800">
    <div class="flex items-center space-x-2.5">
      <div class="p-2 rounded-xl bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200 shadow-2xs">
        <CalendarDays class="w-4 h-4" />
      </div>
      <div>
        <h2 class="text-base font-semibold text-stone-900 dark:text-stone-100">
          {parsed.title || 'Study Schedule'}
        </h2>
        {#if parsed.summaryLine}
          <p class="text-xs text-stone-500 dark:text-stone-400">{parsed.summaryLine}</p>
        {/if}
      </div>
    </div>

    <div class="flex items-center space-x-3">
      {#if parsed.events.length > 0}
        <div class="text-right">
          <div class="text-xs font-semibold text-stone-900 dark:text-stone-100">
            {doneCount} / {parsed.events.length} done
          </div>
          <div class="w-28 h-1.5 rounded-full bg-stone-200 dark:bg-stone-700 overflow-hidden mt-1">
            <div
              class="h-full bg-emerald-500 transition-all"
              style="width: {Math.round((doneCount / parsed.events.length) * 100)}%"
            ></div>
          </div>
        </div>
      {/if}
    </div>
  </div>

  {#if parsed.events.length === 0}
    <div class="p-6 rounded-xl border border-dashed border-stone-300 dark:border-stone-700 text-center space-y-4">
      <div class="space-y-1">
        <p class="text-sm font-medium text-stone-700 dark:text-stone-300">
          No schedule checklist entries could be recognized.
        </p>
        <p class="text-xs text-stone-500 dark:text-stone-400 max-w-md mx-auto">
          {markdown.trim().length > 0
            ? `The AI returned ${markdown.length.toLocaleString()} characters of content, but it did not follow the expected checklist format (- [ ] **Type** ...).`
            : 'No schedule content has been generated yet.'}
        </p>
      </div>

      <div class="flex items-center justify-center gap-2 pt-1">
        {#if onEditMarkdown}
          <button
            onclick={onEditMarkdown}
            class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-200 text-xs font-medium hover:bg-stone-50 dark:hover:bg-stone-700 transition shadow-2xs cursor-pointer"
          >
            Edit as Markdown
          </button>
        {/if}
        <button
          onclick={onRebuild}
          disabled={isGenerating}
          class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-2xs cursor-pointer disabled:opacity-50"
        >
          {#if isGenerating}
            <Loader2 class="w-3.5 h-3.5 animate-spin text-amber-500" />
            <span>Generating Schedule...</span>
          {:else}
            <RotateCcw class="w-3.5 h-3.5" />
            <span>Re-Schedule</span>
          {/if}
        </button>
      </div>

      {#if markdown.trim().length > 0}
        <details class="text-left mt-4 border-t border-stone-200 dark:border-stone-800 pt-4">
          <summary class="text-xs font-semibold text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 cursor-pointer">
            View Raw AI Output ({markdown.length.toLocaleString()} chars)
          </summary>
          <div class="mt-2.5 p-3 rounded-lg bg-stone-50 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700 text-xs font-mono text-stone-700 dark:text-stone-300 overflow-x-auto max-h-80 whitespace-pre-wrap">
            {markdown}
          </div>
        </details>
      {/if}
    </div>
  {:else}
    <div class="space-y-6">
      {#each dayGroups as group (group.date || 'unscheduled')}
        <div class="space-y-2">
          <div class="flex items-center space-x-2 {group.isToday ? 'text-stone-900 dark:text-stone-100' : 'text-stone-500 dark:text-stone-400'}">
            <h3 class="text-xs font-semibold uppercase tracking-wide">{group.label}</h3>
            {#if group.isToday}
              <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-semibold">TODAY</span>
            {/if}
          </div>

          <div class="space-y-1.5">
            {#each group.events as event (event.lineIndex)}
              <div class="flex items-start space-x-3 p-3 rounded-xl border {event.done ? 'border-stone-100 dark:border-stone-800/60 opacity-60' : group.isToday ? 'border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 shadow-2xs' : 'border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900'}">
                <button
                  onclick={() => handleToggle(event)}
                  title={event.done ? 'Mark as not done' : 'Mark as done'}
                  class="mt-0.5 w-4 h-4 shrink-0 rounded border flex items-center justify-center transition cursor-pointer {event.done
                    ? 'bg-emerald-600 border-emerald-600 text-white'
                    : 'border-stone-300 dark:border-stone-600 hover:border-stone-500'}"
                >
                  {#if event.done}
                    <svg class="w-3 h-3" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5L5 9l4.5-5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  {/if}
                </button>

                <div class="flex-1 min-w-0 space-y-1">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span class="px-1.5 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide {scheduleTypeClasses(event.type)}">
                      {event.type}
                    </span>
                    <button
                      type="button"
                      onclick={() => goto(eventHref(courseId, event))}
                      class="font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition inline-flex items-center cursor-pointer"
                      title="Open {event.lessonId}{event.section ? ` (${event.section})` : ''}"
                    >{event.lessonId}{event.section ? `/${event.section}` : ''}</button>
                    {#if event.section && !isLinkableSection(event.section)}
                      <span class="text-[10px] text-stone-400 dark:text-stone-500 italic">{event.section}</span>
                    {/if}
                    <button
                      type="button"
                      onclick={() => goto(eventHref(courseId, event))}
                      class="text-sm font-medium hover:underline hover:text-indigo-600 dark:hover:text-indigo-400 transition cursor-pointer text-left {event.done ? 'line-through text-stone-400 dark:text-stone-500' : 'text-stone-900 dark:text-stone-100'} [&_strong]:font-semibold [&_code]:font-mono"
                      title="Open {event.lessonId}{event.section ? ` (${event.section})` : ''}"
                    >
                      {@html renderInlineMarkdown(event.title)}
                    </button>
                    {#if event.durationMin}
                      <span class="text-[10px] text-stone-400 dark:text-stone-500 whitespace-nowrap">({event.durationMin}m)</span>
                    {/if}
                  </div>
                  {#if event.description}
                    <p class="text-xs text-stone-500 dark:text-stone-400 leading-relaxed [&_strong]:font-normal [&_strong]:italic [&_code]:font-mono [&_code]:text-[11px] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_em]:italic">
                      {@html renderInlineMarkdown(event.description)}
                    </p>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
