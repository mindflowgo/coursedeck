import { describe, expect, it } from 'bun:test';
import { PromptService } from './prompts';
import { classifyPrompt, COURSE_PROMPT_ORDER, LESSON_PROMPT_ORDER } from '../settingsTabs';

describe('PromptService and Studysheet', () => {
  it('loads studysheet in listPrompts', () => {
    const prompts = PromptService.listPrompts();
    const ids = prompts.map((p) => p.id);
    
    expect(ids).toContain('studysheet');

    const studysheet = prompts.find((p) => p.id === 'studysheet');
    expect(studysheet).toBeDefined();
    expect(studysheet?.title).toBe('Studysheet Prompt');
    expect(studysheet?.filename).toBe('studysheet.md');
  });

  it('retrieves studysheet via getPrompt', () => {
    const studysheet = PromptService.getPrompt('studysheet');
    expect(studysheet).toBeDefined();
    expect(studysheet?.id).toBe('studysheet');
    expect(studysheet?.filename).toBe('studysheet.md');
    expect(studysheet?.title).toBe('Studysheet Prompt');
  });

  it('classifies studysheet under lessons', () => {
    expect(classifyPrompt({ id: 'studysheet' })).toBe('lessons');
    expect(classifyPrompt({ id: 'studysheet.md' })).toBe('lessons');
    expect(LESSON_PROMPT_ORDER).toContain('studysheet');
  });

  it('classifies course_studysheet under course', () => {
    expect(classifyPrompt({ id: 'course_studysheet' })).toBe('course');
    expect(classifyPrompt({ id: 'course_studysheet.md' })).toBe('course');
    expect(COURSE_PROMPT_ORDER).toContain('course_studysheet');
  });
});
