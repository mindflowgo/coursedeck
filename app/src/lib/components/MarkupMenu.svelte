<script lang="ts">
  import { Check, ChevronDown, Eraser, Eye, EyeOff, Highlighter, Pencil, Redo2, Trash2, Undo2 } from 'lucide-svelte';
  import AppleLogo from '$lib/components/icons/AppleLogo.svelte';
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
  import { PALETTE_COLORS, type MarkupColor, type MarkupTool } from '$lib/markup/types';
  import { isIPad, isPencilKitAvailable, setPencilKitExcludedRects, setPencilKitTool } from '$lib/markup/pencilKit';

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
  let popoverEl = $state<HTMLDivElement>();
  let isAnIPad = $state(false);

  $effect(() => {
    isAnIPad = isIPad();
    if (!isAnIPad && markupUi.pencilOnly) {
      setPencilOnly(false);
    }
  });

  // Synchronize excluded rects for open popover so Apple Pencil taps on swatches/Done work
  $effect(() => {
    if (isPencilKitAvailable()) {
      if (isOpen && popoverEl) {
        const r = popoverEl.getBoundingClientRect();
        void setPencilKitExcludedRects([
          { x: r.left, y: r.top, width: r.width, height: r.height }
        ]);
      } else {
        void setPencilKitExcludedRects([]);
      }
    }
  });

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
    markupUi.color = color;
    markupUi.eraser = false;
    if (!markupUi.mode) enterMarkupMode();
    if (isPencilKitAvailable() && markupUi.pencilOnly) {
      setPencilKitTool(markupUi.tool, color);
    }
    isOpen = false;
  }

  function selectTool(tool: MarkupTool): void {
    setPencilOnly(false);
    markupUi.tool = tool;
    markupUi.eraser = false;
    if (!markupUi.mode) enterMarkupMode();
    if (isPencilKitAvailable() && markupUi.pencilOnly) {
      setPencilKitTool(tool, markupUi.color);
    }
  }

  function selectPencilTab(): void {
    setPencilOnly(true);
    markupUi.eraser = false;
    enterMarkupMode();
    isOpen = false;
  }

  function selectEraser(): void {
    if (!markupUi.mode) enterMarkupMode();
    markupUi.eraser = true;
    isOpen = false;
  }

  function handleMainButtonClick(): void {
    if (markupUi.mode && markupUi.eraser) {
      markupUi.eraser = false;
    } else if (markupUi.mode) {
      exitMarkupMode();
    } else {
      enterMarkupMode();
    }
  }

  async function handleClearAll(): Promise<void> {
    const ok = await confirmDialog(
      'Remove all markings from this document?',
      'Clear markings'
    );
    if (ok) clearFile(courseId, file);
  }

  function ensureInViewport(node: HTMLElement) {
    function adjust() {
      node.style.transform = '';
      node.style.maxWidth = '';
      const rect = node.getBoundingClientRect();
      const margin = 8;
      const viewportWidth = window.innerWidth;

      // Find any ancestor that clips horizontal overflow
      let containerLeft = 0;
      let containerRight = viewportWidth;
      let parent: HTMLElement | null = node.parentElement;
      while (parent && parent !== document.body) {
        const style = window.getComputedStyle(parent);
        if (style.overflowX === 'hidden' || style.overflow === 'hidden') {
          const parentRect = parent.getBoundingClientRect();
          containerLeft = Math.max(containerLeft, parentRect.left);
          containerRight = Math.min(containerRight, parentRect.right);
          break;
        }
        parent = parent.parentElement;
      }

      const safeLeft = containerLeft + margin;
      const safeRight = containerRight - margin;
      const maxAvailableWidth = Math.max(200, safeRight - safeLeft);

      if (rect.width > maxAvailableWidth) {
        node.style.maxWidth = `${maxAvailableWidth}px`;
      }

      // Re-measure with maxWidth applied
      const updatedRect = node.getBoundingClientRect();
      let shiftX = 0;

      if (updatedRect.left < safeLeft) {
        shiftX = safeLeft - updatedRect.left;
      } else if (updatedRect.right > safeRight) {
        shiftX = safeRight - updatedRect.right;
      }

      if (shiftX !== 0) {
        node.style.transform = `translateX(${Math.round(shiftX)}px)`;
      }
    }

    adjust();
    const raf = requestAnimationFrame(adjust);
    window.addEventListener('resize', adjust);
    return {
      destroy() {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', adjust);
      }
    };
  }
