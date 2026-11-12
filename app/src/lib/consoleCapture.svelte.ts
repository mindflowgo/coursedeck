// app/src/lib/consoleCapture.svelte.ts
// Captures console output into an in-app ring buffer so it can be inspected
// on devices with no devtools (the iPad app) via the ConsoleInspector panel.

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntry {
  id: number;
  ts: string;
  level: ConsoleLevel;
  text: string;
}

const MAX_ENTRIES = 500;

export const consoleState = $state({
  isOpen: false,
  entries: [] as ConsoleEntry[]
});

let nextId = 1;
let patchApplied = false;

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function record(level: ConsoleLevel, args: unknown[]): void {
  const text = args.map(formatArg).join(' ');
  consoleState.entries.push({
    id: nextId++,
    ts: new Date().toLocaleTimeString([], { hour12: false }),
    level,
    text
  });
  if (consoleState.entries.length > MAX_ENTRIES) {
    consoleState.entries.splice(0, consoleState.entries.length - MAX_ENTRIES);
  }
}

/** Patches console.{log,info,warn,error,debug} once; originals keep firing. */
export function initConsoleCapture(): void {
  if (patchApplied || typeof console === 'undefined') return;
  patchApplied = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as ConsoleLevel[]) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        record(level, args);
      } catch {}
    };
  }
}

export function toggleConsole(): void {
  consoleState.isOpen = !consoleState.isOpen;
}

export function closeConsole(): void {
  consoleState.isOpen = false;
}

export function clearConsoleEntries(): void {
  consoleState.entries = [];
}

export function consoleEntriesAsText(): string {
  return consoleState.entries.map((e) => `${e.ts} [${e.level}] ${e.text}`).join('\n');
}
