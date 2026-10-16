<script lang="ts">
  import { Plus, FlagTriangleRight } from 'lucide-svelte';
  import { onDestroy } from 'svelte';

  interface Props {
    containerEl?: HTMLElement | null;
    disabled?: boolean;
    side?: 'left' | 'right';
    onTrigger: (verticalPosition: number) => void;
  }

  let { containerEl, disabled = false, side = 'right', onTrigger }: Props = $props();

  let isVisible: boolean = $state(false);
  let cursorY: number = $state(0);
  let currentScrollTop: number = $state(0);
  let isOverTrigger: boolean = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  // Generous debounce duration so the trigger sits steadily while reading / aiming (2.5s)
  const HIDE_DELAY_MS = 2500;

  function scheduleHide() {
    clearTimeout(hideTimer);
    if (isOverTrigger) return;
    hideTimer = setTimeout(() => {
      if (!isOverTrigger) {
        isVisible = false;
      }
    }, HIDE_DELAY_MS);
  }

  function handleMouseMove(e: MouseEvent) {
    if (disabled || !containerEl) {
      isVisible = false;
      return;
    }

    // While hovering directly over the trigger, keep it completely stationary
    if (isOverTrigger) {
      clearTimeout(hideTimer);
      isVisible = true;
      return;
    }

    const rect = containerEl.getBoundingClientRect();

    // Generous bounding check: include margins and the horizontal travel zone
    const isWithinVerticalBounds = e.clientY >= rect.top - 20 && e.clientY <= rect.bottom + 20;
    const isWithinHorizontalBounds =
      side === 'right'
        ? e.clientX >= rect.left - 40 && e.clientX <= window.innerWidth
        : e.clientX >= 0 && e.clientX <= rect.right + 40;

    if (!isWithinVerticalBounds || !isWithinHorizontalBounds) {
      scheduleHide();
      return;
    }

    clearTimeout(hideTimer);
    isVisible = true;
    currentScrollTop = containerEl.scrollTop;

    // Relative vertical position inside container
    const rawY = Math.max(20, Math.min(rect.height - 24, e.clientY - rect.top));

    // Stabilize: when moving horizontally towards the button (within approach zone),
    // lock cursorY in place so the button doesn't jitter up and down while aiming.
    const isApproachingTrigger =
      side === 'right'
        ? e.clientX >= rect.right - 180
        : e.clientX <= rect.left + 180;

    if (!isApproachingTrigger) {
      // Ignore micro vertical jitter (< 4px) to keep the flag rock-solid
      if (cursorY === 0 || Math.abs(rawY - cursorY) >= 4) {
        cursorY = rawY;
      }
    }

    scheduleHide();
  }

  function handleMouseLeave() {
    scheduleHide();
  }

  function handleTriggerMouseEnter() {
    clearTimeout(hideTimer);
    isOverTrigger = true;
    isVisible = true;
  }

  function handleTriggerMouseMove() {
    clearTimeout(hideTimer);
    isOverTrigger = true;
    isVisible = true;
  }

  function handleTriggerMouseLeave() {
    isOverTrigger = false;
    scheduleHide();
  }

  function handleClick() {
    if (disabled || !containerEl) return;
    const verticalPosition = Math.max(0, Math.floor(currentScrollTop + cursorY));
    onTrigger(verticalPosition);
  }

  $effect(() => {
    if (containerEl && !disabled) {
      containerEl.addEventListener('mousemove', handleMouseMove);
      containerEl.addEventListener('mouseleave', handleMouseLeave);
      return () => {
        containerEl.removeEventListener('mousemove', handleMouseMove);
        containerEl.removeEventListener('mouseleave', handleMouseLeave);
      };
    }
  });

  onDestroy(() => {
    clearTimeout(hideTimer);
  });
</script>

{#if !disabled}
  <div
    class="pointer-events-auto absolute z-30 transition-opacity duration-200 ease-out select-none {side === 'left' ? 'left-2 sm:left-3' : 'right-2 sm:right-3'} {isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}"
    style="top: {cursorY}px; transform: translateY(-50%);"
    role="region"
    aria-label="Checkpoint trigger"
    onmouseenter={handleTriggerMouseEnter}
    onmousemove={handleTriggerMouseMove}
    onmouseleave={handleTriggerMouseLeave}
  >
    <button
      type="button"
      onclick={handleClick}
      title="Add checkpoint note at this position"
      aria-label="Add checkpoint note here"
      class="group flex items-center space-x-1 px-2 py-1 rounded-full bg-white/95 dark:bg-stone-800/95 border border-stone-200/90 dark:border-stone-700 shadow-sm hover:shadow-md hover:border-amber-400 dark:hover:border-amber-500 hover:scale-105 active:scale-95 transition-all cursor-pointer text-stone-600 dark:text-stone-300 hover:text-amber-600 dark:hover:text-amber-400 backdrop-blur-xs"
    >
      <Plus class="w-3.5 h-3.5 text-stone-400 group-hover:text-amber-500 transition-colors" />
      <FlagTriangleRight class="w-3.5 h-3.5" />
    </button>
  </div>
{/if}
