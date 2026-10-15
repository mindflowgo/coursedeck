<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { theme } from '$lib/theme.svelte';
  import { initNavHistory } from '$lib/navHistory';

  onMount(() => {
    theme.init();
    // Record the session's history base eagerly so the Header back button
    // knows whether real in-app history exists behind the current entry.
    initNavHistory();
  });

  let { children } = $props();
</script>

<div class="h-full flex flex-col bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 font-sans transition-colors duration-150">
  {@render children()}
</div>
