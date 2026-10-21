import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
  const provider = url.searchParams.get('provider');
  const target = provider
    ? `/settings?tab=sync_mcp&provider=${encodeURIComponent(provider)}`
    : '/settings?tab=sync_mcp';
  throw redirect(307, target);
};
