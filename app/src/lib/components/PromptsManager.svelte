<script lang="ts">
  import { apiFetch } from '$lib/api';
  import { confirmDialog } from '$lib/dialog';
  import CodeMirrorEditor from '$lib/components/CodeMirrorEditor.svelte';
  import type { PromptItem } from '$lib/server/prompts';
  import { onMount } from 'svelte';
  import { Save, Check, Loader2, FileCode, Info, X, Trash2 } from 'lucide-svelte';

  let prompts: PromptItem[] = $state([]);
  let selectedPromptId: string = $state('');
  let editorContent: string = $state('');
  let originalContent: string = $state('');
  let isLoading = $state(true);
  let isSaving = $state(false);
  let isDeleting = $state(false);
  let saveSuccess = $state(false);

  let selectedPrompt = $derived(
    prompts.find((p) => p.id === selectedPromptId)
  );

  let hasUnsavedChanges = $derived(
    editorContent !== originalContent
  );

  import {
    classifyPrompt,
    COURSE_PROMPT_ORDER,
    UNIT_PROMPT_ORDER,
    LESSON_PROMPT_ORDER,
    type PromptGroupKey
  } from '$lib/settingsTabs';

  const COURSE_ORDER = COURSE_PROMPT_ORDER as readonly string[];
  const UNIT_ORDER = UNIT_PROMPT_ORDER as readonly string[];
  const LESSON_ORDER = LESSON_PROMPT_ORDER as readonly string[];

  let coursePrompts = $derived.by(() => {
    return prompts
      .filter((p) => classifyPrompt(p) === 'course')
      .sort((a, b) => {
        const idA = a.id.toLowerCase().replace(/\./g, '_');
        const idB = b.id.toLowerCase().replace(/\./g, '_');
        const idxA = COURSE_ORDER.indexOf(idA);
        const idxB = COURSE_ORDER.indexOf(idB);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return (a.title || a.id).localeCompare(b.title || b.id);
      });
  });

  let unitPrompts = $derived.by(() => {
    return prompts
      .filter((p) => classifyPrompt(p) === 'unit')
      .sort((a, b) => {
        const idA = a.id.toLowerCase().replace(/\./g, '_');
        const idB = b.id.toLowerCase().replace(/\./g, '_');
        const idxA = UNIT_ORDER.indexOf(idA);
        const idxB = UNIT_ORDER.indexOf(idB);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return (a.title || a.id).localeCompare(b.title || b.id);
      });
  });

  let lessonsPrompts = $derived.by(() => {
    return prompts
      .filter((p) => classifyPrompt(p) === 'lessons')
      .sort((a, b) => {
        const idA = a.id.toLowerCase().replace(/\./g, '_');
        const idB = b.id.toLowerCase().replace(/\./g, '_');
        const idxA = LESSON_ORDER.indexOf(idA);
        const idxB = LESSON_ORDER.indexOf(idB);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return (a.title || a.id).localeCompare(b.title || b.id);
      });
  });

  let customPrompts = $derived.by(() => {
    return prompts
      .filter((p) => classifyPrompt(p) === 'custom')
      .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  });

  function getPromptTitle(p: PromptItem): string {
    if (p.id === 'mcp_prompt_instructions') return 'MCP Instructions';
    return p.title || p.id;
  }

  let selectedGroupLabel = $derived.by(() => {
    if (!selectedPrompt) return '';
    const group = classifyPrompt(selectedPrompt);
    if (group === 'course') return 'Complete Course';
    if (group === 'unit') return 'Unit';
    if (group === 'lessons') return 'Lessons';
    return 'Custom';
  });

  async function loadPrompts() {
    isLoading = true;
    try {
      const res = await apiFetch('/api/prompts');
      if (res.ok) {
        const data = await res.json();
        prompts = data.prompts || [];
        if (prompts.length > 0 && !selectedPromptId) {
          const defaultItem =
            prompts.find((p) => classifyPrompt(p) === 'course') ||
            prompts.find((p) => classifyPrompt(p) === 'lessons') ||
            prompts[0];
          if (defaultItem) {
            selectPrompt(defaultItem.id);
          }
        }
      }
    } catch (e) {
      console.error('Failed to load prompts:', e);
    } finally {
      isLoading = false;
    }
  }

  function selectPrompt(id: string) {
    selectedPromptId = id;
    const p = prompts.find((item) => item.id === id);
    if (p) {
      editorContent = p.content;
      originalContent = p.content;
    }
  }

  async function savePrompt() {
    if (!selectedPromptId) return;
    isSaving = true;

    try {
      const res = await apiFetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedPromptId,
          content: editorContent
        })
      });

      if (res.ok) {
        originalContent = editorContent;
        const p = prompts.find((item) => item.id === selectedPromptId);
        if (p) p.content = editorContent;

        saveSuccess = true;
        setTimeout(() => {
          saveSuccess = false;
        }, 2000);
      }
    } catch (e) {
      console.error('Failed to save prompt:', e);
    } finally {
      isSaving = false;
    }
  }

  async function deletePrompt(p: PromptItem) {
    if (classifyPrompt(p) !== 'custom') return;
    const name = p.title || p.id;
    const confirmed = await confirmDialog(
      `Delete prompt "${name}"?\n\nThis will remove data/prompts/${p.filename} from disk.`,
      'Delete Prompt'
    );
    if (!confirmed) {
      return;
    }

    isDeleting = true;
    try {
      const res = await apiFetch(`/api/prompts?id=${encodeURIComponent(p.id)}`, {
        method: 'DELETE'
      });

      if (res.ok) {
        const remaining = prompts.filter((item) => item.id !== p.id);
        prompts = remaining;

        if (selectedPromptId === p.id) {
          const next =
            remaining.find((item) => classifyPrompt(item) === 'course') ||
            remaining.find((item) => classifyPrompt(item) === 'lessons') ||
            remaining[0];
          if (next) {
            selectPrompt(next.id);
          } else {
            selectedPromptId = '';
            editorContent = '';
            originalContent = '';
          }
        }
      } else {
        const errText = await res.text().catch(() => '');
        alert(`Failed to delete prompt: ${errText || res.statusText}`);
      }
    } catch (e: any) {
      console.error('Failed to delete prompt:', e);
      alert(`Failed to delete prompt: ${e?.message || e}`);
    } finally {
      isDeleting = false;
    }
  }

  onMount(() => {
    loadPrompts();
  });
