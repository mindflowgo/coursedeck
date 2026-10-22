import { spawn } from 'node:child_process';
import readline from 'node:readline';

interface ToolTestCase {
  name: string;
  args: Record<string, any>;
  description: string;
  validateMarkdown: (text: string) => boolean;
}

const testCases: ToolTestCase[] = [
  {
    name: 'list_courses',
    args: {},
    description: 'Summary table of all registered courses',
    validateMarkdown: (t) => t.includes('| ID | Title |')
  },
  {
    name: 'list_courses',
    args: { detail: 'full' },
    description: 'Full syllabus tree with all units and lessons',
    validateMarkdown: (t) => t.includes('# ') && t.includes('### Unit ')
  },
  {
    name: 'get_course',
    args: { id: 'baf3m' },
    description: 'Structured curriculum syllabus outline',
    validateMarkdown: (t) => t.includes('# BAF3M:') && t.includes('## Unit ')
  },
  {
    name: 'get_course',
    args: { id: 'baf3m', includeLessons: false },
    description: 'Lightweight unit header overview without lesson bloat',
    validateMarkdown: (t) => t.includes('# BAF3M:') && t.includes('## Unit 1:') && !t.includes('- [01.01]')
  },
  {
    name: 'list_lessons',
    args: { courseId: 'baf3m', unitNumber: 1 },
    description: 'Markdown table of lessons and available tabs',
    validateMarkdown: (t) => t.includes('| Unit | ID | Title | Type | Available Tabs |')
  },
  {
    name: 'search_course',
    args: { query: 'balance sheet', courseId: 'baf3m', limit: 3 },
    description: 'Ranked search excerpts with scores and blockquotes',
    validateMarkdown: (t) => t.includes('Found ') && t.includes('### [Score:')
  },
  {
    name: 'get_lesson_doc',
    args: { courseId: 'baf3m', lessonId: '01.01', tab: 'summary' },
    description: 'Curated lesson summary document',
    validateMarkdown: (t) => t.includes('# ') || t.includes('## ')
  },
  {
    name: 'get_course_schedule',
    args: { courseId: 'baf3m' },
    description: 'Active study schedule markdown',
    validateMarkdown: (t) => t.includes('# ') || t.includes('Schedule') || t.includes('- [ ]')
  },
  {
    name: 'build_course_schedule',
    args: { courseId: 'baf3m', startDate: '2026-11-01', studyDays: [1, 2, 3, 4, 5], sessionLengthMin: 45 },
    description: 'Deterministic study schedule generator',
    validateMarkdown: (t) => t.includes('# ') && t.includes('- [ ]')
  },
  {
    name: 'create_course',
    args: { id: 'tmp_verify_1', title: 'Verification Course', grade: '11', level: 'Open' },
    description: 'Creation confirmation message',
    validateMarkdown: (t) => t.includes('✓ Course **Verification Course**')
  },
  {
    name: 'delete_course',
    args: { id: 'tmp_verify_1', permanent: true },
    description: 'Deletion confirmation message',
    validateMarkdown: (t) => t.includes('✓ Course **TMP_VERIFY_1** permanently deleted')
  },
  {
    name: 'get_task_status',
    args: { jobId: 'job_verify_123' },
    description: 'Status report or clean error markdown',
    validateMarkdown: (t) => t.includes('not found') || t.includes('### Task Status:')
  }
];

async function runVerification() {
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('         CourseDeck MCP Markdown Output Verification Test Suite           ');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  const proc = spawn('/Applications/CourseDeck.app/Contents/Resources/server', ['--mcp-stdio']);
  const rl = readline.createInterface({ input: proc.stdout, terminal: false });

  let msgId = 1;
  const pending = new Map<number, (res: any) => void>();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const data = JSON.parse(trimmed);
      if (data.id && pending.has(data.id)) {
        const resolve = pending.get(data.id)!;
        pending.delete(data.id);
        resolve(data);
      }
    } catch (e) {
      console.error('Non-JSON line from server:', line);
    }
  });

  function sendRpc(method: string, params: any): Promise<any> {
    const id = msgId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  // 1. Handshake
  const initRes = await sendRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-verifier', version: '1.0.0' }
  });
  console.log('✓ Initialized MCP server:', initRes.result?.serverInfo?.name, `v${initRes.result?.serverInfo?.version}`);
  console.log('✓ Injected Instructions:', initRes.result?.instructions?.slice(0, 60).replace(/\n/g, ' ') + '...\n');

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    const res = await sendRpc('tools/call', {
      name: tc.name,
      arguments: tc.args
    });

    const content = res.result?.content;
    const isError = res.result?.isError;
    const text = content?.[0]?.text ?? (isError ? res.result?.content?.[0]?.text : '');

    // Check if output is raw JSON string instead of markdown
    let isRawJson = false;
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
          isRawJson = true;
        }
      } catch {}
    }

    const isValidMarkdown = !isRawJson && tc.validateMarkdown(text);

    if (isValidMarkdown) {
      passed++;
      console.log(`[PASS] ${tc.name.padEnd(22)} (${tc.description})`);
      const preview = text.slice(0, 90).replace(/\n/g, '↵ ');
      console.log(`       Preview: "${preview}"\n`);
    } else {
      failed++;
      console.error(`[FAIL] ${tc.name.padEnd(22)} (${tc.description})`);
      if (isRawJson) {
        console.error(`       Error: Output was serialized JSON instead of markdown!`);
      } else {
        console.error(`       Error: Output did not match expected markdown structure.`);
      }
      console.error(`       Output: ${text.slice(0, 150)}\n`);
    }
  }

  console.log('───────────────────────────────────────────────────────────────────────────');
  console.log(`Summary: ${passed} passed, ${failed} failed out of ${testCases.length} tool tests.`);
  console.log('───────────────────────────────────────────────────────────────────────────\n');

  proc.kill();
  process.exit(failed === 0 ? 0 : 1);
}

runVerification().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
