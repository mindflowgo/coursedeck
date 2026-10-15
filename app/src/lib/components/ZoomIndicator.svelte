<script lang="ts">
  import { fade } from 'svelte/transition';
  import { zoom } from '$lib/zoom.svelte';
</script>

{#if zoom.indicatorVisible}
  <div
    transition:fade={{ duration: 120 }}
    class="fixed top-16 left-1/2 -translate-x-1/2 z-[100] px-3 py-1.5 rounded-full border border-stone-200 dark:border-stone-700 bg-white/95 dark:bg-stone-900/95 shadow-lg text-xs font-medium text-stone-700 dark:text-stone-200 pointer-events-none select-none"
    style:zoom={String(100 / zoom.level)}
  >
    {zoom.level}%
  </div>
{/if}
