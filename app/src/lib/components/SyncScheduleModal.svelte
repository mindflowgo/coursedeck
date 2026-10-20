<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    Calendar,
    X,
    RefreshCw,
    CheckCircle2,
    AlertCircle,
    Loader2,
    Settings,
    Check,
    Shield,
    ExternalLink,
    Copy,
    Globe,
    CalendarDays,
    ChevronDown,
    ChevronUp
  } from 'lucide-svelte';
  import { apiFetch, isTauriEnvironment } from '$lib/api';
  import { ScheduleParser, type ScheduleEvent } from '$lib/parser/scheduleParser';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
    courseId: string;
    courseTitle?: string;
  }

  let { isOpen, onClose, courseId, courseTitle = '' }: Props = $props();

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

  let selectedProvider = $state<'google' | 'arc'>('google');
  let isCheckingStatus = $state(false);
  let isSyncing = $state(false);

  let isConnected = $state(false);
  let accountEmail = $state<string | undefined>();
  let calendars = $state<Array<{ id: string; name: string; primary: boolean }>>([]);
  let selectedCalendarId = $state('primary');

  // Course schedule events to push
  let scheduleEvents = $state<ScheduleEvent[]>([]);
  let isLoadingSchedule = $state(false);
  let showDatesList = $state(false);

  interface DayGroup {
    date: string;
    label: string;
    events: ScheduleEvent[];
  }

  const dayGroups = $derived.by<DayGroup[]>(() => {
    const groups: DayGroup[] = [];
    for (const e of scheduleEvents) {
      if (!e.date) continue;
      let group = groups.find((g) => g.date === e.date);
      if (!group) {
        let label = e.dayLabel || '';
        try {
          const d = new Date(`${e.date}T00:00:00`);
          label = d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        } catch {
          label = e.date;
        }
        group = { date: e.date, label, events: [] };
        groups.push(group);
      }
      group.events.push(e);
    }
    return groups.sort((a, b) => a.date.localeCompare(b.date));
  });

  function scheduleTypeBadge(type: string): string {
    const t = (type || '').toLowerCase();
    if (t.includes('review')) return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-200 dark:border-amber-800';
    if (t.includes('assign') || t.includes('submit')) return 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 border border-purple-200 dark:border-purple-800';
    if (t.includes('catchup')) return 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 border border-sky-200 dark:border-sky-800';
    return 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300 border border-stone-200 dark:border-stone-700';
  }

  // Credentials input for OAuth setup
  let showCredsForm = $state(false);
  let clientIdInput = $state('');
  let clientSecretInput = $state('');
  let isAuthorizingGoogle = $state(false);
  let copiedRedirect = $state(false);
  const GOOGLE_REDIRECT_URI = 'http://127.0.0.1:3182/api/sync/oauth/google/callback';
  let googlePollInterval: ReturnType<typeof setInterval> | null = null;

  // Timeflow / ARC state
  let arcEndpoint = $state('http://127.0.0.1:3001/v1/groups');
  let arcApiKey = $state('');
  let arcHasCredentials = $state(false);
  let arcStatusMessage = $state('');
  let isSavingArcCreds = $state(false);
  let showArcCredsForm = $state(false);

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

  async function copyRedirectUri() {
    try {
      await navigator.clipboard.writeText(GOOGLE_REDIRECT_URI);
      copiedRedirect = true;
      setTimeout(() => (copiedRedirect = false), 2000);
    } catch (e) {
      console.warn('Failed to copy redirect URI:', e);
    }
  }

  let syncResult = $state<{
    success: boolean;
    message: string;
    stats?: {
      created: number;
      updated: number;
      unchanged: number;
      deletedObsolete: number;
      failed: number;
    };
    errors?: Array<{ eventId: string; error: string }>;
  } | null>(null);

  let errorMsg = $state<string | null>(null);

  $effect(() => {
    if (isOpen) {
      syncResult = null;
      errorMsg = null;
      showDatesList = false;
      fetchStatusAndCalendars();
      loadCourseSchedule();
    }
  });

  async function loadCourseSchedule() {
    if (!courseId) return;
    isLoadingSchedule = true;
    try {
      const res = await apiFetch(`/api/courses/${encodeURIComponent(courseId)}/course-docs?type=schedule`);
      if (res.ok) {
        const data = await res.json();
        if (data.markdown) {
          const parsed = ScheduleParser.parseMarkdown(data.markdown);
          scheduleEvents = parsed.events.filter((e) => Boolean(e.date));
        } else {
          scheduleEvents = [];
        }
      } else {
        scheduleEvents = [];
      }
    } catch (e) {
      console.warn('Failed to load course schedule events:', e);
      scheduleEvents = [];
    } finally {
      isLoadingSchedule = false;
    }
  }

  async function fetchStatusAndCalendars() {
    isCheckingStatus = true;
    errorMsg = null;
    try {
      const res = await apiFetch(`/api/sync/status?courseId=${encodeURIComponent(courseId)}`);
      if (res.ok) {
        const data = await res.json();
        const googleStatus = data.providers?.google;
        isConnected = Boolean(googleStatus?.connected);
        accountEmail = googleStatus?.accountEmail;
        if (googleStatus?.clientId && !clientIdInput) {
          clientIdInput = googleStatus.clientId;
        }

        const arcStatus = data.providers?.arc;
        arcHasCredentials = Boolean(arcStatus?.hasCredentials);
        if (arcStatus?.endpoint) {
          arcEndpoint = arcStatus.endpoint;
        }
        arcStatusMessage = arcStatus?.accountEmail || '';

        if (isConnected) {
          const calRes = await apiFetch('/api/sync/calendars?provider=google');
          if (calRes.ok) {
            const calData = await calRes.json();
            calendars = calData.calendars || [];
            if (calendars.length > 0 && !calendars.some((c) => c.id === selectedCalendarId)) {
              selectedCalendarId = calendars.find((c) => c.primary)?.id || calendars[0].id;
            }
          }
        }
      }
    } catch (e: any) {
      console.warn('Failed to check sync status:', e);
    } finally {
      isCheckingStatus = false;
    }
  }

  async function saveArcCredentials() {
    if (!arcApiKey.trim()) {
      errorMsg = 'Timeflow API Key is required.';
      return;
    }
    isSavingArcCreds = true;
    errorMsg = null;
    try {
      const res = await apiFetch('/api/sync/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'arc',
          endpoint: arcEndpoint.trim() || 'http://127.0.0.1:3001/v1/groups',
          apiKey: arcApiKey.trim()
        })
      });
      if (res.ok) {
        showArcCredsForm = false;
        arcHasCredentials = true;
        await fetchStatusAndCalendars();
      } else {
        const d = await res.json().catch(() => ({}));
        errorMsg = d.message || 'Failed to save Timeflow credentials.';
      }
    } catch (err: any) {
      errorMsg = err.message || 'Failed to save Timeflow credentials.';
    } finally {
      isSavingArcCreds = false;
    }
  }

  async function startGoogleOAuth() {
    if (!clientIdInput.trim()) {
      errorMsg = 'Google Client ID is required to start authorization.';
      return;
    }

    isAuthorizingGoogle = true;
    errorMsg = null;

    try {
      const res = await apiFetch('/api/sync/oauth/google/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: clientIdInput.trim(),
          clientSecret: clientSecretInput.trim() || undefined,
          redirectUri: GOOGLE_REDIRECT_URI
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to initialize Google authorization.');
      }

      const data = await res.json();
      const authUrl = data.authUrl;

      if (typeof window !== 'undefined') {
        if (isTauri) {
          await openExternalUrl(authUrl);
        } else {
          window.open(authUrl, 'google_oauth_popup', 'width=600,height=720,status=no,toolbar=no,menubar=no');
        }
      }

      const handleMessage = (e: MessageEvent) => {
        if (e.data?.type === 'GOOGLE_AUTH_SUCCESS') {
          stopGooglePolling();
          showCredsForm = false;
          fetchStatusAndCalendars();
          window.removeEventListener('message', handleMessage);
        }
      };
      window.addEventListener('message', handleMessage);

      if (googlePollInterval) clearInterval(googlePollInterval);
      const pollStartTime = Date.now();
      googlePollInterval = setInterval(async () => {
        if (Date.now() - pollStartTime > 120_000) {
          stopGooglePolling();
          window.removeEventListener('message', handleMessage);
          errorMsg = 'Google authorization timed out. Please try again.';
          return;
        }

        try {
          const statusRes = await apiFetch(`/api/sync/status?courseId=${encodeURIComponent(courseId)}`);
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.providers?.google?.connected) {
              stopGooglePolling();
              window.removeEventListener('message', handleMessage);
              showCredsForm = false;
              fetchStatusAndCalendars();
            }
          }
        } catch {
          // ignore transient poll error
        }
      }, 1500);

    } catch (err: any) {
      stopGooglePolling();
      errorMsg = err.message || 'Failed to start authorization.';
    }
  }

  async function handleSync() {
    isSyncing = true;
    errorMsg = null;
    syncResult = null;

    try {
      const res = await apiFetch('/api/sync/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          courseId,
          calendarId: selectedProvider === 'arc' ? 'arc_default' : (selectedCalendarId || 'primary')
        })
      });

      const data = await res.json();
      if (res.ok) {
        syncResult = data;
      } else {
        errorMsg = data.message || 'Synchronization failed.';
      }
    } catch (e: any) {
      errorMsg = e.message || 'Network error during synchronization.';
    } finally {
      isSyncing = false;
    }
  }
