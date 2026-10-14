<script lang="ts">
  import Header from '$lib/components/Header.svelte';
  import { onMount } from 'svelte';
  import { apiFetch, isTauriEnvironment } from '$lib/api';
  import { confirmDialog } from '$lib/dialog';
  import {
    Settings,
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
    Monitor
  } from 'lucide-svelte';
  import { theme } from '$lib/theme.svelte';

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

  // Backup state
  let isExportingBackup = $state(false);
  let backupExportProgress = $state('');
  let includeRawArchives = $state(false);
  let isImportingBackup = $state(false);
  let backupFileInput: HTMLInputElement | null = $state(null);
  let backupMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null);

  let provider = $state('openai_compatible');
  let baseUrl = $state('http://localhost:11434/v1');
  let apiKey = $state('');
  let authHeaderType: 'bearer' | 'api_key' | 'both' = $state('bearer');
  let model = $state('');
  let temperature = $state(0.3);

  let isTestingConnection = $state(false);
  let connectionTestResult: { success: boolean; message: string } | null = $state(null);

  let isReparsing = $state(false);
  let reparseResult: string = $state('');
  let saveMessage = $state('');
  let hasStoredApiKey = $state(false);

  let isCompressingImages = $state(false);
  let compressImagesResult: string = $state('');

  function loadSettings() {
    // Clean up any legacy API key from localStorage
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('ilc_llm_apiKey');
    }

    // Load canonical config from server
    apiFetch('/api/llm')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.config) {
          provider = data.config.provider || 'openai_compatible';
          baseUrl = data.config.baseUrl || 'http://localhost:11434/v1';
          model = data.config.model ?? '';
          authHeaderType = data.config.authHeaderType || 'bearer';
          temperature = data.config.temperature ?? 0.3;
          hasStoredApiKey = Boolean(data.config.hasApiKey);
        } else if (typeof localStorage !== 'undefined') {
          provider = localStorage.getItem('ilc_llm_provider') || 'openai_compatible';
          baseUrl = localStorage.getItem('ilc_llm_baseUrl') || 'http://localhost:11434/v1';
          authHeaderType = (localStorage.getItem('ilc_llm_authHeaderType') as any) || 'bearer';
          model = localStorage.getItem('ilc_llm_model') ?? '';
          temperature = parseFloat(localStorage.getItem('ilc_llm_temp') || '0.3');
        }
      })
      .catch(() => {});
  }

  function saveSettings() {
    const cleanModel = model.trim();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('ilc_llm_provider', provider);
      localStorage.setItem('ilc_llm_baseUrl', baseUrl);
      localStorage.removeItem('ilc_llm_apiKey');
      localStorage.setItem('ilc_llm_authHeaderType', authHeaderType);
      localStorage.setItem('ilc_llm_model', cleanModel);
      localStorage.setItem('ilc_llm_temp', temperature.toString());
      saveMessage = 'Settings saved.';
      setTimeout(() => {
        saveMessage = '';
      }, 2500);
    }

    // Sync to server immediately so background queue worker uses CURRENT active settings
    apiFetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save_config',
        config: {
          provider,
          baseUrl,
          apiKey: apiKey || undefined,
          authHeaderType,
          model: cleanModel,
          temperature
        }
      })
    })
      .then(() => {
        if (apiKey) {
          hasStoredApiKey = true;
          apiKey = '';
        }
      })
      .catch((err) => console.warn('Failed to sync LLM config to server:', err));
  }

  async function testConnection() {
    isTestingConnection = true;
    connectionTestResult = null;

    try {
      const res = await apiFetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'test',
          config: {
            provider,
            baseUrl,
            apiKey,
            authHeaderType,
            model,
            temperature
          }
        })
      });

      const data = await res.json();
      connectionTestResult = {
        success: data.success,
        message: data.message || (data.success ? 'Connected successfully!' : 'Connection failed')
      };
    } catch (err: any) {
      connectionTestResult = {
        success: false,
        message: err?.message || 'Error contacting LLM endpoint'
      };
    } finally {
      isTestingConnection = false;
    }
  }

  function isPublicIp(urlStr: string): boolean {
    try {
      const clean = urlStr.trim();
      if (!clean) return false;
      const host = new URL(clean.startsWith('http') ? clean : `http://${clean}`).hostname;
      const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (!match) return false;
      const a = Number(match[1]);
      const b = Number(match[2]);
      if (a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
      return true;
    } catch {
      return false;
    }
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

      const filename = `ilc-study-tool-backup-${new Date().toISOString().split('T')[0]}.zip`;

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

  onMount(() => {
    loadSettings();
    loadStorageInfo();
  });
</script>

<Header />

<main class="flex-1 overflow-y-auto px-4 py-4 max-w-3xl mx-auto w-full space-y-3 text-stone-900 dark:text-stone-100">
  <div class="flex items-center justify-between pb-1 border-b border-stone-200 dark:border-stone-800">
    <div>
      <h1 class="text-base font-semibold text-stone-900 dark:text-stone-100">Settings</h1>
      <p class="text-[11px] text-stone-500 dark:text-stone-400">Appearance, course storage, AI provider, and maintenance.</p>
    </div>
  </div>

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
    <div class="p-3 space-y-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-2">
          <Server class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
          <span class="font-medium text-stone-900 dark:text-stone-100">LLM Provider Configuration</span>
        </div>

        <div class="flex items-center space-x-1.5">
          <button
            onclick={testConnection}
            disabled={isTestingConnection}
            class="flex items-center space-x-1 px-2 py-1 rounded border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 text-[11px] text-stone-700 dark:text-stone-300 font-medium transition cursor-pointer"
          >
            {#if isTestingConnection}
              <Loader2 class="w-3 h-3 animate-spin" />
              <span>Testing...</span>
            {:else}
              <span>Test Connection</span>
            {/if}
          </button>

          <button
            onclick={saveSettings}
            class="flex items-center space-x-1 px-2.5 py-1 rounded bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-[11px] font-medium hover:bg-stone-800 dark:hover:bg-white transition cursor-pointer"
          >
            <Save class="w-3 h-3" />
            <span>Save</span>
          </button>
        </div>
      </div>

      {#if connectionTestResult}
        <div class="flex items-center space-x-1.5 text-[11px] px-2 py-1 rounded border {connectionTestResult.success ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'}">
          {#if connectionTestResult.success}
            <CheckCircle2 class="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          {:else}
            <AlertCircle class="w-3 h-3 shrink-0 text-rose-600 dark:text-rose-400" />
          {/if}
          <span>{connectionTestResult.message}</span>
        </div>
      {/if}

      {#if saveMessage}
        <p class="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">{saveMessage}</p>
      {/if}

      <!-- Dense Inputs Grid -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-0.5">
        <div>
          <label for="provider-select" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">Provider</label>
          <select
            id="provider-select"
            bind:value={provider}
            class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          >
            <option value="openai_compatible">OpenAI-Compatible (Ollama, vLLM, LMStudio)</option>
            <option value="gemini">Google Gemini (via OpenAI Endpoint)</option>
            <option value="ollama">Ollama Local</option>
          </select>
        </div>

        <div>
          <label for="base-url-input" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">Base URL</label>
          <input
            id="base-url-input"
            type="text"
            bind:value={baseUrl}
            placeholder="http://localhost:11434/v1"
            class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs font-mono text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          />
          {#if isPublicIp(baseUrl)}
            <p class="text-[10px] text-amber-600 dark:text-amber-400 mt-1 font-medium">
              Note: Direct IP access to cloud APIs (like DeepSeek, OpenAI, Groq) is blocked by Cloudflare (error 1003). Use the domain name (e.g. <code>https://api.deepseek.com</code>) instead of an IP.
            </p>
          {/if}
        </div>

        <div>
          <label for="model-name-input" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">Model Name (optional)</label>
          <input
            id="model-name-input"
            type="text"
            bind:value={model}
            placeholder="gpt-4o-mini, llama3"
            class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          />
        </div>

        <div>
          <label for="auth-type-select" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">Auth Header</label>
          <select
            id="auth-type-select"
            bind:value={authHeaderType}
            class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          >
            <option value="bearer">Bearer &#123;key&#125; (Standard)</option>
            <option value="api_key">api-key: &#123;key&#125; (Azure)</option>
            <option value="both">Both (Bearer + api-key)</option>
          </select>
        </div>

        <div class="sm:col-span-2">
          <label for="api-key-input" class="text-[11px] font-medium text-stone-600 dark:text-stone-400 block mb-0.5">
            API Key <span class="text-[10px] text-stone-400 dark:text-stone-500">(optional for local models)</span>
          </label>
          <input
            id="api-key-input"
            type="password"
            bind:value={apiKey}
            placeholder={hasStoredApiKey ? 'Saved on server (leave blank to keep)' : 'sk-...'}
            class="w-full px-2 py-1 rounded border border-stone-200 dark:border-stone-700 text-xs font-mono text-stone-900 dark:text-stone-100 bg-stone-50/50 dark:bg-stone-950 placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
          />
        </div>
      </div>
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
</main>

