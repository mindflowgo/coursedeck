<script lang="ts">
  import { ChevronDown, Eraser, Eye, EyeOff, Highlighter, Pencil, Redo2, Trash2, Undo2, X } from 'lucide-svelte';
  import { confirmDialog } from '$lib/dialog';
  import {
    canRedo,
    canUndo,
    clearFile,
    enterMarkupMode,
    exitMarkupMode,
    markupUi,
    redo,
    setShowMarkings,
    setPencilOnly,
    undo
  } from '$lib/markup/annotationStore.svelte';
  import { MARKUP_PRESETS } from '$lib/markup/render';
  import { HIGHLIGHTER_COLORS, MARKER_COLORS, type MarkupColor } from '$lib/markup/types';

  /**
   * Top-bar markup dropdown: marker + highlighter swatches, eraser, undo/redo,
   * global show/hide toggle, pencil-only mode, clear-all, and Done. Tapping a
   * swatch enters markup mode with that tool/color selected.
   */
  let {
    courseId,
    file
  }: { courseId: string; file: string } = $props();

  let isOpen = $state(false);

  // Close the panel when markup mode turns off from elsewhere (e.g. the Edit
  // button), but keep it openable while mode is off — picking a swatch is
  // what turns the mode on.
  let wasMode = markupUi.mode;
  $effect(() => {
    const m = markupUi.mode;
    if (wasMode && !m) isOpen = false;
    wasMode = m;
  });

  function selectColor(color: MarkupColor): void {
    markupUi.tool = color.startsWith('hl-') ? 'highlighter' : 'marker';
    markupUi.color = color;
    markupUi.eraser = false;
    enterMarkupMode();
  }

  async function handleClearAll(): Promise<void> {
    const ok = await confirmDialog(
      'Remove all markings from this document?',
      'Clear markings'
    );
    if (ok) clearFile(courseId, file);
  }
</script>

