export type SettingsTab = 'settings' | 'prompts' | 'sync_mcp';

export function resolveSettingsTab(tabParam?: string | null): SettingsTab {
  if (tabParam === 'prompts') return 'prompts';
  if (tabParam === 'sync_mcp' || tabParam === 'sync-mcp' || tabParam === 'mcp' || tabParam === 'sync') {
    return 'sync_mcp';
  }
  return 'settings';
}

export type PromptGroupKey = 'course' | 'lessons' | 'custom';

export const COURSE_PROMPT_ORDER = ['course_summary', 'course_cheatsheet', 'course_schedule', 'course_test'] as const;
export const LESSON_PROMPT_ORDER = ['summary', 'cheatsheet', 'test', 'test_kica', 'lesson'] as const;

export function classifyPrompt(p: { id: string }): PromptGroupKey {
  const id = p.id.toLowerCase().replace(/\.md$/, '').replace(/\./g, '_');

  // Standard course-wide prompts
  if (
    id === 'course_summary' ||
    id === 'course_cheatsheet' ||
    id === 'course_schedule' ||
    id === 'course_test' ||
    id === 'course'
  ) {
    return 'course';
  }

  // Standard lesson prompts
  if (
    id === 'summary' ||
    id === 'cheatsheet' ||
    id === 'test' ||
    id === 'test_kica' ||
    id === 'lesson'
  ) {
    return 'lessons';
  }

  // Any other prompts (including new custom tabs)
  return 'custom';
}
