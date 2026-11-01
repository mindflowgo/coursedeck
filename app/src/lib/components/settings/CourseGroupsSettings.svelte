<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Folder,
    Plus,
    Pencil,
    Trash2,
    Check,
    X,
    ChevronUp,
    ChevronDown,
    Loader2
  } from 'lucide-svelte';
  import { apiFetch } from '$lib/api';
  import { confirmDialog } from '$lib/dialog';

  interface GroupItem {
    id: string;
    name: string;
    type: 'course' | 'library' | string;
  }

  let allGroups = $state<GroupItem[]>([]);
  let courseCountByGroup = $state<Record<string, number>>({});
  let libraryCountByGroup = $state<Record<string, number>>({});
  let isLoading = $state(true);
  let isAdding = $state(false);
  let newGroupName = $state('');
  let selectedGroupType = $state<'course' | 'library'>('course');
  let activeTab = $state<'course' | 'library'>('course');
  let addError = $state<string | null>(null);

  // Editing state
  let editingGroup = $state<GroupItem | null>(null);
  let editingCurrentName = $state('');
  let isSavingEdit = $state(false);
  let editError = $state<string | null>(null);

  const courseGroups = $derived(allGroups.filter((g) => g.type.toLowerCase() === 'course'));
  const libraryGroups = $derived(allGroups.filter((g) => g.type.toLowerCase() === 'library'));

  async function loadData() {
    isLoading = true;
    try {
      const [groupsRes, coursesRes, libraryRes] = await Promise.all([
        apiFetch('/api/settings/groups'),
        apiFetch('/api/courses'),
        apiFetch('/api/library')
      ]);

      if (groupsRes.ok) {
        const data = await groupsRes.json();
        if (Array.isArray(data.groups)) {
          allGroups = data.groups.map((g: any) => ({
            id: typeof g === 'string' ? g : g?.id || g?.name || '',
            name: typeof g === 'string' ? g : g?.name || '',
            type: typeof g === 'object' && g?.type ? String(g.type).toLowerCase() : 'course'
          }));
        } else if (Array.isArray(data.names)) {
          allGroups = data.names.map((n: string) => ({ id: n, name: n, type: 'course' }));
        } else {
          allGroups = [];
        }
      }

      if (coursesRes.ok) {
        const data = await coursesRes.json();
        const courses = Array.isArray(data.courses) ? data.courses : [];
        const counts: Record<string, number> = {};
        for (const c of courses) {
          if (c.group && c.group.trim()) {
            const g = c.group.trim().toLowerCase();
            counts[g] = (counts[g] || 0) + 1;
          }
        }
        courseCountByGroup = counts;
      }

      if (libraryRes.ok) {
        const data = await libraryRes.json();
        const documents = Array.isArray(data.documents) ? data.documents : [];
        const counts: Record<string, number> = {};
        for (const d of documents) {
          if (d.group && d.group.trim()) {
            const g = d.group.trim().toLowerCase();
            counts[g] = (counts[g] || 0) + 1;
          }
        }
        libraryCountByGroup = counts;
      }
    } catch (e) {
      console.error('Failed to load groups:', e);
    } finally {
      isLoading = false;
    }
  }

  onMount(() => {
    loadData();
  });

  async function handleAddGroup() {
    const trimmed = newGroupName.trim();
    if (!trimmed) {
      addError = 'Group name cannot be empty.';
      return;
    }
    const cleanType = selectedGroupType.toLowerCase();
    if (
      allGroups.some(
        (g) => g.type.toLowerCase() === cleanType && g.name.toLowerCase() === trimmed.toLowerCase()
      )
    ) {
      addError = `A ${cleanType} group with this name already exists.`;
      return;
    }

    isAdding = true;
    addError = null;
    try {
      const res = await apiFetch('/api/settings/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: cleanType, action: 'add', name: trimmed })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to add group');
      }
      activeTab = cleanType as 'course' | 'library';
      await loadData();
      newGroupName = '';
    } catch (err: unknown) {
      addError = err instanceof Error ? err.message : 'Failed to add group';
    } finally {
      isAdding = false;
    }
  }

  function startEdit(group: GroupItem) {
    editingGroup = group;
    editingCurrentName = group.name;
    editError = null;
  }

  function cancelEdit() {
    editingGroup = null;
    editingCurrentName = '';
    editError = null;
  }

  async function saveEdit() {
    if (!editingGroup) return;
    const trimmed = editingCurrentName.trim();
    if (!trimmed) {
      editError = 'Group name cannot be empty.';
      return;
    }
    const cleanType = editingGroup.type.toLowerCase();
    if (
      trimmed.toLowerCase() !== editingGroup.name.toLowerCase() &&
      allGroups.some(
        (g) => g.type.toLowerCase() === cleanType && g.name.toLowerCase() === trimmed.toLowerCase()
      )
    ) {
      editError = `Another ${cleanType} group with this name already exists.`;
      return;
    }

    if (trimmed === editingGroup.name) {
      cancelEdit();
      return;
    }

    isSavingEdit = true;
    editError = null;
    try {
      const res = await apiFetch('/api/settings/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: cleanType,
          action: 'rename',
          oldName: editingGroup.name,
          newName: trimmed
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to rename group');
      }

      await loadData();
      cancelEdit();
    } catch (err: unknown) {
      editError = err instanceof Error ? err.message : 'Failed to rename group';
    } finally {
      isSavingEdit = false;
    }
  }

  async function handleDeleteGroup(group: GroupItem) {
    const cleanType = group.type.toLowerCase();
    const count =
      cleanType === 'course'
        ? courseCountByGroup[group.name.toLowerCase()] || 0
        : libraryCountByGroup[group.name.toLowerCase()] || 0;

    const noun =
      cleanType === 'course'
        ? count === 1
          ? 'course'
          : 'courses'
        : count === 1
          ? 'document'
          : 'documents';

    const title = `Delete ${cleanType === 'course' ? 'Course' : 'Library'} Group`;
    const warning =
      count > 0
        ? `Delete ${cleanType} group "${group.name}"?\n\n${count} ${noun} currently in this group will become ungrouped.`
        : `Delete ${cleanType} group "${group.name}"?`;

    const confirmed = await confirmDialog(warning, title);
    if (!confirmed) return;

    try {
      const res = await apiFetch('/api/settings/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: cleanType,
          action: 'delete',
          name: group.name,
          clearEntities: true
        })
      });
      if (res.ok) {
        await loadData();
      }
    } catch (err) {
      console.error('Failed to delete group:', err);
    }
  }

  async function moveGroup(group: GroupItem, direction: 'up' | 'down') {
    const cleanType = group.type.toLowerCase();
    const list = cleanType === 'course' ? [...courseGroups] : [...libraryGroups];
    const index = list.findIndex((g) => g.id === group.id && g.name === group.name);
    if (index === -1) return;

    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= list.length) return;

    const [moved] = list.splice(index, 1);
    list.splice(targetIndex, 0, moved);

    const reorderedNames = list.map((g) => g.name);

    // Optimistically update
    const otherGroups = allGroups.filter((g) => g.type.toLowerCase() !== cleanType);
    allGroups = [...otherGroups, ...list];

    try {
      await apiFetch('/api/settings/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: cleanType, groups: reorderedNames })
      });
    } catch (err) {
      console.error('Failed to save group order:', err);
    }
  }
