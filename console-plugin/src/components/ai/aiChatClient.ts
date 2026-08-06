import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';

/**
 * Minimal OpenAI-compatible chat client for the in-console AI playground.
 * The browser can't call the gateway directly (cross-origin), so the request
 * goes through the console plugin proxy — the `ai-chat` alias on the
 * ConsolePlugin CR, which the console proxies (same-origin) to a TLS-fronted
 * nginx that forwards to the RHCL gateway with the banking route's Host header.
 * So auth (AuthPolicy) AND the TokenRateLimitPolicy apply exactly as they would
 * for any real client — that's what makes the 429 in the playground real.
 */
const PROXY = '/api/proxy/plugin/kuadrant-console/ai-chat';

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResult {
  status: number;
  /** True when the gateway rejected the call over the token budget. */
  throttled: boolean;
  content?: string;
  usage?: ChatUsage;
  /** Which cluster/instance served it (the mock echoes this). */
  cloud?: string;
  error?: string;
}

function statusFromError(e: unknown): number | null {
  const anyE = e as { response?: { status?: number }; status?: number } | undefined;
  if (typeof anyE?.response?.status === 'number') return anyE.response.status;
  if (typeof anyE?.status === 'number') return anyE.status;
  const m = String(e).match(/\b(429|401|403|5\d\d)\b/);
  return m ? parseInt(m[1], 10) : null;
}

export async function chatCompletion(apiKey: string, prompt: string): Promise<ChatResult> {
  const body = JSON.stringify({
    model: 'banking-mock-gpt',
    messages: [{ role: 'user', content: prompt }],
  });
  try {
    const resp = await consoleFetch(
      `${PROXY}/api/v1/chat/completions`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'api-key': apiKey }, body },
      20_000,
    );
    if (resp.status === 429) return { status: 429, throttled: true };
    const j = await resp.json();
    return {
      status: resp.status,
      throttled: false,
      content: j?.choices?.[0]?.message?.content,
      usage: j?.usage,
      cloud: j?.cloud,
    };
  } catch (e) {
    // consoleFetch rejects on non-2xx — recover the status so a real 429
    // (token budget exceeded) reads as a throttle, not a generic failure.
    const status = statusFromError(e);
    if (status === 429) return { status: 429, throttled: true };
    return { status: status ?? 0, throttled: false, error: e instanceof Error ? e.message : String(e) };
  }
}
