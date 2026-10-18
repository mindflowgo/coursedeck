import { McpServer, StreamableHttpTransport } from 'mcp-lite';
import { z } from 'zod';
import { registerMcpTools } from './tools';
import { authenticateMcpRequest } from './auth';

export const mcp = new McpServer({
  name: 'coursedeck',
  version: '0.1.0',
  schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType)
});

// Register all 11 core tools
registerMcpTools(mcp);

// Bind Streamable HTTP transport
const transport = new StreamableHttpTransport();
export const mcpStreamableHandler = transport.bind(mcp);

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
