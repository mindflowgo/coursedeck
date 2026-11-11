<script lang="ts">
  import { Sparkles, X, Send } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    /** Exact passage the student selected, if any. */
    quote?: string;
    /** Context label shown above the composer (lesson title etc.). */
    contextLabel?: string;
    /** Returning `false` keeps the composer open (e.g. model configuration needed). */
    onSubmit: (question: string) => Promise<void | false> | void | false;
    onClose: () => void;
  }

  let { isOpen = false, quote = '', contextLabel = '', onSubmit, onClose }: Props = $props();

  let question: string = $state('');
  let isSubmitting: boolean = $state(false);
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  $effect(() => {
    if (isOpen) {
      question = '';
      setTimeout(() => textareaEl?.focus(), 50);
    }
  });

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
    if (isSubmitting) return;
    const q = question.trim();
    if (!q) return;
    isSubmitting = true;
    try {
      const result = await onSubmit(q);
      if (result !== false) {
        onClose();
      }
    } finally {
      isSubmitting = false;
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
      aria-label="Close Ask AI composer"
      tabindex="-1"
    ></button>

    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ask AI about this passage"
      class="relative w-full max-w-lg rounded-2xl shadow-2xl border flex flex-col overflow-hidden z-10 bg-white dark:bg-stone-900 border-stone-200 dark:border-stone-800"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-3.5 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2">
          <Sparkles class="w-4 h-4 text-purple-500 shrink-0" />
          <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">Ask AI</h2>
          {#if contextLabel}
            <span class="text-xs text-stone-400 dark:text-stone-500 truncate max-w-48" title={contextLabel}>
              · {contextLabel}
            </span>
          {/if}
        </div>
        <button
          type="button"
          onclick={onClose}
          class="p-1 rounded-lg text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          title="Cancel"
          aria-label="Cancel"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Body -->
      <div class="px-5 py-4 space-y-3">
        {#if quote && quote.trim()}
          <div>
            <div class="text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Selected passage</div>
            <blockquote
              class="text-xs text-stone-700 dark:text-stone-300 border-l-2 border-purple-300 dark:border-purple-700 pl-3 py-1 max-h-28 overflow-y-auto whitespace-pre-wrap"
            >{quote.trim()}</blockquote>
          </div>
        {:else}
          <p class="text-xs text-stone-500 dark:text-stone-400">
            No text selected — your question will be answered using the full lesson context.
          </p>
        {/if}

        <div>
          <label class="text-xs font-medium text-stone-500 dark:text-stone-400 mb-1 block" for="ask-ai-question">
            Your question
          </label>
          <textarea
            id="ask-ai-question"
            bind:this={textareaEl}
            bind:value={question}
            rows="3"
            placeholder="Ask anything about this passage or section…"
            class="w-full text-sm rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800/60 px-3 py-2 text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-purple-400/60 resize-y"
          ></textarea>
        </div>

        <button
          type="button"
          onclick={() => (question = 'Explain this passage')}
          class="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 font-medium transition cursor-pointer"
        >
          Use shortcut: “Explain this passage”
        </button>
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-stone-100 dark:border-stone-800 bg-stone-50/60 dark:bg-stone-900/60">
        <button
          type="button"
          onclick={onClose}
          disabled={isSubmitting}
          class="px-3.5 py-1.5 rounded-xl text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={handleSubmit}
          disabled={isSubmitting || !question.trim()}
          class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer active:scale-95"
        >
          <Send class="w-3.5 h-3.5" />
          {isSubmitting ? 'Asking…' : 'Ask'}
        </button>
      </div>
    </div>
  </div>
{/if}
