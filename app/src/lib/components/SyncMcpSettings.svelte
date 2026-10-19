<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { apiFetch, isTauriEnvironment } from '$lib/api';
  import { confirmDialog } from '$lib/dialog';
  import {
    Calendar,
    Server,
    CheckCircle2,
    AlertCircle,
    Loader2,
    Save,
    RefreshCw,
    LogOut,
    Copy,
    Check,
    Eye,
    EyeOff,
    ExternalLink,
    Terminal,
    Globe,
    Key,
    Shield,
    Sliders,
    Layers,
    ChevronDown,
    ChevronUp
  } from 'lucide-svelte';

  const isTauri = isTauriEnvironment();

  async function openExternalUrl(url: string) {
    if (typeof window !== 'undefined') {
      try {
        if (isTauri) {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('plugin:opener|open_url', { url });
          return;
        }
      } catch (e) {
        console.warn('Tauri open_url failed, falling back to window.open:', e);
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  // ─── Sync Card State ─────────────────────────────────────────────────────────
  type SyncProviderId = 'google' | 'arc';
  let activeSyncProvider: SyncProviderId = $state('google');
  let isLoadingSyncStatus = $state(true);
  let isSavingSync = $state(false);
  let syncMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null);

  // Status for each provider
  let googleStatus = $state<{
    connected: boolean;
    accountEmail?: string;
    expiresAt?: string;
    hasCredentials?: boolean;
  }>({ connected: false });

  let arcStatus = $state<{
    connected: boolean;
    endpoint?: string;
    accountEmail?: string;
    hasCredentials?: boolean;
  }>({ connected: false });

  // Google inputs
  let googleClientId = $state('');
  let googleClientSecret = $state('');
  let showGoogleSecret = $state(false);

  let isAuthorizingGoogle = $state(false);
  let copiedRedirectUri = $state(false);
  const GOOGLE_REDIRECT_URI = 'http://127.0.0.1:3182/api/sync/oauth/google/callback';
  let googlePollInterval: ReturnType<typeof setInterval> | null = null;

  // ARC inputs
  let arcApiKey = $state('');
  let arcEndpoint = $state('');
  let showArcKey = $state(false);

  // ─── MCP Card State ──────────────────────────────────────────────────────────
  let mcpEnabled = $state(true);
  let mcpPort = $state(3182);
  let mcpUrl = $state('http://127.0.0.1:3182/mcp');
  let mcpToken = $state('');
  let mcpServerPath = $state('/path/to/app-study-tool/server/index.ts');
  let mcpCommand = $state('bun');
  let mcpArgs = $state<string[]>(['run', '/path/to/app-study-tool/server/index.ts', '--mcp-stdio']);
  let showMcpToken = $state(false);
  let copiedToken = $state(false);
  let isRotatingToken = $state(false);
  let isLoadingMcp = $state(true);
  let isSavingMcp = $state(false);
  let mcpMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null);

  type McpClientChoice = 'select' | 'claude' | 'antigravity' | 'cursor' | 'windsurf';
  let selectedMcpClient: McpClientChoice = $state('select');
  let copiedSnippet = $state<string | null>(null);
  let copiedUrl = $state(false);
  let copiedStdio = $state(false);
  let showToolsList = $state(false);

  // ─── MCP Tools Catalog ───────────────────────────────────────────────────────
  const MCP_TOOLS = [
    { name: 'list_courses', type: 'read', desc: 'List all available courses with metadata and lesson counts' },
    { name: 'get_course', type: 'read', desc: 'Retrieve complete course manifest, unit structure, and metadata' },
    { name: 'list_lessons', type: 'read', desc: 'List all lessons, checkpoints, and tab files for a course' },
    { name: 'get_lesson_doc', type: 'read', desc: 'Retrieve lesson markdown tab (lesson, summary, cheatsheet, test)' },
    { name: 'create_course', type: 'write', desc: 'Initialize a new course directory and empty curriculum skeleton' },
    { name: 'delete_course', type: 'write', desc: 'Permanently remove a course and clean up any synced calendar events' },
    { name: 'inject_lessons', type: 'write', desc: 'Batch ingest lesson content directly into curriculum units' },
    { name: 'search_course', type: 'read', desc: 'BM25 keyword search across lesson notes and course documents' },
    { name: 'build_course_schedule', type: 'schedule', desc: 'Deterministically generate Ontario-compliant study schedules in <10ms' },
    { name: 'get_course_schedule', type: 'schedule', desc: 'Retrieve current course schedule, milestones, and progress' },
    { name: 'prompt_course', type: 'ai', desc: 'Run targeted LLM prompts over budgeted course materials' },
    { name: 'get_task_status', type: 'ai', desc: 'Poll status of background LLM and course generation jobs' }
  ];

  // ─── Data Fetching ───────────────────────────────────────────────────────────
  async function loadSyncStatus() {
    isLoadingSyncStatus = true;
    try {
      const res = await apiFetch('/api/sync/status');
      if (res.ok) {
        const data = await res.json();
        if (data.providers?.google) {
          googleStatus = data.providers.google;
          if (data.providers.google.clientId && !googleClientId) {
            googleClientId = data.providers.google.clientId;
          }
        }
        if (data.providers?.arc) {
          arcStatus = data.providers.arc;
          if (data.providers.arc.endpoint && !arcEndpoint) {
            arcEndpoint = data.providers.arc.endpoint;
          }
        }
      }
    } catch (e: any) {
      console.warn('Failed to load sync status:', e);
    } finally {
      isLoadingSyncStatus = false;
    }
  }

  async function loadMcpSettings() {
    isLoadingMcp = true;
    try {
      const res = await apiFetch('/api/settings/mcp');
      if (res.ok) {
        const data = await res.json();
        mcpEnabled = Boolean(data.enabled);
        mcpPort = data.port || 3182;
        mcpUrl = data.url || `http://127.0.0.1:${mcpPort}/mcp`;
        mcpToken = data.token || '';
        if (data.serverPath) {
          mcpServerPath = data.serverPath;
        }
        if (data.command) {
          mcpCommand = data.command;
        }
        if (Array.isArray(data.args)) {
          mcpArgs = data.args;
        } else if (data.serverPath) {
          mcpArgs = ['run', data.serverPath, '--mcp-stdio'];
        }
      }
    } catch (e: any) {
      console.warn('Failed to load MCP settings:', e);
    } finally {
      isLoadingMcp = false;
    }
  }

  onMount(() => {
    loadSyncStatus();
    loadMcpSettings();
  });

  onDestroy(() => {
    stopGooglePolling();
  });

  function stopGooglePolling() {
    isAuthorizingGoogle = false;
    if (googlePollInterval) {
      clearInterval(googlePollInterval);
      googlePollInterval = null;
    }
  }

  async function startGoogleOAuth() {
    if (!googleClientId.trim()) {
      syncMessage = {
        type: 'error',
        text: 'Google Client ID is required to begin authorization.'
      };
      return;
    }

    isAuthorizingGoogle = true;
    syncMessage = null;

    try {
      const res = await apiFetch('/api/sync/oauth/google/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: googleClientId.trim(),
          clientSecret: googleClientSecret.trim() || undefined,
          redirectUri: GOOGLE_REDIRECT_URI
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to initialize Google authorization.');
      }

      const data = await res.json();
      const authUrl = data.authUrl;

      // Open popup or system browser
      if (typeof window !== 'undefined') {
        if (isTauri) {
          await openExternalUrl(authUrl);
        } else {
          window.open(authUrl, 'google_oauth_popup', 'width=600,height=720,status=no,toolbar=no,menubar=no');
        }
      }

      // Listen for window message from callback popup
      const handleMessage = (e: MessageEvent) => {
        if (e.data?.type === 'GOOGLE_AUTH_SUCCESS') {
          stopGooglePolling();
          loadSyncStatus();
          syncMessage = {
            type: 'success',
            text: `Successfully authorized Google Calendar${e.data.email ? ` as ${e.data.email}` : ''}!`
          };
          window.removeEventListener('message', handleMessage);
        }
      };
      window.addEventListener('message', handleMessage);

      // Also start background polling in case message event is blocked by cross-origin
      if (googlePollInterval) clearInterval(googlePollInterval);
      const pollStartTime = Date.now();
      googlePollInterval = setInterval(async () => {
        if (Date.now() - pollStartTime > 120_000) {
          stopGooglePolling();
          window.removeEventListener('message', handleMessage);
          syncMessage = {
            type: 'error',
            text: 'Google authorization timed out. Please try again.'
          };
          return;
        }

        try {
          const statusRes = await apiFetch('/api/sync/status');
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.providers?.google?.connected) {
              stopGooglePolling();
              window.removeEventListener('message', handleMessage);
              googleStatus = statusData.providers.google;
              syncMessage = {
                type: 'success',
                text: `Successfully connected to Google Calendar${googleStatus.accountEmail ? ` (${googleStatus.accountEmail})` : ''}!`
              };
            }
          }
        } catch {
          // ignore transient poll error
        }
      }, 1500);

    } catch (err: any) {
      stopGooglePolling();
      syncMessage = {
        type: 'error',
        text: err.message || 'Failed to start authorization.'
      };
    }
  }

  // ─── Sync Actions ────────────────────────────────────────────────────────────
  async function saveArcCredentials() {
    if (!arcApiKey.trim()) {
      syncMessage = {
        type: 'error',
        text: 'ARC API Key is required.'
      };
      return;
    }

    isSavingSync = true;
    syncMessage = null;

    try {
      const res = await apiFetch('/api/sync/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'arc',
          apiKey: arcApiKey.trim(),
          endpoint: arcEndpoint.trim() || undefined
        })
      });

      if (res.ok) {
        syncMessage = { type: 'success', text: 'ARC credentials saved successfully.' };
        arcApiKey = '';
        await loadSyncStatus();
      } else {
        const data = await res.json().catch(() => ({}));
        syncMessage = { type: 'error', text: data.message || 'Failed to save ARC credentials.' };
      }
    } catch (e: any) {
      syncMessage = { type: 'error', text: e.message || 'Network error saving ARC credentials.' };
    } finally {
      isSavingSync = false;
    }
  }

  async function disconnectProvider(provider: SyncProviderId) {
    const providerName = provider === 'google' ? 'Google Calendar' : 'ARC';
    const confirmed = await confirmDialog(
      `Disconnect ${providerName}?\n\nThis will remove the saved credentials from your system.`,
      `Disconnect ${providerName}`
    );
    if (!confirmed) return;

    isSavingSync = true;
    syncMessage = null;

    try {
      const res = await apiFetch('/api/sync/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider })
      });

      if (res.ok) {
        syncMessage = { type: 'success', text: `${providerName} disconnected.` };
        await loadSyncStatus();
      } else {
        const data = await res.json().catch(() => ({}));
        syncMessage = { type: 'error', text: data.message || `Failed to disconnect ${providerName}.` };
      }
    } catch (e: any) {
      syncMessage = { type: 'error', text: e.message || 'Network error disconnecting.' };
    } finally {
      isSavingSync = false;
    }
  }

  // ─── MCP Actions ─────────────────────────────────────────────────────────────
  async function toggleMcp() {
    const nextState = !mcpEnabled;
    isSavingMcp = true;
    mcpMessage = null;

    try {
      const res = await apiFetch('/api/settings/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextState })
      });

      if (res.ok) {
        const data = await res.json();
        mcpEnabled = Boolean(data.enabled);
        mcpMessage = {
          type: 'success',
          text: mcpEnabled ? 'MCP server enabled on port 3182.' : 'MCP server disabled.'
        };
      } else {
        mcpMessage = { type: 'error', text: 'Failed to update MCP setting.' };
      }
    } catch (e: any) {
      mcpMessage = { type: 'error', text: e.message || 'Network error updating MCP setting.' };
    } finally {
      isSavingMcp = false;
    }
  }

  async function regenerateMcpToken() {
    const confirmed = await confirmDialog(
      'Regenerate MCP Secret Token?\n\nExisting MCP clients using the current token will need to be updated with the new token.',
      'Regenerate Token'
    );
    if (!confirmed) return;

    isRotatingToken = true;
    mcpMessage = null;
    try {
      const res = await apiFetch('/api/settings/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rotate_token' })
      });
      if (res.ok) {
        const data = await res.json();
        mcpToken = data.token;
        mcpMessage = { type: 'success', text: 'MCP secret token regenerated successfully.' };
      } else {
        const data = await res.json().catch(() => ({}));
        mcpMessage = { type: 'error', text: data.message || 'Failed to rotate token.' };
      }
    } catch (e: any) {
      mcpMessage = { type: 'error', text: e.message || 'Network error rotating token.' };
    } finally {
      isRotatingToken = false;
    }
  }

  async function copyToClipboard(text: string, identifier: string) {
    try {
      await navigator.clipboard.writeText(text);
      if (identifier === 'token') {
        copiedToken = true;
        setTimeout(() => (copiedToken = false), 2000);
      } else if (identifier === 'url') {
        copiedUrl = true;
        setTimeout(() => (copiedUrl = false), 2000);
      } else if (identifier === 'stdio') {
        copiedStdio = true;
        setTimeout(() => (copiedStdio = false), 2000);
      } else if (identifier === 'redirect') {
        copiedRedirectUri = true;
        setTimeout(() => (copiedRedirectUri = false), 2000);
      } else {
        copiedSnippet = identifier;
        setTimeout(() => (copiedSnippet = null), 2000);
      }
    } catch (e) {
      console.warn('Failed to copy to clipboard:', e);
    }
  }

  // Client Snippets
  let claudeConfigSnippet = $derived(
    JSON.stringify(
      {
        mcpServers: {
          coursedeck: {
            command: mcpCommand,
            args: mcpArgs
          }
        }
      },
      null,
      2
    )
  );

  let antigravityConfigSnippet = $derived(
    JSON.stringify(
      {
        mcpServers: {
          coursedeck: {
            command: mcpCommand,
            args: mcpArgs
          }
        }
      },
      null,
      2
    )
  );

  let cursorConfigSnippet = $derived(
    JSON.stringify(
      {
        mcpServers: {
          coursedeck: {
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${mcpToken || '<MCP_TOKEN>'}`
            }
          }
        }
      },
      null,
      2
    )
  );

  let windsurfConfigSnippet = $derived(
    JSON.stringify(
      {
        mcpServers: {
          coursedeck: {
            serverUrl: mcpUrl,
            headers: {
              Authorization: `Bearer ${mcpToken || '<MCP_TOKEN>'}`
            }
          }
        }
      },
      null,
      2
    )
  );

  let stdioCliCommand = $derived(
    mcpCommand === 'bun'
      ? `bun run ${mcpServerPath.includes(' ') ? `"${mcpServerPath}"` : mcpServerPath} --mcp-stdio`
      : `${mcpCommand.includes(' ') ? `"${mcpCommand}"` : mcpCommand} --mcp-stdio`
  );
</script>

<main class="flex-1 overflow-y-auto pt-4 pb-8 space-y-4 text-stone-900 dark:text-stone-100">
  <!-- ═══════════════════════════════════════════════════════════════════════════ -->
  <!-- CARD 1: Scheduling Sync Provider                                         -->
  <!-- ═══════════════════════════════════════════════════════════════════════════ -->
  <section class="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xs divide-y divide-stone-100 dark:divide-stone-800 text-xs">
    <!-- Header Row -->
    <div class="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
      <div class="flex items-center space-x-2">
        <Calendar class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0" />
        <div>
          <span class="font-medium text-stone-900 dark:text-stone-100">Calendar & Schedule Sync</span>
          <span class="text-[11px] text-stone-400 dark:text-stone-500 ml-1.5">
            Sync study schedules to Google Calendar or ARC
          </span>
        </div>
      </div>

      <!-- Segmented Provider Toggle -->
      <div class="inline-flex p-0.5 rounded-md bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 self-start sm:self-auto">
        <button
          type="button"
          onclick={() => { activeSyncProvider = 'google'; syncMessage = null; }}
          class="flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs font-medium transition cursor-pointer {activeSyncProvider === 'google' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100'}"
        >
          <span>Google Calendar</span>
          {#if googleStatus.connected}
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          {/if}
        </button>
        <button
          type="button"
          onclick={() => { activeSyncProvider = 'arc'; syncMessage = null; }}
          class="flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs font-medium transition cursor-pointer {activeSyncProvider === 'arc' ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-2xs' : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100'}"
        >
          <span>ARC</span>
          {#if arcStatus.connected}
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          {/if}
        </button>
      </div>
    </div>

    <!-- Provider Body -->
    <div class="p-3.5 space-y-3.5">
      <!-- Status Bar -->
      <div class="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-md bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800">
        <div class="flex items-center space-x-2">
          {#if isLoadingSyncStatus}
            <Loader2 class="w-3.5 h-3.5 text-stone-400 animate-spin" />
            <span class="text-stone-500 dark:text-stone-400">Checking connection status...</span>
          {:else if activeSyncProvider === 'google'}
            {#if googleStatus.connected}
              <CheckCircle2 class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span class="font-medium text-emerald-700 dark:text-emerald-300">Connected to Google Calendar</span>
              {#if googleStatus.accountEmail}
                <span class="text-stone-400 dark:text-stone-500 text-[11px]">&bull; {googleStatus.accountEmail}</span>
              {/if}
            {:else}
              <AlertCircle class="w-3.5 h-3.5 text-stone-400" />
              <span class="text-stone-600 dark:text-stone-400">Google Calendar not connected</span>
            {/if}
          {:else}
            {#if arcStatus.connected}
              <CheckCircle2 class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span class="font-medium text-emerald-700 dark:text-emerald-300">Connected to ARC</span>
              {#if arcStatus.accountEmail}
                <span class="text-stone-400 dark:text-stone-500 text-[11px]">&bull; {arcStatus.accountEmail}</span>
              {/if}
            {:else}
              <AlertCircle class="w-3.5 h-3.5 text-stone-400" />
              <span class="text-stone-600 dark:text-stone-400">ARC not configured</span>
            {/if}
          {/if}
        </div>

        <button
          type="button"
          onclick={loadSyncStatus}
          disabled={isLoadingSyncStatus}
          title="Refresh connection status"
          class="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-200/50 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <RefreshCw class="w-3 h-3 {isLoadingSyncStatus ? 'animate-spin' : ''}" />
          <span>Refresh</span>
        </button>
      </div>

      <!-- Sync Message Feedback -->
      {#if syncMessage}
        <div class="p-2.5 rounded text-xs flex items-center space-x-2 {syncMessage.type === 'success' ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'}">
          {#if syncMessage.type === 'success'}
            <CheckCircle2 class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          {:else}
            <AlertCircle class="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" />
          {/if}
          <span>{syncMessage.text}</span>
        </div>
      {/if}

      <!-- GOOGLE CALENDAR FORM -->
      {#if activeSyncProvider === 'google'}
        <div class="space-y-3.5">
          <!-- Cloud Console & Redirect URI Info Card -->
          <div class="hidden p-3 rounded-md bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 space-y-2 text-[11px]">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div class="space-y-0.5">
                <span class="font-medium text-stone-900 dark:text-stone-100 flex items-center space-x-1.5">
                  <Globe class="w-3.5 h-3.5 text-stone-500 shrink-0" />
                  <span>Google Cloud Console</span>
                </span>
                <p class="text-[10px] text-stone-400 dark:text-stone-500">
                  Create OAuth 2.0 Client credentials (Desktop or Web) with Google Calendar API enabled.
                </p>
              </div>
              <a
                href="https://console.cloud.google.com"
                target="_blank"
                rel="noopener noreferrer"
                onclick={(e) => {
                  if (isTauri) {
                    e.preventDefault();
                    openExternalUrl('https://console.cloud.google.com');
                  }
                }}
                class="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:text-stone-900 dark:hover:text-stone-100 shadow-2xs transition cursor-pointer self-start sm:self-auto shrink-0 font-medium"
              >
                <span>Open Google Cloud Console</span>
                <ExternalLink class="w-3 h-3 text-stone-400 shrink-0" />
              </a>
            </div>

            <div class="pt-1.5 border-t border-stone-200/60 dark:border-stone-800 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-[10px]">
              <div class="flex items-center space-x-1.5 truncate">
                <span class="text-stone-500">Authorized Redirect URI:</span>
                <code class="font-mono text-stone-800 dark:text-stone-200 select-all truncate">{GOOGLE_REDIRECT_URI}</code>
              </div>
              <button
                type="button"
                onclick={() => copyToClipboard(GOOGLE_REDIRECT_URI, 'redirect')}
                class="inline-flex items-center space-x-1 text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer shrink-0 self-start sm:self-auto"
              >
                {#if copiedRedirectUri}
                  <Check class="w-2.5 h-2.5 text-emerald-500" />
                  <span class="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
                {:else}
                  <Copy class="w-2.5 h-2.5" />
                  <span>Copy URI</span>
                {/if}
              </button>
            </div>
          </div>

          <!-- Client ID + Client Secret Inputs -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="space-y-1">
              <label for="google-client-id" class="block text-[11px] font-medium text-stone-700 dark:text-stone-300">
                Google Client ID <span class="text-amber-600 dark:text-amber-400">*</span>
              </label>
              <input
                id="google-client-id"
                type="text"
                bind:value={googleClientId}
                placeholder="xxxx.apps.googleusercontent.com"
                class="w-full px-2.5 py-1.5 rounded border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
              />
            </div>

            <div class="space-y-1">
              <label for="google-client-secret" class="block text-[11px] font-medium text-stone-700 dark:text-stone-300">
                Google Client Secret <span class="text-stone-400 font-normal">(optional for Desktop PKCE)</span>
              </label>
              <div class="relative">
                <input
                  id="google-client-secret"
                  type={showGoogleSecret ? 'text' : 'password'}
                  bind:value={googleClientSecret}
                  placeholder="GOCSPX-..."
                  class="w-full px-2.5 py-1.5 pr-8 rounded border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
                />
                <button
                  type="button"
                  onclick={() => (showGoogleSecret = !showGoogleSecret)}
                  class="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 cursor-pointer"
                >
                  {#if showGoogleSecret}<EyeOff class="w-3.5 h-3.5" />{:else}<Eye class="w-3.5 h-3.5" />{/if}
                </button>
              </div>
            </div>
          </div>

          <!-- OAuth Primary Action Button: Sign In with Google -->
          <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div class="flex items-center space-x-2">
              {#if isAuthorizingGoogle}
                <div class="flex items-center space-x-2 px-3 py-1.5 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-xs">
                  <Loader2 class="w-3.5 h-3.5 animate-spin" />
                  <span>Waiting for Google login in browser...</span>
                  <button
                    type="button"
                    onclick={stopGooglePolling}
                    class="ml-2 underline text-[11px] text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              {:else}
                <button
                  type="button"
                  onclick={startGoogleOAuth}
                  disabled={isAuthorizingGoogle || isSavingSync}
                  class="px-3.5 py-1.5 bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 text-white dark:text-stone-900 rounded text-xs font-medium transition cursor-pointer flex items-center space-x-2 disabled:opacity-50 shadow-2xs"
                >
                  <Shield class="w-3.5 h-3.5" />
                  <span>{googleStatus.connected ? 'Re-authorize with Google' : 'Sign in with Google'}</span>
                </button>
              {/if}
            </div>

            {#if googleStatus.connected || googleStatus.hasCredentials}
              <button
                type="button"
                onclick={() => disconnectProvider('google')}
                disabled={isSavingSync || isAuthorizingGoogle}
                class="px-2.5 py-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded text-xs font-medium transition cursor-pointer flex items-center space-x-1"
              >
                <LogOut class="w-3 h-3" />
                <span>Disconnect</span>
              </button>
            {/if}
          </div>

          <!-- Explanatory OAuth Note -->
          <p class="text-[10px] text-stone-400 dark:text-stone-500 pt-1">
            CourseDeck uses OAuth 2.0 PKCE with offline access. Clicking "Sign in with Google" opens the Google authorization prompt, and CourseDeck automatically captures and securely stores the long-lasting refresh token. You do not need to provide or manage tokens manually.
          </p>
        </div>
      {/if}

      <!-- ARC FORM -->
      {#if activeSyncProvider === 'arc'}
        <div class="space-y-3">
          <p class="text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
            Provide your ARC (Academic Resource Coordinator) API credentials. CourseDeck pushes Ontario-aligned schedule blocks directly into your active ARC workspace.
          </p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="space-y-1">
              <label for="arc-api-key" class="block text-[11px] font-medium text-stone-700 dark:text-stone-300">
                ARC API Key
              </label>
              <div class="relative">
                <input
                  id="arc-api-key"
                  type={showArcKey ? 'text' : 'password'}
                  bind:value={arcApiKey}
                  placeholder="arc_live_xxxxxxxxxxxxxxxx"
                  class="w-full px-2.5 py-1.5 pr-8 rounded border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
                />
                <button
                  type="button"
                  onclick={() => (showArcKey = !showArcKey)}
                  class="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 cursor-pointer"
                >
                  {#if showArcKey}<EyeOff class="w-3.5 h-3.5" />{:else}<Eye class="w-3.5 h-3.5" />{/if}
                </button>
              </div>
            </div>

            <div class="space-y-1">
              <label for="arc-endpoint" class="block text-[11px] font-medium text-stone-700 dark:text-stone-300">
                ARC Endpoint URL <span class="text-stone-400 font-normal">(optional)</span>
              </label>
              <input
                id="arc-endpoint"
                type="text"
                bind:value={arcEndpoint}
                placeholder="https://arc.internal/api/v1"
                class="w-full px-2.5 py-1.5 rounded border border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-950 text-xs text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-900 dark:focus:ring-stone-100"
              />
            </div>
          </div>

          <div class="flex items-center justify-between pt-1">
            <button
              type="button"
              onclick={saveArcCredentials}
              disabled={isSavingSync}
              class="px-3 py-1.5 bg-stone-900 dark:bg-stone-100 hover:bg-stone-800 dark:hover:bg-stone-200 text-white dark:text-stone-900 rounded text-xs font-medium transition cursor-pointer flex items-center space-x-1.5 disabled:opacity-50"
            >
              {#if isSavingSync}
                <Loader2 class="w-3 h-3 animate-spin" />
                <span>Saving...</span>
              {:else}
                <Save class="w-3 h-3" />
                <span>Save ARC Key</span>
              {/if}
            </button>

            {#if arcStatus.connected || arcStatus.hasCredentials}
              <button
                type="button"
                onclick={() => disconnectProvider('arc')}
                disabled={isSavingSync}
                class="px-2.5 py-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded text-xs font-medium transition cursor-pointer flex items-center space-x-1"
              >
                <LogOut class="w-3 h-3" />
                <span>Disconnect</span>
              </button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════════════ -->
  <!-- CARD 2: Model Context Protocol (MCP) Server                               -->
  <!-- ═══════════════════════════════════════════════════════════════════════════ -->
  <section class="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-2xs divide-y divide-stone-100 dark:divide-stone-800 text-xs">
    <!-- Header with Enable/Disable Switch -->
    <div class="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div class="flex items-start sm:items-center space-x-2">
        <Server class="w-3.5 h-3.5 text-stone-600 dark:text-stone-400 shrink-0 mt-0.5 sm:mt-0" />
        <div>
          <div class="flex items-center space-x-2">
            <span class="font-medium text-stone-900 dark:text-stone-100">Model Context Protocol (MCP)</span>
            {#if mcpEnabled}
              <span class="inline-flex items-center space-x-1 px-1.5 py-0.2 rounded-full text-[10px] font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                <span>Active</span>
              </span>
            {:else}
              <span class="inline-flex items-center space-x-1 px-1.5 py-0.2 rounded-full text-[10px] font-medium bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 border border-stone-200 dark:border-stone-700">
                <span>Disabled</span>
              </span>
            {/if}
          </div>
          <p class="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5">
            Allow AI coding assistants and LLMs to query courses, search notes, and deterministically generate schedules.
          </p>
        </div>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={mcpEnabled}
        aria-label="Toggle MCP Server"
        disabled={isSavingMcp}
        onclick={toggleMcp}
        class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden {mcpEnabled ? 'bg-stone-900 dark:bg-stone-100' : 'bg-stone-200 dark:bg-stone-700'} disabled:opacity-50 self-start sm:self-auto"
      >
        <span
          class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white dark:bg-stone-900 shadow-md ring-0 transition duration-200 ease-in-out {mcpEnabled ? 'translate-x-4' : 'translate-x-0'}"
        ></span>
      </button>
    </div>

    <!-- MCP Feedback -->
    {#if mcpMessage}
      <div class="p-2.5 mx-3.5 my-2 rounded text-xs flex items-center space-x-2 {mcpMessage.type === 'success' ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'}">
        {#if mcpMessage.type === 'success'}
          <CheckCircle2 class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        {:else}
          <AlertCircle class="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" />
        {/if}
        <span>{mcpMessage.text}</span>
      </div>
    {/if}

    <!-- Transports & Connection Endpoints -->
    <div class="p-3.5 space-y-3">
      <!-- Persistent Secret Token Card -->
      <div class="p-2.5 rounded-md bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-stone-700 dark:text-stone-300 flex items-center space-x-1.5">
            <Key class="w-3 h-3 text-stone-500" />
            <span>MCP Secret Token</span>
          </span>
          <div class="flex items-center space-x-2">
            <button
              type="button"
              onclick={() => (showMcpToken = !showMcpToken)}
              class="flex items-center space-x-1 text-[11px] text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer"
            >
              {#if showMcpToken}
                <EyeOff class="w-3 h-3" />
                <span>Hide</span>
              {:else}
                <Eye class="w-3 h-3" />
                <span>Show</span>
              {/if}
            </button>
            <button
              type="button"
              onclick={() => copyToClipboard(mcpToken, 'token')}
              class="flex items-center space-x-1 text-[11px] text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer"
            >
              {#if copiedToken}
                <Check class="w-3 h-3 text-emerald-500" />
                <span class="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
              {:else}
                <Copy class="w-3 h-3" />
                <span>Copy Token</span>
              {/if}
            </button>
            <button
              type="button"
              disabled={isRotatingToken}
              onclick={regenerateMcpToken}
              title="Generate a new persistent secret token"
              class="flex items-center space-x-1 text-[11px] text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw class="w-3 h-3 {isRotatingToken ? 'animate-spin' : ''}" />
              <span>Regenerate</span>
            </button>
          </div>
        </div>

        <div class="font-mono text-[11px] text-stone-800 dark:text-stone-200 select-all p-1.5 bg-white dark:bg-stone-900 rounded border border-stone-200 dark:border-stone-800 break-all">
          {#if showMcpToken}
            {mcpToken || '(Loading token...)'}
          {:else}
            {mcpToken ? '•'.repeat(Math.min(mcpToken.length, 36)) : '(Loading token...)'}
          {/if}
        </div>

        <p class="text-[10px] text-stone-400 dark:text-stone-500">
          Unrestricted local loopback access is permitted. External clients, proxies, or remote tunnels authenticate using <code class="text-stone-600 dark:text-stone-400">Authorization: Bearer &lt;token&gt;</code>.
        </p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <!-- Streamable HTTP Endpoint -->
        <div class="p-2.5 rounded-md bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-medium text-stone-700 dark:text-stone-300 flex items-center space-x-1.5">
              <Globe class="w-3 h-3 text-stone-500" />
              <span>Streamable HTTP Endpoint</span>
            </span>
            <button
              type="button"
              onclick={() => copyToClipboard(mcpUrl, 'url')}
              class="flex items-center space-x-1 text-[11px] text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer"
            >
              {#if copiedUrl}
                <Check class="w-3 h-3 text-emerald-500" />
                <span class="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
              {:else}
                <Copy class="w-3 h-3" />
                <span>Copy</span>
              {/if}
            </button>
          </div>
          <code class="block font-mono text-[11px] text-stone-800 dark:text-stone-200 break-all select-all">
            {mcpUrl}
          </code>
          <p class="text-[10px] text-stone-400 dark:text-stone-500">
            Used by Cursor, Windsurf, and HTTP/SSE clients.
          </p>
        </div>

        <!-- Stdio Command -->
        <div class="p-2.5 rounded-md bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-medium text-stone-700 dark:text-stone-300 flex items-center space-x-1.5">
              <Terminal class="w-3 h-3 text-stone-500" />
              <span>Stdio CLI Command</span>
            </span>
            <button
              type="button"
              onclick={() => copyToClipboard(stdioCliCommand, 'stdio')}
              class="flex items-center space-x-1 text-[11px] text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer"
            >
              {#if copiedStdio}
                <Check class="w-3 h-3 text-emerald-500" />
                <span class="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
              {:else}
                <Copy class="w-3 h-3" />
                <span>Copy</span>
              {/if}
            </button>
          </div>
          <code class="block font-mono text-[11px] text-stone-800 dark:text-stone-200 break-all select-all">
            {stdioCliCommand}
          </code>
          <p class="text-[10px] text-stone-400 dark:text-stone-500">
            Used by Claude Desktop and Antigravity process runners.
          </p>
        </div>
      </div>

      <!-- Client Configuration Snippets -->
      <div class="space-y-2 pt-2">
        <div class="flex items-center justify-between gap-2 border-b border-stone-100 dark:border-stone-800 pb-2">
          <label for="mcp-client-dropdown" class="font-medium text-stone-900 dark:text-stone-100 text-xs">
            MCP Connection
          </label>
          <select
            id="mcp-client-dropdown"
            bind:value={selectedMcpClient}
            class="px-2.5 py-1 rounded-md border border-stone-200 dark:border-stone-700 text-xs text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-800 hover:border-stone-300 dark:hover:border-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-500 cursor-pointer"
          >
            <option value="select">Select</option>
            <option value="claude">Claude Desktop</option>
            <option value="antigravity">Antigravity</option>
            <option value="cursor">Cursor</option>
            <option value="windsurf">Windsurf</option>
          </select>
        </div>

        <!-- Configuration Details when an AI client is selected -->
        {#if selectedMcpClient === 'claude'}
          <div class="space-y-1.5 pt-1">
            <div class="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400">
              <span>Config file: <code class="text-stone-800 dark:text-stone-200">~/Library/Application Support/Claude/claude_desktop_config.json</code></span>
              <button
                type="button"
                onclick={() => copyToClipboard(claudeConfigSnippet, 'claude')}
                class="flex items-center space-x-1 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
              >
                {#if copiedSnippet === 'claude'}
                  <Check class="w-3 h-3 text-emerald-500" />
                  <span class="text-emerald-600 dark:text-emerald-400">Copied</span>
                {:else}
                  <Copy class="w-3 h-3" />
                  <span>Copy JSON</span>
                {/if}
              </button>
            </div>
            <pre class="p-3 rounded-md bg-stone-950 text-stone-200 font-mono text-[11px] overflow-x-auto leading-relaxed border border-stone-800 select-all cursor-text">{claudeConfigSnippet}</pre>
          </div>
        {:else if selectedMcpClient === 'antigravity'}
          <div class="space-y-1.5 pt-1">
            <div class="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400">
              <span>Config file: <code class="text-stone-800 dark:text-stone-200">~/.gemini/antigravity/mcp/coursedeck/</code> or settings JSON</span>
              <button
                type="button"
                onclick={() => copyToClipboard(antigravityConfigSnippet, 'antigravity')}
                class="flex items-center space-x-1 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
              >
                {#if copiedSnippet === 'antigravity'}
                  <Check class="w-3 h-3 text-emerald-500" />
                  <span class="text-emerald-600 dark:text-emerald-400">Copied</span>
                {:else}
                  <Copy class="w-3 h-3" />
                  <span>Copy JSON</span>
                {/if}
              </button>
            </div>
            <pre class="p-3 rounded-md bg-stone-950 text-stone-200 font-mono text-[11px] overflow-x-auto leading-relaxed border border-stone-800 select-all cursor-text">{antigravityConfigSnippet}</pre>
          </div>
        {:else if selectedMcpClient === 'cursor'}
          <div class="space-y-1.5 pt-1">
            <div class="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400">
              <span>Config file: <code class="text-stone-800 dark:text-stone-200">.cursor/mcp.json</code> (or Cursor Settings &rarr; Features &rarr; MCP)</span>
              <button
                type="button"
                onclick={() => copyToClipboard(cursorConfigSnippet, 'cursor')}
                class="flex items-center space-x-1 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
              >
                {#if copiedSnippet === 'cursor'}
                  <Check class="w-3 h-3 text-emerald-500" />
                  <span class="text-emerald-600 dark:text-emerald-400">Copied</span>
                {:else}
                  <Copy class="w-3 h-3" />
                  <span>Copy JSON</span>
                {/if}
              </button>
            </div>
            <pre class="p-3 rounded-md bg-stone-950 text-stone-200 font-mono text-[11px] overflow-x-auto leading-relaxed border border-stone-800 select-all cursor-text">{cursorConfigSnippet}</pre>
          </div>
        {:else if selectedMcpClient === 'windsurf'}
          <div class="space-y-1.5 pt-1">
            <div class="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400">
              <span>Config file: <code class="text-stone-800 dark:text-stone-200">~/.codeium/windsurf/mcp_config.json</code></span>
              <button
                type="button"
                onclick={() => copyToClipboard(windsurfConfigSnippet, 'windsurf')}
                class="flex items-center space-x-1 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
              >
                {#if copiedSnippet === 'windsurf'}
                  <Check class="w-3 h-3 text-emerald-500" />
                  <span class="text-emerald-600 dark:text-emerald-400">Copied</span>
                {:else}
                  <Copy class="w-3 h-3" />
                  <span>Copy JSON</span>
                {/if}
              </button>
            </div>
            <pre class="p-3 rounded-md bg-stone-950 text-stone-200 font-mono text-[11px] overflow-x-auto leading-relaxed border border-stone-800 select-all cursor-text">{windsurfConfigSnippet}</pre>
          </div>
        {/if}
      </div>

      <!-- Collapsible Tools Catalog -->
      <div class="pt-2 border-t border-stone-100 dark:border-stone-800">
        <button
          type="button"
          onclick={() => (showToolsList = !showToolsList)}
          class="flex items-center justify-between w-full py-1 text-[11px] font-medium text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer"
        >
          <span class="flex items-center space-x-1.5">
            <Layers class="w-3 h-3 text-stone-500" />
            <span>Exposed MCP Tools ({MCP_TOOLS.length})</span>
          </span>
          {#if showToolsList}
            <ChevronUp class="w-3.5 h-3.5" />
          {:else}
            <ChevronDown class="w-3.5 h-3.5" />
          {/if}
        </button>

        {#if showToolsList}
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
            {#each MCP_TOOLS as tool}
              <div class="p-2 rounded bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 space-y-0.5">
                <div class="flex items-center justify-between">
                  <code class="font-mono text-[11px] font-semibold text-stone-800 dark:text-stone-200">{tool.name}</code>
                  <span class="text-[9px] uppercase tracking-wider px-1 py-0.2 rounded font-medium {tool.type === 'read' ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300' : tool.type === 'write' ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300' : tool.type === 'schedule' ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300' : 'bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300'}">
                    {tool.type}
                  </span>
                </div>
                <p class="text-[10px] text-stone-500 dark:text-stone-400 leading-tight">
                  {tool.desc}
                </p>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </section>
</main>
