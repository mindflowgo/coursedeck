<script lang="ts">
  import { PenLine, X, AlertCircle, Loader2 } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
    /** Persist the new metadata; resolve false to surface an error in the modal. */
    onSave: (title: string, description: string) => Promise<boolean>;
    courseId: string;
    title: string;
    description: string;
  }

  let { isOpen, onClose, onSave, courseId, title, description }: Props = $props();

  let titleValue = $state('');
  let descriptionValue = $state('');
  let validationError = $state<string | null>(null);
  let isSaving = $state(false);

  $effect(() => {
    if (isOpen) {
      titleValue = title;
      descriptionValue = description;
      validationError = null;
      isSaving = false;
    }
  });

  async function handleSave() {
    const trimmedTitle = titleValue.trim();
    if (!trimmedTitle) {
      validationError = 'Course name cannot be empty.';
      return;
    }
    validationError = null;
    isSaving = true;
    const ok = await onSave(trimmedTitle, descriptionValue.trim());
    isSaving = false;
    if (ok) onClose();
    else validationError = 'Could not save — please try again.';
  }
</script>

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs">
    <div class="w-full max-w-md rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150">
      <!-- Header -->
      <div class="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2.5">
          <div class="p-2 rounded-xl bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200 shadow-2xs">
            <PenLine class="w-4 h-4" />
          </div>
          <div>
            <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">Rename Course</h2>
            <p class="text-[11px] font-mono uppercase tracking-wide text-stone-500 dark:text-stone-400">
              {courseId}
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
        <div class="space-y-1">
          <label for="rename-title" class="text-xs font-medium text-stone-700 dark:text-stone-300">Course name</label>
          <input
            id="rename-title"
            type="text"
            bind:value={titleValue}
            placeholder="e.g. Introduction to Accounting"
            maxlength="120"
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-stone-400 outline-none"
          />
          <p class="text-[10px] text-stone-400">
            The course code badge is shown separately — no need to repeat it in the name.
          </p>
        </div>

        <div class="space-y-1">
          <label for="rename-description" class="text-xs font-medium text-stone-700 dark:text-stone-300">
            Description <span class="text-stone-400">(optional)</span>
          </label>
          <textarea
            id="rename-description"
            rows="3"
            bind:value={descriptionValue}
            placeholder="Short description shown in course listings and AI prompts"
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
          disabled={isSaving}
          class="px-3.5 py-2 rounded-lg border border-stone-200 dark:border-stone-700 text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition cursor-pointer disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onclick={handleSave}
          disabled={isSaving}
          class="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-sm cursor-pointer disabled:opacity-50"
        >
          {#if isSaving}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
          {/if}
          <span>Save</span>
        </button>
      </div>
    </div>
  </div>
{/if}
