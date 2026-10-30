<script lang="ts">
  import { apiFetch } from '$lib/api';
  import { Upload, X, FileArchive, CheckCircle2, AlertCircle, Loader2, Plus, RefreshCw, Sparkles } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    presetCourseId?: string;
    mode?: 'add' | 'replace';
    targetLessonId?: string;
    targetLessonTitle?: string;
    onClose: () => void;
    onUploaded: (courseId: string) => void;
  }

  let {
    isOpen,
    presetCourseId = '',
    mode = 'add',
    targetLessonId = '',
    targetLessonTitle = '',
    onClose,
    onUploaded
  }: Props = $props();

  let courseId = $state('');
  let selectedFiles: File[] = $state([]);
  let isDragging = $state(false);
  let isUploading = $state(false);
  let autoGenerateAI = $state(true);
  let errorMessage = $state('');

  $effect(() => {
    if (isOpen) {
      errorMessage = '';
      if (presetCourseId) {
        courseId = presetCourseId;
      } else {
        courseId = '';
      }
    }
  });

  function handleFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files) {
      selectedFiles = Array.from(target.files).filter((f) => /\.(zip|mhtml|mht|html|htm)$/i.test(f.name));
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    if (e.dataTransfer?.files) {
      selectedFiles = Array.from(e.dataTransfer.files).filter((f) => /\.(zip|mhtml|mht|html|htm)$/i.test(f.name));
    }
  }

  async function uploadFiles() {
    if (!selectedFiles.length) {
      errorMessage = 'Please select at least one lesson file (.zip, .mhtml, .html).';
      return;
    }

    const finalCourseId = (presetCourseId || courseId).trim().toLowerCase();
    if (!finalCourseId) {
      errorMessage = 'Please enter a course code (e.g. cou1u, czh3m).';
      return;
    }

    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(finalCourseId)) {
      errorMessage = 'Invalid course code. Must start with a letter or digit and contain only letters, numbers, dots, hyphens, or underscores (e.g. mcr3u).';
      return;
    }

    isUploading = true;
    errorMessage = '';

    const formData = new FormData();
    formData.append('courseId', finalCourseId);
    formData.append('mode', mode);
    if (mode === 'replace' && targetLessonId) {
      formData.append('targetLessonId', targetLessonId);
    }

    for (const file of selectedFiles) {
      formData.append('files', file);
    }

    try {
      const res = await apiFetch('/api/parse', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to upload and parse course archive.');
      }

      const data = await res.json();
      selectedFiles = [];

      if (autoGenerateAI) {
        try {
          await apiFetch('/api/queue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'enqueue',
              courseId: finalCourseId,
              lessonId: mode === 'replace' ? targetLessonId : undefined,
              lessonTitle: mode === 'replace' ? targetLessonTitle : undefined,
              tabs: ['summary', 'notes', 'test']
            })
          });
        } catch (queueErr) {
          console.warn('Auto-queue study materials failed:', queueErr);
        }
      }

      onUploaded(finalCourseId);
      onClose();
    } catch (err: any) {
      errorMessage = err?.message || 'Error uploading files.';
    } finally {
      isUploading = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => { if (isOpen && e.key === 'Escape') onClose(); }} />

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs">
    <!-- Backdrop dismiss -->
    <button
      type="button"
      class="absolute inset-0 w-full h-full cursor-default"
      onclick={onClose}
      aria-label="Close modal overlay"
      tabindex="-1"
    ></button>

    <div
      class="relative z-10 w-full max-w-md rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150"
    >
      <!-- Modal Header -->
      <div class="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-stone-800">
        <div class="flex items-center space-x-2">
          <div class="p-1.5 rounded-lg {mode === 'replace' ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400' : 'bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300'}">
            {#if mode === 'replace'}
              <RefreshCw class="w-4 h-4" />
            {:else if presetCourseId}
              <Plus class="w-4 h-4" />
            {:else}
              <Upload class="w-4 h-4" />
            {/if}
          </div>
          <div>
            <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">
              {#if mode === 'replace'}
                Replace Chapter {targetLessonTitle ? `(${targetLessonTitle})` : targetLessonId}
              {:else if presetCourseId}
                Add Chapters to {presetCourseId.toUpperCase()}
              {:else}
                Upload Course Package
              {/if}
            </h2>
            <p class="text-[11px] text-stone-400 dark:text-stone-500">
              {#if mode === 'replace'}
                Upload a replacement package (.zip, .mhtml, .html) for this chapter.
              {:else if presetCourseId}
                New chapters will be parsed and merged into this course.
              {:else}
                Ingest a course package of ILC lessons.
              {/if}
            </p>
          </div>
        </div>
        <button
          onclick={onClose}
          class="p-1 rounded-md text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Course Identifier Input (only shown if not preset) -->
      {#if !presetCourseId}
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label for="course-id" class="text-xs font-medium text-stone-700 dark:text-stone-300">
              Course Code <span class="text-rose-500 font-bold">*</span>
            </label>
            <span class="text-[10px] text-stone-400 dark:text-stone-500 font-medium">Required</span>
          </div>
          <input
            id="course-id"
            type="text"
            required
            bind:value={courseId}
            placeholder="e.g. MAT1U, ENG2U, PHY4U"
            class="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 text-xs font-mono uppercase text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          />
          <p class="text-[11px] text-stone-400 dark:text-stone-500">
            Enter the curriculum code or course name (e.g. mcr3u).
          </p>
        </div>
      {:else}
        <div class="p-2.5 rounded-lg bg-stone-50 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700 text-xs text-stone-600 dark:text-stone-300 flex items-center justify-between">
          <span class="font-medium text-stone-700 dark:text-stone-300">Target Course:</span>
          <span class="font-mono uppercase font-bold text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 px-2 py-0.5 rounded border border-stone-200 dark:border-stone-700">
            {presetCourseId}
          </span>
        </div>
      {/if}

      <!-- Drag & Drop Zone -->
      <div
        role="region"
        aria-label="Course package drop zone"
        ondragover={(e) => { e.preventDefault(); isDragging = true; }}
        ondragleave={() => (isDragging = false)}
        ondrop={handleDrop}
        class="border-2 border-dashed rounded-xl p-6 text-center space-y-2 transition {isDragging ? 'border-stone-900 dark:border-stone-100 bg-stone-50 dark:bg-stone-800/40' : 'border-stone-200 dark:border-stone-700 hover:border-stone-300 dark:hover:border-stone-600'}"
      >
        <div class="mx-auto w-10 h-10 rounded-full bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 flex items-center justify-center text-stone-400 dark:text-stone-500">
          <FileArchive class="w-5 h-5" />
        </div>
        <div class="text-xs text-stone-600 dark:text-stone-400">
          <label for="zip-files" class="font-semibold text-stone-900 dark:text-stone-100 hover:underline cursor-pointer">
            Browse files
          </label>
          or drag & drop lesson files (.zip, .mhtml, .html)
        </div>
        <p class="text-[11px] text-stone-400 dark:text-stone-500">Supports ILC packages, browser-saved complete page zips, and MHTML archives</p>
        <input
          id="zip-files"
          type="file"
          multiple
          accept=".zip,.mhtml,.mht,.html,.htm"
          onchange={handleFileSelect}
          class="hidden"
        />
      </div>

      <!-- File List -->
      {#if selectedFiles.length > 0}
        <div class="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-stone-100 dark:border-stone-800 p-2 bg-stone-50/50 dark:bg-stone-800/40">
          {#each selectedFiles as f}
            <div class="flex items-center justify-between text-[11px] text-stone-700 dark:text-stone-300 py-0.5">
              <span class="truncate max-w-[260px]">{f.name}</span>
              <span class="text-stone-400 dark:text-stone-500 font-mono text-[10px]">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Auto-generate AI Study Materials Toggle -->
      <div class="p-2.5 rounded-xl bg-amber-50/60 dark:bg-amber-950/40 border border-amber-200/50 dark:border-amber-800/50">
        <label class="flex items-center space-x-2 text-xs text-stone-800 dark:text-stone-200 cursor-pointer select-none">
          <input
            type="checkbox"
            bind:checked={autoGenerateAI}
            class="rounded border-stone-300 dark:border-stone-700 text-amber-600 focus:ring-amber-500 cursor-pointer"
          />
          <div class="flex items-center space-x-1.5 flex-1 min-w-0">
            <Sparkles class="w-3.5 h-3.5 text-amber-500 shrink-0" />
            <span class="font-medium text-stone-900 dark:text-stone-100">Auto-queue AI Study Materials</span>
            <span class="text-[10px] text-stone-500 dark:text-stone-400 hidden sm:inline">(Summary, Notes, Test)</span>
          </div>
        </label>
      </div>

      <!-- Error message -->
      {#if errorMessage}
        <div class="flex items-center space-x-2 text-rose-600 dark:text-rose-300 text-xs bg-rose-50 dark:bg-rose-950/50 border border-rose-100 dark:border-rose-900 p-2.5 rounded-lg">
          <AlertCircle class="w-4 h-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      {/if}

      <!-- Actions -->
      <div class="flex items-center justify-between pt-2 border-t border-stone-100 dark:border-stone-800">
        <span class="text-[11px] text-stone-400 dark:text-stone-500">
          Existing notes are preserved.
        </span>
        <div class="flex items-center space-x-2">
          <button
            onclick={onClose}
            disabled={isUploading}
            class="px-3.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 text-xs text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            onclick={uploadFiles}
            disabled={isUploading || selectedFiles.length === 0 || (!presetCourseId && !courseId.trim())}
            class="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm cursor-pointer"
          >
            {#if isUploading}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>{mode === 'replace' ? 'Replacing...' : 'Ingesting...'}</span>
            {:else if mode === 'replace'}
              <RefreshCw class="w-3.5 h-3.5" />
              <span>Replace Chapter & Parse</span>
            {:else}
              <Upload class="w-3.5 h-3.5" />
              <span>{presetCourseId ? 'Add Chapters & Parse' : 'Ingest & Parse'}</span>
            {/if}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
