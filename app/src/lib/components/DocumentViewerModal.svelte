<script lang="ts">
  import { X, Download, FileText, ArrowLeft, Loader2, ExternalLink } from 'lucide-svelte';

  interface Props {
    url: string;
    title?: string;
    courseTitle?: string;
    onClose: () => void;
  }

  let { url, title = 'Document', courseTitle, onClose }: Props = $props();

  let isLoading = $state(true);
  let isImage = $derived(/\.(png|jpe?g|gif|webp|svg)($|\?)/i.test(url));

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function handleContentLoad() {
    isLoading = false;
  }

  // Extract clean filename from URL if title is generic
  let displayTitle = $derived.by(() => {
    if (title && title !== 'Document' && title !== url) {
      return title;
    }
    const cleanUrl = url.split('?')[0];
    const filename = cleanUrl.split('/').pop() || 'Document';
    try {
      return decodeURIComponent(filename);
    } catch {
      return filename;
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Full-page Document / PDF Viewer Overlay -->
<div class="fixed inset-0 z-50 flex flex-col bg-stone-900 animate-in fade-in duration-150">
  <!-- Top Bar with Document Title & Close [X] Button -->
  <header class="h-14 bg-stone-900 border-b border-stone-800 px-3 sm:px-6 flex items-center justify-between text-white shrink-0 select-none shadow-md z-20">
    <!-- Left: Back Button & Document Info -->
    <div class="flex items-center space-x-2 sm:space-x-3 min-w-0">
      <button
        onclick={onClose}
        class="flex items-center space-x-1 sm:space-x-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-stone-300 hover:text-white hover:bg-stone-800 transition cursor-pointer text-xs font-medium shrink-0"
        title="Go back to lesson (Esc)"
      >
        <ArrowLeft class="w-4 h-4" />
        <span class="hidden sm:inline">Back</span>
      </button>

      <div class="h-4 w-px bg-stone-800 shrink-0"></div>

      <div class="p-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
        <FileText class="w-4 h-4" />
      </div>

      <div class="min-w-0">
        <div class="flex items-center space-x-2">
          <h2 class="text-xs sm:text-sm font-semibold text-stone-100 truncate max-w-xs sm:max-w-md md:max-w-lg lg:max-w-xl">
            {displayTitle}
          </h2>
          <span class="hidden sm:inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-stone-800 text-stone-300 border border-stone-700 uppercase tracking-wider shrink-0">
            {isImage ? 'Image' : 'PDF Document'}
          </span>
        </div>
        {#if courseTitle}
          <p class="text-[11px] text-stone-400 truncate max-w-sm hidden sm:block">
            {courseTitle}
          </p>
        {/if}
      </div>
    </div>

    <!-- Right: Actions & Prominent Close Button [X] -->
    <div class="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
      <!-- Download / External Link -->
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        download
        class="flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg border border-stone-700 bg-stone-800 hover:bg-stone-700 text-xs font-medium text-stone-200 hover:text-white transition shadow-2xs cursor-pointer"
        title="Download or open in external viewer"
      >
        <Download class="w-3.5 h-3.5 text-stone-400" />
        <span class="hidden md:inline">Download</span>
      </a>

      <!-- Prominent Close Button [X] -->
      <button
        onclick={onClose}
        class="flex items-center space-x-1.5 px-3 sm:px-3.5 py-1.5 rounded-lg bg-stone-800 hover:bg-rose-950/80 hover:text-rose-200 hover:border-rose-700/80 text-xs font-semibold text-stone-100 border border-stone-700 transition cursor-pointer shadow-sm group"
        title="Close document and go back (Esc)"
      >
        <X class="w-4 h-4 text-stone-300 group-hover:text-rose-300 transition-colors" />
        <span>Close</span>
      </button>
    </div>
  </header>

  <!-- Document Canvas Area -->
  <main class="flex-1 w-full relative bg-stone-950 overflow-hidden flex items-center justify-center">
    {#if isLoading}
      <div class="absolute inset-0 z-10 flex flex-col items-center justify-center space-y-3 bg-stone-950 text-stone-400">
        <Loader2 class="w-7 h-7 animate-spin text-amber-500" />
        <span class="text-xs text-stone-400 font-medium">Loading document...</span>
      </div>
    {/if}

    {#if isImage}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="w-full h-full p-4 overflow-auto flex items-center justify-center cursor-zoom-out"
        onclick={(e) => {
          if (e.target === e.currentTarget) {
            onClose();
          }
        }}
      >
        <img
          src={url}
          alt={displayTitle}
          onload={handleContentLoad}
          class="max-w-full max-h-full object-contain rounded shadow-lg cursor-default"
        />
      </div>
    {:else}
      <iframe
        src={url}
        title={displayTitle}
        onload={handleContentLoad}
        class="w-full h-full border-0 bg-stone-100"
      ></iframe>
    {/if}
  </main>
</div>
