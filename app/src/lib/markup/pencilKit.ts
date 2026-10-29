import { browser } from '$app/environment';
import { addPluginListener, invoke, type PluginListener } from '@tauri-apps/api/core';
import type { MarkupColor, MarkupStroke, MarkupTool } from './types';
import { exitMarkupMode, markupUi } from './annotationStore.svelte';

export interface ToolItemConfig {
  enabled?: boolean;
  color?: string;
  width?: number;
}

export interface EraserConfig {
  enabled?: boolean;
  type?: 'vector' | 'bitmap';
  width?: number;
}

export interface ToolPickerOptions {
  pen?: ToolItemConfig | boolean;
  pencil?: ToolItemConfig | boolean;
  marker?: ToolItemConfig | boolean;
  eraser?: EraserConfig | boolean;
  lasso?: { enabled?: boolean } | boolean;
  ruler?: { enabled?: boolean } | boolean;
  allowsColorSelection?: boolean;
}

/**
 * Default tool configuration:
 * Limited to pencil, marker (highlighter), and eraser.
 * Pen, lasso, and ruler are hidden.
 * Multi-color picker is removed (allowsColorSelection: false).
 */
export const DEFAULT_TOOL_PICKER_CONFIG: ToolPickerOptions = {
  pencil: { enabled: true, color: 'blue', width: 3.5 },
  marker: { enabled: true, color: 'yellow', width: 24.0 },
  eraser: false,
  pen: false,
  lasso: false,
  ruler: false,
  allowsColorSelection: false
};

export interface PencilKitActiveOptions {
  active: boolean;
  file?: string;
  authorWidth?: number;
  targetWidth?: number;
  targetRect?: { x: number; y: number; width: number; height: number };
  topHeight?: number;
  tools?: ToolPickerOptions;
  canUndo?: boolean;
  canRedo?: boolean;
}

export interface ExcludedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativePencilStroke {
  id: string;
  file: string;
  tool: MarkupTool;
  color: MarkupColor;
  viewportPoints: number[];
  authorWidth: number;
  date: string;
  width?: number;
  opacity?: number;
}

type StrokeCallback = (stroke: NativePencilStroke) => void;
type ToolCallback = (
  tool: MarkupTool | 'eraser',
  color: MarkupColor,
  width?: number,
  opacity?: number
) => void;

const strokeListeners = new Set<StrokeCallback>();
const toolListeners = new Set<ToolCallback>();
let isInitialized = false;

/**
 * Checks if native Apple PencilKit is available in the current environment
 * (Tauri iOS running on an iPad).
 */
export function isPencilKitAvailable(): boolean {
  if (!browser) return false;
  const w = window as any;
  if (w.__pencilKitReady) return true;
  const isTauri = '__TAURI_INTERNALS__' in window || 'isTauri' in window;
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return Boolean(isTauri && isIOS);
}

/**
 * Sets whether native PencilKit overlay is active.
 * When active, Apple Pencil draws with native 120/240Hz Metal prediction,
 * and the native PKToolPicker is presented.
 */
export async function setPencilKitActive(options: PencilKitActiveOptions): Promise<void> {
  if (!browser || !isPencilKitAvailable()) return;
  try {
    const payload: Record<string, unknown> = {
      active: options.active,
      file: options.file || '',
      authorWidth: options.authorWidth || 800,
      targetWidth: options.targetWidth || 800,
      targetRect: options.targetRect,
      topHeight: options.topHeight,
      canUndo: options.canUndo,
      canRedo: options.canRedo
    };
    if (options.tools !== undefined) {
      payload.tools = options.tools;
    }
    await invoke('plugin:pencilkit|set_active', payload);
  } catch (err) {
    // Non-fatal if invoked on unsupported platform
  }
}

/**
 * Synchronizes Undo / Redo availability to Apple Pencil's native toolbar
 * so the reverse and forward buttons enable or disable to reflect web state.
 */
export async function syncPencilKitUndoRedo(canUndo: boolean, canRedo: boolean): Promise<void> {
  if (!browser || !isPencilKitAvailable()) return;
  try {
    await invoke('plugin:pencilkit|sync_undo_redo', { canUndo, canRedo });
  } catch (err) {
    // Non-fatal if invoked on unsupported platform
  }
}

/**
 * Configures which built-in tools are visible on Apple PencilKit's PKToolPicker
 * (pen, pencil, marker, eraser, lasso), allows tweaking color/width, and controls
 * color picker display.
 */
