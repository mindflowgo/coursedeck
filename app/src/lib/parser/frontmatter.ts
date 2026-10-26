import { load, dump } from 'js-yaml';

export interface FrontmatterData {
  prompt?: string;
  type?: string;
  version?: number | string;
  updatedAt?: string;
  title?: string;
  [key: string]: any;
}

export interface ParsedMarkdownFile {
  frontmatter: FrontmatterData;
  body: string;
}

// Bun.YAML is the preferred runtime builtin when running on Bun (sidecar, server, CLI).
// When running in a browser / Tauri WebView environment where Bun is unavailable,
// it falls back cleanly to js-yaml.
interface YamlEngine {
  parse(source: string): unknown;
  stringify(value: unknown): string;
}

function getYaml(): YamlEngine {
  const bunYaml = (typeof Bun !== 'undefined' ? Bun.YAML : undefined)
    ?? (globalThis as { Bun?: { YAML?: YamlEngine } }).Bun?.YAML;
  if (bunYaml) {
    return bunYaml;
  }
  return {
    parse(source: string): unknown {
      return load(source);
    },
    stringify(value: unknown): string {
      return dump(value, { lineWidth: -1 });
    }
  };
}


/**
 * Parses YAML frontmatter (---\n...\n---) from markdown content.
 */
let lastYamlSource: string | null = null;
let lastYamlDefaultPrompt: string | null = null;
let lastParsedData: FrontmatterData | null = null;

export function parseFrontmatter(fileContent: string, defaultPrompt: string = ''): ParsedMarkdownFile {
  if (!fileContent) {
    return { frontmatter: { prompt: defaultPrompt }, body: '' };
  }

  const match = fileContent.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n*([\s\S]*)$/);
  if (match) {
    const yamlSource = match[1];
    let data: FrontmatterData;

    if (yamlSource === lastYamlSource && defaultPrompt === lastYamlDefaultPrompt && lastParsedData) {
      data = { ...lastParsedData };
    } else {
      try {
        data = ((getYaml().parse(yamlSource) as FrontmatterData) || {});
        if (!data.prompt && defaultPrompt) {
          data.prompt = defaultPrompt;
        }
        lastYamlSource = yamlSource;
        lastYamlDefaultPrompt = defaultPrompt;
        lastParsedData = data;
      } catch (e) {
        console.warn('Failed to parse YAML frontmatter:', e);
        data = { prompt: defaultPrompt };
      }
    }

    return {
      frontmatter: data,
      body: match[2].trim()
    };
  }

  // If no frontmatter block exists, return default prompt and full body
  return {
    frontmatter: { prompt: defaultPrompt },
    body: fileContent.trim()
  };
}

export interface SplitMarkdown {
  hasFrontmatter: boolean;
  rawFrontmatter: string;
  body: string;
}

/**
 * Splits a markdown document into its verbatim frontmatter block and body.
 * If no frontmatter block exists at the start of the document, hasFrontmatter is false.
 */
export function splitFrontmatter(fileContent: string): SplitMarkdown {
  if (!fileContent) {
    return { hasFrontmatter: false, rawFrontmatter: '', body: '' };
  }

  // Matches frontmatter strictly anchored to the very start of the file
  const match = fileContent.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/);
  if (!match) {
    return { hasFrontmatter: false, rawFrontmatter: '', body: fileContent };
  }

  const rawFrontmatter = fileContent.slice(0, fileContent.length - match[2].length).trimEnd();
  // Strip initial blank lines so the editor begins directly on the first line of content
  const body = match[2].replace(/^\r?\n+/, '');

  return {
    hasFrontmatter: true,
    rawFrontmatter,
    body
  };
}

/**
 * Re-appends the remembered frontmatter block to the revised markdown body.
 */
export function reappendFrontmatter(rawFrontmatter: string, body: string): string {
  if (!rawFrontmatter) return body;
  const cleanHeader = rawFrontmatter.trimEnd();
  const cleanBody = body.replace(/^\r?\n+/, '');
  if (!cleanBody.trim()) {
    return `${cleanHeader}\n\n`;
  }
  return `${cleanHeader}\n\n${cleanBody.replace(/\n*$/, '\n')}`;
}

/**
 * Serializes frontmatter object and body into standard YAML frontmatter markdown.
 */
export function serializeWithFrontmatter(frontmatter: FrontmatterData, body: string): string {
  // Bun.YAML.stringify emits no trailing newline; the closing --- must
  // start its own line or parseFrontmatter cannot find the block.
  const yamlStr = getYaml().stringify(frontmatter).replace(/\n?$/, '\n');
  return `---\n${yamlStr}---\n\n${body.trim()}\n`;
}
