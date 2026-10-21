<script lang="ts">
  import { untrack } from 'svelte';
  import { CalendarDays, X, AlertCircle, ChevronDown } from 'lucide-svelte';
  import {
    WEEKDAY_LABELS,
    defaultSchedulePreferences,
    loadStoredSchedulePreferences,
    storeSchedulePreferences,
    validateSchedulePreferences,
    buildSchedulePrompt,
    type SchedulePreferences
  } from '$lib/schedule';
  import type { CourseManifest } from '$lib/parser/courseIngest';
  import { buildScheduleSkeleton, generateStudyCalendarDays } from '$lib/scheduleGenerator';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
    /** Called with the composed system prompt (template + preferences), preferences object, and custom template if edited. */
    onGenerate: (promptWithPreferences: string, preferences?: SchedulePreferences, customTemplate?: string) => void;
    promptTemplate: string;
    defaultPromptTemplate?: string;
    courseTitle?: string;
    lessonCount?: number;
    course?: CourseManifest | null;
  }

  let {
    isOpen,
    onClose,
    onGenerate,
    promptTemplate,
    defaultPromptTemplate = '',
    courseTitle,
    lessonCount = 0,
    course = null
  }: Props = $props();

  let prefs = $state<SchedulePreferences>(defaultSchedulePreferences());
  let validationError = $state<string | null>(null);
  let hasNotes = $state(false);
  let isEditingPrompt = $state(false);
  let editablePrompt = $state('');

  $effect(() => {
    if (isOpen) {
      untrack(() => {
        editablePrompt = promptTemplate || defaultPromptTemplate || '';
      });
    }
  });

  // Blackout date accordion & addition inputs
  let isBlackoutExpanded = $state(false);
  let newBlackoutStart = $state('');
  let newBlackoutEnd = $state('');
  let newBlackoutLabel = $state('');
  let blackoutError = $state<string | null>(null);

  const DEFAULT_TIMES = ['09:00', '13:00', '17:00'];

  function getDayTime(day: number, sessionIndex: number): string {
    const times = prefs.dayTimes?.[day];
    if (times && times[sessionIndex]) {
      return times[sessionIndex];
    }
    return DEFAULT_TIMES[sessionIndex] || '09:00';
  }

  function setDayTime(day: number, sessionIndex: number, val: string) {
    if (!prefs.dayTimes) prefs.dayTimes = {};
    const existing = prefs.dayTimes[day] ? [...prefs.dayTimes[day]] : [];
    for (let i = 0; i <= sessionIndex; i++) {
      if (!existing[i]) {
        existing[i] = DEFAULT_TIMES[i] || '09:00';
      }
    }
    existing[sessionIndex] = val;
    prefs.dayTimes = {
      ...prefs.dayTimes,
      [day]: existing
    };
  }

  const calculatedEndDate = $derived.by(() => {
    if (!prefs.startDate || !prefs.studyDays || prefs.studyDays.length === 0) return null;
    try {
      if (course && course.units && course.units.length > 0) {
        const skeleton = buildScheduleSkeleton(course, prefs);
        if (skeleton.sessions.length > 0) {
          return skeleton.sessions[skeleton.sessions.length - 1].date;
        }
      }
      const totalSessions = Math.max(1, lessonCount || 1);
      const daysNeeded = Math.ceil(totalSessions / Math.max(1, prefs.sessionsPerDay || 1));
      const dates = generateStudyCalendarDays(prefs, daysNeeded);
      return dates.length > 0 ? dates[dates.length - 1] : null;
    } catch {
      return null;
    }
  });

  function formatDisplayDate(dateIso: string | null): string {
    if (!dateIso) return '—';
    try {
      const date = new Date(`${dateIso}T00:00:00`);
      if (isNaN(date.getTime())) return dateIso;
      return date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return dateIso;
    }
  }

  $effect(() => {
    if (isOpen) {
      untrack(() => {
        const loaded = loadStoredSchedulePreferences() ?? defaultSchedulePreferences();
        prefs = loaded;
        prefs.paceMode = 'steady';
        delete prefs.targetEndDate;
        if (!prefs.dayTimes) prefs.dayTimes = {};
        hasNotes = Boolean(loaded.notes && loaded.notes.trim().length > 0);
        validationError = null;
        blackoutError = null;
        newBlackoutStart = '';
        newBlackoutEnd = '';
        newBlackoutLabel = '';
        isBlackoutExpanded = false;
      });
    }
  });

  function hasStudyDay(day: number): boolean {
    return Array.isArray(prefs.studyDays) && prefs.studyDays.some((d) => Number(d) === day);
  }

  function toggleDay(day: number) {
    if (hasStudyDay(day)) {
      prefs.studyDays = prefs.studyDays.filter((d) => Number(d) !== day);
    } else {
      prefs.studyDays = [...prefs.studyDays, day].sort((a, b) => a - b);
    }
  }

  function addBlackoutRange() {
    blackoutError = null;
    if (!newBlackoutStart || !newBlackoutEnd) {
      blackoutError = 'Please pick both start and end dates.';
      return;
    }
    if (newBlackoutEnd < newBlackoutStart) {
      blackoutError = 'End date must be on or after start date.';
      return;
    }
    prefs.blackoutDates = [
      ...prefs.blackoutDates,
      {
        startDate: newBlackoutStart,
        endDate: newBlackoutEnd,
        label: newBlackoutLabel.trim() || undefined
      }
    ];
    newBlackoutStart = '';
    newBlackoutEnd = '';
    newBlackoutLabel = '';
  }

  function removeBlackoutRange(index: number) {
    prefs.blackoutDates = prefs.blackoutDates.filter((_, i) => i !== index);
  }

  function handleGenerate() {
    validationError = validateSchedulePreferences(prefs);
    if (validationError) return;

    const templateToUse = isEditingPrompt && editablePrompt.trim().length > 0
      ? editablePrompt.trim()
      : (editablePrompt.trim() || promptTemplate);

    if (!templateToUse || templateToUse.trim().length === 0) {
      validationError = 'Core prompt template for course schedule is missing. Please add or verify course_schedule.md in Prompts before generating.';
      return;
    }
    const normalizedDayTimes: Record<number, string[]> = {};
    for (const d of prefs.studyDays) {
      normalizedDayTimes[d] = [];
      for (let i = 0; i < prefs.sessionsPerDay; i++) {
        normalizedDayTimes[d].push(getDayTime(d, i));
      }
    }
    let totalCalendarDays: number | undefined;
    if (prefs.startDate && calculatedEndDate) {
      try {
        const start = new Date(`${prefs.startDate}T00:00:00`);
        const end = new Date(`${calculatedEndDate}T00:00:00`);
        const diffMs = end.getTime() - start.getTime();
        if (!isNaN(diffMs)) {
          totalCalendarDays = Math.max(1, Math.round(diffMs / (86400 * 1000)) + 1);
        }
      } catch {}
    }

    const effectivePrefs: SchedulePreferences = {
      ...prefs,
      paceMode: 'steady',
      targetEndDate: undefined,
      calculatedEndDate: calculatedEndDate || undefined,
      totalCalendarDays,
      dayTimes: normalizedDayTimes,
      notes: hasNotes && prefs.notes?.trim() ? prefs.notes.trim() : undefined
    };
    storeSchedulePreferences(effectivePrefs);
    onGenerate(
      buildSchedulePrompt(templateToUse, effectivePrefs),
      effectivePrefs,
      isEditingPrompt ? templateToUse : undefined
    );
    onClose();
  }
