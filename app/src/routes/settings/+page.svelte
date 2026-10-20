<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import Header from '$lib/components/Header.svelte';
  import PromptsManager from '$lib/components/PromptsManager.svelte';
  import SyncMcpSettings from '$lib/components/SyncMcpSettings.svelte';
  import { onMount } from 'svelte';
  import { apiFetch, isTauriEnvironment } from '$lib/api';
  import { confirmDialog } from '$lib/dialog';
  import {
    Server,
    FolderKanban,
    RotateCw,
    CheckCircle2,
    AlertCircle,
    Loader2,
    Save,
    ImageDown,
    HardDrive,
    FolderOpen,
    Folder,
    Download,
    Upload,
    Archive,
    Palette,
    Sun,
    Moon,
    Monitor,
    ZoomIn,
    Plus,
    Trash2,
    Compass,
    Mail,
    Send,
    Eye,
    EyeOff,
    Info
  } from 'lucide-svelte';
  import { theme } from '$lib/theme.svelte';
  import { zoom } from '$lib/zoom.svelte';
  import { ZOOM_STEPS } from '$lib/zoomLevels';
  import { getResumeLastPosition, setResumeLastPosition } from '$lib/preferences';
  import { LLM_PROVIDER_PRESETS, getProviderPreset, isPublicIpUrl } from '$lib/llmProviders';
  import {
    createLlmCardDraft,
    fetchLlmStore,
    saveLlmStore,
    setActiveLlmCard,
    testLlmCard,
    type LlmCardDraft
  } from '$lib/llmClient';

  import { resolveSettingsTab, type SettingsTab } from '$lib/settingsTabs';

  const isTauri = isTauriEnvironment();

  // Tab state: 'settings' (default) or 'prompts'
  let activeTab: SettingsTab = $state(
    resolveSettingsTab($page.url.searchParams.get('tab'))
  );

  $effect(() => {
    const expected = resolveSettingsTab($page.url.searchParams.get('tab'));
    if (activeTab !== expected) {
      activeTab = expected;
    }
  });

  function switchTab(tab: SettingsTab) {
    activeTab = tab;
    const url = new URL($page.url);
    if (tab === 'prompts') {
      url.searchParams.set('tab', 'prompts');
    } else if (tab === 'sync_mcp') {
      url.searchParams.set('tab', 'sync_mcp');
    } else {
      url.searchParams.delete('tab');
    }
    goto(url.pathname + (url.search ? url.search : ''), {
      replaceState: true,
      noScroll: true,
      keepFocus: true
    });
    if (tab === 'prompts') {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }
  }

  // Storage state
  interface StorageInfo {
    dataDir: string;
    defaultDataDir: string;
    isCustom: boolean;
    courseCount: number;
    totalSize: number;
    totalSizeFormatted: string;
  }

  let storageInfo: StorageInfo | null = $state(null);
  let isLoadingStorage = $state(false);
  let isChangingPath = $state(false);
  let isSavingPath = $state(false);
  let newPath = $state('');
  let migrateExisting = $state(true);
  let storageMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null);

  // Resume course position preference
  let resumeLastPosition: boolean = $state(true);

  function toggleResumePosition() {
    resumeLastPosition = !resumeLastPosition;
    setResumeLastPosition(resumeLastPosition);
  }

  // Backup state
  let isExportingBackup = $state(false);
  let backupExportProgress = $state('');
  let includeRawArchives = $state(false);
  let isImportingBackup = $state(false);
  let backupFileInput: HTMLInputElement | null = $state(null);
  let backupMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null);

  // AI model cards state
  const REQUEST_TIMEOUT_STEPS: readonly number[] = [30, 60, 90, 120, 150, 300, 600];
  let llmCards = $state<LlmCardDraft[]>([]);
  let llmActiveId = $state<string | null>(null);
  let savedActiveId = $state<string | null>(null);
  /** Card ids that exist on the server; anything else needs Save Models first. */
  let savedCardIds = $state<Set<string>>(new Set());
  let llmMessage = $state('');
  let isSavingModels = $state(false);
  let testingCardId = $state<string | null>(null);
  let cardTestResults = $state<Record<string, { success: boolean; message: string }>>({});
  let isLoadingModels = $state(true);
  /** True when the stored models could not be read — saving is blocked so an empty list can't wipe them. */
  let modelsLoadFailed = $state(false);

  let activeCard = $derived(llmCards.find((c) => c.id === llmActiveId) ?? (llmCards.length > 0 ? llmCards[0] : null));

  let isReparsing = $state(false);
  let reparseResult: string = $state('');

  let isCompressingImages = $state(false);
  let compressImagesResult: string = $state('');

  function flashLlmMessage(text: string) {
    llmMessage = text;
    setTimeout(() => {
      if (llmMessage === text) llmMessage = '';
    }, 3000);
  }

  function applySnapshot(snapshot: Awaited<ReturnType<typeof fetchLlmStore>>) {
    if (!snapshot) return;
    llmCards = snapshot.cards.map((c) => ({ ...c, apiKey: '' }));
    llmActiveId = snapshot.activeId ?? snapshot.cards[0]?.id ?? null;
    savedActiveId = llmActiveId;
    savedCardIds = new Set(snapshot.cards.map((c) => c.id));
  }

  async function loadModelCards() {
    isLoadingModels = true;
    const snapshot = await fetchLlmStore();
    isLoadingModels = false;
    if (!snapshot) {
      // Never present a failed read as "no models configured": saving that empty
      // list would wipe the real store.
      modelsLoadFailed = true;
      llmMessage = 'Failed to read the saved models from the backend — reload the page before saving.';
      return;
    }
    modelsLoadFailed = false;
    applySnapshot(snapshot);
  }

  /** Provider select: swap the preset's default URL in unless the user typed a custom one. */
  function applyProviderPreset(card: LlmCardDraft, providerId: string) {
    const previousDefault = getProviderPreset(card.provider).defaultBaseUrl;
    const untouched = !card.baseUrl.trim() || card.baseUrl.trim() === previousDefault;
    card.provider = providerId;
    const preset = getProviderPreset(providerId);
    if (untouched) card.baseUrl = preset.defaultBaseUrl;
    card.label = preset.label;
  }

  function addModelCard() {
    const draft = createLlmCardDraft();
    llmCards.push(draft);
    llmActiveId = draft.id;
  }

  /** Save button: persists the list; an empty list is confirmed inside saveModelCards. */
  async function handleSaveModelsClick() {
    await saveModelCards();
  }

  /**
   * Persists the current card list.
   *
   * `allowEmpty` is only ever set by `removeModelCard` after the user confirmed
   * removing the last model; the server rejects an empty list without it, so an
   * empty list produced by a bug cannot silently remove every model.
   */
  async function saveModelCards(opts?: { allowEmpty?: boolean }): Promise<boolean> {
    if (modelsLoadFailed) {
      llmMessage = 'Failed to save: the current models could not be read from the backend. Reload the page first.';
      return false;
    }

    // A card without a Base URL cannot be stored, so saying so beats letting the
    // save silently drop it (which is how a working config could disappear).
    const blank = llmCards.find((c) => !c.baseUrl.trim());
    if (blank) {
      llmMessage = `Failed to save: "${blank.label || 'a model card'}" needs a Base URL.`;
      return false;
    }

    isSavingModels = true;
    llmMessage = '';
    try {
      const snapshot = await saveLlmStore(llmCards, llmActiveId, { allowEmpty: opts?.allowEmpty === true });
      applySnapshot(snapshot);
      flashLlmMessage('Models saved.');
      return true;
    } catch (err: any) {
      llmMessage = err?.message || 'Failed to save models.';
      return false;
    } finally {
      isSavingModels = false;
    }
  }

  async function removeModelCard(id: string) {
    const card = llmCards.find((c) => c.id === id);
    const confirmed = await confirmDialog(
      `Remove "${card?.label ?? 'this model'}" from the model list?`,
      'Remove Model'
    );
    if (!confirmed) return;

    const isLastSavedCard = savedCardIds.has(id) && savedCardIds.size === 1;
    llmCards = llmCards.filter((c) => c.id !== id);
    delete cardTestResults[id];
    if (llmActiveId === id) {
      llmActiveId = llmCards[0]?.id ?? null;
    }
    // Persist immediately so generation can never keep using a removed model.
    // Removing the final model clears the list, which needs its own confirmation.
    if (savedCardIds.has(id) && !(await saveModelCards({ allowEmpty: isLastSavedCard }))) {
      // Resync instead of showing a local list that disagrees with the server.
      await loadModelCards();
    }
  }

  /** Active model switch persists immediately — every AI feature follows it. */
  async function selectActiveModel(id: string) {
    const previous = llmActiveId;
    llmActiveId = id;
    if (id === savedActiveId) return;

    // A card that has not been saved yet cannot be activated server-side.
    if (!savedCardIds.has(id)) {
      if (!(await saveModelCards())) llmActiveId = previous;
      return;
    }

    try {
      await setActiveLlmCard(id);
      savedActiveId = id;
      flashLlmMessage('Active model switched — all AI features now use it.');
    } catch (err: any) {
      llmActiveId = previous;
      llmMessage = err?.message || 'Failed to switch the active model.';
    }
  }

  async function testModelCard(card: LlmCardDraft) {
    testingCardId = card.id;
    delete cardTestResults[card.id];
    const result = await testLlmCard(
      {
        provider: card.provider,
        baseUrl: card.baseUrl,
        apiKey: card.apiKey || undefined,
        authHeaderType: card.authHeaderType,
        model: card.model,
        temperature: card.temperature,
        timeoutSeconds: card.timeoutSeconds,
        sendSessionId: card.sendSessionId
      },
      card.id
    );
    cardTestResults = { ...cardTestResults, [card.id]: result };
    testingCardId = null;
  }

  async function reparseAllCourses() {
    isReparsing = true;
    reparseResult = '';

    try {
      const res = await apiFetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (res.ok) {
        reparseResult = 'Successfully re-indexed and refreshed all course materials!';
      } else {
        reparseResult = 'Failed to re-index courses.';
      }
    } catch (err: any) {
      reparseResult = 'Error during re-indexing: ' + err?.message;
    } finally {
      isReparsing = false;
    }
  }

  async function compressCourseImages() {
    isCompressingImages = true;
    compressImagesResult = '';

    try {
      const res = await apiFetch('/api/maintenance/compress-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (res.ok) {
        const data = await res.json();
        const { converted, bytesBefore, bytesAfter } = data.totals ?? {};
        const mb = (n: number) => `${(Number(n || 0) / 1048576).toFixed(1)}MB`;
        if (converted > 0) {
          compressImagesResult = `Compressed ${converted} image(s): ${mb(bytesBefore)} → ${mb(bytesAfter)} across ${data.results?.length ?? 0} course(s).`;
        } else {
          compressImagesResult = 'All course images are already optimized — nothing to compress.';
        }
      } else {
        compressImagesResult = 'Failed to compress course images.';
      }
    } catch (err: any) {
      compressImagesResult = 'Error during compression: ' + err?.message;
    } finally {
      isCompressingImages = false;
    }
  }

  async function loadStorageInfo() {
    isLoadingStorage = true;
    try {
      const res = await apiFetch('/api/settings/storage');
      if (res.ok) {
        storageInfo = await res.json();
      }
    } catch (err: any) {
      console.warn('Failed to load storage info:', err);
    } finally {
      isLoadingStorage = false;
    }
  }

  async function openFolder() {
    try {
      const res = await apiFetch('/api/settings/open-folder', { method: 'POST' });
      if (!res.ok) {
        storageMessage = { type: 'error', text: 'Failed to open data folder.' };
      }
    } catch (err: any) {
      storageMessage = { type: 'error', text: 'Error opening folder: ' + (err?.message || '') };
    }
  }

  async function chooseFolder() {
    if (isTauriEnvironment()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select Course Data Folder',
          defaultPath: newPath || storageInfo?.dataDir
        });
        if (selected && typeof selected === 'string') {
          newPath = selected;
          isChangingPath = true;
        }
      } catch (err: any) {
        console.warn('Tauri directory picker error:', err);
        isChangingPath = true;
      }
    } else {
      isChangingPath = true;
      if (!newPath && storageInfo) {
        newPath = storageInfo.dataDir;
      }
    }
  }

  async function saveNewPath(targetPath?: string) {
    const pathToSet = targetPath !== undefined ? targetPath : newPath.trim();
    isSavingPath = true;
    storageMessage = null;

    try {
      const res = await apiFetch('/api/settings/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataDir: pathToSet,
          migrate: migrateExisting
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || data.error || 'Failed to update storage directory');
      }

      storageInfo = {
        dataDir: data.dataDir,
        defaultDataDir: data.defaultDataDir,
        isCustom: data.isCustom,
        courseCount: data.courseCount,
        totalSize: data.totalSize,
        totalSizeFormatted: data.totalSizeFormatted
      };
      isChangingPath = false;
      newPath = '';
      storageMessage = {
        type: 'success',
        text: pathToSet
          ? `Storage location updated! ${data.migratedFiles ? `Copied ${data.migratedFiles} items to new location.` : ''}`
          : 'Storage location reset to default system directory.'
      };
    } catch (err: any) {
      storageMessage = {
        type: 'error',
        text: err?.message || 'Error updating data directory'
      };
    } finally {
      isSavingPath = false;
    }
  }

  async function resetStorageToDefault() {
    const confirmed = await confirmDialog(
      'Reset course data location back to the default system folder?',
      'Reset Data Location'
    );
    if (confirmed) {
      saveNewPath('');
    }
  }

  async function exportBackup() {
    isExportingBackup = true;
    backupExportProgress = 'Connecting...';
    backupMessage = null;

    try {
      console.log(`[Backup Export] Requesting backup archive (includeRaw: ${includeRawArchives})...`);
      const res = await apiFetch(`/api/backup/export?includeRaw=${includeRawArchives}`);
      if (!res.ok) {
        throw new Error(`Export failed with status ${res.status}`);
      }

      const filename = `app-study-tool-backup-${new Date().toISOString().split('T')[0]}.zip`;

      if (!res.body) {
        throw new Error('Response body stream is unavailable.');
      }

      console.log('[Backup Export] Connected to server stream. Downloading archive...');
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let lastLogTime = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          totalBytes += value.length;
          const mb = (totalBytes / 1024 / 1024).toFixed(1);
          backupExportProgress = `${mb} MB`;
          if (Date.now() - lastLogTime >= 800) {
            console.log(`[Backup Export] Streamed ${mb} MB so far...`);
            lastLogTime = Date.now();
          }
        }
      }

      const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
      console.log(`[Backup Export] Download complete! Total: ${totalMb} MB across ${chunks.length} chunks.`);

      const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });

      // If in Tauri desktop app and file is reasonable size (< 25MB), use native save dialog
      if (isTauriEnvironment() && blob.size < 25 * 1024 * 1024) {
        try {
          const [{ save }, { invoke }] = await Promise.all([
            import('@tauri-apps/plugin-dialog'),
            import('@tauri-apps/api/core')
          ]);
          const savePath = await save({
            defaultPath: filename,
            filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
          });

          if (!savePath) {
            // User cancelled
            return;
          }

          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          const dataB64 = btoa(binary);

          await invoke('save_pdf_file', { path: savePath, dataB64 });
          backupMessage = {
            type: 'success',
            text: `Backup successfully saved to ${savePath} (${totalMb} MB)`
          };
          return;
        } catch (tauriErr) {
          console.warn('Native save dialog failed, using browser download:', tauriErr);
        }
      }

      // Browser fallback download (works reliably for all archive sizes)
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      backupMessage = {
        type: 'success',
        text: `Backup exported successfully: ${filename} (${totalMb} MB)`
      };
    } catch (err: any) {
      console.error('[Backup Export Error]', err);
      backupMessage = {
        type: 'error',
        text: 'Backup export failed: ' + (err?.message || 'Unknown error')
      };
    } finally {
      isExportingBackup = false;
      backupExportProgress = '';
    }
  }

  function triggerImportDialog() {
    if (backupFileInput) {
      backupFileInput.click();
    }
  }

  async function handleBackupFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (!file) return;

    const confirmed = await confirmDialog(
      `Restore course data from "${file.name}"?\n\nThis will extract courses and prompts into your active data directory.`,
      'Restore Backup'
    );
    if (!confirmed) {
      input.value = '';
      return;
    }

    isImportingBackup = true;
    backupMessage = null;

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await apiFetch('/api/backup/import', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || data.error || 'Failed to restore backup');
      }

      backupMessage = {
        type: 'success',
        text: `Backup restored! ${data.message || ''}`
      };

      // Refresh storage metrics
      loadStorageInfo();
    } catch (err: any) {
      backupMessage = {
        type: 'error',
        text: 'Restore failed: ' + (err?.message || 'Unknown error')
      };
    } finally {
      isImportingBackup = false;
      if (input) {
        input.value = '';
      }
    }
  }

  // Teacher Check-In state
  let teacherEmail = $state('');
  let teacherSender = $state<'gmail' | 'outlook'>('gmail');
  let teacherLoginEmail = $state('');
  let teacherLoginPassword = $state('');
  let teacherHasPassword = $state(false);
  let showTeacherPassword = $state(false);
  let showAppPasswordGuide = $state(false);
  let isSavingTeacher = $state(false);
  let isTestingTeacher = $state(false);
  let teacherStatusMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null);

  async function loadTeacherCheckin() {
    try {
      const res = await apiFetch('/api/settings/emailserver');
      if (res.ok) {
        const data = await res.json();
        teacherEmail = data.email || '';
        teacherSender = data.sender || 'gmail';
        teacherLoginEmail = data.loginEmail || '';
        teacherHasPassword = Boolean(data.hasPassword);
      }
    } catch (err) {
      console.warn('Failed to load teacher checkin settings:', err);
    }
  }

  async function saveTeacherCheckin() {
    isSavingTeacher = true;
    teacherStatusMessage = null;
    try {
      const res = await apiFetch('/api/settings/emailserver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: teacherEmail,
          sender: teacherSender,
          loginEmail: teacherLoginEmail,
          loginPassword: teacherLoginPassword
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        teacherHasPassword = Boolean(data.hasPassword);
        teacherLoginPassword = '';
        teacherStatusMessage = { type: 'success', text: 'Teacher Check-In settings saved successfully!' };
      } else {
        teacherStatusMessage = { type: 'error', text: data.message || 'Failed to save settings' };
      }
    } catch (err: any) {
      teacherStatusMessage = { type: 'error', text: err?.message || 'Error saving settings' };
    } finally {
      isSavingTeacher = false;
    }
  }

  async function testTeacherCheckin() {
    isTestingTeacher = true;
    teacherStatusMessage = null;
    try {
      const res = await apiFetch('/api/settings/emailserver/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: teacherEmail,
          sender: teacherSender,
          loginEmail: teacherLoginEmail,
          loginPassword: teacherLoginPassword
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        teacherStatusMessage = { type: 'success', text: data.message || 'Test email sent successfully!' };
      } else {
        teacherStatusMessage = { type: 'error', text: data.message || 'Test failed' };
      }
    } catch (err: any) {
      teacherStatusMessage = { type: 'error', text: err?.message || 'Failed to send test email' };
    } finally {
      isTestingTeacher = false;
    }
  }

  onMount(() => {
    resumeLastPosition = getResumeLastPosition();
    loadModelCards();
    loadStorageInfo();
    loadTeacherCheckin();
  });
