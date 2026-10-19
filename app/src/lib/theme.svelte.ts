import { apiFetch, isTauriEnvironment } from '$lib/api';

export type ThemeMode = 'light' | 'dark' | 'system';

class ThemeManager {
  current = $state<ThemeMode>('system');
  isDark = $state<boolean>(false);

  init() {
    if (typeof window === 'undefined') return;

    // 1. Immediately apply cached theme from localStorage to prevent flash
    const stored = (localStorage.getItem('app_theme') as ThemeMode) || 'system';
    this.current = ['light', 'dark', 'system'].includes(stored) ? stored : 'system';
    this.apply();

    // 2. Listen to system preference changes if in 'system' mode
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', () => {
      if (this.current === 'system') {
        this.apply();
      }
    });

    // 3. Asynchronously synchronize with Tauri settings.json / backend
    this.syncFromSettings();
  }

  async setTheme(mode: ThemeMode) {
    this.current = mode;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('app_theme', mode);
    }
    this.apply();

    // Persist to Tauri settings.json if in Tauri
    if (isTauriEnvironment()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_setting', { key: 'theme', value: mode });
      } catch (e) {
        console.warn('Failed to persist theme via Tauri IPC:', e);
      }
    }

    // Persist via HTTP API to ensure settings.json is updated in all environments
    try {
      await apiFetch('/api/settings/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: mode })
      });
    } catch (e) {
      console.warn('Failed to persist theme via API:', e);
    }
  }

  private apply() {
    if (typeof document === 'undefined') return;

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldBeDark = this.current === 'dark' || (this.current === 'system' && prefersDark);
    this.isDark = shouldBeDark;

    if (shouldBeDark) {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.style.colorScheme = 'light';
    }
  }

  private async syncFromSettings() {
    try {
      if (isTauriEnvironment()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const tauriTheme = await invoke<any>('get_setting', { key: 'theme' });
          if (tauriTheme && typeof tauriTheme === 'string' && ['light', 'dark', 'system'].includes(tauriTheme)) {
            if (this.current !== tauriTheme) {
              this.current = tauriTheme as ThemeMode;
              localStorage.setItem('app_theme', tauriTheme);
              this.apply();
              return;
            }
          }
        } catch (_) {}
      }

      const res = await apiFetch('/api/settings/theme');
      if (res.ok) {
        const data = await res.json();
        if (data?.theme && ['light', 'dark', 'system'].includes(data.theme)) {
          if (this.current !== data.theme) {
            this.current = data.theme;
            localStorage.setItem('app_theme', data.theme);
            this.apply();
          }
        }
      }
    } catch (_) {}
  }
}

export const theme = new ThemeManager();
