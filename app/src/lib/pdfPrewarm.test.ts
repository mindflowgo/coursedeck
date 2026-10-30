import { describe, it, expect, beforeEach } from 'bun:test';
import {
  shouldAdoptPrewarmedPage,
  storePrewarmedPage,
  consumePrewarmedPage,
  discardPrewarmedPages,
  type PrewarmedPageBlob
} from './pdfPrewarm';

const ENTRY: PrewarmedPageBlob = { pageIndex: 239, url: 'blob:prewarmed-1', scale: 2.0 };

describe('shouldAdoptPrewarmedPage', () => {
  it('adopts the same page within 10% scale tolerance', () => {
    expect(shouldAdoptPrewarmedPage(ENTRY, 239, 2.0)).toBe(true);
    expect(shouldAdoptPrewarmedPage(ENTRY, 239, 1.95)).toBe(true);
    expect(shouldAdoptPrewarmedPage(ENTRY, 239, 2.1)).toBe(true);
  });

  it('rejects a different page', () => {
    expect(shouldAdoptPrewarmedPage(ENTRY, 240, 2.0)).toBe(false);
    expect(shouldAdoptPrewarmedPage(ENTRY, 238, 2.0)).toBe(false);
  });

  it('rejects scale drift beyond 10%', () => {
    expect(shouldAdoptPrewarmedPage(ENTRY, 239, 1.7)).toBe(false);
    expect(shouldAdoptPrewarmedPage(ENTRY, 239, 2.4)).toBe(false);
  });
});

describe('prewarmed page store', () => {
  beforeEach(() => {
    discardPrewarmedPages('/api/courses/clm3u/assets/locker_docs/course.pdf');
  });

  it('consumes a matching entry exactly once', () => {
    storePrewarmedPage('/api/courses/clm3u/assets/locker_docs/course.pdf', ENTRY);
    expect(consumePrewarmedPage('/api/courses/clm3u/assets/locker_docs/course.pdf', 239, 2.0)).toBe(
      'blob:prewarmed-1'
    );
    expect(consumePrewarmedPage('/api/courses/clm3u/assets/locker_docs/course.pdf', 239, 2.0)).toBeNull();
  });

  it('keeps the entry when page or scale do not match', () => {
    storePrewarmedPage('/api/courses/clm3u/assets/locker_docs/course.pdf', ENTRY);
    expect(consumePrewarmedPage('/api/courses/clm3u/assets/locker_docs/course.pdf', 100, 2.0)).toBeNull();
    expect(consumePrewarmedPage('/api/courses/clm3u/assets/locker_docs/course.pdf', 239, 1.0)).toBeNull();
    expect(consumePrewarmedPage('/api/courses/clm3u/assets/locker_docs/course.pdf', 239, 2.05)).toBe(
      'blob:prewarmed-1'
    );
  });

  it('matches keys case-insensitively (route param vs manifest id casing)', () => {
    storePrewarmedPage('/api/courses/CLM3U/assets/locker_docs/course.pdf', ENTRY);
    expect(consumePrewarmedPage('/api/courses/clm3u/assets/locker_docs/course.pdf', 239, 2.0)).toBe(
      'blob:prewarmed-1'
    );
  });

  it('replaces the previous entry per document (single slot)', () => {
    const docPath = '/api/courses/clm3u/assets/locker_docs/course.pdf';
    storePrewarmedPage(docPath, ENTRY);
    storePrewarmedPage(docPath, { pageIndex: 10, url: 'blob:prewarmed-2', scale: 1.0 });
    expect(consumePrewarmedPage(docPath, 239, 2.0)).toBeNull();
    expect(consumePrewarmedPage(docPath, 10, 1.0)).toBe('blob:prewarmed-2');
  });

  it('discardPrewarmedPages clears the slot', () => {
    const docPath = '/api/courses/clm3u/assets/locker_docs/course.pdf';
    storePrewarmedPage(docPath, ENTRY);
    discardPrewarmedPages(docPath);
    expect(consumePrewarmedPage(docPath, 239, 2.0)).toBeNull();
  });
});