<div class="relative">
  <div class="flex items-stretch rounded-lg border border-stone-200/90 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 backdrop-blur-sm shadow-xs overflow-hidden">
    <button
      type="button"
      onclick={() => {
        if (markupUi.mode) {
          exitMarkupMode();
        } else {
          enterMarkupMode();
        }
      }}
      class="flex items-center space-x-1.5 px-2.5 py-1.5 text-xs font-medium transition cursor-pointer {markupUi.mode
        ? 'bg-amber-500 text-white shadow-inner font-semibold ring-1 ring-amber-600 dark:bg-amber-600 dark:ring-amber-500'
        : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
      title={markupUi.mode ? 'Markup active (tap to turn off)' : 'Tap to start marking with finger/pen'}
      aria-pressed={markupUi.mode}
    >
      <Highlighter class="w-3.5 h-3.5 {markupUi.mode ? 'stroke-[2.5]' : ''}" />
      <span class="hidden sm:inline">Markup</span>
    </button>
    <button
      type="button"
      onclick={() => (isOpen = !isOpen)}
      class="flex items-center px-1.5 border-l border-stone-200/90 dark:border-stone-700 text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer {markupUi.mode ? 'border-amber-400/40 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200' : ''}"
      title="Choose markup tool & color"
      aria-label="Choose markup tool"
      aria-expanded={isOpen}
    >
      <ChevronDown class="w-3 h-3 transition {isOpen ? 'rotate-180' : ''}" />
    </button>
  </div>

  {#if isOpen}
    <div class="fixed inset-0 z-40" onclick={() => (isOpen = false)} role="presentation"></div>

    <div class="absolute right-0 mt-1.5 w-72 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 overflow-hidden">
      <!-- Markers -->
      <div class="px-3 pt-2.5 pb-1">
        <div class="text-[10px] font-semibold uppercase tracking-wide text-stone-400 dark:text-stone-500 mb-1.5">Markers</div>
        <div class="flex items-center gap-1.5">
          {#each MARKER_COLORS as color (color)}
            <button
              type="button"
              onclick={() => selectColor(color)}
              class="w-9 h-9 rounded-lg border flex items-center justify-center transition cursor-pointer {color === 'white' ? 'bg-stone-200 dark:bg-stone-800' : color === 'black' ? 'bg-stone-50 dark:bg-stone-700' : ''} {markupUi.color === color && markupUi.tool === 'marker'
                ? 'border-amber-400 dark:border-amber-500 bg-amber-50 dark:bg-amber-900/40 ring-1 ring-amber-400'
                : 'border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800'}"
              title={MARKUP_PRESETS[color].label}
            >
              <svg viewBox="0 0 24 24" class="w-6 h-4" aria-hidden="true">
                <path
                  d="M 3 16 Q 8 13 12 15 T 21 12"
                  fill="none"
                  stroke={MARKUP_PRESETS[color].color}
                  stroke-width="3.5"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          {/each}
        </div>
      </div>

      <!-- Highlighters -->
      <div class="px-3 pt-2 pb-1">
        <div class="text-[10px] font-semibold uppercase tracking-wide text-stone-400 dark:text-stone-500 mb-1.5">Highlighters</div>
        <div class="flex items-center gap-1.5">
          {#each HIGHLIGHTER_COLORS as color (color)}
            <button
              type="button"
              onclick={() => selectColor(color)}
              class="w-9 h-9 rounded-lg border flex items-center justify-center transition cursor-pointer {markupUi.color === color && markupUi.tool === 'highlighter'
                ? 'border-amber-400 dark:border-amber-500 bg-amber-50 dark:bg-amber-900/40 ring-1 ring-amber-400'
                : 'border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800'}"
              title={MARKUP_PRESETS[color].label}
            >
              <svg viewBox="0 0 24 24" class="w-6 h-4" aria-hidden="true">
                <path
                  d="M 3 15 Q 8 12.5 12 14.5 T 21 11"
                  fill="none"
                  stroke={MARKUP_PRESETS[color].color}
                  stroke-width="7"
                  stroke-linecap="round"
                  opacity="0.55"
                />
              </svg>
            </button>
          {/each}
        </div>
      </div>

      <!-- Tools -->
      <div class="flex items-center gap-1 px-3 py-2 border-t border-stone-100 dark:border-stone-800 mt-1">
        <button
          type="button"
          onclick={() => {
            if (!markupUi.mode) enterMarkupMode();
            markupUi.eraser = !markupUi.eraser;
          }}
          class="w-8 h-8 rounded-lg flex items-center justify-center transition cursor-pointer {markupUi.eraser && markupUi.mode
            ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900'
            : 'text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
          title="Eraser — drag across markings to erase"
        >
          <Eraser class="w-4 h-4" />
        </button>
        <button
          type="button"
          onclick={() => undo(courseId, file)}
          disabled={!canUndo(courseId, file)}
          class="w-8 h-8 rounded-lg flex items-center justify-center transition text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default cursor-pointer"
          title="Undo (⌘Z)"
        >
          <Undo2 class="w-4 h-4" />
        </button>
        <button
          type="button"
          onclick={() => redo(courseId, file)}
          disabled={!canRedo(courseId, file)}
          class="w-8 h-8 rounded-lg flex items-center justify-center transition text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default cursor-pointer"
          title="Redo (⇧⌘Z)"
        >
          <Redo2 class="w-4 h-4" />
        </button>
        <span class="flex-1"></span>
        <button
          type="button"
          onclick={() => setShowMarkings(!markupUi.show)}
          class="w-8 h-8 rounded-lg flex items-center justify-center transition text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
          title={markupUi.show ? 'Hide all markings' : 'Show markings'}
        >
          {#if markupUi.show}<Eye class="w-4 h-4" />{:else}<EyeOff class="w-4 h-4" />{/if}
        </button>
        <button
          type="button"
          onclick={() => void handleClearAll()}
          class="w-8 h-8 rounded-lg flex items-center justify-center transition text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
          title="Clear all markings on this document"
        >
          <Trash2 class="w-4 h-4" />
        </button>
      </div>

      <!-- Footer: checkable pencil-only box + done -->
      <div class="flex items-center justify-between gap-2 px-3 py-2 border-t border-stone-100 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950/40">
        <label
          class="flex items-center space-x-2 text-[11px] font-medium text-stone-700 dark:text-stone-300 cursor-pointer select-none"
          title="When checked: Apple Pencil draws, finger scrolls. When unchecked: finger OR pencil can draw."
        >
          <input
            type="checkbox"
            checked={markupUi.pencilOnly}
            onchange={(e) => setPencilOnly(e.currentTarget.checked)}
            class="rounded border-stone-300 dark:border-stone-600 text-amber-600 focus:ring-amber-500 w-3.5 h-3.5 cursor-pointer accent-amber-600"
          />
          <div class="flex items-center space-x-1 text-stone-600 dark:text-stone-400">
            <Pencil class="w-3 h-3" />
            <span>Pencil only</span>
          </div>
        </label>
        <button
          type="button"
          onclick={() => {
            exitMarkupMode();
            isOpen = false;
          }}
          class="flex items-center space-x-1 px-2.5 py-1.5 rounded-md bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:opacity-90 transition cursor-pointer"
        >
          <X class="w-3.5 h-3.5" />
          <span>Done</span>
        </button>
      </div>
    </div>
  {/if}
</div>
