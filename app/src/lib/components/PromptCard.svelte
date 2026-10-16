<script lang="ts">
  import {
    Sparkles,
    ChevronDown,
    ChevronUp,
    Loader2,
    RotateCcw,
    X
  } from 'lucide-svelte';

  interface Props {
    prompt: string;
    tabName: string;
    isGenerating?: boolean;
    defaultPrompt?: string;
    onChangePrompt: (newPrompt: string) => void;
    onRegenerate: () => void;
    onResetPrompt?: () => void;
    onClose?: () => void;
  }

  let {
    prompt,
    tabName,
    isGenerating = false,
    defaultPrompt = '',
    onChangePrompt,
    onRegenerate,
    onResetPrompt,
    onClose
  }: Props = $props();

  let isExpanded = $state(true);
  let localPrompt = $state('');
  let initialPrompt = $state('');

  $effect(() => {
    localPrompt = prompt;
    initialPrompt = prompt;
  });

  let isModified = $derived.by(() => {
    if (defaultPrompt) {
      return localPrompt.trim() !== defaultPrompt.trim();
    }
    return localPrompt.trim() !== initialPrompt.trim();
  });

  function handleInput(e: Event) {
    const val = (e.target as HTMLTextAreaElement).value;
    localPrompt = val;
    onChangePrompt(val);
  }

  function handleReset() {
    const target = defaultPrompt || initialPrompt;
    localPrompt = target;
    onChangePrompt(target);
    if (onResetPrompt) onResetPrompt();
  }

  function handleRegenerate() {
    if (isGenerating) return;
    onRegenerate();
  }
</script>

<div class="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xs mb-6 overflow-hidden transition">
  <!-- Card Header Bar -->
  <div class="px-4 py-2.5 bg-stone-50/80 dark:bg-stone-800/80 border-b border-stone-200 dark:border-stone-800 flex flex-wrap items-center justify-between gap-3">
    <!-- Left: Title -->
    <div class="flex items-center space-x-2">
      <div class="p-1 rounded-md bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 shadow-2xs">
        <Sparkles class="w-3.5 h-3.5" />
      </div>
      <span class="text-xs font-semibold text-stone-900 dark:text-stone-100">
        {tabName} Prompt
      </span>
    </div>

    <!-- Right: Actions -->
    <div class="flex items-center space-x-1.5">
      {#if isGenerating}
        <span class="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 text-xs font-medium mr-1">
          <Loader2 class="w-3.5 h-3.5 animate-spin" />
          <span>Generating...</span>
        </span>
      {/if}

      <button
        onclick={() => (isExpanded = !isExpanded)}
        class="p-1 rounded-md text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-stone-800 transition cursor-pointer"
        title={isExpanded ? 'Collapse Prompt' : 'Expand Prompt'}
      >
        {#if isExpanded}
          <ChevronUp class="w-4 h-4" />
        {:else}
          <ChevronDown class="w-4 h-4" />
        {/if}
      </button>

      {#if onClose}
        <button
          onclick={onClose}
          class="p-1 rounded-md text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-stone-800 transition cursor-pointer"
          title="Close Prompt"
        >
          <X class="w-4 h-4" />
        </button>
      {/if}
    </div>
  </div>

  <!-- Collapsible Prompt Textarea -->
  {#if isExpanded}
    <div class="p-4 space-y-2 bg-white dark:bg-stone-900 border-t border-stone-100 dark:border-stone-800">
      <textarea
        id="prompt-input"
        value={localPrompt}
        oninput={handleInput}
        rows="7"
        placeholder="Enter prompt instructions for generating this study material..."
        class="w-full p-3 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 text-xs font-mono leading-relaxed text-stone-800 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition resize-y"
      ></textarea>

      <div class="flex items-center justify-between text-xs pt-1">
        <div class="flex items-center space-x-2">
          {#if isModified}
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300">
              Prompt modified
            </span>
            <button
              onclick={handleReset}
              class="flex items-center space-x-1 text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 underline text-[11px] cursor-pointer"
            >
              <RotateCcw class="w-3 h-3" />
              <span>Reset</span>
            </button>
          {/if}
        </div>

        <button
          onclick={handleRegenerate}
          disabled={isGenerating}
          class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50 disabled:cursor-not-allowed text-white dark:text-stone-900 text-xs font-medium transition shadow-2xs cursor-pointer"
        >
          {#if isGenerating}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>Generating...</span>
          {:else}
            <Sparkles class="w-3.5 h-3.5" />
            <span>Apply & Re-generate</span>
          {/if}
        </button>
      </div>
    </div>
  {/if}
</div>
