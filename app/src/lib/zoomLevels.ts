/**
 * Pure zoom-level logic, kept free of runes/DOM so it can be unit tested with
 * bun:test. The UI-facing store lives in zoom.svelte.ts.
 */

/** Browser-style ladder (percent). */
export const ZOOM_STEPS: readonly number[] = [
  50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300
];

export const DEFAULT_ZOOM = 100;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export const STORAGE_KEY = 'course_zoom';

/** Accumulated wheel delta (px) required to move one zoom step. */
export const WHEEL_STEP_THRESHOLD = 40;
/** Wheel bursts separated by more than this many ms start a fresh accumulation. */
export const WHEEL_RESET_MS = 200;

/** Nearest ladder value; ties resolve to the lower step. */
export function snapToStep(level: number): number {
  let best = ZOOM_STEPS[0];
  for (const step of ZOOM_STEPS) {
    if (Math.abs(step - level) < Math.abs(best - level)) {
      best = step;
    }
  }
  return best;
}

/** Stored values are trusted only up to the point of snapping onto the ladder. */
export function parseStoredZoom(raw: string | null): number {
  if (raw == null) return DEFAULT_ZOOM;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ZOOM;
  return snapToStep(value);
}

/** Next ladder value in the given direction, clamped at both ends. */
export function nextLevel(level: number, direction: 1 | -1): number {
  const current = snapToStep(level);
  const index = ZOOM_STEPS.indexOf(current);
  const nextIndex = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
  return ZOOM_STEPS[nextIndex];
}

export type WheelStep = 0 | 'in' | 'out';

export interface WheelStepResult {
  /** Remaining accumulator after this event. */
  accum: number;
  /** Non-zero when the accumulated delta crossed a step threshold. */
  step: WheelStep;
}

/**
 * Accumulates wheel deltas (negative = scroll up) and emits one step each time
 * the accumulated distance crosses the threshold, so a single mouse notch steps
 * once while a trackpad burst steps at a sane rate. Reversing direction resets
 * the accumulation.
 */
export function stepFromWheel(accum: number, deltaY: number): WheelStepResult {
  let next = accum !== 0 && Math.sign(deltaY) !== Math.sign(accum) ? 0 : accum;
  next += deltaY;

  if (Math.abs(next) >= WHEEL_STEP_THRESHOLD) {
    return { accum: 0, step: next < 0 ? 'in' : 'out' };
  }
  return { accum: next, step: 0 };
}

/** Normalizes line/page-mode wheel deltas to approximate pixels. */
export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * 100;
  return deltaY;
}
