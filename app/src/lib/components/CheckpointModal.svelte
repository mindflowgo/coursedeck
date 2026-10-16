<script lang="ts">
  import { Check, Trash2, X, FlagTriangleRight } from 'lucide-svelte';
  import {
    CHECKPOINT_COLORS,
    DEFAULT_CHECKPOINT_COLOR,
    getCheckpointColor,
    type Checkpoint,
    type CheckpointColor
  } from '$lib/checkpoint';

  interface Props {
    checkpoint?: Partial<Checkpoint> | null;
    isOpen: boolean;
    onSave: (data: { color: string; noteText: string }) => Promise<void> | void;
    onDelete?: () => Promise<void> | void;
    onClose: () => void;
  }

  let { checkpoint = null, isOpen = false, onSave, onDelete, onClose }: Props = $props();

  let selectedColorId: string = $state(DEFAULT_CHECKPOINT_COLOR);
  let noteText: string = $state('');
  let isSaving: boolean = $state(false);
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  $effect(() => {
    if (isOpen) {
      selectedColorId = checkpoint?.color || DEFAULT_CHECKPOINT_COLOR;
      noteText = checkpoint?.noteText || '';
      setTimeout(() => {
        textareaEl?.focus();
      }, 50);
    }
  });

  let activeColor: CheckpointColor = $derived(getCheckpointColor(selectedColorId));

  function handleKeydown(e: KeyboardEvent) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handleSubmit() {
    if (isSaving) return;
    isSaving = true;
    try {
      await onSave({
        color: selectedColorId,
        noteText: noteText.trim()
      });
      onClose();
    } finally {
      isSaving = false;
    }
  }

  let isConfirmingDelete: boolean = $state(false);

  async function handleDelete() {
    if (!onDelete || isSaving) return;
    if (noteText.trim() && !isConfirmingDelete) {
      isConfirmingDelete = true;
      return;
    }
    isSaving = true;
    try {
      await onDelete();
      onClose();
    } finally {
      isSaving = false;
      isConfirmingDelete = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
    <!-- Backdrop dismiss -->
    <button
      type="button"
      class="absolute inset-0 w-full h-full cursor-default"
      onclick={onClose}
      aria-label="Close modal overlay"
    ></button>

    <!-- Modal Card with Post-it styled note surface -->
    <div
      class="relative w-full max-w-md rounded-2xl shadow-2xl border transition-colors flex flex-col overflow-hidden z-10 bg-white dark:bg-stone-900 border-stone-200 dark:border-stone-800"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-3.5 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2">
          <FlagTriangleRight
            class="w-4 h-4 shrink-0 transition-colors"
            style="color: {activeColor.dot}; fill: {activeColor.dot};"
          />
          <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {checkpoint?.id ? 'Edit Checkpoint Note' : 'Add Checkpoint Note'}
          </h2>
        </div>

        <button
          type="button"
          onclick={onClose}
          disabled={isSaving}
          class="p-1 rounded-lg text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          title="Cancel"
          aria-label="Cancel"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- EDIT FORM -->
      <div class="p-5 space-y-4">
        <!-- Color Picker: First set grouped together then second set grouped together -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <label for="color-picker-group" class="block text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
              Colour
            </label>
            <span class="text-[11px] font-medium text-stone-400 dark:text-stone-500">
              {activeColor.label}
            </span>
          </div>

          <div id="color-picker-group" class="flex flex-wrap items-center gap-2.5">
            <!-- Set 1: Pastel Tones Group -->
            <div class="flex items-center space-x-1.5 p-1 rounded-xl bg-stone-100/90 dark:bg-stone-800/80 border border-stone-200/80 dark:border-stone-700/80">
              {#each CHECKPOINT_COLORS.filter((c) => c.set === 1) as color (color.id)}
                <button
                  type="button"
                  onclick={() => (selectedColorId = color.id)}
                  title={`${color.label} (Set 1)`}
                  aria-label={color.label}
                  class="relative w-6 h-6 rounded-full shrink-0 flex items-center justify-center transition-transform hover:scale-110 cursor-pointer focus:outline-hidden"
                  style="background-color: {color.dot};"
                >
                  {#if selectedColorId === color.id}
                    <span
                      class="absolute -inset-1 rounded-full border-2 pointer-events-none"
                      style="border-color: {color.dot};"
                    ></span>
                    <Check class="w-3.5 h-3.5 stroke-[2.8] {color.isLight ? 'text-stone-900' : 'text-white'}" />
                  {/if}
                </button>
              {/each}
            </div>

            <!-- Visual Divider Between Sets -->
            <div class="w-px h-6 bg-stone-200 dark:bg-stone-700 self-center hidden sm:block"></div>

            <!-- Set 2: Vibrant Tones Group -->
            <div class="flex items-center space-x-1.5 p-1 rounded-xl bg-stone-100/90 dark:bg-stone-800/80 border border-stone-200/80 dark:border-stone-700/80">
              {#each CHECKPOINT_COLORS.filter((c) => c.set === 2) as color (color.id)}
                <button
                  type="button"
                  onclick={() => (selectedColorId = color.id)}
                  title={`${color.label} (Set 2)`}
                  aria-label={color.label}
                  class="relative w-6 h-6 rounded-full shrink-0 flex items-center justify-center transition-transform hover:scale-110 cursor-pointer focus:outline-hidden"
                  style="background-color: {color.dot};"
                >
                  {#if selectedColorId === color.id}
                    <span
                      class="absolute -inset-1 rounded-full border-2 pointer-events-none"
                      style="border-color: {color.dot};"
                    ></span>
                    <Check class="w-3.5 h-3.5 stroke-[2.8] {color.isLight ? 'text-stone-900' : 'text-white'}" />
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        </div>

        <!-- Post-It Note Text Input -->
        <div>
          <label for="checkpoint-note-textarea" class="block text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-1.5">
            Note
          </label>
          <div
            class="rounded-xl border p-3 transition-colors shadow-inner bg-[var(--note-bg-light)] dark:bg-[var(--note-bg-dark)] border-[var(--note-border-light)] dark:border-[var(--note-border-dark)]"
            style="
              --note-bg-light: {activeColor.bgLight};
              --note-bg-dark: {activeColor.bgDark};
              --note-border-light: {activeColor.borderLight};
              --note-border-dark: {activeColor.borderDark};
            "
          >
            <textarea
              id="checkpoint-note-textarea"
              bind:this={textareaEl}
              bind:value={noteText}
              rows="4"
              placeholder="Write a note at this point in the lesson..."
              class="w-full bg-transparent resize-y text-sm font-medium placeholder:text-stone-500/70 focus:outline-hidden leading-relaxed text-[var(--note-text-light)] dark:text-[var(--note-text-dark)]"
              style="
                --note-text-light: {activeColor.textLight};
                --note-text-dark: {activeColor.textDark};
              "
            ></textarea>
          </div>
          <p class="text-[11px] text-stone-400 dark:text-stone-500 mt-1.5 flex justify-between">
            <span>Press <kbd class="px-1 py-0.5 rounded bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-[10px] font-mono">⌘+Enter</kbd> to save</span>
            <span>Position: {Math.round(checkpoint?.verticalPosition ?? 0)}px</span>
          </p>
        </div>
      </div>

      <!-- Footer Actions -->
      <div class="flex items-center justify-between px-5 py-3.5 bg-stone-50 dark:bg-stone-900/80 border-t border-stone-100 dark:border-stone-800">
        <div>
          {#if checkpoint?.id && onDelete}
            {#if isConfirmingDelete}
              <div class="flex items-center space-x-1.5">
                <span class="text-xs text-rose-600 dark:text-rose-400 font-semibold">Delete note?</span>
                <button
                  type="button"
                  onclick={handleDelete}
                  disabled={isSaving}
                  class="px-2 py-1 rounded text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white transition cursor-pointer"
                >
                  Yes, Delete
                </button>
                <button
                  type="button"
                  onclick={() => (isConfirmingDelete = false)}
                  disabled={isSaving}
                  class="px-2 py-1 rounded text-xs font-medium text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800 transition cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            {:else}
              <button
                type="button"
                onclick={handleDelete}
                disabled={isSaving}
                class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition cursor-pointer"
              >
                <Trash2 class="w-3.5 h-3.5" />
                <span>Delete</span>
              </button>
            {/if}
          {/if}
        </div>

        <div class="flex items-center space-x-2">
          <button
            type="button"
            onclick={onClose}
            disabled={isSaving}
            class="px-3.5 py-1.5 rounded-lg text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onclick={handleSubmit}
            disabled={isSaving}
            class="px-4 py-1.5 rounded-lg text-xs font-semibold shadow-xs transition cursor-pointer disabled:opacity-50 hover:brightness-105 active:scale-98"
            style="background-color: {activeColor.dot}; color: {activeColor.isLight ? '#1c1917' : '#ffffff'};"
          >
            {isSaving ? 'Saving…' : checkpoint?.id ? 'Save Changes' : 'Add Note'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
