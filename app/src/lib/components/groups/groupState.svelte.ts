/**
 * Reusable reactive store for managing and persisting group collapse states in localStorage.
 * Used for collapsible groupings in /courses, /library, and future grouped views.
 */
export class GroupCollapseManager {
  private storageKey: string;
  private defaultCollapsed: boolean;
  collapsedMap = $state<Record<string, boolean>>({});

  constructor(storageKey: string, defaultCollapsed: boolean = false) {
    this.storageKey = storageKey;
    this.defaultCollapsed = defaultCollapsed;
    this.load();
  }

  load(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.collapsedMap = parsed;
        }
      }
    } catch (e) {
      console.warn(`Failed to parse group collapse state for ${this.storageKey}:`, e);
    }
  }

  private save(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.collapsedMap));
    } catch (e) {
      console.warn(`Failed to save group collapse state for ${this.storageKey}:`, e);
    }
  }

  isCollapsed(groupId: string): boolean {
    const val = this.collapsedMap[groupId];
    return val !== undefined ? val : this.defaultCollapsed;
  }

  toggle(groupId: string): void {
    const current = this.isCollapsed(groupId);
    this.collapsedMap = {
      ...this.collapsedMap,
      [groupId]: !current
    };
    this.save();
  }

  setCollapsed(groupId: string, collapsed: boolean): void {
    this.collapsedMap = {
      ...this.collapsedMap,
      [groupId]: collapsed
    };
    this.save();
  }

  expandAll(groupIds?: string[]): void {
    const next: Record<string, boolean> = { ...this.collapsedMap };
    if (groupIds) {
      for (const id of groupIds) {
        next[id] = false;
      }
    } else {
      for (const k of Object.keys(next)) {
        next[k] = false;
      }
    }
    this.collapsedMap = next;
    this.save();
  }

  collapseAll(groupIds?: string[]): void {
    const next: Record<string, boolean> = { ...this.collapsedMap };
    if (groupIds) {
      for (const id of groupIds) {
        next[id] = true;
      }
    } else {
      for (const k of Object.keys(next)) {
        next[k] = true;
      }
    }
    this.collapsedMap = next;
    this.save();
  }
}

export function createGroupCollapseStore(
  storageKey: string,
  defaultCollapsed: boolean = false
): GroupCollapseManager {
  return new GroupCollapseManager(storageKey, defaultCollapsed);
}
