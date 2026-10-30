import fs from 'node:fs';
import path from 'node:path';
import { getPromptsDir, getDefaultDataDir, assertPromptId, safeJoin } from './paths';

export interface PromptItem {
  id: string; // e.g. "summary", "studysheet", "test_kica"
  title: string;
  filename: string;
  content: string;
}

export class PromptService {
  /** Resolves potential fallback locations for prompt templates if not in the active prompts directory. */
  private static getFallbackDirs(): string[] {
    const candidates = [
      path.join(getDefaultDataDir(), 'prompts'),
      path.resolve(process.cwd(), 'data', 'prompts'),
      path.resolve(process.cwd(), '..', 'data', 'prompts')
    ];
    return candidates.filter((d) => fs.existsSync(d));
  }

  static listPrompts(): PromptItem[] {
    const activeDir = getPromptsDir();
    const promptMap = new Map<string, PromptItem>();

    const recordPrompt = (rawId: string, filename: string, content: string) => {
      let id = rawId;
      let fname = filename;
      if (id === 'studysheet') {
        id = 'notes';
        fname = 'notes.md';
      } else if (id === 'course_studysheet') {
        id = 'course_notes';
        fname = 'course_notes.md';
      }

      if (!promptMap.has(id)) {
        const titleMatch = content.match(/^#\s+(.*)/m);
        let title = titleMatch ? titleMatch[1].trim() : id;
        if (id === 'notes' && title.toLowerCase().includes('studysheet')) {
          title = title.replace(/studysheet/gi, 'Notes');
        } else if (id === 'course_notes' && title.toLowerCase().includes('studysheet')) {
          title = title.replace(/studysheet/gi, 'Notes');
        }
        promptMap.set(id, {
          id,
          title,
          filename: fname,
          content
        });
      }
    };

    // 1. Load any defaults first from fallback directories
    for (const fallbackDir of this.getFallbackDirs()) {
      try {
        const files = fs.readdirSync(fallbackDir).filter((f) => f.endsWith('.md'));
        for (const f of files) {
          const id = f.replace(/\.md$/, '');
          const content = fs.readFileSync(path.join(fallbackDir, f), 'utf8');
          recordPrompt(id, f, content);
        }
      } catch {}
    }

    // 2. Active directory takes precedence and overrides defaults with user edits
    if (fs.existsSync(activeDir)) {
      try {
        const files = fs.readdirSync(activeDir).filter((f) => f.endsWith('.md'));
        for (const f of files) {
          const id = f.replace(/\.md$/, '');
          const fullPath = path.join(activeDir, f);
          const content = fs.readFileSync(fullPath, 'utf8');
          recordPrompt(id, f, content);
        }
      } catch {}
    }

    return Array.from(promptMap.values());
  }

  static getPrompt(id: string): PromptItem | null {
    if (id === 'studysheet') {
      return this.getPrompt('notes');
    }
    if (id === 'course_studysheet') {
      return this.getPrompt('course_notes');
    }

    const safeId = assertPromptId(id);
    const activeDir = getPromptsDir();
    const fullPath = safeJoin(activeDir, `${safeId}.md`);

    // 1. Check user/active prompts dir
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const titleMatch = content.match(/^#\s+(.*)/m);
      let title = titleMatch ? titleMatch[1].trim() : safeId;
      if (safeId === 'notes' && title.toLowerCase().includes('studysheet')) {
        title = title.replace(/studysheet/gi, 'Notes');
      } else if (safeId === 'course_notes' && title.toLowerCase().includes('studysheet')) {
        title = title.replace(/studysheet/gi, 'Notes');
      }
      return {
        id: safeId,
        title,
        filename: `${safeId}.md`,
        content
      };
    }

    // 2. Check fallback dirs
    for (const fallbackDir of this.getFallbackDirs()) {
      const fbPath = path.join(fallbackDir, `${safeId}.md`);
      if (fs.existsSync(fbPath)) {
        const content = fs.readFileSync(fbPath, 'utf8');
        const titleMatch = content.match(/^#\s+(.*)/m);
        let title = titleMatch ? titleMatch[1].trim() : safeId;
        if (safeId === 'notes' && title.toLowerCase().includes('studysheet')) {
          title = title.replace(/studysheet/gi, 'Notes');
        } else if (safeId === 'course_notes' && title.toLowerCase().includes('studysheet')) {
          title = title.replace(/studysheet/gi, 'Notes');
        }
        // Auto-seed into activeDir so user has it locally
        try {
          fs.mkdirSync(activeDir, { recursive: true });
          fs.writeFileSync(fullPath, content, 'utf8');
        } catch {}
        return {
          id: safeId,
          title,
          filename: `${safeId}.md`,
          content
        };
      }
    }

    return null;
  }

  static savePrompt(id: string, content: string): boolean {
    const safeId = assertPromptId(id);
    const dir = getPromptsDir();
    fs.mkdirSync(dir, { recursive: true });
    const fullPath = safeJoin(dir, `${safeId}.md`);

    try {
      fs.writeFileSync(fullPath, content, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  static deletePrompt(id: string): boolean {
    const safeId = assertPromptId(id);
    const activeDir = getPromptsDir();
    const fullPath = safeJoin(activeDir, `${safeId}.md`);

    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