</script>

<Header />

<div class="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
  <!-- Parent Wrapper (same width constraint as /courses) -->
  <div class="flex-1 flex flex-col max-w-6xl mx-auto w-full px-4 sm:px-8 py-6 min-h-0 overflow-hidden">
    <!-- Header with Settings / Prompts tabs -->
    <div role="tablist" aria-label="Settings navigation" class="flex items-center space-x-6 border-b border-stone-200 dark:border-stone-800 pb-3 shrink-0">
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'settings'}
        onclick={() => switchTab('settings')}
        class="text-2xl font-bold tracking-tight transition cursor-pointer {activeTab === 'settings' ? 'text-stone-900 dark:text-stone-100' : 'text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300'}"
      >
        Settings
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'prompts'}
        onclick={() => switchTab('prompts')}
        class="text-2xl font-bold tracking-tight transition cursor-pointer {activeTab === 'prompts' ? 'text-stone-900 dark:text-stone-100' : 'text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300'}"
      >
        Prompts
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'sync_mcp'}
        onclick={() => switchTab('sync_mcp')}
        class="text-2xl font-bold tracking-tight transition cursor-pointer {activeTab === 'sync_mcp' ? 'text-stone-900 dark:text-stone-100' : 'text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300'}"
      >
        Sync &amp; MCP
      </button>
    </div>

    <!-- Settings Tab Content -->
    <main class="flex-1 overflow-y-auto pt-4 pb-8 space-y-4 text-stone-900 dark:text-stone-100 {activeTab === 'settings' ? '' : 'hidden'}">
      <!-- Panel 1: General & Storage -->
  <section class="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xs divide-y divide-stone-100 dark:divide-stone-800 text-xs">
    <!-- Theme / UI Row -->
    <div class="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
      <div class="flex items-center space-x-2">
        <Palette class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
        <div>
          <span class="font-medium text-stone-900 dark:text-stone-100">Appearance</span>
          <span class="text-[11px] text-stone-400 dark:text-stone-500 ml-1.5">({theme.isDark ? 'Dark Mode' : 'Light Mode'})</span>
        </div>
      </div>

      <!-- Segmented Theme Toggle -->
      <div class="inline-flex p-0.5 rounded-md bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 self-start sm:self-auto">
        <button
          type="button"
          onclick={() => theme.setTheme('light')}
          class="flex items-center space-x-1 px-2.5 py-1 rounded text-xs font-medium transition cursor-pointer {theme.current === 'light' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100'}"
        >
          <Sun class="w-3.5 h-3.5" />
          <span>Light</span>
        </button>
        <button
          type="button"
          onclick={() => theme.setTheme('dark')}
          class="flex items-center space-x-1 px-2.5 py-1 rounded text-xs font-medium transition cursor-pointer {theme.current === 'dark' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100'}"
        >
          <Moon class="w-3.5 h-3.5" />
          <span>Dark</span>
        </button>
        <button
          type="button"
          onclick={() => theme.setTheme('system')}
          class="flex items-center space-x-1 px-2.5 py-1 rounded text-xs font-medium transition cursor-pointer {theme.current === 'system' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100'}"
        >
          <Monitor class="w-3.5 h-3.5" />
          <span>System</span>
        </button>
      </div>
    </div>

    <!-- Zoom Row (desktop app only) -->
    {#if isTauri}
      <div class="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div class="flex items-center space-x-2">
          <ZoomIn class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
          <div>
            <span class="font-medium text-stone-900 dark:text-stone-100">Zoom</span>
            <span class="text-[11px] text-stone-400 dark:text-stone-500 ml-1.5">Ctrl/Cmd +/− or Ctrl+scroll</span>
          </div>
        </div>

        <select
          id="zoom-level-select"
          value={zoom.level}
          onchange={(event) => zoom.setLevel(Number(event.currentTarget.value))}
          class="px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100 self-start sm:self-auto"
        >
          {#each ZOOM_STEPS as step (step)}
            <option value={step}>{step}%{step === 100 ? ' (default)' : ''}</option>
          {/each}
        </select>
      </div>
    {/if}

    <!-- Return to Most Recent Position in Course Row -->
    <div class="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div class="flex items-start sm:items-center space-x-2">
        <Compass class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0 mt-0.5 sm:mt-0" />
        <div>
          <span class="font-medium text-stone-900 dark:text-stone-100">Return to most recent position in course</span>
          <p class="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5">
            When opening a course generically, resume at your last accessed lesson and position instead of the course main page.
          </p>
        </div>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={resumeLastPosition}
        aria-label="Toggle return to most recent position in course"
        onclick={toggleResumePosition}
        class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden {resumeLastPosition ? 'bg-stone-900 dark:bg-stone-100' : 'bg-stone-200 dark:bg-stone-700'}"
      >
        <span
          class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white dark:bg-stone-900 shadow-md ring-0 transition duration-200 ease-in-out {resumeLastPosition ? 'translate-x-4' : 'translate-x-0'}"
        ></span>
      </button>
    </div>

    <!-- Course Data Storage Row -->
    <div class="p-3 space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-1.5">
        <div class="flex items-center space-x-2">
          <HardDrive class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
          <span class="font-medium text-stone-900 dark:text-stone-100">Course Data Directory</span>
          {#if storageInfo}
            <span class="text-[11px] text-stone-400 dark:text-stone-500">
              ({storageInfo.courseCount} {storageInfo.courseCount === 1 ? 'course' : 'courses'} &bull; {storageInfo.totalSizeFormatted})
            </span>
          {/if}
        </div>

        <div class="flex items-center space-x-1.5">
          {#if storageInfo}
            <span class="px-1.5 py-0.5 rounded text-[10px] font-medium {storageInfo.isCustom ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800' : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'}">
              {storageInfo.isCustom ? 'Custom' : 'Default OS'}
            </span>
          {/if}

          <button
            onclick={openFolder}
            type="button"
            class="flex items-center space-x-1 px-2 py-1 rounded border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 text-[11px] text-stone-700 dark:text-stone-300 font-medium transition cursor-pointer"
            title="Open folder in Finder or File Explorer"
          >
            <FolderOpen class="w-3 h-3" />
            <span>Open</span>
          </button>

          {#if !isChangingPath}
            <button
              onclick={chooseFolder}
              type="button"
              class="flex items-center space-x-1 px-2 py-1 rounded border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 text-[11px] text-stone-700 dark:text-stone-300 font-medium transition cursor-pointer"
            >
              <Folder class="w-3 h-3" />
              <span>Change</span>
            </button>
          {/if}

          {#if storageInfo?.isCustom}
            <button
              onclick={resetStorageToDefault}
              type="button"
              class="flex items-center space-x-1 px-2 py-1 rounded text-[11px] text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
              title="Reset location back to application default"
            >
              <RotateCw class="w-3 h-3" />
              <span>Reset</span>
            </button>
          {/if}
        </div>
      </div>

      <!-- Active Path Box -->
      <div class="font-mono text-[11px] text-stone-700 dark:text-stone-300 break-all select-all bg-stone-50 dark:bg-stone-950 px-2 py-1.5 rounded border border-stone-200 dark:border-stone-800">
        {storageInfo?.dataDir || 'Loading...'}
      </div>

      {#if storageMessage}
        <div class="flex items-center space-x-1.5 text-[11px] px-2 py-1 rounded border {storageMessage.type === 'success' ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'}">
          {#if storageMessage.type === 'success'}
            <CheckCircle2 class="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          {:else}
            <AlertCircle class="w-3 h-3 shrink-0 text-rose-600 dark:text-rose-400" />
          {/if}
          <span>{storageMessage.text}</span>
        </div>
      {/if}

      <!-- Change Directory Form (Inline) -->
      {#if isChangingPath}
        <div class="p-2.5 rounded border border-stone-200 dark:border-stone-700 bg-stone-50/70 dark:bg-stone-800/40 space-y-2 mt-1">
          <div class="flex items-center gap-1.5">
            <input
              id="new-path-input"
              type="text"
              bind:value={newPath}
              placeholder={storageInfo?.dataDir || '/path/to/data'}
              class="flex-1 px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs font-mono text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-950 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
            />
            <button
              onclick={chooseFolder}
              type="button"
              class="flex items-center space-x-1 px-2 py-1 rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-xs font-medium text-stone-700 dark:text-stone-200 transition cursor-pointer shrink-0"
            >
              <Folder class="w-3 h-3" />
              <span>Browse...</span>
            </button>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <label for="migrate-data-checkbox" class="flex items-center space-x-1.5 text-[11px] text-stone-600 dark:text-stone-400 select-none cursor-pointer">
              <input
                id="migrate-data-checkbox"
                type="checkbox"
                bind:checked={migrateExisting}
                class="rounded border-stone-300 dark:border-stone-600 text-stone-900 dark:text-stone-100 focus:ring-stone-900 h-3 w-3"
              />
              <span>Copy existing courses, prompts, and config to new path</span>
            </label>

            <div class="flex items-center space-x-1.5">
              <button
                onclick={() => { isChangingPath = false; newPath = ''; }}
                disabled={isSavingPath}
                class="px-2 py-0.5 rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-[11px] font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-700 transition"
              >
                Cancel
              </button>
              <button
                onclick={() => saveNewPath()}
                disabled={isSavingPath || !newPath.trim()}
                class="flex items-center space-x-1 px-2.5 py-0.5 rounded bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-[11px] font-medium hover:bg-stone-800 dark:hover:bg-white disabled:opacity-50 transition cursor-pointer"
              >
                {#if isSavingPath}
                  <Loader2 class="w-3 h-3 animate-spin" />
                  <span>Applying...</span>
                {:else}
                  <Save class="w-3 h-3" />
                  <span>Apply</span>
                {/if}
              </button>
            </div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Backup & Migration Row -->
    <div class="p-3 space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center space-x-2">
          <Archive class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
          <span class="font-medium text-stone-900 dark:text-stone-100">Backup & Migration</span>
          <span class="text-[11px] text-stone-400 dark:text-stone-500">Zip/unzip courses and config</span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <!-- Toggle to include/exclude raw uploads -->
          <label class="flex items-center space-x-1.5 text-[11px] text-stone-500 dark:text-stone-400 select-none cursor-pointer" title="Include original uploaded course package zip archives found in _backup folders (increases archive size)">
            <input
              type="checkbox"
              bind:checked={includeRawArchives}
              class="rounded border-stone-300 dark:border-stone-700 text-stone-900 focus:ring-stone-500 cursor-pointer"
            />
            <span>Include raw package backups</span>
          </label>

          <!-- Hidden file input for restore -->
          <input
            type="file"
            accept=".zip,application/zip"
            bind:this={backupFileInput}
            onchange={handleBackupFileSelected}
            class="hidden"
          />

          <button
            onclick={exportBackup}
            disabled={isExportingBackup}
            class="flex items-center space-x-1 px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 text-[11px] font-medium text-stone-700 dark:text-stone-300 disabled:opacity-50 transition cursor-pointer"
          >
            {#if isExportingBackup}
              <Loader2 class="w-3 h-3 animate-spin" />
              <span>{backupExportProgress ? `Exporting (${backupExportProgress})...` : 'Exporting...'}</span>
            {:else}
              <Download class="w-3 h-3" />
              <span>Export .zip</span>
            {/if}
          </button>

          <button
            onclick={triggerImportDialog}
            disabled={isImportingBackup}
            class="flex items-center space-x-1 px-2 py-1 rounded border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 text-[11px] font-medium text-stone-700 dark:text-stone-300 disabled:opacity-50 transition cursor-pointer"
          >
            {#if isImportingBackup}
              <Loader2 class="w-3 h-3 animate-spin" />
              <span>Restoring...</span>
            {:else}
              <Upload class="w-3 h-3" />
              <span>Restore .zip</span>
            {/if}
          </button>
        </div>
      </div>

      {#if backupMessage}
        <div class="flex items-center space-x-1.5 text-[11px] px-2 py-1 rounded border {backupMessage.type === 'success' ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'}">
          {#if backupMessage.type === 'success'}
            <CheckCircle2 class="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          {:else}
            <AlertCircle class="w-3 h-3 shrink-0 text-rose-600 dark:text-rose-400" />
          {/if}
          <span>{backupMessage.text}</span>
        </div>
      {/if}
    </div>
  </section>

  <!-- Panel 2: LLM Configuration & Maintenance -->
  <section class="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xs divide-y divide-stone-100 dark:divide-stone-800 text-xs">
    <!-- LLM Provider Header & Inputs -->
    <div class="p-3 space-y-3 relative">
      <div class="flex items-center space-x-2 pr-64">
        <Server class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
        <span class="font-medium text-stone-900 dark:text-stone-100">AI Models</span>
        <span class="text-[11px] text-stone-400 dark:text-stone-500 hidden sm:inline">Configure providers & models for generation</span>
      </div>

      <!-- Action buttons absolutely positioned on top-right of LLM card -->
      <div class="absolute -top-1 right-3 flex items-center space-x-1.5">
        {#if llmMessage}
          <span class="text-[11px] px-2 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 font-medium">
            {llmMessage}
          </span>
        {/if}

        <button
          type="button"
          onclick={addModelCard}
          class="flex items-center space-x-1 px-2.5 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 hover:bg-stone-50 dark:hover:bg-stone-800 text-xs font-medium text-stone-700 dark:text-stone-300 transition cursor-pointer"
          title="Add a new model provider"
        >
          <Plus class="w-3.5 h-3.5" />
          <span>New</span>
        </button>

        {#if activeCard}
          <button
            type="button"
            onclick={() => removeModelCard(activeCard.id)}
            class="flex items-center space-x-1 px-2.5 py-1 rounded border border-rose-200 dark:border-rose-900/60 bg-rose-50/50 dark:bg-rose-950/40 hover:bg-rose-100/60 dark:hover:bg-rose-900/40 text-xs font-medium text-rose-700 dark:text-rose-300 transition cursor-pointer"
            title="Delete this model"
          >
            <Trash2 class="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onclick={handleSaveModelsClick}
            disabled={isSavingModels}
            class="flex items-center space-x-1 px-3 py-1 rounded bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 text-white dark:text-stone-900 text-xs font-medium transition cursor-pointer disabled:opacity-50"
          >
            {#if isSavingModels}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Saving...</span>
            {:else}
              <Save class="w-3.5 h-3.5" />
              <span>Save</span>
            {/if}
          </button>
        {/if}
      </div>

      <!-- Active Model Selector Bar -->
      <div class="flex items-center space-x-2 p-2 rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950">
        <label for="active-model-select" class="text-xs font-semibold text-stone-700 dark:text-stone-300 shrink-0">
          Active Model:
        </label>
        {#if llmCards.length > 0}
          <select
            id="active-model-select"
            value={llmActiveId}
            onchange={(e) => selectActiveModel(e.currentTarget.value)}
            class="flex-1 w-full px-2.5 py-1 rounded border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          >
            {#each llmCards as card (card.id)}
              <option value={card.id}>
                {card.label || 'Untitled Model'} ({getProviderPreset(card.provider).label})
              </option>
            {/each}
          </select>
        {:else}
          <span class="text-xs text-stone-500 italic">No models configured</span>
        {/if}
      </div>

      <!-- ONLY show fields for the active model -->
      {#if activeCard}
        {@const card = activeCard}
        {@const preset = getProviderPreset(card.provider)}
        <div class="p-3 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/60 space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label for="model-label-{card.id}" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
                Model Label / Description
              </label>
              <input
                id="model-label-{card.id}"
                type="text"
                bind:value={card.label}
                placeholder="e.g. DeepSeek (Cloud), Local Qwen 2.5"
                class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
              />
            </div>

            <div>
              <label for="provider-select-{card.id}" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
                Provider Preset
              </label>
              <select
                id="provider-select-{card.id}"
                value={card.provider}
                onchange={(e) => applyProviderPreset(card, e.currentTarget.value)}
                class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
              >
                {#each LLM_PROVIDER_PRESETS as p (p.id)}
                  <option value={p.id}>{p.label}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label for="base-url-input-{card.id}" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
                Base URL <span class="text-rose-500">*</span>
              </label>
              <input
                id="base-url-input-{card.id}"
                type="text"
                bind:value={card.baseUrl}
                placeholder={preset.defaultBaseUrl}
                class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs font-mono text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
              />
              <p class="text-[10px] text-stone-400 dark:text-stone-500 mt-0.5">{preset.hint}</p>
            </div>

            <div>
              <label for="model-id-input-{card.id}" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
                Model ID <span class="text-[10px] text-stone-400 dark:text-stone-500">(optional)</span>
              </label>
              <input
                id="model-id-input-{card.id}"
                type="text"
                bind:value={card.model}
                placeholder="e.g. gpt-4o-mini, deepseek-chat, qwen2.5-7b"
                class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs font-mono text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div>
              <label for="api-key-input-{card.id}" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
                API Key <span class="text-[10px] text-stone-400 dark:text-stone-500">{card.hasApiKey ? '(saved — blank keeps it)' : '(optional)'}</span>
              </label>
              <input
                id="api-key-input-{card.id}"
                type="password"
                bind:value={card.apiKey}
                placeholder={card.hasApiKey ? '••••••••' : 'sk-...'}
                class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs font-mono text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
              />
            </div>

            <div>
              <label for="auth-type-select-{card.id}" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">Auth Header</label>
              <select
                id="auth-type-select-{card.id}"
                bind:value={card.authHeaderType}
                class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
              >
                <option value="bearer">Bearer &#123;key&#125; (Standard)</option>
                <option value="api_key">api-key: &#123;key&#125; (Azure)</option>
                <option value="both">Both (Bearer + api-key)</option>
              </select>
            </div>

            <div>
              <label for="timeout-select-{card.id}" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
                Request Timeout <span class="text-[10px] text-stone-400 dark:text-stone-500">(per attempt)</span>
              </label>
              <select
                id="timeout-select-{card.id}"
                bind:value={card.timeoutSeconds}
                class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
              >
                {#each REQUEST_TIMEOUT_STEPS as step (step)}
                  <option value={step}>{step}s{step === 150 ? ' (default)' : ''}</option>
                {/each}
              </select>
            </div>
          </div>

          <!-- Optional Send session_id checkbox -->
          <div class="pt-0.5">
            <label for="send-session-id-{card.id}" class="inline-flex items-center space-x-1.5 text-[11px] text-stone-600 dark:text-stone-400 select-none cursor-pointer">
              <input
                id="send-session-id-{card.id}"
                type="checkbox"
                bind:checked={card.sendSessionId}
                class="rounded border-stone-300 dark:border-stone-700 text-stone-900 dark:text-stone-100 focus:ring-stone-900 h-3.5 w-3.5 cursor-pointer"
              />
              <span>Send session ID (<code>session_id</code>)</span>
            </label>
            <p class="text-[10px] text-stone-400 dark:text-stone-500 pl-5">
              Keep unchecked if your provider rejects extra inputs with HTTP 400.
            </p>
          </div>

          {#if isPublicIpUrl(card.baseUrl)}
            <p class="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
              Note: Direct IP access to cloud APIs (like DeepSeek, OpenAI, Groq) is blocked by Cloudflare (error 1003). Use the domain name (e.g. <code>https://api.deepseek.com</code>) instead of an IP.
            </p>
          {/if}

          {#if card.apiKey && !card.hasApiKey}
            <p class="text-[10px] text-stone-400 dark:text-stone-500">New API key will be stored when you press Save Models.</p>
          {/if}

          <!-- Test Connection & Status -->
          <div class="flex items-center justify-between pt-1">
            <button
              type="button"
              onclick={() => testModelCard(card)}
              disabled={testingCardId === card.id || !card.baseUrl.trim()}
              class="flex items-center space-x-1 px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 text-[11px] font-medium text-stone-700 dark:text-stone-300 transition cursor-pointer disabled:opacity-50"
            >
              {#if testingCardId === card.id}
                <Loader2 class="w-3 h-3 animate-spin" />
                <span>Testing Connection...</span>
              {:else}
                <span>Test Connection</span>
              {/if}
            </button>

            {#if cardTestResults[card.id]}
              <div class="flex items-center space-x-1.5 text-[11px] px-2 py-1 rounded border {cardTestResults[card.id].success ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'}">
                {#if cardTestResults[card.id].success}
                  <CheckCircle2 class="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                {:else}
                  <AlertCircle class="w-3 h-3 shrink-0 text-rose-600 dark:text-rose-400" />
                {/if}
                <span>{cardTestResults[card.id].message}</span>
              </div>
            {/if}
          </div>
        </div>
      {:else if !isLoadingModels}
        <div class="p-6 text-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950/50">
          <p class="text-xs text-stone-500 dark:text-stone-400 mb-2">No AI model configured yet.</p>
          <button
            type="button"
            onclick={addModelCard}
            class="inline-flex items-center space-x-1 px-3 py-1.5 rounded-md bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 text-white dark:text-stone-900 text-xs font-medium transition cursor-pointer"
          >
            <Plus class="w-3.5 h-3.5" />
            <span>Add a Model Provider</span>
          </button>
        </div>
      {/if}
    </div>

    <!-- Maintenance Row -->
    <div class="p-3 space-y-2">
      <div class="flex items-center space-x-2">
        <FolderKanban class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
        <span class="font-medium text-stone-900 dark:text-stone-100">Ingestion & Maintenance</span>
        <span class="text-[11px] text-stone-400 dark:text-stone-500">Only needed if files were damaged</span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5">
        <div class="flex items-center justify-between p-2 rounded border border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950 gap-2">
          <div class="text-[11px] text-stone-600 dark:text-stone-400 leading-tight">
            Re-parse all raw HTML in <code class="text-[10px]">_backup/</code>
          </div>
          <button
            onclick={reparseAllCourses}
            disabled={isReparsing}
            class="flex items-center space-x-1 px-2 py-1 rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-[11px] font-medium text-stone-700 dark:text-stone-300 disabled:opacity-50 transition cursor-pointer shrink-0"
          >
            {#if isReparsing}
              <Loader2 class="w-3 h-3 animate-spin" />
              <span>Parsing...</span>
            {:else}
              <RotateCw class="w-3 h-3" />
              <span>Re-parse All</span>
            {/if}
          </button>
        </div>

        <div class="flex items-center justify-between p-2 rounded border border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-950 gap-2">
          <div class="text-[11px] text-stone-600 dark:text-stone-400 leading-tight">
            Compress course images (&gt;512px)
          </div>
          <button
            onclick={compressCourseImages}
            disabled={isCompressingImages}
            class="flex items-center space-x-1 px-2 py-1 rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-[11px] font-medium text-stone-700 dark:text-stone-300 disabled:opacity-50 transition shrink-0 cursor-pointer"
          >
            {#if isCompressingImages}
              <Loader2 class="w-3 h-3 animate-spin" />
              <span>Compressing...</span>
            {:else}
              <ImageDown class="w-3 h-3" />
              <span>Compress</span>
            {/if}
          </button>
        </div>
      </div>

      {#if reparseResult}
        <div class="text-[11px] px-2 py-1 rounded bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-stone-700 dark:text-stone-300">
          {reparseResult}
        </div>
      {/if}

      {#if compressImagesResult}
        <div class="text-[11px] px-2 py-1 rounded bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-stone-700 dark:text-stone-300">
          {compressImagesResult}
        </div>
      {/if}
    </div>
  </section>

  <!-- Panel 3: Supervisor Check-In (Accountability) -->
  <section class="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xs divide-y divide-stone-100 dark:divide-stone-800 text-xs">
    <div class="p-3 space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-2">
          <Mail class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
          <span class="font-medium text-stone-900 dark:text-stone-100">Supervisor Check-In</span>
          <span class="text-[11px] text-stone-400 dark:text-stone-500 hidden sm:inline">Accountability updates &amp; pop quiz reporting</span>
        </div>

        <div class="flex items-center space-x-1.5">
          <button
            type="button"
            onclick={testTeacherCheckin}
            disabled={isTestingTeacher || !teacherEmail || !teacherLoginEmail}
            class="flex items-center space-x-1 px-2.5 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 hover:bg-stone-50 dark:hover:bg-stone-700 text-xs font-medium text-stone-700 dark:text-stone-300 transition cursor-pointer disabled:opacity-50"
            title="Send a verification test email to the supervisor address"
          >
            {#if isTestingTeacher}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Sending Test...</span>
            {:else}
              <Send class="w-3.5 h-3.5" />
              <span>Send Test Email</span>
            {/if}
          </button>

          <button
            type="button"
            onclick={saveTeacherCheckin}
            disabled={isSavingTeacher}
            class="flex items-center space-x-1 px-3 py-1 rounded bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 text-white dark:text-stone-900 text-xs font-medium transition cursor-pointer disabled:opacity-50"
          >
            {#if isSavingTeacher}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Saving...</span>
            {:else}
              <Save class="w-3.5 h-3.5" />
              <span>Save</span>
            {/if}
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <label for="teacher-email-input" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
            Supervisor / Admin Email <span class="text-rose-500">*</span>
          </label>
          <input
            id="teacher-email-input"
            type="email"
            bind:value={teacherEmail}
            placeholder="e.g. teacher@school.org"
            class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          />
          <p class="text-[10px] text-stone-400 dark:text-stone-500 mt-0.5">Quiz results and progress updates are delivered here.</p>
        </div>

        <div>
          <label for="teacher-sender-select" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
            Email Sender <span class="text-rose-500">*</span>
          </label>
          <select
            id="teacher-sender-select"
            bind:value={teacherSender}
            class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          >
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook</option>
          </select>
          <p class="text-[10px] text-stone-400 dark:text-stone-500 mt-0.5">SMTP service provider used to send the emails.</p>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <label for="teacher-login-email-input" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
            Login Email <span class="text-rose-500">*</span>
          </label>
          <input
            id="teacher-login-email-input"
            type="email"
            bind:value={teacherLoginEmail}
            placeholder={teacherSender === 'gmail' ? 'your-name@gmail.com' : 'your-name@outlook.com'}
            class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          />
          <p class="text-[10px] text-stone-400 dark:text-stone-500 mt-0.5">The sending account username/email.</p>
        </div>

        <div>
          <label for="teacher-password-input" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
            Login Password / App Password <span class="text-rose-500">*</span>
            {#if teacherHasPassword && !teacherLoginPassword}
              <span class="text-[10px] text-emerald-600 dark:text-emerald-400 font-normal ml-1">(Saved in config)</span>
            {/if}
            {#if teacherSender === 'gmail'}
              <button
                type="button"
                onclick={(e) => { e.preventDefault(); e.stopPropagation(); showAppPasswordGuide = !showAppPasswordGuide; }}
                class="text-[10px] text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-200 underline font-normal ml-1 cursor-pointer"
                title="Toggle Google App Password guide"
              >
                (Info)
              </button>
            {/if}
          </label>
          <div class="relative">
            <input
              id="teacher-password-input"
              type={showTeacherPassword ? 'text' : 'password'}
              bind:value={teacherLoginPassword}
              placeholder={teacherHasPassword ? '•••••••••••••••• (Leave blank to keep saved)' : (teacherSender === 'gmail' ? '16-character Google App Password' : 'Password or App Password')}
              class="w-full pl-2 pr-8 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
            />
            <button
              type="button"
              onclick={() => (showTeacherPassword = !showTeacherPassword)}
              class="absolute right-2 top-1.5 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 transition"
              title={showTeacherPassword ? 'Hide password' : 'Show password'}
            >
              {#if showTeacherPassword}
                <EyeOff class="w-3.5 h-3.5" />
              {:else}
                <Eye class="w-3.5 h-3.5" />
              {/if}
            </button>
          </div>
          {#if teacherSender === 'gmail'}
            {#if showAppPasswordGuide}
              <div class="mt-2 p-2.5 rounded-lg border border-amber-200 dark:border-amber-800/80 bg-amber-50/70 dark:bg-amber-950/30 text-[11px] text-stone-700 dark:text-stone-300 space-y-1.5 shadow-2xs animate-in fade-in duration-150">
                <div class="flex items-center justify-between">
                  <div class="flex items-center space-x-1.5 font-semibold text-amber-900 dark:text-amber-200 text-[11px]">
                    <Info class="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>How to get an App Password:</span>
                  </div>
                  <button
                    type="button"
                    onclick={() => (showAppPasswordGuide = false)}
                    class="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 text-xs cursor-pointer p-0.5 leading-none"
                    title="Hide guide"
                  >
                    &times;
                  </button>
                </div>
                <ol class="list-decimal list-outside ml-3.5 space-y-1 text-[10.5px] leading-relaxed text-stone-600 dark:text-stone-300">
                  <li>
                    Go to your <a href="https://myaccount.google.com/security" target="_blank" rel="noreferrer" class="text-amber-700 dark:text-amber-400 font-medium underline hover:text-amber-900 dark:hover:text-amber-200">Google Account Security</a> page.
                  </li>
                  <li>
                    Verify that 2-Step Verification is turned ON on your account (required by Google to generate App Passwords).
                  </li>
                  <li>
                    Search for "App passwords" in the top search bar (or visit <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" class="text-amber-700 dark:text-amber-400 font-medium underline hover:text-amber-900 dark:hover:text-amber-200">myaccount.google.com/apppasswords</a>).
                  </li>
                  <li>
                    Under "App name", enter CourseDeck and click Create.
                  </li>
                  <li>
                    Google will display a 16-character code (e.g., <code class="font-mono bg-amber-100/80 dark:bg-amber-900/50 px-1 py-0.5 rounded text-[10px] text-amber-950 dark:text-amber-200">abcd efgh ijkl mnop</code>).
                  </li>
                </ol>
              </div>
            {/if}
          {:else}
            <p class="text-[10px] text-stone-400 dark:text-stone-500 mt-1 leading-relaxed">
              <span class="text-amber-600 dark:text-amber-400 font-medium">Important for Outlook:</span> Use an <strong>App Password</strong> if 2-Step Verification is enabled on your Microsoft account (created in Microsoft Account Security settings).
            </p>
          {/if}
        </div>
      </div>

      {#if teacherStatusMessage}
        <div class="flex items-center space-x-1.5 text-[11px] px-2.5 py-1.5 rounded border {teacherStatusMessage.type === 'success' ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'}">
          {#if teacherStatusMessage.type === 'success'}
            <CheckCircle2 class="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          {:else}
            <AlertCircle class="w-3.5 h-3.5 shrink-0 text-rose-600 dark:text-rose-400" />
          {/if}
          <span>{teacherStatusMessage.text}</span>
        </div>
      {/if}
    </div>
  </section>
  </main>
  
  <!-- Prompts Tab Content -->
  <div class="flex-1 min-h-0 mt-4 flex overflow-hidden rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xs {activeTab === 'prompts' ? '' : 'hidden'}">
    <PromptsManager />
  </div>

  <!-- Sync & MCP Tab Content -->
  <div class="flex-1 min-h-0 flex flex-col overflow-hidden {activeTab === 'sync_mcp' ? '' : 'hidden'}">
    <SyncMcpSettings />
  </div>
  </div>
</div>