</script>

<div class="relative">
  {#if markupUi.mode && isPencilKitAvailable() && markupUi.pencilOnly}
    <!-- Apple Pencil mode active on iPad: Done button with dropdown chevron to access/deselect pencil mode -->
    <div class="flex items-stretch rounded-lg bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white shadow-xs overflow-hidden shrink-0">
      <button
        type="button"
        onclick={() => exitMarkupMode()}
        class="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold transition cursor-pointer active:scale-95"
        title="Done marking up (tap to exit)"
        aria-label="Done marking up"
      >
        <Check class="w-3.5 h-3.5 stroke-[2.5]" />
        <span>Done</span>
      </button>
      <button
        type="button"
        onclick={() => (isOpen = !isOpen)}
        class="flex items-center px-1.5 border-l border-emerald-500/80 hover:bg-black/15 transition cursor-pointer"
        title="Apple Pencil options"
        aria-label="Apple Pencil options"
        aria-expanded={isOpen}
      >
        <ChevronDown class="w-3 h-3 transition duration-150 {isOpen ? 'rotate-180' : ''}" />
      </button>
    </div>
  {:else}
    <!-- Split button: highlights when active, dropdown always openable -->
    <div
      class="flex items-stretch rounded-lg border transition shadow-xs overflow-hidden {markupUi.mode
        ? 'border-amber-500/70 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 ring-1 ring-amber-400/50'
        : 'border-stone-200/90 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 text-stone-700 dark:text-stone-300 backdrop-blur-sm'}"
    >
      <button
        type="button"
        onclick={handleMainButtonClick}
        class="flex items-center space-x-1.5 px-2.5 py-1.5 text-xs font-medium transition cursor-pointer hover:bg-stone-100/70 dark:hover:bg-stone-800/70"
        title={markupUi.mode ? (markupUi.eraser ? 'Exit Erase mode' : 'Exit Markup mode') : 'Tap to start marking with finger/pen'}
      >
        {#if markupUi.eraser && markupUi.mode}
          <Eraser class="w-3.5 h-3.5" />
        {:else if markupUi.tool === 'highlighter'}
          <Highlighter class="w-3.5 h-3.5" />
        {:else}
          <Pencil class="w-3.5 h-3.5" />
        {/if}
        <span class="hidden sm:inline">{markupUi.eraser && markupUi.mode ? 'Erase' : 'Markup'}</span>
      </button>
      <button
        type="button"
        onclick={() => (isOpen = !isOpen)}
        class="flex items-center px-1.5 border-l border-stone-200/90 dark:border-stone-700 hover:bg-stone-100/70 dark:hover:bg-stone-800/70 transition cursor-pointer"
        title="Choose markup tool & color"
        aria-label="Choose markup tool"
        aria-expanded={isOpen}
      >
        <ChevronDown class="w-3 h-3 transition duration-150 {isOpen ? 'rotate-180' : ''}" />
      </button>
    </div>
  {/if}

  {#if isOpen}
    <div class="fixed inset-0 z-40" onclick={() => (isOpen = false)} role="presentation"></div>

    <div
      bind:this={popoverEl}
      use:ensureInViewport
      class="absolute right-0 mt-1.5 w-[280px] max-w-[calc(100vw-1rem)] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 overflow-hidden"
    >
      <!-- 1. Tool Selection: Pen vs Highlighter (vs Apple Pencil on iPad) -->
      <div class="px-3 pt-2.5 pb-2">
        <div class="text-[10px] font-semibold uppercase tracking-wide text-stone-400 dark:text-stone-500 mb-1.5">Tool</div>
        <div class="grid {isAnIPad ? 'grid-cols-3' : 'grid-cols-2'} gap-1 p-0.5 rounded-lg bg-stone-100 dark:bg-stone-800/80">
          <button
            type="button"
            onclick={() => selectTool('marker')}
            class="flex items-center justify-center space-x-1 py-1.5 px-1.5 rounded-md text-[11px] sm:text-xs font-medium transition cursor-pointer {!markupUi.pencilOnly && markupUi.tool === 'marker' && !markupUi.eraser
              ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-xs'
              : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100'}"
          >
            <Pencil class="w-3.5 h-3.5 shrink-0" />
            <span>Pen</span>
          </button>
          <button
            type="button"
            onclick={() => selectTool('highlighter')}
            class="flex items-center justify-center space-x-1 py-1.5 px-1.5 rounded-md text-[11px] sm:text-xs font-medium transition cursor-pointer {!markupUi.pencilOnly && markupUi.tool === 'highlighter' && !markupUi.eraser
              ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-xs'
              : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100'}"
          >
            <Highlighter class="w-3.5 h-3.5 shrink-0" />
            <span>Highlighter</span>
          </button>
          {#if isAnIPad}
            <button
              type="button"
              onclick={selectPencilTab}
              class="flex items-center justify-center space-x-1 py-1.5 px-1.5 rounded-md text-[11px] sm:text-xs font-medium transition cursor-pointer {markupUi.pencilOnly
                ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-xs'
                : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100'}"
              title="Apple Pencil mode"
            >
              <AppleLogo class="w-3.5 h-3.5 shrink-0" />
              <span>Pencil</span>
            </button>
          {/if}
        </div>
      </div>

      <!-- 2. Color Palette (5 colors from Apple Markup) - hidden when Apple Pencil is selected -->
      {#if !markupUi.pencilOnly}
        <div class="px-3 py-2 border-t border-stone-100 dark:border-stone-800">
          <div class="flex items-center justify-between gap-1.5 px-0.5">
            {#each PALETTE_COLORS as c (c.id)}
              {@const isSelected = markupUi.color === c.id}
              <button
                type="button"
                onclick={() => selectColor(c.id)}
                class="relative p-0.5 rounded-full transition cursor-pointer focus:outline-hidden"
                title={c.label}
                aria-label={c.label}
              >
                <!-- Outer concentric selection ring matching Apple Markup style -->
                <div class="w-8 h-8 rounded-full flex items-center justify-center transition-all {isSelected
                  ? 'ring-2 ring-offset-2 ring-stone-400 dark:ring-stone-400 dark:ring-offset-stone-900'
                  : 'hover:scale-105'}">
                  <div
                    class="w-7 h-7 rounded-full shadow-xs {c.id === 'white' ? 'border border-stone-300 dark:border-stone-600' : ''}"
                    style:background-color={c.hex}
                  ></div>
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- 3. Actions: Eraser, Undo, Redo, Show/Hide, Clear -->
      <div class="flex items-center gap-1 px-3 py-2 border-t border-stone-100 dark:border-stone-800">
        {#if !markupUi.pencilOnly}
          <button
            type="button"
            onclick={selectEraser}
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
        {/if}
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

      <!-- Footer: Hide button -->
      <div class="flex items-center justify-end px-3 py-2 border-t border-stone-100 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950/40">
        <button
          type="button"
          onclick={() => {
            if (!markupUi.pencilOnly && !markupUi.mode) enterMarkupMode();
            isOpen = false;
          }}
          class="flex items-center space-x-1 px-3 py-1.5 rounded-md bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-semibold hover:opacity-90 transition cursor-pointer"
          title="Hide menu"
        >
          <span>Hide</span>
        </button>
      </div>
    </div>
  {/if}
</div>
