<script lang="ts">
  import { FlagTriangleRight, Edit3, Trash2, Sparkles, Highlighter } from 'lucide-svelte';
  import {
    formatCheckpointDate,
    getCheckpointColor,
    type Checkpoint,
    type CheckpointColor
  } from '$lib/checkpoint';
  import { renderTextWithMath } from '$lib/markdown/mathRenderer';
  import DOMPurify from 'dompurify';

  interface Props {
    checkpoint: Checkpoint;
    /** Override pixel top position (computed from anchor at render time). Falls back to checkpoint.verticalPosition. */
    resolvedTop?: number;
    isOpen?: boolean;
    isActive?: boolean;
    side?: 'left' | 'right';
    onToggle?: (checkpoint: Checkpoint) => void;
    onEdit?: (checkpoint: Checkpoint) => void;
    onDelete?: (checkpoint: Checkpoint) => void;
    onClose?: (checkpoint: Checkpoint) => void;
    onClick?: (checkpoint: Checkpoint) => void;
    /** Retry a failed AI generation for this checkpoint. */
    onRetryAi?: (checkpoint: Checkpoint) => void;
  }

  let {
    checkpoint,
    resolvedTop,
    isOpen = false,
    isActive = false,
    side = 'right',
    onToggle,
    onEdit,
    onDelete,
    onClick,
    onRetryAi
  }: Props = $props();

  let color: CheckpointColor = $derived(getCheckpointColor(checkpoint.color));
  let formattedDate: string = $derived(formatCheckpointDate(checkpoint.date));
  let isConfirmingDelete: boolean = $state(false);

  $effect(() => {
    if (!isOpen) {
      isConfirmingDelete = false;
    }
  });

  function handleDotClick() {
    if (onToggle) {
      onToggle(checkpoint);
    } else if (onClick) {
      onClick(checkpoint);
    }
  }

  function handleEditClick(e: MouseEvent) {
    e.stopPropagation();
    onEdit?.(checkpoint);
  }

  function handleStartDelete(e: MouseEvent) {
    console.log('[CheckpointMarker] handleStartDelete fired', { checkpoint });
    e.stopPropagation();
    if (checkpoint.type === 'highlight' || !checkpoint.noteText?.trim()) {
      console.log('[CheckpointMarker] invoking onDelete for highlight', checkpoint.id);
      onDelete?.(checkpoint);
      return;
    }
    isConfirmingDelete = true;
  }

  function handleCancelDelete(e: MouseEvent) {
    e.stopPropagation();
    isConfirmingDelete = false;
  }

  function handleConfirmDelete(e: MouseEvent) {
    e.stopPropagation();
    isConfirmingDelete = false;
    onDelete?.(checkpoint);
  }

  function renderContent(text?: string): string {
    if (!text) return '';
    const rendered = renderTextWithMath(text);
    if (typeof window === 'undefined') return rendered;
    const purify = typeof DOMPurify.sanitize === 'function' ? DOMPurify : (DOMPurify as any)(window);
    if (!purify || typeof purify.sanitize !== 'function') return rendered;
    return purify.sanitize(rendered, {
      ADD_TAGS: ['details', 'summary', 'mark']
    });
  }
</script>

<div
  class="absolute {side === 'left' ? 'left-2 sm:left-3' : 'right-2 sm:right-3'} z-40 flex items-center"
  data-checkpoint-marker
  data-pencilkit-exclude
  style="top: {resolvedTop ?? checkpoint.verticalPosition}px; transform: translateY(-50%);"
