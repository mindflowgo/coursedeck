<script lang="ts">
  import { PenLine, Highlighter, FlagTriangleRight, Sparkles } from 'lucide-svelte';
  import { tick, untrack } from 'svelte';
  import { clampTriggerY, defaultTriggerY, isWithinVerticalBounds, readerYToOverlayY } from '$lib/checkpoint/coordinates';

  interface Props {
    containerEl?: HTMLElement | null;
    disabled?: boolean;
    side?: 'left' | 'right';
    hasSelection?: boolean;
    /** Live pointer position inside an embedded iframe (already translated to reader viewport space). */
    externalPosition?: { cursorY: number; scrollTop: number } | null;
    onTriggerHighlight?: (verticalPosition: number) => void;
    onTriggerNote?: (verticalPosition: number) => void;
    onTriggerAskAI?: (verticalPosition: number) => void;
    onTrigger?: (verticalPosition: number) => void;
  }

  let {
    containerEl,
    disabled = false,
    side = 'right',
    hasSelection = false,
    externalPosition = null,
    onTriggerHighlight,
    onTriggerNote,
    onTriggerAskAI,
    onTrigger
  }: Props = $props();

  let isExpanded: boolean = $state(false);
  /** Viewport-space center Y of the control inside the reader. */
  let cursorY: number = $state(120);
  let currentScrollTop: number = $state(0);
  let rootEl: HTMLElement | null = $state(null);
  let overlayEl: HTMLDivElement | null = $state(null);
  let layoutRevision = $state(0);
  let compactBtnEl: HTMLButtonElement | null = $state(null);
  let expandedEl: HTMLElement | null = $state(null);

  // Clearance below the tab bar and the top-right markup/ellipsis action bar.
  const TOP_CLEARANCE = 56;
  const CONTROL_HALF_HEIGHT = 20;

  // Touch: commit the position on release; a second finger or a scroll-takeover
  // cancels the sequence instead of teleporting the control.
  let activeTouchId: number | null = null;
  let touchSequenceCancelled = false;

  let hasInitialPosition = false;

  function readerViewportHeight(): number {
    const rect = containerEl?.getBoundingClientRect();
    if (rect && rect.height > 0) return rect.height;
    const rootRect = overlayEl?.getBoundingClientRect();
    return rootRect && rootRect.height > 0 ? rootRect.height : 600;
  }

  function setCursorY(candidateViewportY: number) {
    cursorY = clampTriggerY(candidateViewportY, { height: readerViewportHeight() }, {
      topClearance: TOP_CLEARANCE,
      controlHalfHeight: CONTROL_HALF_HEIGHT
    });
  }

  /** Overlay-space top for CSS (overlay may sit slightly above the scroller). */
  function renderTop(): number {
    layoutRevision;
    if (!overlayEl || !containerEl) return cursorY;
    // Measure the stationary containing block, never the moving control.
    // Its own rect includes the previous top and translateY(-50%), creating
    // a feedback loop if used as the origin for the next position.
    return readerYToOverlayY(cursorY, containerEl.getBoundingClientRect(), overlayEl.getBoundingClientRect());
  }

  /** Content-space position handed to the checkpoint actions. */
  function getVerticalPosition(): number {
    return Math.max(0, Math.floor(currentScrollTop + cursorY));
  }

  function isFrozen(): boolean {
    if (isExpanded) return true;
    return rootEl !== null && document.activeElement !== null && rootEl.contains(document.activeElement);
  }

  /** True when the pointer is over the control (or just off its edge) — it must hold still so aiming and clicking work. */
  function isPointerOverControl(clientX: number, clientY: number): boolean {
    if (!rootEl) return false;
    const r = rootEl.getBoundingClientRect();
    const pad = 8;
    return (
      clientX >= r.left - pad &&
      clientX <= r.right + pad &&
      clientY >= r.top - pad &&
      clientY <= r.bottom + pad
    );
  }

  function handlePointerMove(e: PointerEvent) {
    if (disabled || !containerEl) return;
    if (e.pointerType === 'touch') return; // touch commits on release, not during drags
    if (isFrozen() || isPointerOverControl(e.clientX, e.clientY)) return;
    const rect = containerEl.getBoundingClientRect();
    if (!isWithinVerticalBounds(e.clientY, rect)) return;
    currentScrollTop = containerEl.scrollTop;
    setCursorY(e.clientY - rect.top);
  }

  function handlePointerDown(e: PointerEvent) {
    if (disabled || !containerEl || e.pointerType !== 'touch') return;
    if (activeTouchId !== null) {
      // Second finger: pinch-zoom or multitouch, not a positioning tap.
      touchSequenceCancelled = true;
      return;
    }
    activeTouchId = e.pointerId;
    touchSequenceCancelled = false;
  }

  function handlePointerUp(e: PointerEvent) {
    if (disabled || !containerEl || e.pointerType !== 'touch') return;
    if (e.pointerId !== activeTouchId) return;
    activeTouchId = null;
    if (touchSequenceCancelled || isFrozen()) return;
    const rect = containerEl.getBoundingClientRect();
    if (!isWithinVerticalBounds(e.clientY, rect)) return;
    currentScrollTop = containerEl.scrollTop;
    setCursorY(e.clientY - rect.top);
  }

  function handlePointerCancel(e: PointerEvent) {
    if (e.pointerId === activeTouchId) {
      activeTouchId = null;
      touchSequenceCancelled = true;
    }
  }

  function handleScroll() {
    if (!containerEl || disabled) return;
    currentScrollTop = containerEl.scrollTop;
  }

  function collapse(restoreFocus = false) {
    isExpanded = false;
    if (restoreFocus) {
      void tick().then(() => {
        if (!isExpanded) compactBtnEl?.focus();
      });
    }
  }

  function expandFromCompact() {
    isExpanded = true;
  }

  function runAction(kind: 'highlight' | 'note' | 'ai') {
    const vp = getVerticalPosition();
    collapse(false);
    const handler = kind === 'highlight' ? onTriggerHighlight : kind === 'note' ? onTriggerNote : onTriggerAskAI;
    (handler ?? onTrigger)?.(vp);
  }

  function handleWindowPointerDown(e: PointerEvent) {
    if (!isExpanded || !rootEl) return;
    if (e.target instanceof Node && rootEl.contains(e.target)) return;
    collapse(false);
  }

  function handleWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isExpanded) {
      e.stopPropagation();
      collapse(true);
    }
  }

  function handleFocusout(e: FocusEvent & { currentTarget: EventTarget & HTMLElement }) {
    if (!isExpanded) return;
    const next = e.relatedTarget;
    if (next instanceof Node && rootEl?.contains(next)) return;
    // Keyboard expansion removes the focused compact button before the
    // action bar's focus effect runs. Wait for that transfer before treating
    // a null relatedTarget as focus leaving the controls.
    queueMicrotask(() => {
      if (isExpanded && !rootEl?.contains(document.activeElement)) collapse(false);
    });
  }

  // Move focus into the action bar whenever it expands (keyboard flow).
  $effect(() => {
    if (isExpanded && expandedEl) {
      expandedEl.focus();
    }
  });

  // Pointer positions forwarded from an embedded iframe (HTML lessons).
  $effect(() => {
    const position = externalPosition;
    // Only a NEW iframe event may move the control. Reading isExpanded,
    // cursorY, or the DOM bindings reactively here replays an old event when
    // the menu closes or the parent pointer moves.
    untrack(() => {
      if (position && !disabled && !isFrozen() && Number.isFinite(position.cursorY)) {
        currentScrollTop = containerEl?.scrollTop ?? position.scrollTop;
        setCursorY(position.cursorY);
      }
    });
  });

  $effect(() => {
    const reader = containerEl;
    const overlay = overlayEl;
    if (!reader || !overlay || disabled) return;
    const updateLayout = () => {
      layoutRevision++;
      setCursorY(cursorY);
    };
    const observer = new ResizeObserver(updateLayout);
    observer.observe(reader);
    observer.observe(overlay);
    window.addEventListener('resize', updateLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateLayout);
    };
  });

  $effect(() => {
    const reader = containerEl;
    if (!reader || disabled) return;
    untrack(() => {
      if (!hasInitialPosition) {
        setCursorY(defaultTriggerY({ height: readerViewportHeight() }));
        hasInitialPosition = true;
      }
      currentScrollTop = reader.scrollTop;
    });
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    reader.addEventListener('pointerdown', handlePointerDown, { passive: true });
    reader.addEventListener('pointerup', handlePointerUp, { passive: true });
    reader.addEventListener('pointercancel', handlePointerCancel, { passive: true });
    reader.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      reader.removeEventListener('pointerdown', handlePointerDown);
      reader.removeEventListener('pointerup', handlePointerUp);
      reader.removeEventListener('pointercancel', handlePointerCancel);
      reader.removeEventListener('scroll', handleScroll);
      activeTouchId = null;
    };
  });
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

