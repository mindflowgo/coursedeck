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

  let groups = $state<string[]>([]);
  let courseCountByGroup = $state<Record<string, number>>({});
  let isLoading = $state(true);
  let isAdding = $state(false);
  let newGroupName = $state('');
  let addError = $state<string | null>(null);

  // Editing state
  let editingOriginalName = $state<string | null>(null);
  let editingCurrentName = $state('');
  let isSavingEdit = $state(false);
  let editError = $state<string | null>(null);

  async function loadData() {
    isLoading = true;
    try {
      const [groupsRes, coursesRes] = await Promise.all([
        apiFetch('/api/settings/groups?type=course'),
        apiFetch('/api/courses')
      ]);

      if (groupsRes.ok) {
        const data = await groupsRes.json();
        if (Array.isArray(data.names)) {
          groups = data.names;
        } else if (Array.isArray(data.groups)) {
          groups = data.groups.map((g: any) => (typeof g === 'string' ? g : g?.name || ''));
        } else {
          groups = [];
        }
      }

      if (coursesRes.ok) {
        const data = await coursesRes.json();
        const courses = Array.isArray(data.courses) ? data.courses : [];
        const counts: Record<string, number> = {};
        for (const c of courses) {
          if (c.group && c.group.trim()) {
            const g = c.group.trim();
            counts[g] = (counts[g] || 0) + 1;
          }
        }
        courseCountByGroup = counts;
      }
    } catch (e) {
      console.error('Failed to load course groups:', e);
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
    if (groups.some((g) => g.toLowerCase() === trimmed.toLowerCase())) {
      addError = 'A group with this name already exists.';
      return;
    }

    isAdding = true;
    addError = null;
    try {
      const res = await apiFetch('/api/settings/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'course', action: 'add', name: trimmed })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to add group');
      }
      const data = await res.json();
      groups = Array.isArray(data.names) ? data.names : [...groups, trimmed];
      newGroupName = '';
    } catch (err: unknown) {
      addError = err instanceof Error ? err.message : 'Failed to add group';
    } finally {
      isAdding = false;
    }
  }

  function startEdit(group: string) {
    editingOriginalName = group;
    editingCurrentName = group;
    editError = null;
  }

  function cancelEdit() {
    editingOriginalName = null;
    editingCurrentName = '';
    editError = null;
  }

  async function saveEdit() {
    if (!editingOriginalName) return;
    const trimmed = editingCurrentName.trim();
    if (!trimmed) {
      editError = 'Group name cannot be empty.';
      return;
    }
    if (
      trimmed.toLowerCase() !== editingOriginalName.toLowerCase() &&
      groups.some((g) => g.toLowerCase() === trimmed.toLowerCase())
    ) {
      editError = 'Another group with this name already exists.';
      return;
    }

    if (trimmed === editingOriginalName) {
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
          type: 'course',
          action: 'rename',
          oldName: editingOriginalName,
          newName: trimmed
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to rename group');
      }
      const data = await res.json();
      groups = Array.isArray(data.names) ? data.names : groups.map((g) => (g === editingOriginalName ? trimmed : g));

      // Update local course count mapping
      if (courseCountByGroup[editingOriginalName]) {
        courseCountByGroup[trimmed] = courseCountByGroup[editingOriginalName];
        delete courseCountByGroup[editingOriginalName];
        courseCountByGroup = { ...courseCountByGroup };
      }

      cancelEdit();
    } catch (err: unknown) {
      editError = err instanceof Error ? err.message : 'Failed to rename group';
    } finally {
      isSavingEdit = false;
    }
  }

  async function handleDeleteGroup(group: string) {
    const count = courseCountByGroup[group] || 0;
    const warning = count > 0
      ? `Delete group "${group}"?\n\n${count} course(s) currently in this group will become ungrouped.`
      : `Delete group "${group}"?`;

    const confirmed = await confirmDialog(warning, 'Delete Course Group');
    if (!confirmed) return;

    try {
      const res = await apiFetch('/api/settings/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'course',
          action: 'delete',
          name: group,
          clearEntities: true
        })
      });
      if (res.ok) {
        const data = await res.json();
        groups = Array.isArray(data.names) ? data.names : groups.filter((g) => g !== group);
        delete courseCountByGroup[group];
        courseCountByGroup = { ...courseCountByGroup };
      }
    } catch (err) {
      console.error('Failed to delete group:', err);
    }
  }

  async function moveGroup(index: number, direction: 'up' | 'down') {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= groups.length) return;

    const next = [...groups];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);
    groups = next;

    try {
      await apiFetch('/api/settings/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'course', groups: next })
      });
    } catch (err) {
      console.error('Failed to save group order:', err);
    }
  }
</script>

<div class="p-3 sm:p-4 space-y-3">
  <!-- Section Title & Description -->
  <div class="flex items-start justify-between gap-2">
    <div class="flex items-center space-x-2">
      <Folder class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
      <div>
        <span class="font-medium text-stone-900 dark:text-stone-100">Course Groups</span>
        <p class="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5">
          Organize courses into collapsible categories on your courses page (e.g. Grade 11, STEM, Electives).
        </p>
      </div>
    </div>
  </div>

  <!-- Add Group Form -->
  <div class="space-y-1.5 pt-1">
    <div class="flex items-center space-x-2">
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
        class="flex-1 max-w-sm px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition"
      />
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

  <!-- Groups List -->
  {#if isLoading}
    <div class="flex items-center space-x-2 py-3 text-stone-400 text-xs">
      <Loader2 class="w-4 h-4 animate-spin" />
      <span>Loading groups...</span>
    </div>
  {:else if groups.length === 0}
    <p class="text-xs text-stone-400 dark:text-stone-500 py-1 italic">
      No course groups defined yet. Add one above to start organizing your courses.
    </p>
  {:else}
    <div class="divide-y divide-stone-100 dark:divide-stone-800 rounded-lg border border-stone-200/70 dark:border-stone-800/80 bg-stone-50/30 dark:bg-stone-950/30 overflow-hidden">
      {#each groups as group, index (group)}
        {@const count = courseCountByGroup[group] || 0}
        <div class="flex items-center justify-between p-2 sm:px-3 text-xs hover:bg-stone-50 dark:hover:bg-stone-800/40 transition">
          {#if editingOriginalName === group}
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
                {group}
              </span>
              <span class="px-1.5 py-0.5 rounded-full text-2xs font-medium bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 shrink-0">
                {count} {count === 1 ? 'course' : 'courses'}
              </span>
            </div>

            <div class="flex items-center space-x-1 shrink-0">
              <!-- Reorder Up/Down -->
              <button
                type="button"
                disabled={index === 0}
                onclick={() => moveGroup(index, 'up')}
                title="Move up"
                class="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-20 cursor-pointer disabled:cursor-default"
              >
                <ChevronUp class="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                disabled={index === groups.length - 1}
                onclick={() => moveGroup(index, 'down')}
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
      {/each}
    </div>
  {/if}
</div>
