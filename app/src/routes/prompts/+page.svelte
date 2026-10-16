<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import PromptsManager from '$lib/components/PromptsManager.svelte';
  import Header from '$lib/components/Header.svelte';

  onMount(() => {
    goto('/settings?tab=prompts', { replaceState: true });
  });
</script>

<Header />
<main class="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
  <PromptsManager />
</main>
