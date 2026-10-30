<script lang="ts">
  import {
    Sparkles,
    ChevronDown,
    ChevronUp,
    Loader2,
    RotateCcw,
    Paperclip,
    Upload,
    X
  } from 'lucide-svelte';
  import { apiFetch } from '$lib/api';
  import { isUnitScopeId } from '$lib/tabs';
  import { fetchLlmStore, setActiveLlmCard } from '$lib/llmClient';
  import type { LlmCardSummary } from '$lib/llmProviders';

  interface Props {
    prompt: string;
    tabName: string;
    isGenerating?: boolean;
    defaultPrompt?: string;
    courseId?: string;
    lessonId?: string;
    activeTab?: string;
    initialAttachment?: string;
    onChangePrompt: (newPrompt: string) => void;
    onRegenerate: (options?: {
      customPrompt?: string;
      customContent?: string;
      contextAttachment?: string;
      cardId?: string;
    }) => void;
    onResetPrompt?: () => void;
    onClose?: () => void;
  }

  let {
    prompt,
    tabName,
    isGenerating = false,
    defaultPrompt = '',
    courseId = '',
    lessonId = '',
    activeTab = '',
    initialAttachment = '',
    onChangePrompt,
    onRegenerate,
    onResetPrompt,
    onClose
  }: Props = $props();

  let isExpanded = $state(true);
  let localPrompt = $state('');
  let initialPrompt = $state('');
  let selectedAttachment = $state('');
  let attachmentChars = $state(0);
  let isLoadingAttachmentChars = $state(false);

  let availableCards = $state<LlmCardSummary[]>([]);
  let selectedCardId = $state<string>('');

  async function loadModels() {
    try {
      const store = await fetchLlmStore();
      if (store) {
        availableCards = store.cards.filter((c) => Boolean(c.baseUrl && c.baseUrl.trim()));
        if (!selectedCardId || !availableCards.some((c) => c.id === selectedCardId)) {
          selectedCardId = store.activeId || availableCards[0]?.id || '';
        }
      }
    } catch (err) {
      console.warn('Failed to load LLM models for PromptCard:', err);
    }
  }

  $effect(() => {
    void loadModels();
  });

  async function handleModelChange(newCardId: string) {
    selectedCardId = newCardId;
    try {
      await setActiveLlmCard(newCardId);
    } catch (err) {
      console.warn('Failed to set active LLM card:', err);
    }
  }

  interface LockerDoc {
    filename: string;
    size: number;
    url: string;
  }

  let lockerDocs = $state<LockerDoc[]>([]);
  let isLoadingLockerDocs = $state(false);
  let isUploadingLocker = $state(false);

  async function loadLockerDocs() {
    if (!courseId) return;
    isLoadingLockerDocs = true;
    try {
      const res = await apiFetch(`/api/courses/${courseId}/locker-docs`);
      if (res.ok) {
        const data = await res.json();
        lockerDocs = Array.isArray(data.files) ? data.files : [];
      }
    } catch (err) {
      console.error('Failed to load locker docs:', err);
    } finally {
      isLoadingLockerDocs = false;
    }
  }

  $effect(() => {
    if (courseId) {
      void loadLockerDocs();
    }
  });

  function resolveDefaultAttachment(tab: string, scopeId?: string): string {
    if (scopeId && isUnitScopeId(scopeId)) return 'unit - lessons';
    const scope = scopeId ? 'lesson' : 'course';
    if (scope === 'lesson') return 'lesson - lessons';
    const cleanTab = tab.toLowerCase().trim();
    if (cleanTab === 'notes' || cleanTab === 'studysheet') return 'course - notes';
    return 'course - summaries';
  }

  function normalizeAttachment(attachment: string | undefined, tab: string, scopeId?: string): string {
    if (attachment && attachment.toLowerCase().trim().startsWith('locker - ')) {
      return attachment;
    }
    const isLesson = scopeId && !isUnitScopeId(scopeId);
    if (isLesson) {
      if (!attachment || attachment === 'lesson - summaries' || attachment === 'lesson - notes' || attachment === 'lesson - studysheets') {
        return 'lesson - lessons';
      }
      return attachment;
    }
    return attachment || resolveDefaultAttachment(tab, scopeId);
  }

  $effect(() => {
    selectedAttachment = normalizeAttachment(initialAttachment, activeTab, lessonId);
  });

  $effect(() => {
    localPrompt = prompt;
    initialPrompt = prompt;
  });

  async function updateAttachmentCharCount(attachment: string) {
    if (!courseId) return;
    isLoadingAttachmentChars = true;
    try {
      const url = `/api/courses/${courseId}/prompt-context?attachment=${encodeURIComponent(attachment)}${lessonId ? `&lessonId=${encodeURIComponent(lessonId)}` : ''}`;
      const res = await apiFetch(url);
      if (res.ok) {
        const data = await res.json();
        attachmentChars = typeof data.charCount === 'number' ? data.charCount : 0;
      } else {
        attachmentChars = 0;
      }
    } catch (err) {
      console.error('Failed to fetch prompt context char count:', err);
      attachmentChars = 0;
    } finally {
      isLoadingAttachmentChars = false;
    }
  }

  $effect(() => {
    if (courseId && selectedAttachment) {
      updateAttachmentCharCount(selectedAttachment);
    }
  });

  let selectedScope = $derived.by(() => {
    if ((selectedAttachment || '').toLowerCase().startsWith('locker - ')) return 'locker';
    const parts = (selectedAttachment || '').split(' - ');
    if (parts[0]) return parts[0];
    if (lessonId && isUnitScopeId(lessonId)) return 'unit';
    return lessonId ? 'lesson' : 'course';
  });

  let selectedTab = $derived.by(() => {
    const parts = (selectedAttachment || '').split(' - ');
    const tabPart = parts[1] || 'lessons';
    if (tabPart === 'studysheets') return 'notes';
    return tabPart;
  });

  let selectedLockerDoc = $derived.by(() => {
    if ((selectedAttachment || '').toLowerCase().startsWith('locker - ')) {
      return selectedAttachment.slice(9).trim();
    }
    return '';
  });

  function handleScopeChange(newScope: string) {
    if (newScope === 'locker') {
      const doc = selectedLockerDoc || lockerDocs[0]?.filename || '';
      selectedAttachment = doc ? `locker - ${doc}` : 'locker - ';
    } else {
      let newTab = selectedTab;
      selectedAttachment = `${newScope} - ${newTab}`;
    }
  }

  function handleTabChange(newTab: string) {
    selectedAttachment = `${selectedScope} - ${newTab}`;
  }

  function handleLockerDocChange(filename: string) {
    selectedAttachment = `locker - ${filename}`;
  }

  async function handlePromptLockerUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !courseId) return;

    isUploadingLocker = true;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch(`/api/courses/${courseId}/locker-docs`, {
        method: 'POST',
        body: formData
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      await loadLockerDocs();
      if (data.file?.filename) {
        selectedAttachment = `locker - ${data.file.filename}`;
      }
    } catch (err) {
      console.error('Failed to upload locker doc in prompt card:', err);
      alert('Failed to upload document to locker');
    } finally {
      isUploadingLocker = false;
      input.value = '';
    }
  }

  let isModified = $derived.by(() => {
    const promptChanged = defaultPrompt
      ? localPrompt.trim() !== defaultPrompt.trim()
      : localPrompt.trim() !== initialPrompt.trim();
    const baselineAtt = normalizeAttachment(initialAttachment, activeTab, lessonId);
    const defaultAtt = resolveDefaultAttachment(activeTab, lessonId);
    const attachmentChanged = selectedAttachment !== baselineAtt && selectedAttachment !== defaultAtt;
    return promptChanged || attachmentChanged;
  });

  function handleInput(e: Event) {
    const val = (e.target as HTMLTextAreaElement).value;
    localPrompt = val;
    onChangePrompt(val);
  }

  function handleReset() {
    const target = defaultPrompt || initialPrompt;
    localPrompt = target;
    onChangePrompt(target);
    selectedAttachment = resolveDefaultAttachment(activeTab, lessonId);
    if (onResetPrompt) onResetPrompt();
  }

  function handleRegenerate() {
    if (isGenerating) return;
    onRegenerate({
      customPrompt: localPrompt,
      contextAttachment: selectedAttachment,
      cardId: selectedCardId || undefined
    });
  }
