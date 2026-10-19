import { McpServer, StreamableHttpTransport } from 'mcp-lite';
import { z } from 'zod';
import { registerMcpTools } from './tools';
import { registerMcpResources } from './resources';
import { authenticateMcpRequest } from './auth';
import { PromptService } from '../../app/src/lib/server/prompts';

export const mcp = new McpServer({
  name: 'coursedeck',
  version: '0.1.0',
  schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType)
});

// Register all core tools and resources
registerMcpTools(mcp);
registerMcpResources(mcp);

// Bind Streamable HTTP transport
const transport = new StreamableHttpTransport();
const baseHandler = transport.bind(mcp);

/**
 * Reads MCP instructions dynamically from the prompt template ('mcp_prompt_instructions').
 * No hardcoded fallback strings; managed purely through prompt files / Prompts manager.
 */
export function getMcpInstructions(): string | undefined {
  return PromptService.getPrompt('mcp_prompt_instructions')?.content?.trim();
}

export async function mcpStreamableHandler(req: Request): Promise<Response> {
  let isInit = false;
  try {
    const cloned = req.clone();
    const body = await cloned.json();
    if (body?.method === 'initialize') {
      isInit = true;
    }
  } catch {
    // Ignore body parse errors for non-json
  }

  const res = await baseHandler(req);

  if (isInit) {
    try {
      const resText = await res.text();
      const resJson = JSON.parse(resText);
      const instructions = getMcpInstructions();
      if (resJson?.result && typeof resJson.result === 'object' && instructions) {
        resJson.result.instructions = instructions;
      }
      return new Response(JSON.stringify(resJson), {
        status: res.status,
        headers: res.headers
      });
    } catch {
      // Fallback to base response if json parsing fails
    }
  }

  return res;
}

/**
 * HTTP handler with security boundary (Host, Origin, Token validation).
 */
export async function handleMcpHttpRequest(req: Request): Promise<Response> {
  const auth = authenticateMcpRequest(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status || 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return await mcpStreamableHandler(req);
}
