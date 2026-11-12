<script lang="ts">
  import { Check, ChevronDown, Trash2, X, FlagTriangleRight } from 'lucide-svelte';
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
    onSave: (data: { color: string; noteText: string }) => Promise<void | false> | void | false;
    onDelete?: () => Promise<void> | void;
    onClose: () => void;
  }

  let { checkpoint = null, isOpen = false, onSave, onDelete, onClose }: Props = $props();

  let selectedColorId: string = $state(DEFAULT_CHECKPOINT_COLOR);
  let noteText: string = $state('');
  let isSaving: boolean = $state(false);
  let isColorDropdownOpen: boolean = $state(false);
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  $effect(() => {
    if (isOpen) {
      selectedColorId = checkpoint?.color || DEFAULT_CHECKPOINT_COLOR;
      noteText = checkpoint?.noteText || checkpoint?.aiAnswer || '';
      isColorDropdownOpen = false;
      isConfirmingDelete = false;
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
      if (isColorDropdownOpen) {
        isColorDropdownOpen = false;
        return;
      }
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
      const result = await onSave({
        color: selectedColorId,
        noteText: noteText.trim()
      });
      if (result !== false) onClose();
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
      tabindex="-1"
    ></button>

    <!-- Modal Card with Post-it styled note surface -->
    <div
      class="relative w-full max-w-[420px] rounded-2xl shadow-2xl border transition-colors flex flex-col z-10 bg-white dark:bg-stone-900 border-stone-200 dark:border-stone-800"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-stone-100 dark:border-stone-800 rounded-t-2xl">
        <div class="flex items-center space-x-2">
          <FlagTriangleRight
            class="w-4 h-4 shrink-0 transition-colors"
            style="color: {activeColor.dot}; fill: {activeColor.dot};"
          />
          <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {checkpoint?.id ? 'Edit Note' : checkpoint?.selection?.text ? 'Note on Selection' : 'Add Checkpoint Note'}
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
      <div class="p-4 space-y-3">
        {#if checkpoint?.selection?.text}
          <div class="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-200 italic leading-relaxed">
            <span class="not-italic font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider text-[10px] mr-1.5">Selection</span>"{checkpoint.selection.text.length > 200
              ? checkpoint.selection.text.slice(0, 200) + '…'
              : checkpoint.selection.text}"
          </div>
        {/if}

        <!-- Note Header + Color Dropdown -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label for="checkpoint-note-textarea" class="block text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
              Note
            </label>

            <!-- Color Picker Dropdown -->
            <div class="relative">
              <button
                type="button"
                onclick={() => (isColorDropdownOpen = !isColorDropdownOpen)}
                class="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800/80 hover:bg-stone-100 dark:hover:bg-stone-800 text-xs font-medium text-stone-700 dark:text-stone-300 transition cursor-pointer shadow-2xs"
                aria-haspopup="listbox"
                aria-expanded={isColorDropdownOpen}
                title="Choose note color"
              >
                <span
                  class="w-3 h-3 rounded-full shrink-0 border border-black/10 dark:border-white/20"
                  style="background-color: {activeColor.dot};"
                ></span>
                <span class="text-xs font-medium text-stone-700 dark:text-stone-200">{activeColor.label}</span>
                <ChevronDown class="w-3 h-3 text-stone-400 transition-transform duration-150 {isColorDropdownOpen ? 'rotate-180' : ''}" />
              </button>

              {#if isColorDropdownOpen}
                <!-- Backdrop to close on click outside -->
                <div
                  class="fixed inset-0 z-40 cursor-default"
                  onclick={() => (isColorDropdownOpen = false)}
                  aria-hidden="true"
                ></div>

                <!-- Dropdown Menu of Colors -->
                <div
                  class="absolute right-0 top-full mt-1.5 w-64 sm:w-72 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 p-2 animate-in fade-in zoom-in-95 duration-100 select-none"
                  role="listbox"
                  aria-label="Note colors"
                >
                  <div class="grid grid-cols-2 gap-2">
                    <!-- Set 1: Pastel Tones -->
                    <div>
                      <div class="px-2 py-0.5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                        Pastel
                      </div>
                      <div class="space-y-0.5">
                        {#each CHECKPOINT_COLORS.filter((c) => c.set === 1) as color (color.id)}
                          <button
                            type="button"
                            role="option"
                            aria-selected={selectedColorId === color.id}
                            onclick={() => {
                              selectedColorId = color.id;
                              isColorDropdownOpen = false;
                            }}
                            class="w-full flex items-center space-x-1.5 px-2 py-1 rounded-md text-xs transition cursor-pointer text-left {selectedColorId === color.id ? 'bg-stone-100 dark:bg-stone-800 font-semibold text-stone-900 dark:text-stone-100' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100/70 dark:hover:bg-stone-800/70'}"
                          >
                            <span
                              class="w-3 h-3 rounded-full shrink-0 border border-black/10 dark:border-white/20"
                              style="background-color: {color.dot};"
                            ></span>
                            <span class="truncate text-[11px]">{color.label}</span>
                            {#if selectedColorId === color.id}
                              <Check class="w-3 h-3 ml-auto shrink-0 text-stone-600 dark:text-stone-300" />
                            {/if}
                          </button>
                        {/each}
                      </div>
                    </div>

                    <!-- Set 2: Vibrant Tones -->
                    <div class="border-l border-stone-100 dark:border-stone-800 pl-2">
                      <div class="px-2 py-0.5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                        Vibrant
                      </div>
                      <div class="space-y-0.5">
                        {#each CHECKPOINT_COLORS.filter((c) => c.set === 2) as color (color.id)}
                          <button
                            type="button"
                            role="option"
                            aria-selected={selectedColorId === color.id}
                            onclick={() => {
                              selectedColorId = color.id;
                              isColorDropdownOpen = false;
                            }}
                            class="w-full flex items-center space-x-1.5 px-2 py-1 rounded-md text-xs transition cursor-pointer text-left {selectedColorId === color.id ? 'bg-stone-100 dark:bg-stone-800 font-semibold text-stone-900 dark:text-stone-100' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100/70 dark:hover:bg-stone-800/70'}"
                          >
                            <span
                              class="w-3 h-3 rounded-full shrink-0 border border-black/10 dark:border-white/20"
                              style="background-color: {color.dot};"
                            ></span>
                            <span class="truncate text-[11px]">{color.label}</span>
                            {#if selectedColorId === color.id}
                              <Check class="w-3 h-3 ml-auto shrink-0 text-stone-600 dark:text-stone-300" />
                            {/if}
                          </button>
                        {/each}
                      </div>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          </div>

          <!-- Post-It Note Text Input -->
          <div
            class="rounded-xl border p-2 transition-colors shadow-inner bg-[var(--note-bg-light)] dark:bg-[var(--note-bg-dark)] border-[var(--note-border-light)] dark:border-[var(--note-border-dark)]"
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
              rows="3"
              placeholder="Write a note at this point in the lesson..."
              class="w-full bg-transparent resize-y text-sm font-medium placeholder:text-stone-500/70 focus:outline-hidden leading-relaxed text-[var(--note-text-light)] dark:text-[var(--note-text-dark)]"
              style="
                --note-text-light: {activeColor.textLight};
                --note-text-dark: {activeColor.textDark};
              "
            ></textarea>
          </div>
          <p class="text-[11px] text-stone-400 dark:text-stone-500 mt-1">
            Press <kbd class="px-1 py-0.5 rounded bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-[10px] font-mono">⌘+Enter</kbd> to save
          </p>
        </div>
      </div>

      <!-- Footer Actions -->
      <div class="flex items-center justify-between px-4 py-2.5 bg-stone-50 dark:bg-stone-900/80 border-t border-stone-100 dark:border-stone-800 rounded-b-2xl">
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
                class="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition cursor-pointer"
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
            class="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onclick={handleSubmit}
            disabled={isSaving}
            class="px-3.5 py-1.5 rounded-lg text-xs font-semibold shadow-xs transition cursor-pointer disabled:opacity-50 hover:brightness-105 active:scale-98"
            style="background-color: {activeColor.dot}; color: {activeColor.isLight ? '#1c1917' : '#ffffff'};"
          >
            {isSaving ? 'Saving…' : checkpoint?.id ? 'Save Changes' : 'Add Note'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
