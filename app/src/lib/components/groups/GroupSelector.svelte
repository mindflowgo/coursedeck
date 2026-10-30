<script lang="ts">
  import { Plus, Check, X, Loader2 } from 'lucide-svelte';

  interface Props {
    value: string;
    groups: string[];
    label?: string;
    noneLabel?: string;
    id?: string;
    disabled?: boolean;
    onSelect: (group: string) => void;
    onCreateGroup?: (name: string) => Promise<string | boolean | void>;
  }

  let {
    value = '',
    groups = [],
    label = 'Course Group',
    noneLabel = 'None (Ungrouped)',
    id = 'group-selector',
    disabled = false,
    onSelect,
    onCreateGroup
  }: Props = $props();

  let isCreating = $state(false);
  let newGroupName = $state('');
  let isSavingNew = $state(false);
  let createError = $state<string | null>(null);

  function handleSelectChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    const val = target.value;
    if (val === '__new__') {
      isCreating = true;
      newGroupName = '';
      createError = null;
    } else {
      onSelect(val);
    }
  }

  async function handleCreateNew() {
    const trimmed = newGroupName.trim();
    if (!trimmed) {
      createError = 'Group name cannot be empty.';
      return;
    }
    if (groups.some((g) => g.toLowerCase() === trimmed.toLowerCase())) {
      // Already exists, just select it
      onSelect(groups.find((g) => g.toLowerCase() === trimmed.toLowerCase()) || trimmed);
      isCreating = false;
      newGroupName = '';
      createError = null;
      return;
    }

    if (!onCreateGroup) {
      onSelect(trimmed);
      isCreating = false;
      newGroupName = '';
      createError = null;
      return;
    }

    isSavingNew = true;
    createError = null;
    try {
      await onCreateGroup(trimmed);
      onSelect(trimmed);
      isCreating = false;
      newGroupName = '';
    } catch (err: unknown) {
      createError = err instanceof Error ? err.message : 'Failed to create group';
    } finally {
      isSavingNew = false;
    }
  }

  function handleCancelCreate() {
    isCreating = false;
    newGroupName = '';
    createError = null;
  }
</script>

<div class="space-y-1.5 w-full">
  <div class="flex items-center justify-between">
    <label for={id} class="block text-xs font-medium text-stone-600 dark:text-stone-400">
      {label}
    </label>
    {#if !isCreating && onCreateGroup && !disabled}
      <button
        type="button"
        onclick={() => {
          isCreating = true;
          newGroupName = '';
          createError = null;
        }}
        class="text-2xs text-amber-600 dark:text-amber-500 hover:underline flex items-center space-x-1 cursor-pointer"
      >
        <Plus class="w-3 h-3" />
        <span>New Group</span>
      </button>
    {/if}
  </div>

  {#if !isCreating}
    <select
      {id}
      {disabled}
      value={value}
      onchange={handleSelectChange}
      class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50 text-stone-900 dark:text-stone-100 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
    >
      <option value="">{noneLabel}</option>
      {#each groups as group (group)}
        <option value={group}>{group}</option>
      {/each}
      {#if onCreateGroup && !disabled}
        <option value="__new__">+ Create New Group...</option>
      {/if}
    </select>
  {:else}
    <div class="space-y-1.5">
      <div class="flex items-center space-x-1.5">
        <input
          type="text"
          bind:value={newGroupName}
          placeholder="New group name..."
          disabled={isSavingNew}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleCreateNew();
            } else if (e.key === 'Escape') {
              handleCancelCreate();
            }
          }}
          class="flex-1 px-3 py-1.5 text-xs sm:text-sm rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 focus:outline-hidden focus:ring-2 focus:ring-amber-500/50"
        />
        <button
          type="button"
          onclick={handleCreateNew}
          disabled={isSavingNew}
          title="Save group"
          class="px-2.5 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-white transition flex items-center justify-center cursor-pointer shrink-0 disabled:opacity-50"
        >
          {#if isSavingNew}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
          {:else}
            <Check class="w-3.5 h-3.5" />
          {/if}
        </button>
        <button
          type="button"
          onclick={handleCancelCreate}
          disabled={isSavingNew}
          title="Cancel"
          class="px-2 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 text-stone-500 hover:text-stone-800 dark:hover:text-stone-200 transition flex items-center justify-center cursor-pointer shrink-0"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
      {#if createError}
        <p class="text-2xs text-rose-500">{createError}</p>
      {/if}
    </div>
  {/if}
</div>
