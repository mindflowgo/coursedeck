import { describe, expect, it } from 'bun:test';
import { PromptService } from './prompts';
import { classifyPrompt, COURSE_PROMPT_ORDER, LESSON_PROMPT_ORDER } from '../settingsTabs';

describe('PromptService and Notes', () => {
  it('loads notes in listPrompts', () => {
    const prompts = PromptService.listPrompts();
    const ids = prompts.map((p) => p.id);
    
    expect(ids).toContain('notes');

    const notes = prompts.find((p) => p.id === 'notes');
    expect(notes).toBeDefined();
    expect(notes?.title).toBe('Notes Prompt');
    expect(notes?.filename).toBe('notes.md');
  });

  it('retrieves notes via getPrompt', () => {
    const notes = PromptService.getPrompt('notes');
    expect(notes).toBeDefined();
    expect(notes?.id).toBe('notes');
    expect(notes?.filename).toBe('notes.md');
    expect(notes?.title).toBe('Notes Prompt');
  });

  it('classifies notes under lessons', () => {
    expect(classifyPrompt({ id: 'notes' })).toBe('lessons');
    expect(classifyPrompt({ id: 'notes.md' })).toBe('lessons');
    expect(LESSON_PROMPT_ORDER).toContain('notes');
  });

  it('classifies course_notes under course', () => {
    expect(classifyPrompt({ id: 'course_notes' })).toBe('course');
    expect(classifyPrompt({ id: 'course_notes.md' })).toBe('course');
    expect(COURSE_PROMPT_ORDER).toContain('course_notes');
  });

  it('loads and classifies course_builder under course (Complete Course)', () => {
    const courseBuilder = PromptService.getPrompt('course_builder');
    expect(courseBuilder).toBeDefined();
    expect(courseBuilder?.title).toBe('Automatic Lesson Builder');
    expect(classifyPrompt({ id: 'course_builder' })).toBe('course');
    expect(classifyPrompt({ id: 'course_builder.md' })).toBe('course');
    expect(COURSE_PROMPT_ORDER).toContain('course_builder');
  });
});
