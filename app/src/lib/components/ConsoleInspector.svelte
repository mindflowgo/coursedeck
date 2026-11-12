<!-- ConsoleInspector: on-device console viewer for debugging where devtools
     aren't available (the iPad app). Toggled by the bug icon in the Header. -->
<script lang="ts">
  import {
    consoleState,
    closeConsole,
    clearConsoleEntries,
    consoleEntriesAsText
  } from '$lib/consoleCapture.svelte';
  import { X, Copy, Check, Trash2 } from 'lucide-svelte';

  let scroller: HTMLElement | null = $state(null);
  let copied = $state(false);

  const levelClass: Record<string, string> = {
    log: 'text-stone-600 dark:text-stone-300',
    info: 'text-sky-700 dark:text-sky-300',
    debug: 'text-stone-500 dark:text-stone-400',
    warn: 'text-amber-700 dark:text-amber-300',
    error: 'text-red-600 dark:text-red-400'
  };

  $effect(() => {
    // Keep the newest line visible as entries stream in.
    void consoleState.entries.length;
    if (consoleState.isOpen && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(consoleEntriesAsText());
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {}
  }
</script>

{#if consoleState.isOpen}
  <div
    class="fixed inset-x-0 bottom-0 z-[80] h-[45vh] flex flex-col border-t-2 border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 shadow-2xl"
    role="region"
    aria-label="Console inspector"
  >
    <div class="flex items-center justify-between px-3 py-1.5 border-b border-stone-200 dark:border-stone-800 bg-stone-100 dark:bg-stone-900 shrink-0">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
        Console ({consoleState.entries.length})
      </span>
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={copyAll}
          aria-label="Copy all console output"
          title="Copy all"
          class="p-1.5 rounded-md text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-200 transition cursor-pointer"
        >
          {#if copied}<Check class="w-3.5 h-3.5 text-emerald-500" />{:else}<Copy class="w-3.5 h-3.5" />{/if}
        </button>
        <button
          type="button"
          onclick={clearConsoleEntries}
          aria-label="Clear console"
          title="Clear"
          class="p-1.5 rounded-md text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-200 transition cursor-pointer"
        >
          <Trash2 class="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onclick={closeConsole}
          aria-label="Close console"
          title="Close"
          class="p-1.5 rounded-md text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-200 transition cursor-pointer"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
    <div bind:this={scroller} class="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
      {#if consoleState.entries.length === 0}
        <p class="text-stone-400 dark:text-stone-600">No console output captured yet.</p>
      {:else}
        {#each consoleState.entries as entry (entry.id)}
          <p class="whitespace-pre-wrap break-all {levelClass[entry.level] ?? levelClass.log}">
            <span class="text-stone-400 dark:text-stone-600">{entry.ts}</span>
            {entry.text}
          </p>
        {/each}
      {/if}
    </div>
  </div>
{/if}
