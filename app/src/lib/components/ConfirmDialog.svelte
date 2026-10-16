<script lang="ts">
  import { AlertTriangle } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    title: string;
    /** Optional supporting line under the title. */
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let {
    isOpen,
    title,
    message = '',
    confirmLabel = 'Delete',
    cancelLabel = 'Cancel',
    onConfirm,
    onCancel
  }: Props = $props();

  /** The destructive action is the default, so it takes focus and Enter. */
  let confirmButton: HTMLButtonElement | null = $state(null);
  /**
   * Dismissal must start on the backdrop: a press that begins inside the card
   * (e.g. selecting the message text) and ends on the backdrop is not a cancel.
   */
  let pressedBackdrop = false;

  $effect(() => {
    if (isOpen) confirmButton?.focus();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (!isOpen || e.key !== 'Escape') return;
    e.preventDefault();
    onCancel();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
    role="presentation"
    onmousedown={(e) => {
      pressedBackdrop = e.target === e.currentTarget;
    }}
    onclick={(e) => {
      if (pressedBackdrop && e.target === e.currentTarget) onCancel();
      pressedBackdrop = false;
    }}
  >
    <div
      class="w-full max-w-sm rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl p-5 space-y-4 animate-in fade-in zoom-in-95 duration-150"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div class="flex items-start space-x-3">
        <div
          class="p-2 rounded-xl shrink-0 bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 border border-rose-200/80 dark:border-rose-900/50"
        >
          <AlertTriangle class="w-4 h-4" />
        </div>
        <div class="min-w-0 space-y-1">
          <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">{title}</h2>
          {#if message}
            <p class="text-xs text-stone-500 dark:text-stone-400 leading-relaxed">{message}</p>
          {/if}
        </div>
      </div>

      <div class="flex items-center justify-end space-x-2 pt-1">
        <button
          type="button"
          onclick={onCancel}
          class="px-3.5 py-2 rounded-lg border border-stone-200 dark:border-stone-700 text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          bind:this={confirmButton}
          onclick={onConfirm}
          class="px-4 py-2 rounded-lg bg-rose-600 text-white text-xs font-medium hover:bg-rose-500 transition shadow-sm cursor-pointer"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