</script>

{#snippet groupRow(group: GroupItem, index: number, list: GroupItem[], count: number, noun: 'course' | 'document')}
  <div class="flex items-center justify-between p-2 sm:px-3 text-xs hover:bg-stone-50 dark:hover:bg-stone-800/40 transition">
    {#if editingGroup && editingGroup.type === group.type && editingGroup.name === group.name}
      <!-- Inline Edit Mode -->
      <div class="flex items-center space-x-1.5 flex-1 mr-2">
        <input
          type="text"
          bind:value={editingCurrentName}
          disabled={isSavingEdit}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveEdit();
            } else if (e.key === 'Escape') {
              cancelEdit();
            }
          }}
          class="flex-1 px-2.5 py-1 rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 text-xs focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
        />
        <button
          type="button"
          onclick={saveEdit}
          disabled={isSavingEdit}
          title="Save changes"
          class="p-1.5 rounded text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950 transition cursor-pointer"
        >
          {#if isSavingEdit}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
          {:else}
            <Check class="w-3.5 h-3.5" />
          {/if}
        </button>
        <button
          type="button"
          onclick={cancelEdit}
          disabled={isSavingEdit}
          title="Cancel"
          class="p-1.5 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition cursor-pointer"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
      {#if editError}
        <p class="text-2xs text-rose-500 mr-2">{editError}</p>
      {/if}
    {:else}
      <!-- Normal Row Display -->
      <div class="flex items-center space-x-2 min-w-0">
        <span class="font-medium text-stone-800 dark:text-stone-200 truncate">
          {group.name}
        </span>
        <span class="px-1.5 py-0.5 rounded-full text-2xs font-medium bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 shrink-0">
          {count} {count === 1 ? noun : noun === 'course' ? 'courses' : 'documents'}
        </span>
      </div>

      <div class="flex items-center space-x-1 shrink-0">
        <!-- Reorder Up/Down -->
        <button
          type="button"
          disabled={index === 0}
          onclick={() => moveGroup(group, 'up')}
          title="Move up"
          class="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-20 cursor-pointer disabled:cursor-default"
        >
          <ChevronUp class="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          disabled={index === list.length - 1}
          onclick={() => moveGroup(group, 'down')}
          title="Move down"
          class="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-20 cursor-pointer disabled:cursor-default"
        >
          <ChevronDown class="w-3.5 h-3.5" />
        </button>

        <!-- Edit Button -->
        <button
          type="button"
          onclick={() => startEdit(group)}
          title="Rename group"
          class="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <Pencil class="w-3.5 h-3.5" />
        </button>

        <!-- Delete Button -->
        <button
          type="button"
          onclick={() => handleDeleteGroup(group)}
          title="Delete group"
          class="p-1 rounded text-stone-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950 transition cursor-pointer"
        >
          <Trash2 class="w-3.5 h-3.5" />
        </button>
      </div>
    {/if}
  </div>
{/snippet}

<div class="p-3 sm:p-4 space-y-3">
  <!-- Section Title & Description -->
  <div class="flex items-start justify-between gap-2">
    <div class="flex items-center space-x-2">
      <Folder class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
      <div>
        <span class="font-medium text-stone-900 dark:text-stone-100">Groups</span>
        <p class="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5">
          Organize courses and library documents into collapsible categories on your courses and library pages.
        </p>
      </div>
    </div>
  </div>

  <!-- Add Group Form -->
  <div class="space-y-1.5 pt-1">
    <div class="flex flex-wrap items-center gap-2">
      <input
        type="text"
        bind:value={newGroupName}
        placeholder="New group name..."
        disabled={isAdding}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleAddGroup();
          }
        }}
        class="flex-1 min-w-[160px] max-w-sm px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition"
      />
      <select
        bind:value={selectedGroupType}
        disabled={isAdding}
        aria-label="Group Type"
        class="px-2.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition cursor-pointer"
      >
        <option value="course">Course</option>
        <option value="library">Library</option>
      </select>
      <button
        type="button"
        onclick={handleAddGroup}
        disabled={isAdding || !newGroupName.trim()}
        class="inline-flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-white transition disabled:opacity-40 cursor-pointer shrink-0"
      >
        {#if isAdding}
          <Loader2 class="w-3.5 h-3.5 animate-spin" />
        {:else}
          <Plus class="w-3.5 h-3.5" />
        {/if}
        <span>Add Group</span>
      </button>
    </div>
    {#if addError}
      <p class="text-[11px] text-rose-500">{addError}</p>
    {/if}
  </div>

  <!-- Groups Filter Tabs & Display -->
  {#if isLoading}
    <div class="flex items-center space-x-2 py-3 text-stone-400 text-xs">
      <Loader2 class="w-4 h-4 animate-spin" />
      <span>Loading groups...</span>
    </div>
  {:else}
    <div class="space-y-2.5 pt-1">
      <!-- Tabs: Course vs Library -->
      <div class="flex items-center space-x-1.5 pb-0.5">
        <button
          type="button"
          onclick={() => {
            activeTab = 'course';
            selectedGroupType = 'course';
          }}
          class="px-2.5 py-1 rounded-full text-xs font-medium transition cursor-pointer {activeTab === 'course' ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700'}"
        >
          Course ({courseGroups.length})
        </button>
        <button
          type="button"
          onclick={() => {
            activeTab = 'library';
            selectedGroupType = 'library';
          }}
          class="px-2.5 py-1 rounded-full text-xs font-medium transition cursor-pointer {activeTab === 'library' ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700'}"
        >
          Library ({libraryGroups.length})
        </button>
      </div>

      <!-- Current Tab List -->
      {#if activeTab === 'course'}
        {#if courseGroups.length === 0}
          <p class="text-xs text-stone-400 dark:text-stone-500 py-1.5 px-0.5 italic">
            No course groups defined yet.
          </p>
        {:else}
          <div class="divide-y divide-stone-100 dark:divide-stone-800 rounded-lg border border-stone-200/70 dark:border-stone-800/80 bg-stone-50/30 dark:bg-stone-950/30 overflow-hidden">
            {#each courseGroups as group, index (group.id + '-' + group.name)}
              {@render groupRow(group, index, courseGroups, courseCountByGroup[group.name.toLowerCase()] || 0, 'course')}
            {/each}
          </div>
        {/if}
      {:else if activeTab === 'library'}
        {#if libraryGroups.length === 0}
          <p class="text-xs text-stone-400 dark:text-stone-500 py-1.5 px-0.5 italic">
            No library groups defined yet.
          </p>
        {:else}
          <div class="divide-y divide-stone-100 dark:divide-stone-800 rounded-lg border border-stone-200/70 dark:border-stone-800/80 bg-stone-50/30 dark:bg-stone-950/30 overflow-hidden">
            {#each libraryGroups as group, index (group.id + '-' + group.name)}
              {@render groupRow(group, index, libraryGroups, libraryCountByGroup[group.name.toLowerCase()] || 0, 'document')}
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
