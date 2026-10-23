export type SettingsTab = 'settings' | 'llm' | 'prompts' | 'integrations' | 'sync_mcp';

export function resolveSettingsTab(tabParam?: string | null): SettingsTab {
  if (!tabParam) return 'settings';
  const param = tabParam.toLowerCase().trim();
  if (param === 'llm' || param === 'ai' || param === 'models') {
    return 'llm';
  }
  if (param === 'prompts') {
    return 'prompts';
  }
  if (
    param === 'integrations' ||
    param === 'integration' ||
    param === 'sync_mcp' ||
    param === 'sync-mcp' ||
    param === 'mcp' ||
    param === 'sync'
  ) {
    return 'integrations';
  }
  return 'settings';
}

export type PromptGroupKey = 'course' | 'unit' | 'lessons' | 'custom';

export const COURSE_PROMPT_ORDER = ['course_summary', 'course_schedule', 'course_test'] as const;
export const UNIT_PROMPT_ORDER = ['unit_assignments', 'unit_test'] as const;
export const LESSON_PROMPT_ORDER = ['summary', 'cheatsheet', 'popquiz', 'lesson'] as const;

export function classifyPrompt(p: { id: string }): PromptGroupKey {
  const id = p.id.toLowerCase().replace(/\.md$/, '').replace(/\./g, '_');

  // Standard complete course prompts
  if (
    id === 'course_summary' ||
    id === 'course_schedule' ||
    id === 'course_test' ||
    id === 'course'
  ) {
    return 'course';
  }

  // Standard unit prompts
  if (
    id === 'unit_assignments' ||
    id === 'unit_assignment' ||
    id === 'unit_test' ||
    id === 'unit'
  ) {
    return 'unit';
  }

  // Standard lesson prompts
  if (
    id === 'summary' ||
    id === 'cheatsheet' ||
    id === 'popquiz' ||
    id === 'pop_quiz' ||
    id === 'lesson'
  ) {
    return 'lessons';
  }

  // Any other prompts (including new custom tabs)
  return 'custom';
}
