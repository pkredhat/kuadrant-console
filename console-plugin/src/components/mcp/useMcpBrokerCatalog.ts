import * as React from 'react';
import { mcpInitialize, mcpListTools, mcpListPrompts, McpTool, McpPrompt } from './mcpBrokerClient';

export type McpCatalogStatus = 'connecting' | 'ready' | 'error';

export interface McpBrokerCatalog {
  status: McpCatalogStatus;
  /** Live broker session id — reusable by the playground so it doesn't reconnect. */
  session: string | null;
  /** This server's federated tools (filtered to `prefix`). */
  tools: McpTool[];
  /** This server's federated prompts (filtered to `prefix`). */
  prompts: McpPrompt[];
  error: string | null;
  retry: () => void;
}

/**
 * Live catalog for one MCP server: connects to the broker through the console
 * proxy once on mount and reads its federated tools + prompts (`initialize →
 * tools/list → prompts/list`), filtered to the server's `prefix`. This is the
 * only place the *actual* tool/prompt inventory can come from — the
 * MCPServerRegistration CR status is conditions-only.
 *
 * Real data, honest gaps: when the broker proxy isn't wired (no `mcp-broker`
 * alias / MCP Gateway not installed) the hook lands in `error` and the
 * dashboard shows N/A tiles + a clear reason, never a fabricated count.
 */
export function useMcpBrokerCatalog(prefix?: string): McpBrokerCatalog {
  const [status, setStatus] = React.useState<McpCatalogStatus>('connecting');
  const [session, setSession] = React.useState<string | null>(null);
  const [tools, setTools] = React.useState<McpTool[]>([]);
  const [prompts, setPrompts] = React.useState<McpPrompt[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setStatus('connecting');
    setError(null);
    (async () => {
      try {
        const s = await mcpInitialize();
        if (!s) throw new Error('The broker did not return a session id.');
        const [allTools, allPrompts] = await Promise.all([mcpListTools(s), mcpListPrompts(s)]);
        if (cancelled) return;
        const ft = prefix ? allTools.filter((x) => x.name.startsWith(prefix)) : allTools;
        const fp = prefix ? allPrompts.filter((x) => x.name.startsWith(prefix)) : allPrompts;
        setSession(s);
        setTools(ft);
        setPrompts(fp);
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefix, nonce]);

  const retry = React.useCallback(() => setNonce((n) => n + 1), []);

  return { status, session, tools, prompts, error, retry };
}
