import { describe, it, expect } from 'bun:test';
import {
  resolveSettingsTab,
  classifyPrompt,
  COURSE_PROMPT_ORDER,
  UNIT_PROMPT_ORDER,
  LESSON_PROMPT_ORDER
} from './settingsTabs';

describe('resolveSettingsTab', () => {
  it('resolves null, undefined, or empty string to settings', () => {
    expect(resolveSettingsTab(null)).toBe('settings');
    expect(resolveSettingsTab(undefined)).toBe('settings');
    expect(resolveSettingsTab('')).toBe('settings');
  });

  it('resolves unknown tab parameters to settings', () => {
    expect(resolveSettingsTab('general')).toBe('settings');
    expect(resolveSettingsTab('random')).toBe('settings');
  });

  it('resolves "prompts" to prompts tab', () => {
    expect(resolveSettingsTab('prompts')).toBe('prompts');
  });
});

describe('classifyPrompt', () => {
  it('classifies standard complete course prompts as course', () => {
    expect(classifyPrompt({ id: 'course_summary' })).toBe('course');
    expect(classifyPrompt({ id: 'course_schedule' })).toBe('course');
    expect(classifyPrompt({ id: 'course_test' })).toBe('course');
    expect(classifyPrompt({ id: 'course.summary.md' })).toBe('course');
  });

  it('classifies standard unit prompts as unit', () => {
    expect(classifyPrompt({ id: 'unit_assignments' })).toBe('unit');
    expect(classifyPrompt({ id: 'unit_assignment' })).toBe('unit');
    expect(classifyPrompt({ id: 'unit_test' })).toBe('unit');
    expect(classifyPrompt({ id: 'unit' })).toBe('unit');
  });

  it('classifies standard lesson prompts as lessons', () => {
    expect(classifyPrompt({ id: 'summary' })).toBe('lessons');
    expect(classifyPrompt({ id: 'cheatsheet' })).toBe('lessons');
    expect(classifyPrompt({ id: 'lesson' })).toBe('lessons');
    expect(classifyPrompt({ id: 'popquiz' })).toBe('lessons');
    expect(classifyPrompt({ id: 'popquiz.md' })).toBe('lessons');
    expect(classifyPrompt({ id: 'pop_quiz' })).toBe('lessons');
    expect(classifyPrompt({ id: 'summary.md' })).toBe('lessons');
  });

  it('classifies custom tabs and other prompts as custom', () => {
    expect(classifyPrompt({ id: 'mcp_prompt_instructions' })).toBe('custom');
    expect(classifyPrompt({ id: 'research_notes' })).toBe('custom');
    expect(classifyPrompt({ id: 'my_custom_prompt.md' })).toBe('custom');
  });
});

describe('prompt order constants', () => {
  it('has consistent ordering lists', () => {
    expect(COURSE_PROMPT_ORDER).toContain('course_summary');
    expect(COURSE_PROMPT_ORDER).toContain('course_schedule');
    expect(COURSE_PROMPT_ORDER).toContain('course_test');
    expect(UNIT_PROMPT_ORDER).toContain('unit_assignments');
    expect(UNIT_PROMPT_ORDER).toContain('unit_test');
    expect(LESSON_PROMPT_ORDER).toContain('summary');
    expect(LESSON_PROMPT_ORDER).toContain('cheatsheet');
    expect(LESSON_PROMPT_ORDER).toContain('popquiz');
  });
});
