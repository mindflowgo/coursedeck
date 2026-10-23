<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';

  onMount(() => {
    const provider = $page.url.searchParams.get('provider');
    const target = provider
      ? `/settings?tab=integrations&provider=${encodeURIComponent(provider)}`
      : '/settings?tab=integrations';
    goto(target, { replaceState: true });
  });
</script>