</script>

<div class="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xs mb-6 overflow-hidden transition">
  <!-- Card Header Bar -->
  <div class="px-4 py-2.5 bg-stone-50/80 dark:bg-stone-800/80 border-b border-stone-200 dark:border-stone-800 flex flex-wrap items-center justify-between gap-3">
    <!-- Left: Title -->
    <div class="flex items-center space-x-2 flex-wrap gap-y-1.5">
      <div class="p-1 rounded-md bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 shadow-2xs shrink-0">
        <Sparkles class="w-3.5 h-3.5" />
      </div>
      <span class="text-xs font-semibold text-stone-900 dark:text-stone-100 whitespace-nowrap">
        {tabName} Prompt
      </span>

      {#if availableCards.length > 1}
        <span class="text-xs text-stone-400 dark:text-stone-500 font-normal">using</span>
        <select
          value={selectedCardId}
          onchange={(e) => handleModelChange(e.currentTarget.value)}
          aria-label="Select AI model for this prompt"
          class="px-2 py-0.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-xs font-medium text-stone-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition cursor-pointer shadow-2xs max-w-[200px] truncate"
        >
          {#each availableCards as card (card.id)}
            <option value={card.id}>
              {card.label || 'Untitled'}{card.model ? ` (${card.model})` : ''}
            </option>
          {/each}
        </select>
      {/if}
    </div>

    <!-- Right: Actions -->
    <div class="flex items-center space-x-1.5">
      {#if isGenerating}
        <span class="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 text-xs font-medium mr-1">
          <Loader2 class="w-3.5 h-3.5 animate-spin" />
          <span>Generating...</span>
        </span>
      {/if}

      <button
        type="button"
        onclick={() => (isExpanded = !isExpanded)}
        class="p-1 rounded-md text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-stone-800 transition cursor-pointer"
        title={isExpanded ? 'Collapse Prompt' : 'Expand Prompt'}
      >
        {#if isExpanded}
          <ChevronUp class="w-4 h-4" />
        {:else}
          <ChevronDown class="w-4 h-4" />
        {/if}
      </button>

      {#if onClose}
        <button
          type="button"
          onclick={onClose}
          class="p-1 rounded-md text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-stone-800 transition cursor-pointer"
          title="Close Prompt"
        >
          <X class="w-4 h-4" />
        </button>
      {/if}
    </div>
  </div>

  <!-- Collapsible Prompt Textarea -->
  {#if isExpanded}
    <div class="px-3.5 py-2 space-y-1.5 bg-white dark:bg-stone-900 border-t border-stone-100 dark:border-stone-800">
      <!-- Attachment Controls (Two Dropdowns + Character Count) -->
      <div class="flex items-center justify-between text-xs py-0">
        <div class="flex items-center space-x-1.5">
          <div class="flex items-center space-x-1 text-stone-500 dark:text-stone-400 font-medium text-[11px]">
            <Paperclip class="w-3 h-3 text-stone-400 dark:text-stone-500" />
            <span>attachment:</span>
          </div>

          <select
            value={selectedScope}
            onchange={(e) => handleScopeChange((e.target as HTMLSelectElement).value)}
            class="px-1.5 py-0.5 rounded border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-950 text-[11px] font-medium text-stone-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition cursor-pointer"
          >
            <option value="course">course</option>
            <option value="unit" disabled={!lessonId}>unit</option>
            <option value="lesson" disabled={!lessonId}>lesson</option>
            <option value="locker">locker</option>
          </select>

          <span class="text-stone-400 dark:text-stone-600 text-[11px]">-</span>

          {#if selectedScope === 'locker'}
            <div class="flex items-center space-x-1">
              <select
                value={selectedLockerDoc}
                onchange={(e) => handleLockerDocChange((e.target as HTMLSelectElement).value)}
                class="max-w-[160px] sm:max-w-[220px] px-1.5 py-0.5 rounded border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-950 text-[11px] font-medium text-stone-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition cursor-pointer truncate"
              >
                {#if lockerDocs.length === 0}
                  <option value="">(No documents in locker)</option>
                {:else}
                  {#each lockerDocs as doc}
                    <option value={doc.filename}>{doc.filename}</option>
                  {/each}
                {/if}
              </select>

              <label
                class="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded border border-stone-200 dark:border-stone-800 bg-stone-100 dark:bg-stone-800 text-[10px] text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer transition shrink-0"
                title="Upload a new document to course locker"
              >
                <input
                  type="file"
                  class="hidden"
                  accept=".pdf,.html,.htm,.txt,.md,.doc,.docx"
                  disabled={isUploadingLocker}
                  onchange={handlePromptLockerUpload}
                />
                {#if isUploadingLocker}
                  <Loader2 class="w-3 h-3 animate-spin" />
                {:else}
                  <Upload class="w-3 h-3" />
                  <span class="hidden sm:inline">Upload</span>
                {/if}
              </label>
            </div>
          {:else}
            <select
              value={selectedTab}
              onchange={(e) => handleTabChange((e.target as HTMLSelectElement).value)}
              class="px-1.5 py-0.5 rounded border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-950 text-[11px] font-medium text-stone-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition cursor-pointer"
            >
              <option value="lessons">lesson(s)</option>
              <option value="summaries">summary(s)</option>
              <option value="notes">note(s)</option>
            </select>
          {/if}
        </div>

        <div class="flex items-center space-x-1.5 text-[10px] text-stone-400 dark:text-stone-500 font-mono select-none">
          {#if isLoadingAttachmentChars}
            <Loader2 class="w-3 h-3 animate-spin text-stone-400" />
            <span>calculating...</span>
          {:else if attachmentChars > 0}
            <span title="Context attachment length: {attachmentChars.toLocaleString()} characters">
              {attachmentChars.toLocaleString()}-chars
            </span>
          {:else}
            <span class="opacity-60">0-chars</span>
          {/if}
        </div>
      </div>

      <!-- Dominant Main Prompt Textarea -->
      <textarea
        id="prompt-input"
        value={localPrompt}
        oninput={handleInput}
        rows="7"
        placeholder="Enter prompt instructions for generating this study material..."
        class="w-full p-2.5 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 text-xs font-mono leading-relaxed text-stone-800 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition resize-y"
      ></textarea>

      <!-- Bottom Status Bar -->
      <div class="flex items-center justify-between text-xs pt-1">
        <div class="flex items-center space-x-2">
          {#if isModified}
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300">
              Prompt modified
            </span>
            <button
              type="button"
              onclick={handleReset}
              class="flex items-center space-x-1 text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 underline text-[11px] cursor-pointer"
            >
              <RotateCcw class="w-3 h-3" />
              <span>Reset</span>
            </button>
          {/if}
        </div>

        <button
          type="button"
          onclick={handleRegenerate}
          disabled={isGenerating}
          class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50 disabled:cursor-not-allowed text-white dark:text-stone-900 text-xs font-medium transition shadow-2xs cursor-pointer"
        >
          {#if isGenerating}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>Generating...</span>
          {:else}
            <Sparkles class="w-3.5 h-3.5" />
            <span>Save & Re-generate</span>
          {/if}
        </button>
      </div>
    </div>
  {/if}
</div>