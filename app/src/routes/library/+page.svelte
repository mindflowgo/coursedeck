<script lang="ts">
  import Header from '$lib/components/Header.svelte';
  import { onMount, tick } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    LibraryBig,
    Upload,
    Search,
    FileText,
    BookOpen,
    Trash2,
    Edit3,
    MoreVertical,
    X,
    GripVertical,
    Check,
    ArrowLeft,
    Loader2,
    Sparkles,
    FileCode,
    Clock,
    FileUp,
    AlertTriangle,
    Folder,
    RotateCw,
    ChevronRight,
    Plus
  } from 'lucide-svelte';
  import { apiFetch, isTauriDesktop, isTauriEnvironment } from '$lib/api';
  import { confirmDialog } from '$lib/dialog';
  import PDFViewer from '$lib/components/pdf/PDFViewer.svelte';
  import { pdfRenderThumbnail } from '$lib/pdfClient';
  import GroupSection from '$lib/components/groups/GroupSection.svelte';
  import { createGroupCollapseStore } from '$lib/components/groups/groupState.svelte';
  import { groupItemsByGroups } from '$lib/components/groups/groupUtils';
  import GroupSelector from '$lib/components/groups/GroupSelector.svelte';

  interface LibraryDocument {
    id: string;
    filename: string;
    format: 'pdf' | 'epub' | 'mobi';
    title: string;
    description: string;
    additionDate: string;
    thumbnail?: string;
    pages?: number;
    lastPage?: number;
    fileSize?: number;
    position: number;
    group?: string;
  }

  let documents = $state<LibraryDocument[]>([]);
  let isLoading = $state(true);
  let isRefreshing = $state(false);
  let loadFailed = $state(false);
  let searchQuery = $state('');

  // Active document for reader view
  let activeDocFilename = $derived($page.url.searchParams.get('doc') || '');
  let activeTargetPage = $derived.by(() => {
    const p = $page.url.searchParams.get('page');
    return p ? parseInt(p, 10) : null;
  });

  let activeDoc = $derived(
    documents.find(
      (d) => d.filename.toLowerCase() === activeDocFilename.toLowerCase() || d.id.toLowerCase() === activeDocFilename.toLowerCase()
    ) || null
  );

  // Grouping state
  const groupState = createGroupCollapseStore('coursedeck_library_collapsed_groups', false);
  let allGroups = $state<Array<{ id: string; name: string; type: string }>>([]);
  let libraryGroups = $derived(
    allGroups.filter((g) => g.type === 'library').map((g) => g.name)
  );

  let availableLibraryGroups = $derived.by(() => {
    const set = new Set<string>();
    const list: string[] = [];
    for (const g of libraryGroups) {
      if (!set.has(g.toLowerCase())) {
        set.add(g.toLowerCase());
        list.push(g);
      }
    }
    for (const d of documents) {
      if (d.group && d.group.trim() && !set.has(d.group.trim().toLowerCase())) {
        set.add(d.group.trim().toLowerCase());
        list.push(d.group.trim());
      }
    }
    return list;
  });

  // Filtered documents (filtered by name and description)
  let filteredDocuments = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((doc) => {
      const titleMatch = doc.title ? doc.title.toLowerCase().includes(q) : false;
      const descMatch = doc.description ? doc.description.toLowerCase().includes(q) : false;
      return titleMatch || descMatch;
    });
  });

  let groupedDocuments = $derived(
    groupItemsByGroups(
      filteredDocuments,
      (d) => d.group,
      (d) => d.id,
      libraryGroups
    )
  );

  // Drag and drop state for card reordering
  let draggedId = $state<string | null>(null);
  let dragOverId = $state<string | null>(null);

  // Upload modal state
  let isUploadModalOpen = $state(false);
  let uploadFiles = $state<FileList | null>(null);
  let uploadTitle = $state('');
  let uploadDescription = $state('');
  let uploadGroup = $state('');
  let isUploading = $state(false);
  let uploadError = $state<string | null>(null);
  let uploadOverwritesExisting = $state(false);

  // Edit metadata modal state
  let editingDoc = $state<LibraryDocument | null>(null);
  let editTitle = $state('');
  let editDescription = $state('');
  let editGroup = $state('');
  let isSavingMeta = $state(false);

  // Card action menu popover state
  let openMenuId = $state<string | null>(null);
  let groupMenuDocId = $state<string | null>(null);
  let isCreatingGroupInMenu = $state<string | null>(null);
  let newGroupNameInput = $state('');
  let isSubmittingNewGroup = $state(false);

  // Thumbnail cache
  let thumbnails = $state<Record<string, string>>({});

  const isTauri = isTauriEnvironment();
  const isDesktop = isTauriDesktop();

  async function loadGroups() {
    try {
      const res = await apiFetch('/api/settings/groups?type=library');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.groups)) {
          allGroups = data.groups;
        } else if (Array.isArray(data.names)) {
          allGroups = data.names.map((n: string) => ({ id: n.toLowerCase(), name: n, type: 'library' }));
        }
      }
    } catch (e) {
      console.warn('Failed to load library groups:', e);
    }
  }

  async function loadLibrary() {
    isLoading = true;
    loadFailed = false;
    try {
      const res = await apiFetch('/api/library');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { documents?: LibraryDocument[] };
      documents = Array.isArray(data.documents) ? data.documents : [];
      void generateThumbnails();
    } catch (err) {
      console.error('[Library] Failed to load library documents:', err);
      loadFailed = true;
    } finally {
      isLoading = false;
    }
  }

  async function openLibraryFolder() {
    if (isTauriEnvironment()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_library_folder');
        return;
      } catch (err) {
        console.error('Failed to open library folder via Tauri:', err);
      }
    }
    try {
      const res = await apiFetch('/api/library/open', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Failed to open library folder via API:', data.error || res.statusText);
      }
    } catch (e) {
      console.error('Failed to open library folder:', e);
    }
  }

  async function refreshLibrary() {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      const res = await apiFetch('/api/library/refresh', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.documents)) {
          documents = data.documents;
        } else {
          await loadLibrary();
        }
      } else {
        await loadLibrary();
      }
      void loadGroups();
      void generateThumbnails();
    } catch (err) {
      console.error('[Library] Refresh failed:', err);
      await loadLibrary();
    } finally {
      isRefreshing = false;
    }
  }

  async function generateThumbnails() {
    if (!isTauri) return;
    for (const doc of documents) {
      if (doc.format === 'pdf' && !thumbnails[doc.filename] && !doc.thumbnail) {
        try {
          const thumb = await pdfRenderThumbnail(`/api/library/pdf/${encodeURIComponent(doc.filename)}`, 0, 180);
          if (thumb) {
            thumbnails[doc.filename] = thumb;
          }
        } catch {}
      }
    }
  }

  onMount(() => {
    void loadLibrary();
    void loadGroups();
  });

  function openDocument(doc: LibraryDocument) {
    const pageToOpen = doc.lastPage && doc.lastPage > 1 ? doc.lastPage : 1;
    goto(`/library?doc=${encodeURIComponent(doc.filename)}&page=${pageToOpen}`);
  }

  function closeDocument() {
    goto('/library');
  }

  let savePositionTimer: ReturnType<typeof setTimeout> | null = null;
  function handlePageChange(newPage: number) {
    if (!activeDoc) return;
    const docName = activeDoc.filename;

    // Optimistically update memory
    activeDoc.lastPage = newPage;

    if (savePositionTimer) clearTimeout(savePositionTimer);
    savePositionTimer = setTimeout(() => {
      void apiFetch('/api/library/checkpoints/position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: docName, page: newPage })
      });
    }, 400);
  }

  // ── Group Assignment Handlers ─────────────────────────────────────────────

  async function handleSetDocGroup(doc: LibraryDocument, targetGroupName: string) {
    const trimmed = targetGroupName.trim();
    if (trimmed === (doc.group || '').trim()) {
      openMenuId = null;
      groupMenuDocId = null;
      isCreatingGroupInMenu = null;
      return;
    }

    const previousGroup = doc.group;
    if (trimmed) {
      doc.group = trimmed;
      groupState.setCollapsed(trimmed, false);
    } else {
      delete doc.group;
      groupState.setCollapsed('__ungrouped__', false);
    }
    documents = [...documents];
    openMenuId = null;
    groupMenuDocId = null;
    isCreatingGroupInMenu = null;

    try {
      const res = await apiFetch('/api/library/meta', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: doc.id, group: trimmed })
      });
      if (!res.ok) throw new Error('Failed to update group');
    } catch (err) {
      console.error('Failed to update document group:', err);
      doc.group = previousGroup;
      documents = [...documents];
    }
  }

  async function handleCreateAndAssignGroup(doc: LibraryDocument, customName?: string) {
    const trimmed = (customName !== undefined ? customName : newGroupNameInput).trim();
    if (!trimmed) return;

    isSubmittingNewGroup = true;
    try {
      const res = await apiFetch('/api/settings/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', type: 'library', name: trimmed })
      });

      if (res.ok) {
        if (!allGroups.some((g) => g.type === 'library' && g.name.toLowerCase() === trimmed.toLowerCase())) {
          allGroups = [...allGroups, { id: trimmed.toLowerCase(), name: trimmed, type: 'library' }];
        }
      }

      await handleSetDocGroup(doc, trimmed);
    } catch (err) {
      console.error('Failed to create and assign group:', err);
    } finally {
      isSubmittingNewGroup = false;
      isCreatingGroupInMenu = null;
      newGroupNameInput = '';
    }
  }

  async function handleCreateGroupFromSelector(name: string) {
    const res = await apiFetch('/api/settings/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'library', action: 'add', name })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Failed to create group');
    }
    const data = await res.json();
    if (Array.isArray(data.groups)) {
      allGroups = data.groups;
    } else if (!allGroups.some((g) => g.type === 'library' && g.name.toLowerCase() === name.toLowerCase())) {
      allGroups = [...allGroups, { id: name.toLowerCase(), name, type: 'library' }];
    }
  }

  // ── Drag and Drop Reordering ─────────────────────────────────────────────

  function handleDragStart(id: string, e: DragEvent) {
    draggedId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    }
  }

  function handleDragOver(id: string, e: DragEvent) {
    e.preventDefault();
    if (draggedId === null || draggedId === id) return;
    dragOverId = id;
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDragLeave() {
    dragOverId = null;
  }

  async function handleDrop(targetId: string, e: DragEvent) {
    e.preventDefault();
    if (draggedId === null || draggedId === targetId) {
      draggedId = null;
      dragOverId = null;
      return;
    }

    const fromIndex = documents.findIndex((d) => d.id === draggedId);
    const toIndex = documents.findIndex((d) => d.id === targetId);
    if (fromIndex === -1 || toIndex === -1) {
      draggedId = null;
      dragOverId = null;
      return;
    }

    const itemToMove = documents[fromIndex];
    const newDocs = [...documents];
    newDocs.splice(fromIndex, 1);
    newDocs.splice(toIndex, 0, itemToMove);

    newDocs.forEach((d, idx) => (d.position = idx));
    documents = newDocs;

    draggedId = null;
    dragOverId = null;

    try {
      await apiFetch('/api/library/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: newDocs.map((d) => d.id) })
      });
    } catch (err) {
      console.warn('[Library] Failed to persist card order:', err);
    }
  }

  function handleDragEnd() {
    draggedId = null;
    dragOverId = null;
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  function handleFileSelected(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      uploadFiles = target.files;
      const f = target.files[0];
      if (!uploadTitle) {
        uploadTitle = f.name.replace(/\.[^/.]+$/, '').replace(/[-_]+/g, ' ');
      }
      uploadOverwritesExisting = documents.some(
        (d) => d.filename.toLowerCase() === f.name.toLowerCase()
      );
    }
  }

  async function handleUploadSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!uploadFiles || uploadFiles.length === 0) {
      uploadError = 'Please select a document file (.pdf, .epub, .mobi).';
      return;
    }

    const file = uploadFiles[0];
    if (uploadOverwritesExisting) {
      const confirmed = await confirmDialog(
        `A document named "${file.name}" already exists in your library. Overwrite it? Your reading position is kept.`,
        'Overwrite document?'
      );
      if (!confirmed) return;
    }

    isUploading = true;
    uploadError = null;

    try {
      const formData = new FormData();
      formData.append('file', file);
      if (uploadTitle.trim()) formData.append('title', uploadTitle.trim());
      if (uploadDescription.trim()) formData.append('description', uploadDescription.trim());
      if (uploadGroup.trim()) formData.append('group', uploadGroup.trim());

      const res = await apiFetch('/api/library/upload', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || `Upload failed (HTTP ${res.status})`);
      }

      const data = (await res.json()) as { success: boolean; document: LibraryDocument };
      if (data.document) {
        documents = [...documents, data.document];
      }
      isUploadModalOpen = false;
      uploadFiles = null;
      uploadOverwritesExisting = false;
      uploadTitle = '';
      uploadDescription = '';
      uploadGroup = '';
      void loadLibrary();
    } catch (err: any) {
      uploadError = err?.message || 'Failed to upload document.';
    } finally {
      isUploading = false;
    }
  }

  // ── Metadata Editing & Deletion ──────────────────────────────────────────

  function startEdit(doc: LibraryDocument) {
    editingDoc = doc;
    editTitle = doc.title;
    editDescription = doc.description;
    editGroup = doc.group || '';
    openMenuId = null;
    groupMenuDocId = null;
  }

  async function saveMetadata(e: SubmitEvent) {
    e.preventDefault();
    if (!editingDoc) return;
    isSavingMeta = true;
    try {
      const res = await apiFetch('/api/library/meta', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingDoc.id,
          title: editTitle.trim(),
          description: editDescription.trim(),
          group: editGroup.trim()
        })
      });

      if (!res.ok) throw new Error('Failed to update details');
      editingDoc.title = editTitle.trim();
      editingDoc.description = editDescription.trim();
      editingDoc.group = editGroup.trim() || undefined;
      editingDoc = null;
    } catch (err) {
      console.error('[Library] Failed to save metadata:', err);
    } finally {
      isSavingMeta = false;
    }
  }

  async function handleDelete(doc: LibraryDocument) {
    openMenuId = null;
    groupMenuDocId = null;
    const confirmed = await confirmDialog(
      `This will permanently remove "${doc.title}" along with any notes and annotations from your library.`,
      `Delete "${doc.title}"?`
    );

    if (!confirmed) return;

    try {
      const res = await apiFetch(`/api/library/${encodeURIComponent(doc.id)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        documents = documents.filter((d) => d.id !== doc.id && d.filename !== doc.filename);
        if (activeDocFilename === doc.filename) {
          closeDocument();
        }
      }
    } catch (err) {
      console.error('[Library] Failed to delete document:', err);
    }
  }

  function formatBytes(bytes?: number): string {
    if (!bytes || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function formatBadgeClasses(format: string): string {
    switch (format.toLowerCase()) {
      case 'pdf':
        return 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30';
      case 'epub':
        return 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30';
      case 'mobi':
        return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30';
      default:
        return 'bg-stone-500/10 text-stone-600 dark:text-stone-400 border-stone-500/30';
    }
  }
</script>

<svelte:head>
  <title>{activeDoc ? `${activeDoc.title} - Library` : 'Library - CourseDeck'}</title>
</svelte:head>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      openMenuId = null;
      groupMenuDocId = null;
      isCreatingGroupInMenu = null;
    }
  }}
/>

<!-- Global Header -->
<Header
  courseId=""
  courseTitle=""
  libraryDocTitle={activeDoc ? activeDoc.title : ''}
/>

{#if activeDocFilename && activeDoc}
  <!-- ========================================================================= -->
  <!-- READER VIEW (Document Opened: Header at top, NO course-nav, Floating Bar) -->
  <!-- ========================================================================= -->
  <div class="flex-1 flex flex-col h-[calc(100vh-3.5rem)] w-full max-w-full min-w-0 overflow-hidden relative">
    {#if activeDoc.format === 'pdf'}
      <PDFViewer
        url={`/api/library/pdf/${encodeURIComponent(activeDoc.filename)}`}
        courseId="library"
        title={activeDoc.title}
        initialPage={activeTargetPage || activeDoc.lastPage || 1}
        onPageChange={handlePageChange}
      />
    {:else}
      <!-- EPUB / MOBI Reader Preview / Reflowable View Placeholder -->
      <div class="flex-1 flex flex-col items-center justify-center p-8 bg-stone-50 dark:bg-stone-900 text-stone-600 dark:text-stone-300">
        <div class="max-w-md w-full bg-white dark:bg-stone-800 p-8 rounded-2xl border border-stone-200 dark:border-stone-700 shadow-lg text-center space-y-4">
          <div class="w-16 h-16 mx-auto rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center">
            <BookOpen class="w-8 h-8" />
          </div>
          <h2 class="text-xl font-bold text-stone-900 dark:text-stone-100">{activeDoc.title}</h2>
          <span class="inline-block px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider border {formatBadgeClasses(activeDoc.format)}">
            {activeDoc.format}
          </span>
          <p class="text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
            {activeDoc.description || 'Offline reflowable eBook saved in your library.'}
          </p>
          <div class="pt-4 flex items-center justify-center gap-3">
            <button
              type="button"
              onclick={closeDocument}
              class="px-4 py-2 rounded-xl border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-700 text-xs font-medium transition cursor-pointer"
            >
              Return to Library
            </button>
            <a
              href={`/api/library/pdf/${encodeURIComponent(activeDoc.filename)}`}
              download={activeDoc.filename}
              class="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium transition shadow-xs cursor-pointer inline-flex items-center gap-1.5"
            >
              <span>Download File</span>
            </a>
          </div>
        </div>
      </div>
    {/if}
  </div>

{:else}
  <!-- ========================================================================= -->
  <!-- CATALOG / SHELF VIEW (Document Catalog, Drag-and-Drop, Upload)             -->
  <!-- ========================================================================= -->
  <main class="flex-1 overflow-y-auto px-0 py-3 space-y-4 sm:px-4 sm:py-6 sm:space-y-8 max-w-6xl mx-auto w-full">
    <!-- Top Shelf Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-1.5 sm:px-0">
      <div class="flex items-center space-x-2.5">
        <div class="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <LibraryBig class="w-6 h-6" />
        </div>
        <div>
          <h1 class="text-2xl font-bold tracking-tight text-stone-900 dark:text-stone-100">Library</h1>
        </div>
      </div>

      <div class="flex -mt-2 items-center space-x-1.5 sm:space-x-2">
        <!-- Desktop-only Open Library Folder Button (Left of filter search) -->
        {#if isDesktop}
          <button
            type="button"
            title="Open library folder"
            aria-label="Open library folder"
            onclick={openLibraryFolder}
            class="p-1.5 rounded-lg text-stone-400 dark:text-stone-500 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 hover:border-stone-200 dark:border-stone-700 border border-transparent transition cursor-pointer shrink-0"
          >
            <Folder class="w-4 h-4" />
          </button>
        {/if}

        <!-- Single Refresh Button (Beside open-library button, no text, just icon) -->
        <button
          type="button"
          title="Scan library folder & refresh"
          aria-label="Scan library folder and refresh"
          disabled={isRefreshing}
          onclick={refreshLibrary}
          class="p-1.5 rounded-lg text-stone-400 dark:text-stone-500 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 hover:border-stone-200 dark:border-stone-700 border border-transparent transition cursor-pointer shrink-0 disabled:opacity-50"
        >
          <RotateCw class="w-4 h-4 {isRefreshing ? 'animate-spin text-amber-500' : ''}" />
        </button>

        <!-- Compact Filter Search (half size) -->
        <div class="relative w-32 sm:w-36 transition-all duration-200 focus-within:w-44 sm:focus-within:w-48">
          <Search class="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-stone-400 dark:text-stone-500" />
          <input
            type="text"
            bind:value={searchQuery}
            placeholder="Filter..."
            class="w-full pl-8 pr-7 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 transition"
          />
          {#if searchQuery}
            <button
              type="button"
              onclick={() => { searchQuery = ''; }}
              class="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 p-0.5 cursor-pointer"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          {/if}
        </div>

        <button
          type="button"
          onclick={() => { isUploadModalOpen = true; }}
          class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-white transition shadow-2xs shrink-0 cursor-pointer"
        >
          <Upload class="w-3.5 h-3.5" />
          <span>Upload</span>
        </button>        
      </div>
    </div>

    <!-- Content Grid / Loading / Empty -->
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-20 text-stone-400 space-y-3">
        <Loader2 class="w-8 h-8 animate-spin text-amber-500" />
        <p class="text-xs font-medium">Scanning offline library...</p>
      </div>

    {:else if loadFailed}
      <div class="p-8 rounded-2xl border border-rose-200 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/20 text-center space-y-3 mx-1.5 sm:mx-0">
        <p class="text-sm font-medium text-rose-700 dark:text-rose-300">Could not read /library directory.</p>
        <button
          type="button"
          onclick={loadLibrary}
          class="px-3.5 py-1.5 rounded-lg bg-white dark:bg-stone-800 border border-stone-300 dark:border-stone-700 text-xs font-semibold text-stone-800 dark:text-stone-200 hover:bg-stone-50 transition cursor-pointer"
        >
          Try Again
        </button>
      </div>

    {:else if filteredDocuments.length === 0}
      <div class="text-center py-20 px-4 rounded-3xl border-2 border-dashed border-stone-200 dark:border-stone-800 space-y-4 mx-1.5 sm:mx-0">
        <div class="w-14 h-14 mx-auto rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center">
          <BookOpen class="w-7 h-7" />
        </div>
        <div class="space-y-1">
          <h3 class="text-base font-semibold text-stone-800 dark:text-stone-200">
            {searchQuery ? 'No matching documents found' : 'Your library is empty'}
          </h3>
          <p class="text-xs text-stone-500 dark:text-stone-400 max-w-sm mx-auto">
            {searchQuery
              ? 'Try adjusting your search query.'
              : 'Add PDF, EPUB, or MOBI documents to your local /library folder to read offline and generate courses.'}
          </p>
        </div>
        {#if !searchQuery}
          <button
            type="button"
            onclick={() => { isUploadModalOpen = true; }}
            class="inline-flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold shadow-xs transition cursor-pointer"
          >
            <Upload class="w-4 h-4" />
            <span>Upload Your First Document</span>
          </button>
        {/if}
      </div>

    {:else}
      <!-- Snippet for Document Grid -->
      {#snippet documentGrid(items: LibraryDocument[])}
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-3.5 px-1.5 sm:px-0">
          {#each items as doc (doc.id)}
            <div
              draggable="true"
              ondragstart={(e) => handleDragStart(doc.id, e)}
              ondragover={(e) => handleDragOver(doc.id, e)}
              ondragleave={handleDragLeave}
              ondrop={(e) => handleDrop(doc.id, e)}
              ondragend={handleDragEnd}
              class="group relative flex flex-col bg-white dark:bg-stone-900 rounded-2xl border transition-all duration-150 select-none overflow-hidden cursor-pointer shadow-xs hover:shadow-md {dragOverId === doc.id ? 'border-amber-500 ring-2 ring-amber-500/30 scale-[1.02]' : 'border-stone-200 dark:border-stone-800 hover:border-amber-500/40'}"
              onclick={() => openDocument(doc)}
            >
              <!-- Card Thumbnail / Cover Area -->
              <div class="relative w-full aspect-[3/4] bg-stone-100 dark:bg-stone-950 flex items-center justify-center overflow-hidden border-b border-stone-100 dark:border-stone-800/80">
                {#if thumbnails[doc.filename] || doc.thumbnail}
                  <img
                    src={thumbnails[doc.filename] || doc.thumbnail}
                    alt={doc.title}
                    class="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                  />
                {:else}
                  <!-- Stylized Cover Fallback -->
                  <div class="flex flex-col items-center justify-center p-6 text-center space-y-2 text-stone-400 group-hover:text-amber-500 transition-colors">
                    <div class="w-10 h-10 rounded-xl bg-stone-200/60 dark:bg-stone-800/60 flex items-center justify-center">
                      <FileText class="w-5 h-5 stroke-[1.8]" />
                    </div>
                  </div>
                {/if}

                <!-- Top Bar over Image: Title on Left, Grab Bar & Actions on Right -->
                <div class="absolute top-0 inset-x-0 p-2 flex items-center justify-between gap-1.5 z-10 bg-gradient-to-b from-black/80 via-black/45 to-transparent">
                  <h3
                    class="text-xs font-semibold text-white drop-shadow-xs truncate flex-1 min-w-0 pr-1 group-hover:text-amber-300 transition-colors"
                    title={doc.title}
                  >
                    {doc.title}
                  </h3>

                  <!-- Drag Handle & Options (Top Right) -->
                  <div class="flex items-center space-x-1 shrink-0" onclick={(e) => e.stopPropagation()}>
                    <div
                      title="Drag to rearrange position"
                      class="p-1 rounded-md bg-black/40 hover:bg-black/60 text-white/80 hover:text-white backdrop-blur-md transition cursor-grab active:cursor-grabbing"
                    >
                      <GripVertical class="w-3.5 h-3.5" />
                    </div>

                    <div class="relative">
                    <button
                      type="button"
                      onclick={(e) => {
                        e.stopPropagation();
                        openMenuId = openMenuId === doc.id ? null : doc.id;
                        groupMenuDocId = null;
                        isCreatingGroupInMenu = null;
                      }}
                      class="p-1 rounded-lg bg-black/40 hover:bg-black/60 text-white/80 hover:text-white backdrop-blur-md transition cursor-pointer"
                      title="Document actions"
                    >
                      <MoreVertical class="w-3.5 h-3.5" />
                    </button>

                    {#if openMenuId === doc.id}
                      <div
                        class="fixed inset-0 z-40"
                        onclick={() => {
                          openMenuId = null;
                          groupMenuDocId = null;
                          isCreatingGroupInMenu = null;
                        }}
                      ></div>
                      <div class="absolute right-0 mt-1 w-44 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl z-50 py-1 text-xs">
                        <!-- To Group Submenu -->
                        <div class="relative">
                          <button
                            type="button"
                            onclick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              groupMenuDocId = groupMenuDocId === doc.id ? null : doc.id;
                            }}
                            class="w-full flex items-center justify-between px-3 py-1.5 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 text-left transition cursor-pointer"
                          >
                            <div class="flex items-center space-x-2">
                              <Folder class="w-3.5 h-3.5 text-stone-400" />
                              <span>To Group</span>
                            </div>
                            <ChevronRight class="w-3 h-3 text-stone-400" />
                          </button>

                          {#if groupMenuDocId === doc.id}
                            <div
                              class="absolute right-full top-0 mr-1 w-48 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-xl py-1 text-xs max-h-64 overflow-y-auto z-50"
                              onclick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                onclick={() => handleSetDocGroup(doc, '')}
                                class="w-full flex items-center justify-between px-3 py-1.5 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 text-left transition cursor-pointer"
                              >
                                <span class="italic text-stone-400">Ungrouped</span>
                                {#if !doc.group}
                                  <Check class="w-3.5 h-3.5 text-amber-500 shrink-0 ml-2" />
                                {/if}
                              </button>
                              {#if availableLibraryGroups.length > 0}
                                {#each availableLibraryGroups as groupName}
                                  {@const isCurrent = doc.group?.trim().toLowerCase() === groupName.toLowerCase()}
                                  <button
                                    type="button"
                                    onclick={() => handleSetDocGroup(doc, groupName)}
                                    class="w-full flex items-center justify-between px-3 py-1.5 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 text-left transition cursor-pointer"
                                  >
                                    <span class="truncate font-medium {isCurrent ? 'text-amber-600 dark:text-amber-400' : ''}">{groupName}</span>
                                    {#if isCurrent}
                                      <Check class="w-3.5 h-3.5 text-amber-500 shrink-0 ml-2" />
                                    {/if}
                                  </button>
                                {/each}
                              {/if}
                              <div class="my-1 border-t border-stone-100 dark:border-stone-800"></div>
                              {#if isCreatingGroupInMenu === doc.id}
                                <div class="p-2 space-y-1.5" onclick={(e) => e.stopPropagation()}>
                                  <input
                                    type="text"
                                    placeholder="New group name..."
                                    bind:value={newGroupNameInput}
                                    onkeydown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void handleCreateAndAssignGroup(doc);
                                      } else if (e.key === 'Escape') {
                                        isCreatingGroupInMenu = null;
                                        newGroupNameInput = '';
                                      }
                                    }}
                                    class="w-full px-2 py-1 text-xs rounded border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
                                  />
                                  <div class="flex items-center justify-end gap-1">
                                    <button
                                      type="button"
                                      onclick={() => {
                                        isCreatingGroupInMenu = null;
                                        newGroupNameInput = '';
                                      }}
                                      class="px-2 py-0.5 text-[11px] rounded text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      disabled={!newGroupNameInput.trim() || isSubmittingNewGroup}
                                      onclick={() => handleCreateAndAssignGroup(doc)}
                                      class="px-2 py-0.5 text-[11px] rounded bg-amber-500 hover:bg-amber-600 text-white font-medium disabled:opacity-50 cursor-pointer"
                                    >
                                      Add
                                    </button>
                                  </div>
                                </div>
                              {:else}
                                <button
                                  type="button"
                                  onclick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    isCreatingGroupInMenu = doc.id;
                                    newGroupNameInput = '';
                                  }}
                                  class="flex w-full items-center space-x-2 px-3 py-1.5 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition cursor-pointer"
                                >
                                  <Plus class="w-3.5 h-3.5" />
                                  <span>New Group...</span>
                                </button>
                              {/if}
                            </div>
                          {/if}
                        </div>

                        <button
                          type="button"
                          onclick={() => startEdit(doc)}
                          class="w-full flex items-center space-x-2 px-3 py-1.5 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 text-left transition cursor-pointer"
                        >
                          <Edit3 class="w-3.5 h-3.5" />
                          <span>Edit Details</span>
                        </button>
                        <button
                          type="button"
                          onclick={() => handleDelete(doc)}
                          class="w-full flex items-center space-x-2 px-3 py-1.5 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-left transition cursor-pointer"
                        >
                          <Trash2 class="w-3.5 h-3.5" />
                          <span>Delete</span>
                        </button>
                      </div>
                    {/if}
                  </div>
                </div>
              </div>

              <!-- Page Progress Simple Button on Image (Bottom-Right) -->
                {#if doc.pages && doc.pages > 0}
                  {@const current = doc.lastPage || 1}
                  {@const total = doc.pages}
                  {@const percent = Math.min(100, Math.round((current / total) * 100))}
                  <button
                    type="button"
                    onclick={(e) => {
                      e.stopPropagation();
                      openDocument(doc);
                    }}
                    title={`Resume page ${current} of ${total} (${percent}%)`}
                    class="absolute bottom-2 right-2 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-black/70 hover:bg-black/90 text-white backdrop-blur-md shadow-xs border border-white/15 transition cursor-pointer hover:scale-105"
                  >
                    <BookOpen class="w-3 h-3 text-amber-400" />
                    <span>{current > 1 ? `p. ${current}/${total}` : `${total}p`}</span>
                    {#if current > 1}
                      <span class="text-[9px] text-stone-300 font-mono">({percent}%)</span>
                    {/if}
                  </button>
                {:else}
                  <button
                    type="button"
                    onclick={(e) => {
                      e.stopPropagation();
                      openDocument(doc);
                    }}
                    title="Read document"
                    class="absolute bottom-2 right-2 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-black/70 hover:bg-black/90 text-white backdrop-blur-md shadow-xs border border-white/15 transition cursor-pointer hover:scale-105"
                  >
                    <BookOpen class="w-3 h-3 text-amber-400" />
                    <span>Read</span>
                  </button>
                {/if}
              </div>

              <!-- Card Description (if present) -->
              {#if doc.description}
                <div class="p-2 sm:p-2.5">
                  <p class="text-[11px] text-stone-500 dark:text-stone-400 line-clamp-2 leading-relaxed">
                    {doc.description}
                  </p>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/snippet}

      <!-- Render Grouped Buckets -->
      <div class="space-y-6">
        {#each groupedDocuments as bucket (bucket.id)}
          {#if bucket.name}
            <GroupSection
              title={bucket.name}
              count={bucket.items.length}
              groupId={bucket.id}
              isOpen={!groupState.isCollapsed(bucket.id) || Boolean(searchQuery.trim())}
              onToggle={() => groupState.toggle(bucket.id)}
            >
              {@render documentGrid(bucket.items)}
            </GroupSection>
          {:else}
            {@render documentGrid(bucket.items)}
          {/if}
        {/each}
      </div>
    {/if}
  </main>
{/if}

<!-- ========================================================================= -->
<!-- UPLOAD MODAL                                                              -->
<!-- ========================================================================= -->
{#if isUploadModalOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
    <div
      class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-100"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-2">
          <div class="p-1.5 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Upload class="w-5 h-5" />
          </div>
          <h2 class="text-base font-bold text-stone-900 dark:text-stone-100">Upload to Library</h2>
        </div>
        <button
          type="button"
          onclick={() => { isUploadModalOpen = false; }}
          class="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 p-1 rounded-lg"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <form onsubmit={handleUploadSubmit} class="space-y-4">
        <!-- File input -->
        <div class="space-y-1.5">
          <label for="library-upload-file" class="block text-xs font-semibold text-stone-700 dark:text-stone-300">
            Select Document (.pdf, .epub, .mobi)
          </label>
          <input
            id="library-upload-file"
            type="file"
            accept=".pdf,.epub,.mobi"
            onchange={handleFileSelected}
            class="w-full text-xs file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-amber-500/10 file:text-amber-600 dark:file:text-amber-400 hover:file:bg-amber-500/20 text-stone-600 dark:text-stone-400 cursor-pointer"
          />
        </div>

        {#if uploadFiles && uploadOverwritesExisting}
          <div class="flex items-start gap-2 rounded-xl border border-amber-300/60 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2">
            <AlertTriangle class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <p class="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
              "{uploadFiles[0]?.name}" already exists in your library. Saving will overwrite it — you'll be asked to confirm.
            </p>
          </div>
        {/if}

        <!-- Title -->
        <div class="space-y-1.5">
          <label for="library-upload-title" class="block text-xs font-semibold text-stone-700 dark:text-stone-300">
            Title
          </label>
          <input
            id="library-upload-title"
            type="text"
            bind:value={uploadTitle}
            placeholder="e.g. Physics Grade 11 Reference"
            class="w-full px-3 py-2 rounded-xl text-xs bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 outline-none focus:ring-2 focus:ring-amber-500/50"
          />
        </div>

        <!-- Description -->
        <div class="space-y-1.5">
          <label for="library-upload-description" class="block text-xs font-semibold text-stone-700 dark:text-stone-300">
            Description (Optional)
          </label>
          <textarea
            id="library-upload-description"
            bind:value={uploadDescription}
            rows="3"
            placeholder="Notes about the textbook, chapters, or syllabus..."
            class="w-full px-3 py-2 rounded-xl text-xs bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 outline-none focus:ring-2 focus:ring-amber-500/50 resize-none"
          ></textarea>
        </div>

        <!-- Group Selector -->
        <div>
          <GroupSelector
            id="library-upload-group"
            value={uploadGroup}
            groups={libraryGroups}
            label="Library Group"
            noneLabel="None (Ungrouped)"
            onSelect={(g) => (uploadGroup = g)}
            onCreateGroup={handleCreateGroupFromSelector}
          />
        </div>

        {#if uploadError}
          <p class="text-xs text-rose-500 font-medium">{uploadError}</p>
        {/if}

        <div class="flex items-center justify-end space-x-2 pt-2">
          <button
            type="button"
            onclick={() => { isUploadModalOpen = false; }}
            disabled={isUploading}
            class="px-4 py-2 rounded-xl border border-stone-200 dark:border-stone-700 text-xs font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isUploading || !uploadFiles}
            class="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition cursor-pointer flex items-center space-x-1.5"
          >
            {#if isUploading}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Saving...</span>
            {:else}
              <Upload class="w-3.5 h-3.5" />
              <span>Upload Document</span>
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- ========================================================================= -->
<!-- EDIT METADATA MODAL                                                       -->
<!-- ========================================================================= -->
{#if editingDoc}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
    <div
      class="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-100"
    >
      <div class="flex items-center justify-between">
        <h2 class="text-base font-bold text-stone-900 dark:text-stone-100">Edit Document Info</h2>
        <button
          type="button"
          onclick={() => { editingDoc = null; }}
          class="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 p-1 rounded-lg"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <form onsubmit={saveMetadata} class="space-y-4">
        <div class="space-y-1.5">
          <label for="library-edit-title" class="block text-xs font-semibold text-stone-700 dark:text-stone-300">Title</label>
          <input
            id="library-edit-title"
            type="text"
            bind:value={editTitle}
            class="w-full px-3 py-2 rounded-xl text-xs bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 outline-none focus:ring-2 focus:ring-amber-500/50"
          />
        </div>

        <div class="space-y-1.5">
          <label for="library-edit-description" class="block text-xs font-semibold text-stone-700 dark:text-stone-300">Description</label>
          <textarea
            id="library-edit-description"
            bind:value={editDescription}
            rows="3"
            class="w-full px-3 py-2 rounded-xl text-xs bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 outline-none focus:ring-2 focus:ring-amber-500/50 resize-none"
          ></textarea>
        </div>

        <div>
          <GroupSelector
            id="library-edit-group"
            value={editGroup}
            groups={libraryGroups}
            label="Library Group"
            noneLabel="None (Ungrouped)"
            onSelect={(g) => (editGroup = g)}
            onCreateGroup={handleCreateGroupFromSelector}
          />
        </div>

        <div class="flex items-center justify-end space-x-2 pt-2">
          <button
            type="button"
            onclick={() => { editingDoc = null; }}
            disabled={isSavingMeta}
            class="px-4 py-2 rounded-xl border border-stone-200 dark:border-stone-700 text-xs font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSavingMeta}
            class="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition cursor-pointer flex items-center space-x-1.5"
          >
            {#if isSavingMeta}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Saving...</span>
            {:else}
              <Check class="w-3.5 h-3.5" />
              <span>Save Changes</span>
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
