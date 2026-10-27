import { describe, it, expect } from 'bun:test';
import { generateLockerDocFilename } from './imageProcessor';

describe('imageProcessor', () => {
  it('generates filename starting with lesson prefix and ending in .jpg', () => {
    const filename = generateLockerDocFilename('01.01');
    expect(filename).toMatch(/^01\.01_[a-z0-9]+\.jpg$/i);
  });

  it('generates filename for course scope when lessonId is omitted or course', () => {
    const fn1 = generateLockerDocFilename();
    expect(fn1).toMatch(/^course_[a-z0-9]+\.jpg$/i);

    const fn2 = generateLockerDocFilename('course');
    expect(fn2).toMatch(/^course_[a-z0-9]+\.jpg$/i);

    const fn3 = generateLockerDocFilename('');
    expect(fn3).toMatch(/^course_[a-z0-9]+\.jpg$/i);
  });

  it('preserves valid characters in lesson ids (like assignments)', () => {
    const filename = generateLockerDocFilename('01.06_assign1');
    expect(filename).toMatch(/^01\.06_assign1_[a-z0-9]+\.jpg$/i);
  });

  it('generates unique filenames across multiple invocations', () => {
    const filenames = new Set<string>();
    for (let i = 0; i < 50; i++) {
      filenames.add(generateLockerDocFilename('01.01'));
    }
    expect(filenames.size).toBe(50);
  });
});
