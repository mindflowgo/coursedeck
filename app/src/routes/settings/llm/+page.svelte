<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  onMount(() => {
    goto('/settings?tab=llm', { replaceState: true });
  });
</script>
