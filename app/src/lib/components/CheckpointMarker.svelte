<script lang="ts">
  import { FlagTriangleRight, Edit3, Trash2 } from 'lucide-svelte';
  import {
    formatCheckpointDate,
    getCheckpointColor,
    type Checkpoint,
    type CheckpointColor
  } from '$lib/checkpoint';

  interface Props {
    checkpoint: Checkpoint;
    isOpen?: boolean;
    isActive?: boolean;
    side?: 'left' | 'right';
    onToggle?: (checkpoint: Checkpoint) => void;
    onEdit?: (checkpoint: Checkpoint) => void;
    onDelete?: (checkpoint: Checkpoint) => void;
    onClose?: (checkpoint: Checkpoint) => void;
    onClick?: (checkpoint: Checkpoint) => void;
  }

  let {
    checkpoint,
    isOpen = false,
    isActive = false,
    side = 'right',
    onToggle,
    onEdit,
    onDelete,
    onClick
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
    e.stopPropagation();
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
</script>

<div
  class="absolute {side === 'left' ? 'left-2 sm:left-3' : 'right-2 sm:right-3'} z-20 flex items-center"
  style="top: {checkpoint.verticalPosition}px;"
>
  <!-- Circular Marker Dot + Date -->
  <div class="relative flex flex-col items-center justify-center -translate-y-[68%]">
    <!-- ABOVE in light grey letters the date -->
    {#if formattedDate}
      <span
        class="text-xs text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 transition-colors select-none leading-none mb-1 drop-shadow-2xs pointer-events-none"
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
      <FlagTriangleRight
        class="w-5 h-5 drop-shadow-xs {color.isLight ? 'text-stone-900 fill-stone-900' : 'text-white fill-white'}"
      />
    </button>
  </div>

  <!-- Non-editable Overlay Post-It Note expanding to the left (250px by 100px scrollable) -->
  {#if isOpen}
    <div
      class="absolute {side === 'left' ? 'left-[calc(100%+12px)]' : 'right-[calc(100%+12px)]'} top-0 -translate-y-1/2 w-[250px] h-[100px] rounded-xl border shadow-xl flex flex-col overflow-hidden z-30 transition-all select-text bg-[var(--note-bg-light)] dark:bg-[var(--note-bg-dark)] border-[var(--note-border-light)] dark:border-[var(--note-border-dark)] text-[var(--note-text-light)] dark:text-[var(--note-text-dark)]"
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

      <!-- Note body: scrollable text inside 100px total height, text starts on first line -->
      <div
        class="flex-1 overflow-y-auto px-2.5 py-2 text-xs font-medium leading-relaxed select-text whitespace-pre-wrap break-words scrollbar-thin"
      >
        <!-- Floated Edit | Trash actions overlay in top right of note -->
        <div
          class="float-right mb-0.5 flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold select-none bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition-colors border border-black/5 dark:border-white/10"
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
            {#if onEdit}
              <button
                type="button"
                onclick={handleEditClick}
                class="hover:underline cursor-pointer"
                title="Edit note"
              ><Edit3 class="w-2.5 h-2.5" /></button>
            {/if}

            {#if onEdit && onDelete}
              <span class="opacity-30">|</span>
            {/if}

            {#if onDelete}
              <button
                type="button"
                onclick={handleStartDelete}
                class="hover:text-rose-600 dark:hover:text-rose-400 transition cursor-pointer flex items-center space-x-0.5"
                title="Delete note"
              >
                <Trash2 class="w-2.5 h-2.5" />
              </button>
            {/if}
          {/if}
        </div>

        {checkpoint.noteText || ''}
      </div>

      <!-- Decorative pointer tether pointing towards the dot -->
      <div
        class="absolute {side === 'left' ? '-left-1.5 border-b border-l' : '-right-1.5 border-t border-r'} top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 pointer-events-none bg-[var(--note-bg-light)] dark:bg-[var(--note-bg-dark)] border-[var(--note-border-light)] dark:border-[var(--note-border-dark)]"
      ></div>
    </div>
  {/if}
</div>
