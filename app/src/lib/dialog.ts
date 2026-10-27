import { isTauriEnvironment } from './api';

/**
 * Cross-platform confirmation dialog.
 * Uses native Tauri dialog on desktop with permission fallback to window.confirm.
 */
export async function confirmDialog(message: string, title?: string): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { confirm } = await import('@tauri-apps/plugin-dialog');
      return await confirm(message, title ? { title, kind: 'warning' } : undefined);
    } catch (e) {
      console.warn('Native dialog.confirm failed, falling back:', e);
      // In Tauri, do not call window.confirm as it invokes the same native dialog IPC
      return true;
    }
  }

  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    try {
      return window.confirm(message);
    } catch (e) {
      console.warn('window.confirm failed:', e);
    }
  }

  return true;
}

/**
 * Cross-platform message/alert dialog.
 * Uses native Tauri dialog on desktop with fallback to window.alert.
 */
export async function messageDialog(message: string, title?: string): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { message: tauriMessage } = await import('@tauri-apps/plugin-dialog');
      await tauriMessage(message, title ? { title } : undefined);
      return;
    } catch (e) {
      console.warn('Native dialog.message failed:', e);
      return;
    }
  }

  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    try {
      window.alert(message);
    } catch {}
  }
}
