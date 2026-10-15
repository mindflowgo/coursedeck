<script lang="ts">
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

  interface Props {
    isOpen: boolean;
    onClose: () => void;
    /** Called with the composed system prompt (template + preferences) and preferences object. */
    onGenerate: (promptWithPreferences: string, preferences?: SchedulePreferences) => void;
    promptTemplate: string;
    courseTitle?: string;
  }

  let { isOpen, onClose, onGenerate, promptTemplate, courseTitle }: Props = $props();

  let prefs = $state<SchedulePreferences>(defaultSchedulePreferences());
  let validationError = $state<string | null>(null);

  // Blackout date accordion & addition inputs
  let isBlackoutExpanded = $state(false);
  let newBlackoutStart = $state('');
  let newBlackoutEnd = $state('');
  let newBlackoutLabel = $state('');
  let blackoutError = $state<string | null>(null);

  $effect(() => {
    if (isOpen) {
      prefs = loadStoredSchedulePreferences() ?? defaultSchedulePreferences();
      validationError = null;
      blackoutError = null;
      newBlackoutStart = '';
      newBlackoutEnd = '';
      newBlackoutLabel = '';
      isBlackoutExpanded = false;
    }
  });

  function toggleDay(day: number) {
    if (prefs.studyDays.includes(day)) {
      prefs.studyDays = prefs.studyDays.filter((d) => d !== day);
    } else {
      prefs.studyDays = [...prefs.studyDays, day];
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
    if (!promptTemplate || promptTemplate.trim().length === 0) {
      validationError = 'Core prompt template for course schedule is missing. Please add or verify course_schedule_enrichment.md in Prompts before generating.';
      return;
    }
    storeSchedulePreferences(prefs);
    onGenerate(buildSchedulePrompt(promptTemplate, prefs), prefs);
    onClose();
  }
</script>

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs">
    <div class="w-full max-w-lg rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
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

        <!-- Study days -->
        <div class="space-y-1.5">
          <span class="text-xs font-medium text-stone-700 dark:text-stone-300">Study days</span>
          <div class="flex flex-wrap gap-1.5">
            {#each WEEKDAY_LABELS as label, day}
              <button
                type="button"
                onclick={() => toggleDay(day)}
                class="px-2.5 py-1.5 rounded-lg border text-xs font-medium transition cursor-pointer {prefs.studyDays.includes(day)
                  ? 'border-stone-900 dark:border-stone-100 bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900'
                  : 'border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-300 dark:hover:border-stone-500'}"
              >
                {label}
              </button>
            {/each}
          </div>
        </div>

        <!-- Session length + sessions per day -->
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="sched-length" class="text-xs font-medium text-stone-700 dark:text-stone-300">Session length</label>
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
            <label for="sched-perday" class="text-xs font-medium text-stone-700 dark:text-stone-300">Sessions / study day</label>
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

        <!-- Pace -->
        <div class="space-y-1.5">
          <span class="text-xs font-medium text-stone-700 dark:text-stone-300">Pace</span>
          <div class="flex gap-1.5">
            <button
              type="button"
              onclick={() => (prefs.paceMode = 'steady')}
              class="flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition cursor-pointer {prefs.paceMode === 'steady'
                ? 'border-stone-900 dark:border-stone-100 bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900'
                : 'border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-300 dark:hover:border-stone-500'}"
            >
              Steady pace
            </button>
            <button
              type="button"
              onclick={() => (prefs.paceMode = 'target')}
              class="flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition cursor-pointer {prefs.paceMode === 'target'
                ? 'border-stone-900 dark:border-stone-100 bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900'
                : 'border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-300 dark:hover:border-stone-500'}"
            >
              Target end date
            </button>
          </div>
          {#if prefs.paceMode === 'target'}
            <input
              type="date"
              bind:value={prefs.targetEndDate}
              class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none"
            />
          {/if}
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
          <p class="text-[11px] text-stone-500 dark:text-stone-400 pl-6.5">
            Inserts buffer sessions to prevent falling behind on unexpected delays.
          </p>
        </div>

        <!-- Review sessions toggle + intensity -->
        <div class="space-y-1.5">
          <span class="text-xs font-medium text-stone-700 dark:text-stone-300">Schedule review time?</span>
          <div class="flex gap-1.5">
            <button
              type="button"
              onclick={() => (prefs.includeReviews = true)}
              class="flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition cursor-pointer {prefs.includeReviews
                ? 'border-stone-900 dark:border-stone-100 bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900'
                : 'border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-300 dark:hover:border-stone-500'}"
            >
              Yes — schedule reviews
            </button>
            <button
              type="button"
              onclick={() => (prefs.includeReviews = false)}
              class="flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition cursor-pointer {!prefs.includeReviews
                ? 'border-stone-900 dark:border-stone-100 bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900'
                : 'border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-300 dark:hover:border-stone-500'}"
            >
              No — study sessions only
            </button>
          </div>
          {#if prefs.includeReviews}
            <select
              id="sched-review"
              bind:value={prefs.reviewIntensity}
              class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none cursor-pointer"
            >
              <option value="light">Light — short recall checks</option>
              <option value="standard">Standard — review 2–3 days after each lesson</option>
              <option value="heavy">Heavy — frequent reviews + weekly recaps</option>
            </select>
          {/if}
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

        <!-- Notes -->
        <div class="space-y-1">
          <label for="sched-notes" class="text-xs font-medium text-stone-700 dark:text-stone-300">Notes <span class="text-stone-400">(optional — away days, constraints)</span></label>
          <textarea
            id="sched-notes"
            rows="2"
            bind:value={prefs.notes}
            placeholder="e.g. away Oct 20–24; prefer lighter Fridays"
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none resize-none"
          ></textarea>
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