{#if !disabled}
  <div bind:this={overlayEl} class="pointer-events-none absolute inset-0">
  <div
    bind:this={rootEl}
    class="pointer-events-auto absolute z-30 select-none {side === 'left' ? 'left-2 sm:left-3' : 'right-2 sm:right-3'}"
    style="top: {renderTop()}px; transform: translateY(-50%);"
    role="toolbar"
    data-checkpoint-controls
    aria-label="Checkpoint actions"
    onfocusout={handleFocusout}
  >
    {#if !isExpanded}
      <!-- Compact: always available; expands on click/tap/keyboard, never on hover -->
      <button
        bind:this={compactBtnEl}
        type="button"
        onclick={expandFromCompact}
        onmousedown={(e) => e.preventDefault()}
        aria-expanded={isExpanded}
        title={hasSelection
          ? 'Selection captured — click for Highlight, Note, or Ask AI'
          : 'Add highlight, note, or ask AI (moves with your cursor)'}
        aria-label={hasSelection ? 'Checkpoint actions (selection captured)' : 'Checkpoint actions'}
        class="group flex items-center gap-1 min-h-9 px-2.5 py-1.5 rounded-full bg-white/95 dark:bg-stone-800/95 border border-stone-200/90 dark:border-stone-700 shadow-md hover:shadow-lg hover:border-amber-400 dark:hover:border-amber-500 backdrop-blur-xs transition-all cursor-pointer hover:scale-105 active:scale-95 {hasSelection ? 'ring-2 ring-amber-400/80 dark:ring-amber-500/80' : ''}"
      >
        <PenLine class="w-3.5 h-3.5 text-stone-600 dark:text-stone-300 group-hover:text-amber-500 transition-colors" />
        <Sparkles class="w-3.5 h-3.5 text-purple-500 group-hover:scale-110 transition-transform" />
      </button>
    {:else}
      <!-- Expanded: position frozen while choosing an action -->
      <div
        bind:this={expandedEl}
        tabindex="-1"
        class="flex items-center gap-1 p-1 rounded-full bg-white/95 dark:bg-stone-800/95 border border-stone-200/90 dark:border-stone-700 shadow-xl backdrop-blur-xs transition-all animate-in fade-in zoom-in-95 duration-150 outline-none {hasSelection ? 'ring-2 ring-amber-400/80 dark:ring-amber-500/80' : ''}"
      >
        <!-- 1. Highlight (needs an active selection) -->
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            if (!hasSelection) return;
            runAction('highlight');
          }}
          disabled={!hasSelection}
          title={hasSelection ? 'Highlight selected text' : 'Select text to highlight'}
          aria-label={hasSelection ? 'Highlight selected text' : 'Highlight (select text first)'}
          aria-disabled={!hasSelection}
          class="group flex items-center gap-1.5 min-h-8 px-2.5 py-1 rounded-full hover:bg-amber-50 dark:hover:bg-amber-950/40 text-stone-600 dark:text-stone-300 hover:text-amber-600 dark:hover:text-amber-400 text-xs font-medium transition whitespace-nowrap {hasSelection ? 'cursor-pointer active:scale-95' : 'cursor-not-allowed opacity-50'}"
        >
          <Highlighter class="w-3.5 h-3.5 text-amber-500 group-hover:scale-110 transition-transform shrink-0" />
          <span>Highlight</span>
        </button>

        <div class="w-px h-3.5 bg-stone-200 dark:bg-stone-700 shrink-0"></div>

        <!-- 2. Note -->
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            runAction('note');
          }}
          title={hasSelection ? 'Add note on selected text' : 'Add note at this position'}
          aria-label="Note"
          class="group flex items-center gap-1.5 min-h-8 px-2.5 py-1 rounded-full hover:bg-stone-100 dark:hover:bg-stone-700/60 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 text-xs font-medium transition cursor-pointer active:scale-95 whitespace-nowrap"
        >
          <FlagTriangleRight class="w-3.5 h-3.5 text-blue-500 group-hover:scale-110 transition-transform shrink-0" />
          <span>Note</span>
        </button>

        <div class="w-px h-3.5 bg-stone-200 dark:bg-stone-700 shrink-0"></div>

        <!-- 3. Ask AI -->
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            runAction('ai');
          }}
          title={hasSelection ? 'Ask AI about selected text' : 'Ask AI about this section'}
          aria-label="Ask AI"
          class="group flex items-center gap-1.5 min-h-8 px-2.5 py-1 rounded-full hover:bg-purple-50 dark:hover:bg-purple-950/40 text-stone-600 dark:text-stone-300 hover:text-purple-600 dark:hover:text-purple-400 text-xs font-medium transition cursor-pointer active:scale-95 whitespace-nowrap"
        >
          <Sparkles class="w-3.5 h-3.5 text-purple-500 group-hover:scale-110 transition-transform shrink-0" />
          <span>Ask AI</span>
        </button>
      </div>
    {/if}
  </div>
  </div>
{/if}
