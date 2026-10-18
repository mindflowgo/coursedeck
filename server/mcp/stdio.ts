import readline from 'node:readline';
import { mcpStreamableHandler } from './server';

/**
 * Runs the MCP server in Stdio mode.
 * stdout is strictly reserved for newline-delimited JSON-RPC messages.
 * All diagnostics and error logging are routed to stderr.
 */
export async function runMcpStdio(): Promise<void> {
  console.error('[MCP Stdio] Initializing CourseDeck MCP Stdio bridge...');

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const req = new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: trimmed
      });

      const res = await mcpStreamableHandler(req);
      const text = await res.text();

      // If the method was a notification or empty response, no stdout response needed
      if (text && text.trim().length > 0) {
        process.stdout.write(text + '\n');
      }
    } catch (err: any) {
      console.error('[MCP Stdio Error]', err);
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: err.message || 'Internal error'
        }
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  });

  rl.on('close', () => {
    console.error('[MCP Stdio] Stdin closed, exiting.');
    process.exit(0);
  });
}
