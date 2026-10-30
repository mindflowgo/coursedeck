<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronDown, ChevronRight, Folder } from 'lucide-svelte';

  interface Props {
    title: string;
    count?: number;
    groupId?: string;
    isOpen: boolean;
    onToggle: () => void;
    children: Snippet;
    headerExtra?: Snippet;
  }

  let {
    title,
    count,
    groupId = '',
    isOpen,
    onToggle,
    children,
    headerExtra
  }: Props = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  }
</script>

<section
  class="group/section space-y-3"
  data-group-id={groupId || title}
  aria-labelledby="group-heading-{groupId || title}"
>
  <!-- Group Header Toggle -->
  <div
    role="button"
    tabindex="0"
    id="group-heading-{groupId || title}"
    aria-expanded={isOpen}
    aria-controls="group-content-{groupId || title}"
    onclick={onToggle}
    onkeydown={handleKeydown}
    class="flex items-center justify-between py-2 px-2 -mx-2 rounded-xl cursor-pointer select-none transition-colors hover:bg-stone-100/70 dark:hover:bg-stone-800/50"
  >
    <div class="flex items-center space-x-2.5 min-w-0">
      <span
        class="flex items-center justify-center w-5 h-5 rounded-md text-stone-500 dark:text-stone-400 group-hover/section:text-stone-800 dark:group-hover/section:text-stone-200 transition-transform duration-150 {isOpen ? 'rotate-0' : '-rotate-90'}"
      >
        <ChevronDown class="w-4 h-4 stroke-[2.2]" />
      </span>

      <h2 class="text-sm sm:text-base font-semibold tracking-tight text-stone-900 dark:text-stone-100 truncate">
        {title}
      </h2>

      {#if typeof count === 'number'}
        <span
          class="px-2 py-0.5 rounded-full text-2xs font-medium bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 border border-stone-200/60 dark:border-stone-700/60"
        >
          {count}
        </span>
      {/if}
    </div>

    <div class="flex items-center space-x-2">
      {#if headerExtra}
        {@render headerExtra()}
      {/if}
    </div>
  </div>

  <!-- Collapsible Content -->
  {#if isOpen}
    <div
      id="group-content-{groupId || title}"
      class="pt-0.5 animate-in fade-in-50 duration-150"
    >
      {@render children()}
    </div>
  {/if}
</section>
