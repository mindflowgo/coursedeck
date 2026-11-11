import { handleApiRequest } from '$lib/server/api';
import type { RequestHandler } from './$types';

/**
 * Single catch-all adapter for the entire HTTP API.
 *
 * All endpoint logic lives in the shared `src/lib/server/api.ts` handler —
 * the same function the compiled Bun sidecar serves — so the dev server and
 * packaged desktop builds can never drift apart.
 */

export const prerender = false;

const handle: RequestHandler = ({ request, url }) => handleApiRequest(request, url);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
