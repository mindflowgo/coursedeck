import { goto } from '$app/navigation';

/**
 * Back-button support for the SPA.
 *
 * SvelteKit stamps every history entry it creates with a monotonic sequence
 * number (`sveltekit:history` in history.state). We record the LOWEST value
 * seen in this tab session (persisted across reloads via sessionStorage) as
 * the "base" entry — the first in-app page. The Header back button can then
 * retrace real history entries while the user is above the base, and fall
 * back to the course list ('/') when the base is reached (fresh load or deep
 * link with nothing in-app behind it).
 *
 * If SvelteKit's state key is ever absent (entry created outside the kit
 * router), we degrade to plain history.back().
 */

const BASE_KEY = 'app_nav_base';
let initialized = false;

/** The current entry's SvelteKit history sequence, if present. */
function currentSequence(): number | undefined {
  const value = (window.history.state as Record<string, unknown> | null)?.['sveltekit:history'];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Records the session base as the lowest in-app sequence seen so far.
 * Idempotent; called lazily by goBackOrHome and safe to call on any page.
 */
export function initNavHistory(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  const current = currentSequence();
  if (current === undefined) return;
  try {
    const raw = sessionStorage.getItem(BASE_KEY);
    const stored = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(stored) || current < stored) {
      sessionStorage.setItem(BASE_KEY, String(current));
    }
  } catch {
    // sessionStorage unavailable (private mode etc.) — back falls back to
    // plain history.back() via the base-read failure path.
  }
}

/**
 * Header back button: retrace one real history entry while there is in-app
 * history behind us; otherwise navigate to the course list.
 */
export function goBackOrHome(): void {
  if (typeof window === 'undefined') return;
  initNavHistory();

  const current = currentSequence();
  let base = Number.NaN;
  try {
    const raw = sessionStorage.getItem(BASE_KEY);
    base = raw === null ? Number.NaN : Number(raw);
  } catch {}

  if (current === undefined || !Number.isFinite(base) || current <= base) {
    goto('/');
    return;
  }
  window.history.back();
}
