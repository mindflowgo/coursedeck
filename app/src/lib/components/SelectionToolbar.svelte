<script lang="ts">
  import { Sparkles, X, Loader2, ArrowRight, Lightbulb, Scale, BookOpen, HelpCircle } from 'lucide-svelte';
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    containerSelector?: string; // CSS selector of content area to observe
    isGenerating?: boolean;
    onSubmitQuery: (selectedText: string, query: string) => Promise<void>;
  }

  let { containerSelector = '.markdown-body', isGenerating = false, onSubmitQuery }: Props = $props();

  let selectedText = $state('');
  let isToolbarVisible = $state(false);
  let isPromptOpen = $state(false);
  let userQuery = $state('');
  let toolbarCoords = $state({ top: 0, left: 0 });

  const QUICK_PROMPTS = [
    { label: 'Explain simply', prompt: 'Explain this in simple terms with a clear breakdown.' },
    { label: 'Why significant?', prompt: 'What is the legal and curriculum significance of this concept in Ontario?' },
    { label: 'Exam takeaway', prompt: 'What is the most likely way this is tested on an exam?' },
    { label: 'Real-world example', prompt: 'Provide a concrete real-world Canadian example illustrating this.' }
  ];

  function handleSelectionChange() {
    if (isPromptOpen || isGenerating) return; // Don't interrupt while typing query or generating

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      isToolbarVisible = false;
      return;
    }

    const text = selection.toString().trim();
    if (text.length < 3) {
      isToolbarVisible = false;
      return;
    }

    // Check if selection is within target container
    const anchorNode = selection.anchorNode;
    if (!anchorNode) return;

    const container = document.querySelector(containerSelector);
    if (!container || !container.contains(anchorNode)) {
      isToolbarVisible = false;
      return;
    }

    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      selectedText = text;
      // Position above selection center (using pure viewport coordinates for fixed positioning)
      const topPos = rect.top - 44 < 12 ? rect.bottom + 8 : rect.top - 44;
      const leftPos = Math.max(48, Math.min(window.innerWidth - 48, rect.left + rect.width / 2));
      toolbarCoords = {
        top: Math.round(topPos),
        left: Math.round(leftPos)
      };
      isToolbarVisible = true;
    } catch {
      isToolbarVisible = false;
    }
  }

  function handleOpenPrompt() {
    isToolbarVisible = false;
    isPromptOpen = true;
  }

  function handleClosePrompt() {
    isPromptOpen = false;
    isToolbarVisible = false;
    selectedText = '';
    userQuery = '';
  }

  async function handleSend(queryToSubmit?: string) {
    const q = (queryToSubmit || userQuery).trim();
    if (!q || !selectedText) return;

    try {
      await onSubmitQuery(selectedText, q);
      handleClosePrompt();
    } catch (e) {
      console.error('Failed to submit annotation query:', e);
    }
  }

  function handleSelectChip(chipPrompt: string) {
    userQuery = chipPrompt;
    handleSend(chipPrompt);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isPromptOpen) {
      handleClosePrompt();
    }
  }

  onMount(() => {
    document.addEventListener('selectionchange', handleSelectionChange);
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('selectionchange', handleSelectionChange);
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Floating Pill Trigger Button -->
{#if isToolbarVisible && !isPromptOpen}
  <div
    style="top: {toolbarCoords.top}px; left: {toolbarCoords.left}px;"
    class="fixed -translate-x-1/2 z-40 animate-in fade-in zoom-in-95 duration-150"
  >
    <button
      onclick={handleOpenPrompt}
      class="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-stone-900 text-white text-xs font-medium shadow-lg hover:bg-stone-800 transition transform hover:scale-105 active:scale-95 border border-stone-700/50 cursor-pointer"
      title="Ask AI a question about this highlighted text"
    >
      <Sparkles class="w-3.5 h-3.5 text-amber-400" />
      <span>Ask AI</span>
    </button>
  </div>
{/if}

<!-- AI Annotation Prompt Popover Modal -->
{#if isPromptOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
    <!-- Backdrop dismiss -->
    <button
      type="button"
      class="absolute inset-0 w-full h-full cursor-default"
      onclick={handleClosePrompt}
      aria-label="Close modal overlay"
      tabindex="-1"
    ></button>

    <div class="relative z-10 bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 shadow-2xl max-w-lg w-full p-5 space-y-4 animate-in zoom-in-95 duration-150">
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-stone-100 dark:border-stone-800 pb-3">
        <div class="flex items-center space-x-2">
          <div class="p-1.5 rounded-lg bg-stone-900 dark:bg-stone-800 text-white dark:text-stone-200">
            <Sparkles class="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <h3 class="text-sm font-semibold text-stone-900 dark:text-stone-100">Add AI Post-It Note</h3>
            <p class="text-[11px] text-stone-500 dark:text-stone-400">Ask a question or request explanation for this excerpt</p>
          </div>
        </div>

        <button
          onclick={handleClosePrompt}
          class="p-1 rounded-md text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Selected Excerpt Quote Preview -->
      <div class="p-3 rounded-xl bg-stone-50 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700/60 text-xs text-stone-700 dark:text-stone-300 italic max-h-24 overflow-y-auto leading-relaxed border-l-3 border-l-amber-500">
        "{selectedText}"
      </div>

      <!-- Quick Prompt Chips -->
      <div class="space-y-1.5">
        <div class="text-[11px] font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
          Quick Questions
        </div>
        <div class="flex flex-wrap gap-1.5">
          {#each QUICK_PROMPTS as chip}
            <button
              onclick={() => handleSelectChip(chip.prompt)}
              disabled={isGenerating}
              class="px-2.5 py-1 rounded-lg border border-stone-200 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500 hover:bg-stone-50 dark:hover:bg-stone-800 bg-white dark:bg-stone-800/50 text-[11px] text-stone-700 dark:text-stone-300 font-medium transition cursor-pointer disabled:opacity-50"
            >
              {chip.label}
            </button>
          {/each}
        </div>
      </div>

      <!-- Custom Query Textarea -->
      <div class="space-y-1">
        <label for="annotation-query-input" class="text-[11px] font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
          Custom Question
        </label>
        <textarea
          id="annotation-query-input"
          bind:value={userQuery}
          rows="3"
          placeholder="e.g. Why is this precedent critical in Canadian constitutional law?"
          class="w-full p-2.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 resize-none"
        ></textarea>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-between pt-2 border-t border-stone-100 dark:border-stone-800">
        <button
          onclick={handleClosePrompt}
          class="px-3 py-1.5 rounded-lg text-xs font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          Cancel
        </button>

        <button
          onclick={() => handleSend()}
          disabled={isGenerating || !userQuery.trim()}
          class="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50 text-white dark:text-stone-900 text-xs font-medium transition shadow-2xs cursor-pointer"
        >
          {#if isGenerating}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>Generating Note...</span>
          {:else}
            <Sparkles class="w-3.5 h-3.5 text-amber-400" />
            <span>Generate & Insert Note</span>
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