</script>

<div class="flex-1 flex overflow-hidden w-full h-full">
  <!-- Left Sidebar: Prompts List Grouped by Course Wide, Lessons, Custom -->
  <aside class="w-64 border-r border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4 flex flex-col justify-between shrink-0 overflow-hidden">
    <div class="flex flex-col flex-1 min-h-0 space-y-3">
      {#if isLoading}
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <div class="h-10 rounded-lg bg-stone-100 dark:bg-stone-800 animate-pulse"></div>
          {/each}
        </div>
      {:else}
        <div class="flex-1 overflow-y-auto space-y-4 pr-1 -mr-1">
          <!-- Complete Course -->
          <div class="space-y-1">
            <div class="px-2 py-1 text-[11px] font-semibold text-stone-400 dark:text-stone-500 uppercase tracking-wider flex items-center justify-between">
              <span>Complete Course</span>
              <span class="text-[10px] font-mono opacity-60">{coursePrompts.length}</span>
            </div>
            {#if coursePrompts.length === 0}
              <p class="px-2 py-1 text-xs text-stone-400 dark:text-stone-500 italic">No course prompts</p>
            {:else}
              {#each coursePrompts as p (p.id)}
                {@const isSelected = p.id === selectedPromptId}
                <button
                  onclick={() => selectPrompt(p.id)}
                  title="{p.title || p.id} ({p.filename})"
                  class="w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition flex items-center space-x-2 cursor-pointer {isSelected ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
                >
                  <FileCode class="w-3.5 h-3.5 shrink-0 opacity-70" />
                  <span class="truncate">{p.title || p.id}</span>
                </button>
              {/each}
            {/if}
          </div>

          <!-- Unit -->
          <div class="space-y-1">
            <div class="px-2 py-1 text-[11px] font-semibold text-stone-400 dark:text-stone-500 uppercase tracking-wider flex items-center justify-between">
              <span>Unit</span>
              <span class="text-[10px] font-mono opacity-60">{unitPrompts.length}</span>
            </div>
            {#if unitPrompts.length === 0}
              <p class="px-2 py-1 text-xs text-stone-400 dark:text-stone-500 italic">No unit prompts</p>
            {:else}
              {#each unitPrompts as p (p.id)}
                {@const isSelected = p.id === selectedPromptId}
                <button
                  onclick={() => selectPrompt(p.id)}
                  title="{p.title || p.id} ({p.filename})"
                  class="w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition flex items-center space-x-2 cursor-pointer {isSelected ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
                >
                  <FileCode class="w-3.5 h-3.5 shrink-0 opacity-70" />
                  <span class="truncate">{p.title || p.id}</span>
                </button>
              {/each}
            {/if}
          </div>

          <!-- Lessons -->
          <div class="space-y-1">
            <div class="px-2 py-1 text-[11px] font-semibold text-stone-400 dark:text-stone-500 uppercase tracking-wider flex items-center justify-between">
              <span>Lessons</span>
              <span class="text-[10px] font-mono opacity-60">{lessonsPrompts.length}</span>
            </div>
            {#if lessonsPrompts.length === 0}
              <p class="px-2 py-1 text-xs text-stone-400 dark:text-stone-500 italic">No lesson prompts</p>
            {:else}
              {#each lessonsPrompts as p (p.id)}
                {@const isSelected = p.id === selectedPromptId}
                <button
                  onclick={() => selectPrompt(p.id)}
                  title="{p.title || p.id} ({p.filename})"
                  class="w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition flex items-center space-x-2 cursor-pointer {isSelected ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
                >
                  <FileCode class="w-3.5 h-3.5 shrink-0 opacity-70" />
                  <span class="truncate flex-1">{p.title || p.id}</span>
                </button>
              {/each}
            {/if}
          </div>

          <!-- Custom (only shown if custom prompts exist) -->
          {#if customPrompts.length > 0}
            <div class="space-y-1">
              <div class="px-2 py-1 text-[11px] font-semibold text-stone-400 dark:text-stone-500 uppercase tracking-wider flex items-center justify-between">
                <span>Custom</span>
                <span class="text-[10px] font-mono opacity-60">{customPrompts.length}</span>
              </div>
              {#each customPrompts as p (p.id)}
                {@const isSelected = p.id === selectedPromptId}
                {@const promptTitle = getPromptTitle(p)}
                <div class="group relative flex items-center">
                  <button
                    onclick={() => selectPrompt(p.id)}
                    title="{promptTitle} ({p.filename})"
                    class="w-full text-left pl-3 {p.id === 'mcp_prompt_instructions' ? 'pr-3' : 'pr-8'} py-2 rounded-lg text-xs font-medium transition flex items-center space-x-2 cursor-pointer {isSelected ? 'bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-semibold' : 'text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}"
                  >
                    <FileCode class="w-3.5 h-3.5 shrink-0 opacity-70" />
                    <span class="truncate">{promptTitle}</span>
                  </button>
                  {#if p.id !== 'mcp_prompt_instructions'}
                    <button
                      type="button"
                      onclick={(e) => {
                        e.stopPropagation();
                        deletePrompt(p);
                      }}
                      title="Delete prompt {promptTitle}"
                      class="absolute right-1.5 p-1 rounded hover:bg-stone-200 dark:hover:bg-stone-700 text-stone-400 hover:text-red-500 dark:hover:text-red-400 transition cursor-pointer {isSelected ? 'opacity-90 text-stone-300 dark:text-stone-600 hover:text-red-400 dark:hover:text-red-400' : 'opacity-0 group-hover:opacity-100'}"
                    >
                      <X class="w-3.5 h-3.5" />
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Variable Reference Card -->
    <div class="shrink-0 pt-3">
      <div class="p-3 rounded-xl bg-stone-50 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-800 space-y-1.5 text-[11px] text-stone-600 dark:text-stone-300">
        <div class="flex items-center space-x-1 font-semibold text-stone-800 dark:text-stone-200">
          <Info class="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
          <span>Template Variables</span>
        </div>
        <ul class="space-y-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
          <li><code>{"{{lesson_title}}"}</code> - Title</li>
          <li><code>{"{{unit}}"}</code> - Unit name</li>
          <li><code>{"{{content}}"}</code> - Lesson text</li>
        </ul>
      </div>
    </div>
  </aside>

  <!-- Right: Editor Area -->
  <section class="flex-1 flex flex-col overflow-hidden bg-stone-50 dark:bg-stone-950 p-6">
    <div class="flex items-center justify-between pb-4 mb-4 border-b border-stone-200 dark:border-stone-800">
      <div>
        <div class="flex items-center space-x-2">
          {#if selectedGroupLabel}
            <span class="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-stone-200/70 dark:bg-stone-800 text-stone-700 dark:text-stone-300">
              {selectedGroupLabel}
            </span>
          {/if}
          <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {selectedPrompt ? getPromptTitle(selectedPrompt) : ''}
          </h2>
        </div>
        <p class="text-xs text-stone-400 dark:text-stone-500 font-mono mt-0.5">
          file: data/prompts/{selectedPrompt ? selectedPrompt.filename : ''}
        </p>
      </div>

      <div class="flex items-center space-x-2">
        {#if selectedPrompt && classifyPrompt(selectedPrompt) === 'custom' && selectedPrompt.id !== 'mcp_prompt_instructions'}
          <button
            onclick={() => selectedPrompt && deletePrompt(selectedPrompt)}
            disabled={isDeleting}
            class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-xs font-medium transition cursor-pointer disabled:opacity-40"
            title="Delete this prompt"
          >
            <Trash2 class="w-3.5 h-3.5" />
            <span>Delete</span>
          </button>
        {/if}

        <button
          onclick={savePrompt}
          disabled={isSaving || !hasUnsavedChanges}
          class="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-40 disabled:cursor-not-allowed transition shadow-2xs cursor-pointer"
        >
          {#if isSaving}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>Saving...</span>
          {:else if saveSuccess}
            <Check class="w-3.5 h-3.5 text-emerald-400 dark:text-emerald-600" />
            <span class="font-semibold text-emerald-400 dark:text-emerald-600">Saved!</span>
          {:else}
            <Save class="w-3.5 h-3.5" />
            <span>Save Prompt</span>
          {/if}
        </button>
      </div>
    </div>

    <div class="flex-1 min-h-0 bg-white dark:bg-stone-900 rounded-xl border border-stone-200 dark:border-stone-800 shadow-2xs overflow-hidden">
      <CodeMirrorEditor
        value={editorContent}
        preserveFrontmatter={false}
        onChange={(val) => (editorContent = val)}
        onSave={savePrompt}
      />
    </div>
  </section>
</div>
