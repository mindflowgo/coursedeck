<script lang="ts">
  import { Flag, X, AlertCircle, Loader2, BookOpen, MapPin, Check } from 'lucide-svelte';
  import { CHECKPOINT_COLORS, DEFAULT_CHECKPOINT_COLOR, MAX_LESSON_CHECKPOINTS, getCheckpointColor } from '$lib/checkpoints';
  import { createCheckpointRequest } from '$lib/studyStateClient';
  import type { CheckpointKind, StudyState } from '$lib/studyStateTypes';

  interface Props {
    isOpen: boolean;
    courseId: string;
    lessonId: string;
    lessonTitle: string;
    /** Text snippet of the current reading location, captured when the modal opened. */
    locationAnchor: string | null;
    lessonCheckpointCount: number;
    onClose: () => void;
    onCreated: (state: StudyState) => void;
  }

  let {
    isOpen,
    courseId,
    lessonId,
    lessonTitle,
    locationAnchor,
    lessonCheckpointCount,
    onClose,
    onCreated
  }: Props = $props();

  let kind = $state<CheckpointKind>('lesson');
  let label = $state('');
  let color = $state(DEFAULT_CHECKPOINT_COLOR);
  let error = $state<string | null>(null);
  let isSaving = $state(false);

  let atLessonLimit = $derived(lessonCheckpointCount >= MAX_LESSON_CHECKPOINTS);
  let canUseLocation = $derived(Boolean(locationAnchor));
  let canSubmit = $derived(!((kind === 'lesson' && atLessonLimit) || (kind === 'location' && !canUseLocation)));

  function defaultLabel(forKind: CheckpointKind): string {
    if (forKind === 'location') return locationAnchor ? locationAnchor.slice(0, 40) : 'Location';
    return lessonTitle || `Lesson ${lessonId}`;
  }

  $effect(() => {
    if (isOpen) {
      kind = atLessonLimit && canUseLocation ? 'location' : 'lesson';
      label = defaultLabel(kind);
      color = DEFAULT_CHECKPOINT_COLOR;
      error = null;
      isSaving = false;
    }
  });

  function chooseKind(next: CheckpointKind) {
    if (next === kind) return;
    // Keep a user-typed name only if it was not just the previous default.
    if (label.trim() === '' || label === defaultLabel(kind)) label = defaultLabel(next);
    kind = next;
  }

  async function handleCreate() {
    const name = label.trim();
    if (!name) {
      error = 'Give the checkpoint a name.';
      return;
    }
    if (kind === 'location' && !locationAnchor) {
      error = 'Could not determine your current location in this lesson.';
      return;
    }
    error = null;
    isSaving = true;
    const outcome = await createCheckpointRequest(courseId, {
      lessonId,
      kind,
      anchor: kind === 'location' ? locationAnchor : null,
      label: name,
      color
    });
    isSaving = false;
    if (outcome.ok && outcome.state) {
      onCreated(outcome.state);
      onClose();
    } else {
      error = outcome.error || 'Could not create the checkpoint.';
    }
  }
</script>

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs">
    <div class="w-full max-w-md rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150">
      <!-- Header -->
      <div class="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2.5">
          <div class="p-2 rounded-xl bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200 shadow-2xs">
            <Flag class="w-4 h-4" />
          </div>
          <div>
            <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">Add Checkpoint</h2>
            <p class="text-[11px] text-stone-500 dark:text-stone-400 truncate max-w-[240px]">
              {lessonTitle || `Lesson ${lessonId}`}
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
        <!-- Kind -->
        <div class="space-y-1.5">
          <span class="text-xs font-medium text-stone-700 dark:text-stone-300">Checkpoint</span>
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              onclick={() => chooseKind('lesson')}
              disabled={atLessonLimit}
              title={atLessonLimit ? `This lesson already has ${MAX_LESSON_CHECKPOINTS} checkpoints` : 'Flag the whole lesson'}
              class="flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed {kind === 'lesson' ? 'border-stone-900 dark:border-stone-100 bg-stone-900/5 dark:bg-white/10' : 'border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800'}"
            >
              <BookOpen class="w-4 h-4 text-stone-500 dark:text-stone-400" />
              <span class="text-xs font-medium text-stone-900 dark:text-stone-100">Whole lesson</span>
              <span class="text-[10px] text-stone-500 dark:text-stone-400">Flags the lesson in your menus</span>
            </button>

            <button
              type="button"
              onclick={() => chooseKind('location')}
              disabled={!canUseLocation}
              title={canUseLocation ? 'Flag your current reading position' : 'No readable location here'}
              class="flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed {kind === 'location' ? 'border-stone-900 dark:border-stone-100 bg-stone-900/5 dark:bg-white/10' : 'border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800'}"
            >
              <MapPin class="w-4 h-4 text-stone-500 dark:text-stone-400" />
              <span class="text-xs font-medium text-stone-900 dark:text-stone-100">Current location</span>
              <span class="text-[10px] text-stone-500 dark:text-stone-400">Divider where you are now</span>
            </button>
          </div>
          {#if atLessonLimit}
            <p class="text-[10px] text-amber-600 dark:text-amber-400">
              This lesson already has the maximum of {MAX_LESSON_CHECKPOINTS} lesson checkpoints.
            </p>
          {/if}
        </div>

        <!-- Name -->
        <div class="space-y-1">
          <label for="checkpoint-name" class="text-xs font-medium text-stone-700 dark:text-stone-300">Name</label>
          <input
            id="checkpoint-name"
            type="text"
            bind:value={label}
            maxlength="60"
            placeholder="e.g. Review before quiz"
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none"
          />
        </div>

        <!-- Colour -->
        <div class="space-y-1.5">
          <span class="text-xs font-medium text-stone-700 dark:text-stone-300">Colour</span>
          <div class="flex flex-wrap gap-2">
            {#each CHECKPOINT_COLORS as option (option.id)}
              <button
                type="button"
                onclick={() => (color = option.id)}
                title={option.label}
                aria-label={option.label}
                class="relative w-6 h-6 rounded-full {option.swatch} ring-offset-2 ring-offset-white dark:ring-offset-stone-900 transition cursor-pointer {color === option.id ? `ring-2 ${option.ring}` : 'hover:scale-110'}"
              >
                {#if color === option.id}
                  <Check class="absolute inset-0 m-auto w-3.5 h-3.5 text-white" />
                {/if}
              </button>
            {/each}
          </div>
          <p class="text-[10px] text-stone-400 dark:text-stone-500">
            Preview: <Flag class="inline w-3 h-3 {getCheckpointColor(color).flag}" /> <span class="align-middle">{label.trim() || 'Checkpoint'}</span>
          </p>
        </div>

        {#if error}
          <div class="flex items-start space-x-2 p-2.5 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">
            <AlertCircle class="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-end space-x-2 pt-3 border-t border-stone-100 dark:border-stone-800">
        <button
          onclick={onClose}
          disabled={isSaving}
          class="px-3.5 py-2 rounded-lg border border-stone-200 dark:border-stone-700 text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition cursor-pointer disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onclick={handleCreate}
          disabled={isSaving || !canSubmit}
          class="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {#if isSaving}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
          {/if}
          <span>Create</span>
        </button>
      </div>
    </div>
  </div>
{/if}
