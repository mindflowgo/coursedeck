import { describe, it, expect } from 'bun:test';
import {
  SCROLL_KEY_PREFIX,
  scrollMemoryKey,
  recallScroll,
  rememberScroll,
  forgetCourseScroll,
  pruneScrollMemory,
  type ScrollStorage
} from './scrollMemory';

/** Map-backed stand-in for localStorage. */
class FakeStorage implements ScrollStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** Storage whose every operation throws (private mode / quota failures). */
const throwingStorage: ScrollStorage = {
  get length(): number {
    throw new Error('no storage');
  },
  key(): string | null {
    throw new Error('no storage');
  },
  getItem(): string | null {
    throw new Error('no storage');
  },
  setItem(): void {
    throw new Error('no storage');
  },
  removeItem(): void {
    throw new Error('no storage');
  }
};

describe('scrollMemoryKey', () => {
  it('prefixes and lowercases course, scope and tab', () => {
    expect(scrollMemoryKey('BAF3M', '01.01', 'Summary')).toBe('tab_scroll:baf3m:01.01:summary');
    expect(scrollMemoryKey('baf3m', 'course', 'schedule')).toBe(
      'tab_scroll:baf3m:course:schedule'
    );
    expect(SCROLL_KEY_PREFIX).toBe('tab_scroll:');
  });
});

describe('rememberScroll / recallScroll', () => {
  it('round-trips an offset, flooring fractional pixels', () => {
    const storage = new FakeStorage();
    const key = scrollMemoryKey('baf3m', '01.01', 'lesson');
    rememberScroll(key, 1284.7, storage);
    expect(storage.getItem(key)).toBe('1284');
    expect(recallScroll(key, storage)).toBe(1284);
  });

  it('returns 0 for missing, garbage or negative values', () => {
    const storage = new FakeStorage();
    const key = 'tab_scroll:baf3m:01.01:lesson';
    expect(recallScroll(key, storage)).toBe(0);
    storage.setItem(key, 'not-a-number');
    expect(recallScroll(key, storage)).toBe(0);
    storage.setItem(key, '-40');
    expect(recallScroll(key, storage)).toBe(0);
  });

  it('forgets near-top offsets instead of storing them', () => {
    const storage = new FakeStorage();
    const key = 'tab_scroll:baf3m:01.01:lesson';
    rememberScroll(key, 900, storage);
    rememberScroll(key, 3, storage);
    expect(storage.getItem(key)).toBeNull();
    expect(recallScroll(key, storage)).toBe(0);
  });

  it('ignores non-finite offsets', () => {
    const storage = new FakeStorage();
    const key = 'tab_scroll:baf3m:01.01:lesson';
    rememberScroll(key, 900, storage);
    rememberScroll(key, Number.NaN, storage);
    expect(storage.getItem(key)).toBeNull();
  });

  it('is a silent no-op without storage', () => {
    expect(() => rememberScroll('tab_scroll:x:y:z', 500, null)).not.toThrow();
    expect(recallScroll('tab_scroll:x:y:z', null)).toBe(0);
  });

  it('survives a throwing storage', () => {
    expect(() => rememberScroll('tab_scroll:x:y:z', 500, throwingStorage)).not.toThrow();
    expect(recallScroll('tab_scroll:x:y:z', throwingStorage)).toBe(0);
    expect(() => forgetCourseScroll('x', throwingStorage)).not.toThrow();
    expect(() => pruneScrollMemory(['x'], throwingStorage)).not.toThrow();
  });
});

describe('forgetCourseScroll', () => {
  it('removes only the given course and leaves everything else', () => {
    const storage = new FakeStorage();
    storage.setItem('tab_scroll:baf3m:01.01:summary', '1200');
    storage.setItem('tab_scroll:baf3m:course:schedule', '80');
    storage.setItem('tab_scroll:mcr3u:02.01:lesson', '640');
    storage.setItem('app_llm_model', 'qwen');

    forgetCourseScroll('baf3m', storage);

    expect(storage.keys()).toEqual(['tab_scroll:mcr3u:02.01:lesson', 'app_llm_model']);
  });

  it('matches the course id case-insensitively', () => {
    const storage = new FakeStorage();
    storage.setItem('tab_scroll:baf3m:01.01:summary', '1200');
    forgetCourseScroll('BAF3M', storage);
    expect(storage.keys()).toEqual([]);
  });

  it('does not remove courses sharing a prefix', () => {
    const storage = new FakeStorage();
    storage.setItem('tab_scroll:baf:01.01:lesson', '300');
    storage.setItem('tab_scroll:baf3m:01.01:lesson', '900');
    forgetCourseScroll('baf', storage);
    expect(storage.keys()).toEqual(['tab_scroll:baf3m:01.01:lesson']);
  });
});

describe('pruneScrollMemory', () => {
  it('keeps known courses (case-insensitive) and drops the rest', () => {
    const storage = new FakeStorage();
    storage.setItem('tab_scroll:baf3m:01.01:summary', '1200');
    storage.setItem('tab_scroll:mcr3u:02.01:lesson', '640');
    storage.setItem('tab_scroll:zzz9:course:test', '12');
    storage.setItem('app_nav_base', '1');

    pruneScrollMemory(['BAF3M', 'mcr3u'], storage);

    expect(storage.keys()).toEqual([
      'tab_scroll:baf3m:01.01:summary',
      'tab_scroll:mcr3u:02.01:lesson',
      'app_nav_base'
    ]);
  });

  it('drops every scroll key when no courses remain', () => {
    const storage = new FakeStorage();
    storage.setItem('tab_scroll:baf3m:01.01:summary', '1200');
    pruneScrollMemory([], storage);
    expect(storage.keys()).toEqual([]);
  });
});