</script>

<svelte:window onkeydown={(e) => { if (isOpen && e.key === 'Escape') onClose(); }} />

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs">
    <!-- Backdrop dismiss -->
    <button
      type="button"
      class="absolute inset-0 w-full h-full cursor-default"
      onclick={onClose}
      aria-label="Close modal overlay"
      tabindex="-1"
    ></button>

    <div class="relative z-10 w-full max-w-xl rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
      <!-- Header -->
      <div class="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2.5">
          <div class="p-2 rounded-xl bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200 shadow-2xs">
            <CalendarDays class="w-4 h-4" />
          </div>
          <div>
            <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">Build Study Schedule</h2>
            <p class="text-[11px] text-stone-500 dark:text-stone-400">
              {courseTitle ? `${courseTitle} — ` : ''}a few questions, then the planner does the rest
            </p>
          </div>
        </div>

        <button
          onclick={onClose}
          class="p-1 rounded-md text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="space-y-4">
        <!-- Lesson count statement -->
        <div>
          <p class="text-xs font-medium text-stone-700 dark:text-stone-300">
            There {lessonCount === 1 ? 'is 1 lesson' : `are ${lessonCount ?? 0} lessons`} to schedule.
          </p>
        </div>

        <!-- Session Length / Sessions/Day -->
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="sched-length" class="text-xs font-medium text-stone-700 dark:text-stone-300">Session Length</label>
            <select
              id="sched-length"
              bind:value={prefs.sessionLengthMin}
              class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none cursor-pointer"
            >
              {#each [30, 45, 60, 90, 120] as len}
                <option value={len}>{len} minutes</option>
              {/each}
            </select>
          </div>
          <div class="space-y-1">
            <label for="sched-perday" class="text-xs font-medium text-stone-700 dark:text-stone-300">Sessions/Day</label>
            <select
              id="sched-perday"
              bind:value={prefs.sessionsPerDay}
              class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none cursor-pointer"
            >
              {#each [1, 2, 3] as n}
                <option value={n}>{n}</option>
              {/each}
            </select>
          </div>
        </div>

        <!-- Day Schedule -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-stone-700 dark:text-stone-300">Day Schedule</span>
            <span class="text-[11px] text-stone-400 dark:text-stone-500">Pick study days & session times</span>
          </div>
          <div class="overflow-x-auto pb-1 -mx-1 px-1">
            <div class="min-w-[460px] grid grid-cols-7 gap-2">
              {#each WEEKDAY_LABELS as label, day}
                <div class="flex flex-col items-center gap-1.5">
                  <button
                    type="button"
                    onclick={() => toggleDay(day)}
                    class="w-full py-2 rounded-lg border text-xs font-medium transition cursor-pointer text-center {hasStudyDay(day)
                      ? 'border-stone-900 dark:border-stone-100 bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 shadow-2xs'
                      : 'border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:border-stone-300 dark:hover:border-stone-600 bg-white dark:bg-stone-800/40'}"
                  >
                    {label}
                  </button>

                  {#if hasStudyDay(day)}
                    <div class="w-full space-y-1.5">
                      {#each Array(prefs.sessionsPerDay) as _, sessionIdx}
                        <input
                          type="time"
                          value={getDayTime(day, sessionIdx)}
                          oninput={(e) => setDayTime(day, sessionIdx, e.currentTarget.value)}
                          aria-label="{label} session {sessionIdx + 1} time"
                          title="{label} session {sessionIdx + 1}"
                          class="w-full px-1.5 py-1 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-[11px] text-stone-900 dark:text-stone-100 text-center outline-none focus:ring-1 focus:ring-stone-400"
                        />
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        </div>

        <!-- Start date & End date (calculated) -->
        <div class="grid grid-cols-2 gap-3 items-start">
          <!-- Start date -->
          <div class="space-y-1">
            <label for="sched-start" class="text-xs font-medium text-stone-700 dark:text-stone-300">Start date</label>
            <input
              id="sched-start"
              type="date"
              bind:value={prefs.startDate}
              class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none"
            />
          </div>

          <!-- End date -->
          <div class="space-y-1">
            <span class="text-xs font-medium text-stone-700 dark:text-stone-300">End date</span>
            <div
              class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800/50 text-xs font-medium text-stone-800 dark:text-stone-200 flex items-center min-h-[35px]"
            >
              {#if calculatedEndDate}
                <span>{formatDisplayDate(calculatedEndDate)}</span>
              {:else}
                <span class="text-stone-400 dark:text-stone-500">Pick study days to calculate</span>
              {/if}
            </div>
          </div>
        </div>

        <!-- Review day toggle -->
        <div class="space-y-1">
          <label class="flex items-center space-x-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              bind:checked={prefs.includeReviews}
              class="w-4 h-4 rounded border-stone-300 dark:border-stone-700 text-stone-900 dark:bg-stone-800 focus:ring-stone-400"
            />
            <span class="text-xs font-medium text-stone-700 dark:text-stone-300">
              Include review day (1/unit)
            </span>
          </label>
        </div>

        <!-- Catch-up buffer days toggle -->
        <div class="space-y-1">
          <label class="flex items-center space-x-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              bind:checked={prefs.includeCatchupDays}
              class="w-4 h-4 rounded border-stone-300 dark:border-stone-700 text-stone-900 dark:bg-stone-800 focus:ring-stone-400"
            />
            <span class="text-xs font-medium text-stone-700 dark:text-stone-300">
              Include catch-up buffer days (~1 per week)
            </span>
          </label>
        </div>

        <!-- Holiday / Blackout Dates (Expandable) -->
        <div class="rounded-xl border border-stone-200 dark:border-stone-800 overflow-hidden bg-stone-50/50 dark:bg-stone-800/40">
          <button
            type="button"
            onclick={() => (isBlackoutExpanded = !isBlackoutExpanded)}
            class="w-full flex items-center justify-between px-3 py-2.5 text-left text-xs font-medium text-stone-700 dark:text-stone-300 hover:bg-stone-100/70 dark:hover:bg-stone-800/70 transition cursor-pointer"
          >
            <div class="flex items-center space-x-2">
              <span>Holiday / Blackout Dates</span>
              {#if prefs.blackoutDates && prefs.blackoutDates.length > 0}
                <span class="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-900">
                  {prefs.blackoutDates.length}
                </span>
              {/if}
            </div>
            <ChevronDown class="w-3.5 h-3.5 text-stone-400 transition-transform duration-200 {isBlackoutExpanded ? 'rotate-180' : ''}" />
          </button>

          {#if isBlackoutExpanded}
            <div class="p-3 pt-1 border-t border-stone-200 dark:border-stone-800 space-y-2.5">
              <p class="text-[11px] text-stone-500 dark:text-stone-400">
                Specify days or vacation windows to skip completely during scheduling.
              </p>

              {#if prefs.blackoutDates && prefs.blackoutDates.length > 0}
                <div class="flex flex-wrap gap-1.5 pb-0.5">
                  {#each prefs.blackoutDates as b, idx}
                    <span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-900">
                      <span>{b.label ? `${b.label}: ` : ''}{b.startDate} → {b.endDate}</span>
                      <button
                        type="button"
                        onclick={() => removeBlackoutRange(idx)}
                        class="text-amber-600 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-100 transition cursor-pointer"
                        title="Remove exclusion"
                      >
                        <X class="w-3 h-3" />
                      </button>
                    </span>
                  {/each}
                </div>
              {/if}

              <div class="p-2.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 space-y-2">
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label for="bo-start" class="block text-[10px] text-stone-500 dark:text-stone-400 mb-0.5">From</label>
                    <input
                      id="bo-start"
                      type="date"
                      bind:value={newBlackoutStart}
                      class="w-full px-2 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 outline-none"
                    />
                  </div>
                  <div>
                    <label for="bo-end" class="block text-[10px] text-stone-500 dark:text-stone-400 mb-0.5">To</label>
                    <input
                      id="bo-end"
                      type="date"
                      bind:value={newBlackoutEnd}
                      class="w-full px-2 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 outline-none"
                    />
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Optional label (e.g. Winter Break)"
                    bind:value={newBlackoutLabel}
                    class="flex-1 px-2 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 outline-none"
                  />
                  <button
                    type="button"
                    onclick={addBlackoutRange}
                    class="px-2.5 py-1.5 rounded-md bg-stone-200 dark:bg-stone-700 hover:bg-stone-300 dark:hover:bg-stone-600 text-stone-800 dark:text-stone-200 text-xs font-medium transition cursor-pointer shrink-0"
                  >
                    + Add
                  </button>
                </div>
                {#if blackoutError}
                  <p class="text-[11px] text-rose-600 dark:text-rose-400">{blackoutError}</p>
                {/if}
              </div>
            </div>
          {/if}
        </div>

        <!-- Notes checkbox & textarea -->
        <div class="space-y-1.5">
          <label class="flex items-center space-x-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              bind:checked={hasNotes}
              class="w-4 h-4 rounded border-stone-300 dark:border-stone-700 text-stone-900 dark:bg-stone-800 focus:ring-stone-400"
            />
            <span class="text-xs font-medium text-stone-700 dark:text-stone-300">
              Notes <span class="text-stone-400 dark:text-stone-500 font-normal">(optional — away days, constraints)</span>
            </span>
          </label>
          {#if hasNotes}
            <textarea
              id="sched-notes"
              rows="2"
              bind:value={prefs.notes}
              placeholder="e.g. away Oct 20–24; prefer lighter Fridays"
              class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none resize-none"
            ></textarea>
          {/if}
        </div>

        <!-- Edit AI Prompt checkbox & textarea -->
        <div class="space-y-1.5">
          <label class="flex items-center space-x-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              bind:checked={isEditingPrompt}
              class="w-4 h-4 rounded border-stone-300 dark:border-stone-700 text-stone-900 dark:bg-stone-800 focus:ring-stone-400"
            />
            <span class="text-xs font-medium text-stone-700 dark:text-stone-300">
              Edit AI Prompt <span class="text-stone-400 dark:text-stone-500 font-normal">(customize system prompt template)</span>
            </span>
          </label>
          {#if isEditingPrompt}
            <div class="space-y-1.5 pt-1">
              <textarea
                id="sched-prompt"
                rows="5"
                bind:value={editablePrompt}
                placeholder="Custom schedule prompt template..."
                class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none resize-y font-mono text-[11px] leading-relaxed"
              ></textarea>
              {#if defaultPromptTemplate && editablePrompt !== defaultPromptTemplate}
                <div class="flex justify-end">
                  <button
                    type="button"
                    onclick={() => (editablePrompt = defaultPromptTemplate)}
                    class="text-[11px] text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 underline cursor-pointer"
                  >
                    Reset to default prompt
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        {#if validationError}
          <div class="flex items-start space-x-2 p-2.5 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">
            <AlertCircle class="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{validationError}</span>
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-end space-x-2 pt-3 border-t border-stone-100 dark:border-stone-800">
        <button
          onclick={onClose}
          class="px-3.5 py-2 rounded-lg border border-stone-200 dark:border-stone-700 text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          Cancel
        </button>
        <button
          onclick={handleGenerate}
          class="px-4 py-2 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-sm cursor-pointer"
        >
          Build Schedule
        </button>
      </div>
    </div>
  </div>
{/if}
