import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';

/**
 * Minimal MCP (Model Context Protocol) client for the in-console playground.
 *
 * The browser can't reach the MCP broker directly (cross-origin), so every call
 * goes through the console's own plugin proxy — declared in the ConsolePlugin CR
 * as the `mcp-broker` alias, which the console proxies (same-origin) to a
 * TLS-fronted `mcp-broker` Service. The wire protocol is MCP's JSON-RPC over
 * Streamable HTTP: `initialize` returns an `mcp-session-id` header that every
 * subsequent request must echo; responses may come back as JSON or as an SSE
 * (`text/event-stream`) frame, so we handle both.
 */

const PROXY = '/api/proxy/plugin/kuadrant-console/mcp-broker/mcp';
const PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** Extract the JSON-RPC payload whether the body is plain JSON or an SSE frame. */
function parseBody(text: string): { result?: unknown; error?: { message?: string } } | null {
  const dataLines = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  const payload = dataLines.length ? dataLines.join('') : text;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function rpc(
  session: string | null,
  body: Record<string, unknown>,
): Promise<{ sessionId: string | null; parsed: { result?: unknown; error?: { message?: string } } | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (session) headers['mcp-session-id'] = session;

  const resp = await consoleFetch(PROXY, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  });
  const sessionId = resp.headers.get('mcp-session-id') || session;
  const text = await resp.text();
  return { sessionId, parsed: parseBody(text) };
}

/** Handshake: initialize + `notifications/initialized`. Returns the session id. */
export async function mcpInitialize(): Promise<string | null> {
  const { sessionId } = await rpc(null, {
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'rhcl-console', version: '1.0' },
    },
  });
  if (sessionId) {
    await rpc(sessionId, { method: 'notifications/initialized' });
  }
  return sessionId;
}

/** The federated tool list the broker exposes (already prefixed per server). */
export async function mcpListTools(session: string): Promise<McpTool[]> {
  const { parsed } = await rpc(session, { id: 2, method: 'tools/list' });
  if (parsed?.error) throw new Error(parsed.error.message || 'tools/list failed');
  const result = parsed?.result as { tools?: McpTool[] } | undefined;
  return result?.tools || [];
}

/**
 * The federated prompt list the broker exposes. Prompts are federated per
 * server the same way tools are, so callers filter by the server's prefix.
 * Servers without prompts simply return an empty list (or the broker answers
 * `-32601 Method not found`, which we treat as "no prompts").
 */
export async function mcpListPrompts(session: string): Promise<McpPrompt[]> {
  const { parsed } = await rpc(session, { id: 4, method: 'prompts/list' });
  // A broker that doesn't implement prompts returns a JSON-RPC error — that's
  // "no prompts", not a failure worth surfacing.
  if (parsed?.error) return [];
  const result = parsed?.result as { prompts?: McpPrompt[] } | undefined;
  return result?.prompts || [];
}

/** Invoke a tool and return its raw result. */
export async function mcpCallTool(
  session: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { parsed } = await rpc(session, {
    id: 3,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (parsed?.error) throw new Error(parsed.error.message || 'tools/call failed');
  return parsed?.result;
}