</script>

{#if isOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 dark:bg-black/60 backdrop-blur-xs">
    <div class="w-full max-w-lg rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] flex flex-col">
      
      <!-- Header -->
      <div class="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-stone-800 shrink-0">
        <div class="flex items-center space-x-2.5">
          <div class="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Calendar class="w-5 h-5" />
          </div>
          <div>
            <h2 class="text-sm font-semibold text-stone-900 dark:text-stone-100">Synchronize Study Schedule</h2>
            <p class="text-[11px] font-mono uppercase tracking-wide text-stone-500 dark:text-stone-400">
              {courseId} {courseTitle ? `· ${courseTitle}` : ''}
            </p>
          </div>
        </div>
        <button
          onclick={onClose}
          class="p-1 rounded-lg text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Scrollable Modal Body -->
      <div class="overflow-y-auto space-y-4 flex-1 pr-1">
        <!-- Service Selection Tabs -->
        <div class="grid grid-cols-2 gap-2 p-1 rounded-xl bg-stone-100 dark:bg-stone-800/60 text-xs font-medium">
        <button
          type="button"
          onclick={() => { selectedProvider = 'google'; errorMsg = null; }}
          class="py-2 px-3 rounded-lg transition flex items-center justify-center space-x-2 cursor-pointer {selectedProvider === 'google'
            ? 'bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold'
            : 'text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200'}"
        >
          <span>Google Calendar</span>
          {#if isConnected && selectedProvider === 'google'}
            <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
          {/if}
        </button>
        <button
          type="button"
          onclick={() => { selectedProvider = 'arc'; errorMsg = null; }}
          class="py-2 px-3 rounded-lg transition flex items-center justify-center space-x-2 cursor-pointer {selectedProvider === 'arc'
            ? 'bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 shadow-2xs font-semibold'
            : 'text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200'}"
        >
          <span>Timeflow</span>
          {#if arcHasCredentials}
            <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
          {:else}
            <span class="text-[9px] px-1.5 py-0.2 rounded-full bg-stone-200 dark:bg-stone-700 text-stone-600 dark:text-stone-300">Setup</span>
          {/if}
        </button>
      </div>

      {#if errorMsg}
        <div class="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-300 flex items-start space-x-2">
          <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      {/if}

      <!-- Google Calendar View -->
      {#if selectedProvider === 'google'}
        {#if isCheckingStatus}
          <div class="py-8 flex flex-col items-center justify-center space-y-2 text-stone-500 dark:text-stone-400 text-xs">
            <Loader2 class="w-5 h-5 animate-spin text-amber-500" />
            <span>Checking Google Calendar connection...</span>
          </div>
        {:else if !isConnected && !showCredsForm}
          <div class="p-4 rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-800/30 space-y-3">
            <div class="flex items-start space-x-3">
              <Shield class="w-5 h-5 text-stone-400 mt-0.5" />
              <div class="space-y-1">
                <h4 class="text-xs font-semibold text-stone-800 dark:text-stone-200">Connect Google Calendar</h4>
                <p class="text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
                  Synchronize lessons, study blocks, and checkpoints directly to your Google Calendar with 4-worker idempotent reconciliation.
                </p>
              </div>
            </div>
            <div class="pt-2 flex justify-end">
              <button
                type="button"
                onclick={() => { showCredsForm = true; }}
                class="px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-2xs cursor-pointer"
              >
                Configure Connection
              </button>
            </div>
          </div>
        {:else if !isConnected && showCredsForm}
          <div class="space-y-3.5 p-4 rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-800/30">
            <div class="flex items-center justify-between">
              <h4 class="text-xs font-semibold text-stone-800 dark:text-stone-200">OAuth Credentials Setup</h4>
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
                class="inline-flex items-center space-x-1 text-[11px] font-medium text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition cursor-pointer"
              >
                <span>Google Cloud Console</span>
                <ExternalLink class="w-3 h-3 ml-0.5 inline" />
              </a>
            </div>

            <!-- Redirect URI Info Banner -->
            <div class="p-2.5 rounded-lg bg-stone-100/70 dark:bg-stone-900/60 border border-stone-200 dark:border-stone-800 flex items-center justify-between text-[11px]">
              <div class="truncate mr-2">
                <span class="text-stone-500">Redirect URI:</span>
                <code class="font-mono text-stone-800 dark:text-stone-200 ml-1 select-all">{GOOGLE_REDIRECT_URI}</code>
              </div>
              <button
                type="button"
                onclick={copyRedirectUri}
                class="inline-flex items-center space-x-1 text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition shrink-0 cursor-pointer text-xs"
              >
                {#if copiedRedirect}
                  <Check class="w-3 h-3 text-emerald-500" />
                  <span class="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
                {:else}
                  <Copy class="w-3 h-3" />
                  <span>Copy</span>
                {/if}
              </button>
            </div>

            <p class="text-[11px] text-stone-500 dark:text-stone-400">
              Create OAuth 2.0 Client credentials (Desktop or Web) in Google Cloud Console with Google Calendar API enabled. Enter your Client ID below to sign in directly through your browser.
            </p>

            <div class="space-y-2.5 text-xs">
              <div>
                <label for="google-client-id" class="block text-[11px] font-medium text-stone-600 dark:text-stone-400 mb-1">
                  Google Client ID <span class="text-amber-600 dark:text-amber-400">*</span>
                </label>
                <input
                  id="google-client-id"
                  type="text"
                  bind:value={clientIdInput}
                  placeholder="xxxx.apps.googleusercontent.com"
                  class="w-full px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 font-mono text-xs focus:ring-1 focus:ring-amber-500 outline-none"
                />
              </div>
              <div>
                <label for="google-client-secret" class="block text-[11px] font-medium text-stone-600 dark:text-stone-400 mb-1">
                  Client Secret <span class="text-stone-400 font-normal">(optional for Desktop PKCE)</span>
                </label>
                <input
                  id="google-client-secret"
                  type="password"
                  bind:value={clientSecretInput}
                  placeholder="GOCSPX-..."
                  class="w-full px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 font-mono text-xs focus:ring-1 focus:ring-amber-500 outline-none"
                />
              </div>
            </div>

            <!-- Primary Action: Sign in with Google -->
            <div class="pt-2 flex items-center justify-between gap-2">
              <div>
                {#if isAuthorizingGoogle}
                  <div class="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-xs">
                    <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    <span>Waiting for browser sign-in...</span>
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
                    disabled={isAuthorizingGoogle}
                    class="flex items-center space-x-2 px-3.5 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-2xs cursor-pointer disabled:opacity-50"
                  >
                    <Shield class="w-3.5 h-3.5" />
                    <span>Sign in with Google</span>
                  </button>
                {/if}
              </div>

              <button
                type="button"
                onclick={() => { showCredsForm = false; stopGooglePolling(); }}
                class="px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 text-xs font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
              >
                Close
              </button>
            </div>

            <!-- Explanatory OAuth Note -->
            <p class="text-[10px] text-stone-400 dark:text-stone-500 pt-1">
              CourseDeck uses OAuth 2.0 PKCE with offline access. When you click "Sign in with Google", your browser approves access and CourseDeck automatically captures and stores the refresh token on your machine. You do not need to provide or manage tokens manually.
            </p>
          </div>
        {:else}
          <!-- Connected State -->
          <div class="space-y-3.5">
            <!-- Subtle Connected Status Bar with Settings Cog -->
            <div class="flex items-center justify-between py-1.5 px-3 rounded-lg bg-stone-50 dark:bg-stone-800/40 border border-stone-200/80 dark:border-stone-800 text-xs">
              <div class="flex items-center space-x-2 min-w-0">
                <span class="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
                <span class="text-[11px] text-stone-600 dark:text-stone-400 truncate">
                  Google Calendar: <strong class="font-medium text-stone-800 dark:text-stone-200">{accountEmail || 'Connected'}</strong>
                </span>
              </div>
              <button
                type="button"
                onclick={() => {
                  onClose();
                  goto('/settings?tab=sync_mcp');
                }}
                class="flex items-center space-x-1 p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700 transition cursor-pointer shrink-0"
                title="Adjust Google Calendar & MCP settings"
              >
                <Settings class="w-3.5 h-3.5" />
              </button>
            </div>

            <!-- Target Calendar Selector -->
            <div>
              <label for="sync-target-calendar" class="block text-xs font-medium text-stone-700 dark:text-stone-300 mb-1">Target Calendar</label>
              <select
                id="sync-target-calendar"
                bind:value={selectedCalendarId}
                class="w-full px-3 py-2 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs text-stone-900 dark:text-stone-100 focus:ring-1 focus:ring-amber-500 outline-none"
              >
                {#if calendars.length === 0}
                  <option value="primary">Primary Calendar</option>
                {:else}
                  {#each calendars as cal}
                    <option value={cal.id}>{cal.name} {cal.primary ? '(Primary)' : ''}</option>
                  {/each}
                {/if}
              </select>
            </div>

            <!-- Collapsible List of Scheduled Course Dates -->
            <div class="space-y-1.5 mt-2 pt-1.5 border-t border-stone-100 dark:border-stone-800">
              <button
                type="button"
                onclick={() => { showDatesList = !showDatesList; }}
                class="flex items-center justify-between w-full py-1 text-xs font-medium text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer select-none text-left"
              >
                <span class="flex items-center space-x-1.5">
                  <CalendarDays class="w-3.5 h-3.5 text-stone-500" />
                  <span>Schedule Sync</span>
                  {#if showDatesList}
                    <ChevronUp class="w-3.5 h-3.5 text-stone-400" />
                  {:else}
                    <ChevronDown class="w-3.5 h-3.5 text-stone-400" />
                  {/if}
                </span>
                {#if scheduleEvents.length > 0}
                  <span class="text-[10px] text-stone-400 dark:text-stone-500 font-normal">
                    {scheduleEvents.length} session{scheduleEvents.length === 1 ? '' : 's'} across {dayGroups.length} date{dayGroups.length === 1 ? '' : 's'}
                  </span>
                {/if}
              </button>

              {#if showDatesList}
                {#if isLoadingSchedule}
                  <div class="py-6 flex items-center justify-center space-x-2 text-stone-400 text-xs rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-900/40">
                    <Loader2 class="w-4 h-4 animate-spin text-amber-500" />
                    <span>Loading schedule dates...</span>
                  </div>
                {:else if dayGroups.length === 0}
                  <div class="py-5 px-3 text-center text-xs text-stone-500 dark:text-stone-400 rounded-xl border border-dashed border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-900/40 space-y-1">
                    <p class="font-medium text-stone-700 dark:text-stone-300">No scheduled dates found</p>
                    <p class="text-[11px] text-stone-400">Please generate a study schedule for this course before syncing.</p>
                  </div>
                {:else}
                  <div class="max-h-52 overflow-y-auto rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/40 dark:bg-stone-900/40 divide-y divide-stone-100 dark:divide-stone-800 text-xs">
                    {#each dayGroups as group}
                      <div class="p-2 space-y-1">
                        <div class="flex items-center justify-between text-[11px]">
                          <span class="font-medium text-stone-800 dark:text-stone-200">
                            {group.label}
                          </span>
                          <span class="font-mono text-[10px] text-stone-400">
                            {group.date}
                          </span>
                        </div>
                        <div class="space-y-1">
                          {#each group.events as evt}
                            <div class="flex items-center justify-between text-[11px] bg-white dark:bg-stone-800/80 px-2 py-1 rounded border border-stone-200/60 dark:border-stone-700/60 gap-2">
                              <div class="flex items-center space-x-1.5 truncate">
                                <span class="px-1 py-0.2 rounded text-[9px] font-semibold uppercase tracking-wider {scheduleTypeBadge(evt.type)}">
                                  {evt.type || 'study'}
                                </span>
                                <span class="truncate text-stone-700 dark:text-stone-300">
                                  {evt.lessonId ? `${evt.lessonId} · ` : ''}{evt.title}
                                </span>
                              </div>
                              {#if evt.durationMin}
                                <span class="text-[10px] text-stone-400 whitespace-nowrap shrink-0">
                                  {evt.durationMin}m
                                </span>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              {/if}
            </div>
          </div>
        {/if}
      {:else}
        <!-- Timeflow View -->
        <div class="space-y-3.5">
          <!-- Connection Status Bar -->
          <div class="flex items-center justify-between py-1.5 px-3 rounded-lg bg-stone-50 dark:bg-stone-800/40 border border-stone-200/80 dark:border-stone-800 text-xs">
            <div class="flex items-center space-x-2 min-w-0">
              <span class="w-2 h-2 rounded-full {arcHasCredentials ? 'bg-emerald-500' : 'bg-amber-500'} shrink-0"></span>
              <span class="text-[11px] text-stone-600 dark:text-stone-400 truncate">
                {arcHasCredentials ? 'Timeflow Server:' : 'Status:'} <strong class="font-medium text-stone-800 dark:text-stone-200">{arcStatusMessage || 'Credentials Required'}</strong>
              </span>
            </div>
            <button
              type="button"
              onclick={() => { showArcCredsForm = !showArcCredsForm; }}
              class="flex items-center space-x-1 p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700 transition cursor-pointer shrink-0"
              title="Configure Timeflow server and API key"
            >
              <Settings class="w-3.5 h-3.5" />
            </button>
          </div>

          <!-- Configuration Form -->
          {#if showArcCredsForm || !arcHasCredentials}
            <div class="space-y-3 p-3.5 rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-800/30 text-xs">
              <div class="flex items-center justify-between">
                <h4 class="text-xs font-semibold text-stone-800 dark:text-stone-200">Timeflow API Configuration</h4>
                {#if arcHasCredentials}
                  <button
                    type="button"
                    onclick={() => { showArcCredsForm = false; }}
                    class="text-[11px] text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 cursor-pointer"
                  >
                    Hide
                  </button>
                {/if}
              </div>
              <p class="text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
                Connect your course schedule to Timeflow. Enter your Timeflow Server Endpoint and API Key (found in Timeflow under <em>Settings → Sync & MCP → API Key</em>).
              </p>
              <div class="space-y-2">
                <div>
                  <label for="arc-endpoint" class="block text-[11px] font-medium text-stone-600 dark:text-stone-400 mb-1">
                    Server Endpoint URL
                  </label>
                  <input
                    id="arc-endpoint"
                    type="text"
                    bind:value={arcEndpoint}
                    placeholder="http://127.0.0.1:3001/v1/groups"
                    class="w-full px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 font-mono text-xs focus:ring-1 focus:ring-sky-500 outline-none"
                  />
                </div>
                <div>
                  <label for="arc-api-key" class="block text-[11px] font-medium text-stone-600 dark:text-stone-400 mb-1">
                    Timeflow API Key <span class="text-sky-600">*</span>
                  </label>
                  <input
                    id="arc-api-key"
                    type="password"
                    bind:value={arcApiKey}
                    placeholder="e1a2b3c.xxxxxxxxxxxxxxxx"
                    class="w-full px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 font-mono text-xs focus:ring-1 focus:ring-sky-500 outline-none"
                  />
                </div>
              </div>
              <div class="flex justify-end pt-1">
                <button
                  type="button"
                  onclick={saveArcCredentials}
                  disabled={isSavingArcCreds}
                  class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition shadow-2xs cursor-pointer disabled:opacity-50"
                >
                  {#if isSavingArcCreds}
                    <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    <span>Saving...</span>
                  {:else}
                    <Check class="w-3.5 h-3.5" />
                    <span>Save Configuration</span>
                  {/if}
                </button>
              </div>
            </div>
          {/if}

          <!-- Collapsible List of Scheduled Course Dates -->
          <div class="space-y-1.5 pt-1.5 border-t border-stone-100 dark:border-stone-800">
            <button
              type="button"
              onclick={() => { showDatesList = !showDatesList; }}
              class="flex items-center justify-between w-full py-1 text-xs font-medium text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition cursor-pointer select-none text-left"
            >
              <span class="flex items-center space-x-1.5">
                <CalendarDays class="w-3.5 h-3.5 text-stone-500" />
                <span>Schedule Preview</span>
                {#if showDatesList}
                  <ChevronUp class="w-3.5 h-3.5 text-stone-400" />
                {:else}
                  <ChevronDown class="w-3.5 h-3.5 text-stone-400" />
                {/if}
              </span>
              {#if scheduleEvents.length > 0}
                <span class="text-[10px] text-stone-400 dark:text-stone-500 font-normal">
                  {scheduleEvents.length} session{scheduleEvents.length === 1 ? '' : 's'} across {dayGroups.length} date{dayGroups.length === 1 ? '' : 's'}
                </span>
              {/if}
            </button>

            {#if showDatesList}
              {#if isLoadingSchedule}
                <div class="py-6 flex items-center justify-center space-x-2 text-stone-400 text-xs rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-900/40">
                  <Loader2 class="w-4 h-4 animate-spin text-sky-500" />
                  <span>Loading schedule dates...</span>
                </div>
              {:else if dayGroups.length === 0}
                <div class="py-5 px-3 text-center text-xs text-stone-500 dark:text-stone-400 rounded-xl border border-dashed border-stone-200 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-900/40 space-y-1">
                  <p class="font-medium text-stone-700 dark:text-stone-300">No scheduled dates found</p>
                  <p class="text-[11px] text-stone-400">Please generate a study schedule for this course before syncing.</p>
                </div>
              {:else}
                <div class="max-h-52 overflow-y-auto rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/40 dark:bg-stone-900/40 divide-y divide-stone-100 dark:divide-stone-800 text-xs">
                  {#each dayGroups as group}
                    <div class="p-2 space-y-1">
                      <div class="flex items-center justify-between text-[11px]">
                        <span class="font-medium text-stone-800 dark:text-stone-200">
                          {group.label}
                        </span>
                        <span class="font-mono text-[10px] text-stone-400">
                          {group.date}
                        </span>
                      </div>
                      <div class="space-y-1">
                        {#each group.events as evt}
                          <div class="flex items-center justify-between text-[11px] bg-white dark:bg-stone-800/80 px-2 py-1 rounded border border-stone-200/60 dark:border-stone-700/60 gap-2">
                            <div class="flex items-center space-x-1.5 truncate">
                              <span class="px-1 py-0.2 rounded text-[9px] font-semibold uppercase tracking-wider {scheduleTypeBadge(evt.type)}">
                                {evt.type || 'study'}
                              </span>
                              <span class="truncate text-stone-700 dark:text-stone-300">
                                {evt.lessonId ? `${evt.lessonId} · ` : ''}{evt.title}
                              </span>
                            </div>
                            {#if evt.durationMin}
                              <span class="text-[10px] text-stone-400 whitespace-nowrap shrink-0">
                                {evt.durationMin}m
                              </span>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        </div>
      {/if}

      <!-- Results Card -->
      {#if syncResult}
        <div class="p-4 rounded-xl bg-stone-50 dark:bg-stone-800/50 border border-stone-200 dark:border-stone-700 space-y-2">
          <div class="flex items-center space-x-2 text-xs font-semibold {syncResult.success ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}">
            {#if syncResult.success}
              <CheckCircle2 class="w-4 h-4 text-emerald-500" />
              <span>Synchronization Complete</span>
            {:else}
              <AlertCircle class="w-4 h-4 text-amber-500" />
              <span>Completed with Warnings</span>
            {/if}
          </div>
          {#if syncResult.stats}
            <div class="grid {syncResult.stats.failed > 0 ? 'grid-cols-5' : 'grid-cols-4'} gap-2 pt-1 text-center">
              <div class="p-2 rounded-lg bg-white dark:bg-stone-800 border border-stone-200/60 dark:border-stone-700/60">
                <div class="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{syncResult.stats.created}</div>
                <div class="text-[10px] text-stone-500">Created</div>
              </div>
              <div class="p-2 rounded-lg bg-white dark:bg-stone-800 border border-stone-200/60 dark:border-stone-700/60">
                <div class="text-sm font-semibold text-sky-600 dark:text-sky-400">{syncResult.stats.updated}</div>
                <div class="text-[10px] text-stone-500">Updated</div>
              </div>
              <div class="p-2 rounded-lg bg-white dark:bg-stone-800 border border-stone-200/60 dark:border-stone-700/60">
                <div class="text-sm font-semibold text-stone-600 dark:text-stone-300">{syncResult.stats.unchanged}</div>
                <div class="text-[10px] text-stone-500">Unchanged</div>
              </div>
              <div class="p-2 rounded-lg bg-white dark:bg-stone-800 border border-stone-200/60 dark:border-stone-700/60">
                <div class="text-sm font-semibold text-stone-500 dark:text-stone-400">{syncResult.stats.deletedObsolete}</div>
                <div class="text-[10px] text-stone-500">Deleted</div>
              </div>
              {#if syncResult.stats.failed > 0}
                <div class="p-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60">
                  <div class="text-sm font-semibold text-red-600 dark:text-red-400">{syncResult.stats.failed}</div>
                  <div class="text-[10px] text-red-500">Failed</div>
                </div>
              {/if}
            </div>
            {#if syncResult.errors && syncResult.errors.length > 0}
              <div class="text-[11px] text-red-600 dark:text-red-400 p-2.5 rounded-lg bg-red-50/50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-900/40 space-y-1">
                <div class="font-medium flex items-center justify-between">
                  <span>{syncResult.errors.length} event{syncResult.errors.length === 1 ? '' : 's'} failed to sync</span>
                </div>
                <ul class="list-disc pl-4 space-y-0.5 text-[10px] text-stone-600 dark:text-stone-400 max-h-24 overflow-y-auto">
                  {#each syncResult.errors.slice(0, 3) as err}
                    <li class="truncate">{err.error}</li>
                  {/each}
                  {#if syncResult.errors.length > 3}
                    <li class="italic font-medium">...and {syncResult.errors.length - 3} more errors</li>
                  {/if}
                </ul>
              </div>
            {/if}
          {/if}
        </div>
      {/if}
      </div>

      <!-- Footer Buttons -->
      <div class="flex items-center justify-between pt-3 border-t border-stone-100 dark:border-stone-800 shrink-0">
        <button
          type="button"
          onclick={onClose}
          class="px-3.5 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 text-xs font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition cursor-pointer"
        >
          Close
        </button>
        {#if selectedProvider === 'google' && isConnected}
          <button
            type="button"
            onclick={handleSync}
            disabled={isSyncing || scheduleEvents.length === 0}
            class="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium transition shadow-2xs cursor-pointer disabled:opacity-50"
          >
            {#if isSyncing}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Reconciling Events...</span>
            {:else}
              <RefreshCw class="w-3.5 h-3.5" />
              <span>Sync to Google Calendar{scheduleEvents.length > 0 ? ` (${scheduleEvents.length})` : ''}</span>
            {/if}
          </button>
        {:else if selectedProvider === 'arc'}
          <button
            type="button"
            onclick={handleSync}
            disabled={isSyncing || scheduleEvents.length === 0}
            class="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium transition shadow-2xs cursor-pointer disabled:opacity-50"
          >
            {#if isSyncing}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Pushing to Timeflow...</span>
            {:else}
              <RefreshCw class="w-3.5 h-3.5" />
              <span>{arcHasCredentials ? 'Push to Timeflow' : 'Simulate Timeflow Sync'}{scheduleEvents.length > 0 ? ` (${scheduleEvents.length})` : ''}</span>
            {/if}
          </button>
        {/if}
      </div>

    </div>
  </div>
{/if}
