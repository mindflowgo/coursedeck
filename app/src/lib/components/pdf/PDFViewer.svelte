<script lang="ts">
  import { isTauriEnvironment, pdfGetInfo, type PdfDocumentInfo } from '$lib/pdfClient';
  import ViewerToolbar from './ViewerToolbar.svelte';
  import { Loader2, FileWarning, RefreshCw } from 'lucide-svelte';

  interface Props {
    url?: string | null;
    buffer?: ArrayBuffer | null;
    title?: string;
    courseId?: string;
    lessonTitle?: string;
    pageRange?: string;
    readingDescription?: string;
    initialPage?: number | null;
  }

  let {
    url = null,
    buffer = null,
    title = 'Course Book',
    courseId = '',
    lessonTitle = '',
    pageRange = '',
    readingDescription = '',
    initialPage = null
  }: Props = $props();

  // Static environment fact — evaluating it once avoids the state/onMount
  // round-trip racing the initial load effect.
  const isTauri = isTauriEnvironment();

  let docInfo = $state<PdfDocumentInfo | null>(null);
  let isLoading = $state(true);
  let loadError = $state<string | null>(null);

  async function loadDocument() {
    if (!url) {
      docInfo = null;
      isLoading = false;
      loadError = null;
      return;
    }

    // In browser development outside of Tauri, the browser's native PDF
    // viewer (iframe fallback below) is used instead.
    if (!isTauri) {
      isLoading = false;
      return;
    }

    isLoading = true;
    loadError = null;

    try {
      const info = await pdfGetInfo(url);
      docInfo = info;
    } catch (err: any) {
      console.error('[PDFViewer] Failed to load PDF info:', err);
      loadError = err?.message || (typeof err === 'string' ? err : 'Could not load PDF document.');
    } finally {
      isLoading = false;
    }
  }

  $effect(() => {
    if (url) {
      void loadDocument();
    }
  });
</script>

{#if isLoading}
  <div class="h-full w-full flex flex-col items-center justify-center space-y-3 bg-stone-50 dark:bg-stone-900 text-stone-500">
    <Loader2 class="w-7 h-7 animate-spin text-amber-500" />
    <span class="text-xs font-medium">Opening document...</span>
  </div>
{:else if loadError}
  <div class="h-full w-full flex flex-col items-center justify-center space-y-3 bg-stone-50 dark:bg-stone-900 text-stone-500 px-6 text-center">
    <FileWarning class="w-8 h-8 text-rose-400" />
    <div class="text-sm font-medium text-stone-700 dark:text-stone-200">Could not load document</div>
    <p class="text-xs max-w-sm leading-relaxed">{loadError}</p>
    {#if url}
      <button
        type="button"
        onclick={() => void loadDocument()}
        class="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700 transition cursor-pointer"
      >
        <RefreshCw class="w-3.5 h-3.5" />
        Try again
      </button>
    {/if}
  </div>
{:else if !isTauri && url}
  <!-- Standalone browser fallback using standard browser native PDF viewer -->
  <iframe
    src={initialPage ? `${url}#page=${initialPage}` : url}
    title={title}
    class="w-full h-full border-0 bg-stone-100 dark:bg-stone-950"
  ></iframe>
{:else if docInfo && url}
  <ViewerToolbar
    docPath={url}
    {docInfo}
    {title}
    {courseId}
    {lessonTitle}
    {pageRange}
    {readingDescription}
    {initialPage}
  />
{:else}
  <div class="h-full w-full flex items-center justify-center text-stone-400 text-xs">
    No document selected.
  </div>
{/if}