export async function configurePencilKitTools(
  options: ToolPickerOptions = DEFAULT_TOOL_PICKER_CONFIG
): Promise<void> {
  if (!browser || !isPencilKitAvailable()) return;
  try {
    await invoke('plugin:pencilkit|configure_tools', { tools: options });
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Syncs the active tool and color to native PencilKit.
 */
export async function setPencilKitTool(
  tool: MarkupTool | 'eraser',
  colorName: MarkupColor,
  width?: number
): Promise<void> {
  if (!browser || !isPencilKitAvailable()) return;
  try {
    await invoke('plugin:pencilkit|set_tool', {
      tool,
      color: colorName,
      width
    });
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Sets interactive regions (such as open menus, dialogs, or dropdowns)
 * that should never capture Apple Pencil drawing strokes, allowing pencil
 * taps to pass straight through to the underlying HTML buttons.
 */
export async function setPencilKitExcludedRects(
  rects: ExcludedRect[],
  topHeight?: number
): Promise<void> {
  if (!browser || !isPencilKitAvailable()) return;
  try {
    await invoke('plugin:pencilkit|set_excluded_rects', {
      rects,
      topHeight
    });
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Clears the native scratchpad drawing.
 */
export async function clearPencilKit(): Promise<void> {
  if (!browser || !isPencilKitAvailable()) return;
  try {
    await invoke('plugin:pencilkit|clear');
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Acknowledges that one or more stroke IDs have been rendered into the DOM / SVG canvas.
 * Signals native PencilKit to safely retire those strokes from the PKCanvasView scratchpad
 * without causing any visual blank frame.
 */
export async function ackPencilKitRendered(ids: string[]): Promise<void> {
  if (!browser || ids.length === 0 || !isPencilKitAvailable()) return;
  try {
    await invoke('plugin:pencilkit|ack_rendered', { ids });
  } catch (err) {
    console.warn('[PencilKit] Failed to acknowledge rendered stroke:', err);
  }
}

/**
 * Subscribes to strokes drawn via native PencilKit.
 */
export function onPencilKitStroke(cb: StrokeCallback): () => void {
  strokeListeners.add(cb);
  return () => {
    strokeListeners.delete(cb);
  };
}

/**
 * Subscribes to tool changes from Apple's native PKToolPicker.
 */
export function onPencilKitToolChange(cb: ToolCallback): () => void {
  toolListeners.add(cb);
  return () => {
    toolListeners.delete(cb);
  };
}

export interface UndoActionInfo {
  source?: 'toolbar' | 'double-tap' | string;
}

type UndoRedoCallback = (info?: UndoActionInfo) => void;
const undoListeners = new Set<UndoRedoCallback>();
const redoListeners = new Set<() => void>();

/**
 * Subscribes to Undo triggers from Apple Pencil's native toolbar or double-tap.
 */
export function onPencilKitUndo(cb: UndoRedoCallback): () => void {
  undoListeners.add(cb);
  return () => {
    undoListeners.delete(cb);
  };
}

/**
 * Subscribes to Redo taps from Apple Pencil's native toolbar.
 */
export function onPencilKitRedo(cb: () => void): () => void {
  redoListeners.add(cb);
  return () => {
    redoListeners.delete(cb);
  };
}

function handleUndo(source?: string): void {
  const info: UndoActionInfo = { source };
  for (const listener of undoListeners) {
    try {
      listener(info);
    } catch (err) {
      console.error('[PencilKit] Error in undo listener:', err);
    }
  }
}

function handleRedo(): void {
  for (const listener of redoListeners) {
    try {
      listener();
    } catch (err) {
      console.error('[PencilKit] Error in redo listener:', err);
    }
  }
}

function handleStrokeDrawn(stroke: NativePencilStroke): void {
  for (const listener of strokeListeners) {
    try {
      listener(stroke);
    } catch (err) {
      console.error('[PencilKit] Error in stroke listener:', err);
    }
  }
}

function handleToolChanged(data: { tool: string; color: string; width?: number; opacity?: number }): void {
  const isEraser = data.tool === 'eraser';
  const isHighlighter = data.tool === 'highlighter';
  const resolvedTool: MarkupTool = isHighlighter ? 'highlighter' : 'marker';
  const color = (data.color || 'blue') as MarkupColor;

  // Synchronize web markupUi state with native PKToolPicker
  if (isEraser) {
    markupUi.eraser = true;
  } else {
    markupUi.eraser = false;
    markupUi.tool = resolvedTool;
    markupUi.color = color;
    if (data.width !== undefined) {
      markupUi.width = data.width;
    }
    if (data.opacity !== undefined) {
      markupUi.opacity = data.opacity;
    }
  }

  for (const listener of toolListeners) {
    try {
      listener(isEraser ? 'eraser' : resolvedTool, color, data.width, data.opacity);
    } catch (err) {
      console.error('[PencilKit] Error in tool listener:', err);
    }
  }
}

export function initPencilKit(): void {
  if (!browser || isInitialized) return;
  isInitialized = true;

  // Set default tool picker configuration: pencil, marker; eraser/pen/lasso/ruler hidden; multicolor picker removed
  void configurePencilKitTools(DEFAULT_TOOL_PICKER_CONFIG);

  if (!isPencilKitAvailable()) return;

  // Register sanctioned Tauri plugin channels (via plugin:pencilkit|registerListener)
  void addPluginListener<NativePencilStroke>('pencilkit', 'pencilkit:stroke-drawn', (stroke) => {
    handleStrokeDrawn(stroke);
  });

  void addPluginListener<{ tool: string; color: string; width?: number; opacity?: number }>(
    'pencilkit',
    'pencilkit:tool-changed',
    (data) => {
      handleToolChanged(data);
    }
  );

  void addPluginListener('pencilkit', 'pencilkit:closed', () => {
    exitMarkupMode();
  });

  void addPluginListener<{ source?: string }>('pencilkit', 'pencilkit:undo', (data) => {
    handleUndo(data?.source);
  });

  void addPluginListener('pencilkit', 'pencilkit:redo', () => {
    handleRedo();
  });
}

if (browser) {
  initPencilKit();
}
