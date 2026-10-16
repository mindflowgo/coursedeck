/**
 * Checkpoint presentation: the named colour palette used for checkpoint flags,
 * and the small limits that keep the UI readable. Colours are Tailwind class
 * strings (static literals so the JIT compiler emits them).
 */

export interface CheckpointColor {
  id: string;
  label: string;
  /** Outline `Flag` icon colour. */
  flag: string;
  /** Solid swatch background for the colour picker. */
  swatch: string;
  /** Ring colour applied to the selected swatch. */
  ring: string;
  /** Small dot colour for compact flag rows. */
  dot: string;
}

export const CHECKPOINT_COLORS: readonly CheckpointColor[] = [
  { id: 'red', label: 'Red', flag: 'text-red-500 dark:text-red-400', swatch: 'bg-red-500', ring: 'ring-red-500', dot: 'bg-red-500' },
  { id: 'orange', label: 'Orange', flag: 'text-orange-500 dark:text-orange-400', swatch: 'bg-orange-500', ring: 'ring-orange-500', dot: 'bg-orange-500' },
  { id: 'amber', label: 'Amber', flag: 'text-amber-500 dark:text-amber-400', swatch: 'bg-amber-500', ring: 'ring-amber-500', dot: 'bg-amber-500' },
  { id: 'yellow', label: 'Yellow', flag: 'text-yellow-500 dark:text-yellow-400', swatch: 'bg-yellow-500', ring: 'ring-yellow-500', dot: 'bg-yellow-500' },
  { id: 'green', label: 'Green', flag: 'text-green-600 dark:text-green-400', swatch: 'bg-green-600', ring: 'ring-green-600', dot: 'bg-green-600' },
  { id: 'emerald', label: 'Emerald', flag: 'text-emerald-600 dark:text-emerald-400', swatch: 'bg-emerald-600', ring: 'ring-emerald-600', dot: 'bg-emerald-600' },
  { id: 'teal', label: 'Teal', flag: 'text-teal-600 dark:text-teal-400', swatch: 'bg-teal-600', ring: 'ring-teal-600', dot: 'bg-teal-600' },
  { id: 'sky', label: 'Sky', flag: 'text-sky-600 dark:text-sky-400', swatch: 'bg-sky-600', ring: 'ring-sky-600', dot: 'bg-sky-600' },
  { id: 'blue', label: 'Blue', flag: 'text-blue-600 dark:text-blue-400', swatch: 'bg-blue-600', ring: 'ring-blue-600', dot: 'bg-blue-600' },
  { id: 'violet', label: 'Violet', flag: 'text-violet-600 dark:text-violet-400', swatch: 'bg-violet-600', ring: 'ring-violet-600', dot: 'bg-violet-600' },
  { id: 'purple', label: 'Purple', flag: 'text-purple-600 dark:text-purple-400', swatch: 'bg-purple-600', ring: 'ring-purple-600', dot: 'bg-purple-600' },
  { id: 'pink', label: 'Pink', flag: 'text-pink-600 dark:text-pink-400', swatch: 'bg-pink-600', ring: 'ring-pink-600', dot: 'bg-pink-600' }
];

const FALLBACK_COLOR: CheckpointColor = {
  id: 'slate',
  label: 'Slate',
  flag: 'text-stone-500 dark:text-stone-400',
  swatch: 'bg-stone-500',
  ring: 'ring-stone-500',
  dot: 'bg-stone-500'
};

export const DEFAULT_CHECKPOINT_COLOR = 'blue';

/** The auto "Current" checkpoint borrows the completion look. */
export const CURRENT_CHECKPOINT_COLOR = 'emerald';

/** At most this many whole-lesson checkpoints may be pinned to one lesson. */
export const MAX_LESSON_CHECKPOINTS = 3;

/** Flags rendered inline before a lesson name / in the dropdown before truncating. */
export const MAX_FLAGS_SHOWN = 3;

export const CHECKPOINT_COLOR_IDS = CHECKPOINT_COLORS.map((c) => c.id);

export function getCheckpointColor(id: string | null | undefined): CheckpointColor {
  if (!id) return FALLBACK_COLOR;
  return CHECKPOINT_COLORS.find((c) => c.id === id) ?? FALLBACK_COLOR;
}

export function isValidCheckpointColor(id: string): boolean {
  return CHECKPOINT_COLOR_IDS.includes(id);
}
