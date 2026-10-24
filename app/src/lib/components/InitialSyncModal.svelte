<!-- app/src/lib/components/InitialSyncModal.svelte -->
<script lang="ts">
  import { syncFromDesktop } from '$lib/syncState.svelte';
  import { Download, CheckCircle2, AlertCircle, Loader2, Sparkles } from 'lucide-svelte';

  let { onDone }: { onDone: () => void } = $props();

  let progress = $state<'idle' | 'syncing' | 'done' | 'error'>('idle');
  let errorMessage = $state('');
  let includeLlmKeys = $state(true);

  async function startSync() {
    progress = 'syncing';
    errorMessage = '';
    try {
      await syncFromDesktop({ includeLlmKeys });
      progress = 'done';
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : 'Failed to download courses from desktop';
      progress = 'error';
    }
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
  <div class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-6 sm:p-8 max-w-md w-full shadow-2xl space-y-5 animate-in fade-in duration-200">
    <div class="flex items-center space-x-3">
      <div class="w-10 h-10 rounded-xl bg-amber-400/10 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
        <Download class="w-5 h-5" />
      </div>
      <div>
        <h2 class="text-base font-semibold text-stone-900 dark:text-stone-100">Welcome to CourseDeck</h2>
        <p class="text-xs text-stone-500 dark:text-stone-400">Set up offline study on this iPad</p>
      </div>
    </div>

    {#if progress === 'idle'}
      <p class="text-xs text-stone-600 dark:text-stone-300 leading-relaxed">
        Your Mac is connected on your local network! Download all your courses, lessons, and prompts now so you can study completely offline anytime.
      </p>

      <div class="rounded-xl bg-stone-50 dark:bg-stone-800/60 p-3.5 border border-stone-200/80 dark:border-stone-700/80">
        <label class="flex items-start space-x-3 cursor-pointer">
          <input
            type="checkbox"
            bind:checked={includeLlmKeys}
            class="mt-0.5 rounded border-stone-300 dark:border-stone-600 text-stone-900 dark:text-stone-100 focus:ring-0"
          />
          <div class="space-y-0.5">
            <span class="text-xs font-medium text-stone-900 dark:text-stone-100 flex items-center gap-1.5">
              <Sparkles class="w-3.5 h-3.5 text-amber-500" />
              Include AI settings & keys
            </span>
            <p class="text-[11px] text-stone-500 dark:text-stone-400">
              Needed if you want to generate summaries or ask AI questions while away from your computer.
            </p>
          </div>
        </label>
      </div>

      <div class="pt-2">
        <button
          onclick={startSync}
          class="w-full py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center space-x-2"
        >
          <Download class="w-4 h-4" />
          <span>Download Courses for Offline Use</span>
        </button>
      </div>

    {:else if progress === 'syncing'}
      <div class="py-6 flex flex-col items-center justify-center space-y-4">
        <Loader2 class="w-8 h-8 animate-spin text-stone-900 dark:text-stone-100" />
        <div class="text-center space-y-1">
          <p class="text-xs font-medium text-stone-900 dark:text-stone-100">Downloading courses from your Mac...</p>
          <p class="text-[11px] text-stone-500 dark:text-stone-400">Packaging manifests, lesson texts, and notes into local storage</p>
        </div>
      </div>

    {:else if progress === 'done'}
      <div class="py-4 space-y-4 text-center">
        <div class="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto">
          <CheckCircle2 class="w-6 h-6" />
        </div>
        <div class="space-y-1">
          <p class="text-sm font-semibold text-stone-900 dark:text-stone-100">Ready for Offline Study!</p>
          <p class="text-xs text-stone-500 dark:text-stone-400 max-w-xs mx-auto">
            All your courses are now stored locally. You can close this or add this page to your Home Screen.
          </p>
        </div>
        <button
          onclick={onDone}
          class="w-full py-2.5 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold shadow-xs transition cursor-pointer"
        >
          Start Studying
        </button>
      </div>

    {:else if progress === 'error'}
      <div class="py-4 space-y-4">
        <div class="flex items-start space-x-3 text-red-600 dark:text-red-400 text-xs bg-red-50 dark:bg-red-950/40 p-3.5 rounded-xl border border-red-200 dark:border-red-900/40">
          <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
          <span class="break-words">{errorMessage}</span>
        </div>
        <div class="flex items-center space-x-3">
          <button
            onclick={onDone}
            class="flex-1 py-2 rounded-xl border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Skip for Now
          </button>
          <button
            onclick={startSync}
            class="flex-1 py-2 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-stone-900 text-xs font-semibold transition cursor-pointer"
          >
            Try Again
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>