>
  <!-- Circular Marker Dot + Date -->
  <div class="relative flex items-center justify-center w-9 h-9">
    <!-- ABOVE in light grey letters the date -->
    {#if formattedDate}
      <span
        class="absolute bottom-full mb-1 right-0 whitespace-nowrap text-[10px] text-stone-400 dark:text-stone-500 select-none leading-none pointer-events-none"
      >
        {formattedDate}
      </span>
    {/if}

    <!-- Larger circular DOT (36px) -->
    <button
      type="button"
      onclick={handleDotClick}
      class="w-9 h-9 rounded-full flex items-center justify-center shadow-lg border-[2.5px] border-white dark:border-stone-900 transition-all cursor-pointer focus:outline-hidden hover:scale-110 active:scale-95 {isOpen || isActive ? 'scale-105 ring-2 ring-stone-400 dark:ring-stone-500 ring-offset-2 dark:ring-offset-stone-900' : ''}"
      style="background-color: {color.dot};"
      title={isOpen ? 'Close note' : checkpoint.noteText ? `Checkpoint (${formattedDate}): ${checkpoint.noteText}` : `Checkpoint (${formattedDate})`}
      aria-label={isOpen ? 'Close checkpoint note' : `Open checkpoint note from ${formattedDate}`}
    >
      {#if checkpoint.type === 'ai'}
        <Sparkles class="w-4 h-4 drop-shadow-xs {color.isLight ? 'text-stone-900' : 'text-white'}" />
      {:else if checkpoint.type === 'highlight'}
        <Highlighter class="w-4 h-4 drop-shadow-xs {color.isLight ? 'text-stone-900' : 'text-white'}" />
      {:else}
        <FlagTriangleRight
          class="w-5 h-5 drop-shadow-xs {color.isLight ? 'text-stone-900 fill-stone-900' : 'text-white fill-white'}"
        />
      {/if}
    </button>
  </div>

  <!-- Non-editable Overlay Post-It Note expanding to the left -->
  {#if isOpen}
    <div
      class="absolute {side === 'left' ? 'left-[calc(100%+12px)]' : 'right-[calc(100%+12px)]'} top-1/2 -translate-y-1/2 max-w-[calc(100vw-4.5rem)] {checkpoint.type === 'ai' ? 'w-[320px] sm:w-[380px] min-h-[120px] max-h-[340px]' : 'w-[250px] min-h-[100px] max-h-[240px]'} rounded-xl border shadow-xl flex flex-col overflow-hidden z-30 transition-all select-text bg-[var(--note-bg-light)] dark:bg-[var(--note-bg-dark)] border-[var(--note-border-light)] dark:border-[var(--note-border-dark)] text-[var(--note-text-light)] dark:text-[var(--note-text-dark)]"
      style="
        --note-bg-light: {color.bgLight};
        --note-bg-dark: {color.bgDark};
        --note-border-light: {color.borderLight};
        --note-border-dark: {color.borderDark};
        --note-text-light: {color.textLight};
        --note-text-dark: {color.textDark};
      "
    >
      <!-- Top colored sticky strip accent -->
      <div class="h-1 w-full shrink-0" style="background-color: {color.dot};"></div>

      <!-- Actions bar overlay in top right: positioned absolutely with z-30 so it can NEVER be obscured by text -->
      <div
        class="absolute top-2 right-2 z-30 flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold select-none bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition-colors border border-black/5 dark:border-white/10 pointer-events-auto"
      >
        {#if isConfirmingDelete}
          <span class="text-rose-600 dark:text-rose-400 font-bold">Delete?</span>
          <button
            type="button"
            onclick={handleConfirmDelete}
            class="px-1 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-bold transition cursor-pointer"
            title="Confirm delete"
          >
            Yes
          </button>
          <button
            type="button"
            onclick={handleCancelDelete}
            class="px-1 py-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition cursor-pointer opacity-70"
            title="Cancel"
          >
            No
          </button>
        {:else}
          {#if checkpoint.type !== 'highlight' && onEdit}
            <button
              type="button"
              onclick={handleEditClick}
              class="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition cursor-pointer"
              title="Edit note"
              aria-label="Edit note"
            ><Edit3 class="w-3 h-3" /></button>
          {/if}

          {#if checkpoint.type !== 'highlight' && onEdit && onDelete}
            <span class="opacity-30">|</span>
          {/if}

          {#if onDelete}
            <button
              type="button"
              onpointerdown={(e) => console.log('[CheckpointMarker] trash pointerdown', e)}
              onclick={(e) => {
                console.log('[CheckpointMarker] trash button clicked', e);
                handleStartDelete(e);
              }}
              class="p-0.5 rounded text-stone-600 dark:text-stone-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer flex items-center justify-center"
              title={checkpoint.type === 'highlight' ? 'Remove highlight' : 'Delete note'}
              aria-label={checkpoint.type === 'highlight' ? 'Remove highlight' : 'Delete note'}
            >
              <Trash2 class="w-3.5 h-3.5 pointer-events-none" />
            </button>
          {/if}
        {/if}
      </div>

      <!-- Note body: scrollable text inside note height, text starts on first line -->
      <div
        class="flex-1 overflow-y-auto px-2.5 py-2 pr-10 text-xs font-medium leading-relaxed select-text break-words scrollbar-thin"
      >

        {#if checkpoint.type === 'ai'}
          {#if checkpoint.aiStatus === 'pending'}
            <div class="flex items-center gap-1.5 text-violet-600 dark:text-violet-400 italic text-[11px] py-1">
              <div class="w-3 h-3 border border-violet-500 border-t-transparent rounded-full animate-spin shrink-0"></div>
              <span>Asking AI…</span>
            </div>
          {:else if checkpoint.aiStatus === 'error'}
            <div class="flex items-center gap-2 py-0.5">
              <span class="text-rose-600 dark:text-rose-400 text-[11px] italic">AI answer failed.</span>
              {#if onRetryAi}
                <button
                  type="button"
                  onclick={(e) => {
                    e.stopPropagation();
                    onRetryAi(checkpoint);
                  }}
                  class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 hover:bg-rose-200 dark:hover:bg-rose-900/60 transition cursor-pointer"
                  title="Retry AI generation"
                >
                  Retry
                </button>
              {/if}
            </div>
            {#if checkpoint.aiAnswer}
              <div class="checkpoint-markdown text-[11px] opacity-70">
                {@html renderContent(checkpoint.aiAnswer)}
              </div>
            {/if}
          {:else}
            <div class="checkpoint-markdown text-[11px] leading-relaxed">
              {@html renderContent(checkpoint.aiAnswer || checkpoint.noteText)}
            </div>
          {/if}
        {:else if checkpoint.type === 'highlight' && checkpoint.selection?.text && !checkpoint.noteText}
          <div class="italic text-[11px] leading-relaxed opacity-80 whitespace-pre-wrap">"{checkpoint.selection.text.length > 120
            ? checkpoint.selection.text.slice(0, 120) + '…'
            : checkpoint.selection.text}"</div>
        {:else}
          <div class="checkpoint-markdown text-[11px] leading-relaxed">
            {@html renderContent(checkpoint.noteText || '')}
          </div>
        {/if}
      </div>

      <!-- Decorative pointer tether pointing towards the dot -->
      <div
        class="absolute {side === 'left' ? '-left-1.5 border-b border-l' : '-right-1.5 border-t border-r'} top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 pointer-events-none bg-[var(--note-bg-light)] dark:bg-[var(--note-bg-dark)] border-[var(--note-border-light)] dark:border-[var(--note-border-dark)]"
      ></div>
    </div>
  {/if}
</div>

<style>
  :global(.checkpoint-markdown) {
    word-break: break-word;
  }
  :global(.checkpoint-markdown p) {
    margin-bottom: 0.45rem;
  }
  :global(.checkpoint-markdown p:first-child) {
    margin-top: 0;
  }
  :global(.checkpoint-markdown p:last-child) {
    margin-bottom: 0;
  }
  :global(.checkpoint-markdown ul, .checkpoint-markdown ol) {
    margin: 0.35rem 0 0.45rem 1.25rem;
    padding: 0;
  }
  :global(.checkpoint-markdown ul) {
    list-style-type: disc;
  }
  :global(.checkpoint-markdown ol) {
    list-style-type: decimal;
  }
  :global(.checkpoint-markdown li) {
    margin-bottom: 0.15rem;
  }
  :global(.checkpoint-markdown strong) {
    font-weight: 700;
  }
  :global(.checkpoint-markdown code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.9em;
    padding: 0.1rem 0.25rem;
    border-radius: 0.25rem;
    background-color: rgba(0, 0, 0, 0.08);
  }
  :global(.dark .checkpoint-markdown code) {
    background-color: rgba(255, 255, 255, 0.12);
  }
  :global(.checkpoint-markdown pre) {
    overflow-x: auto;
    padding: 0.4rem;
    border-radius: 0.375rem;
    background-color: rgba(0, 0, 0, 0.08);
    margin: 0.35rem 0;
  }
  :global(.dark .checkpoint-markdown pre) {
    background-color: rgba(255, 255, 255, 0.1);
  }
  :global(.checkpoint-markdown .katex-display) {
    overflow-x: auto;
    overflow-y: hidden;
    max-width: 100%;
    padding: 0.2rem 0;
    margin: 0.35rem 0;
  }
  :global(.checkpoint-markdown .katex) {
    font-size: 1.05em;
    text-rendering: auto;
  }
</style>
