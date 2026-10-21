<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';

  onMount(() => {
    const provider = $page.url.searchParams.get('provider');
    const target = provider
      ? `/settings?tab=sync_mcp&provider=${encodeURIComponent(provider)}`
      : '/settings?tab=sync_mcp';
    goto(target, { replaceState: true });
  });
</script>
