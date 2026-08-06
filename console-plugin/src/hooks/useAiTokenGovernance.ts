import * as React from 'react';
import { consoleFetch, useK8sWatchResource, K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { TokenRateLimitPolicyGVK } from '../models';
import { usePollingEffect } from './usePollingEffect';

/**
 * The AI-gateway "token governance" lens data — the real, honest signals
 * available on this cluster for an OpenAI-compatible route governed by a
 * Kuadrant `TokenRateLimitPolicy`.
 *
 * "Real-only, honest gaps":
 *   - token throughput  → `bank_ai_tokens_total` (the app's usage counter) —
 *     GLOBAL only, because the app reports every call under consumer "anonymous"
 *     (the x-consumer-id doesn't reach it), so there is no truthful per-consumer
 *     token split here. Per-consumer REQUESTS do exist (istio x-consumer-id) and
 *     are surfaced by the Cost hook.
 *   - the budget         → read straight off the TokenRateLimitPolicy spec.
 *   - throttling (429)   → istio_requests_total on the governed route.
 * The Limitador-native `authorized_hits` counter is intentionally NOT used: it
 * comes back empty for this route/version, so relying on it would fabricate a
 * signal that isn't there.
 */

export interface AiTokenPolicy {
  name: string;
  namespace: string;
  /** Token budget value (per window). */
  limit: number;
  /** Raw window, e.g. "1m". */
  window: string;
  /** Window in seconds. */
  windowSeconds: number;
  /** Budget normalised to tokens/min for the gauge. */
  limitPerMin: number;
  enforced: boolean;
  accepted: boolean;
  /** HTTPRoute the policy targets. */
  routeName: string;
  routeNamespace: string;
  /** Path predicate the token limit applies to (best-effort from `when`). */
  pathHint: string | null;
}

export interface AiTokenGovernance {
  policies: AiTokenPolicy[];
  primary: AiTokenPolicy | null;
  /** tokens/min (global, from bank_ai_tokens_total). */
  tokensPerMin: number | null;
  tokensSeries: number[];
  /** requests/min on the governed route. */
  reqPerMin: number | null;
  reqSeries: number[];
  /** throttled (429) requests/min on the governed route. */
  throttledPerMin: number | null;
  /** 0-100 tokens/min ÷ limitPerMin. */
  budgetPct: number | null;
  loaded: boolean;
  metricsAvailable: boolean;
}

function parseWindowSeconds(w: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec((w || '').trim());
  if (!m) return 60;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  return unit === 's' ? n : unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n * 86400;
}

interface TrlpSpec {
  targetRef?: { kind?: string; name?: string; namespace?: string };
  limits?: Record<
    string,
    { rates?: { limit?: number; window?: string }[]; when?: { predicate?: string }[] }
  >;
}

function toPolicy(cr: K8sResourceCommon & { spec?: TrlpSpec; status?: { conditions?: { type: string; status: string }[] } }): AiTokenPolicy | null {
  const spec = cr.spec;
  if (!spec) return null;
  const ns = cr.metadata?.namespace || '';
  const limits = spec.limits || {};
  // Take the first limit's first rate as the headline budget.
  const firstLimit = Object.values(limits)[0];
  const rate = firstLimit?.rates?.[0];
  const limit = rate?.limit ?? 0;
  const window = rate?.window ?? '1m';
  const windowSeconds = parseWindowSeconds(window);
  const pathPred = firstLimit?.when?.map((w) => w.predicate).find((p) => p && p.includes('path'));
  const pathMatch = pathPred?.match(/["']([^"']*\/[^"']*)["']/);
  const conds = cr.status?.conditions || [];
  return {
    name: cr.metadata?.name || '',
    namespace: ns,
    limit,
    window,
    windowSeconds,
    limitPerMin: windowSeconds > 0 ? (limit / windowSeconds) * 60 : limit,
    enforced: conds.some((c) => c.type === 'Enforced' && c.status === 'True'),
    accepted: conds.some((c) => c.type === 'Accepted' && c.status === 'True'),
    routeName: spec.targetRef?.name || '',
    routeNamespace: spec.targetRef?.namespace || ns,
    pathHint: pathMatch ? pathMatch[1] : null,
  };
}

async function q(query: string, signal: AbortSignal): Promise<number | null> {
  try {
    const url = `/api/prometheus/api/v1/query?query=${encodeURIComponent(query)}`;
    const r = await consoleFetch(url, { signal }, 12_000);
    const j = await r.json();
    const v = j?.data?.result?.[0]?.value?.[1];
    return v != null ? parseFloat(v) : null;
  } catch {
    return null;
  }
}
async function qRange(query: string, signal: AbortSignal): Promise<number[]> {
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 3600;
    const params = new URLSearchParams({ query, start: String(start), end: String(end), step: '120' });
    const r = await consoleFetch(`/api/prometheus/api/v1/query_range?${params}`, { signal }, 15_000);
    const j = await r.json();
    return (j?.data?.result?.[0]?.values || []).map(([, v]: [number, string]) => parseFloat(v) || 0);
  } catch {
    return [];
  }
}

export function useAiTokenGovernance(): AiTokenGovernance {
  const [crs, loaded] = useK8sWatchResource<(K8sResourceCommon & { spec?: TrlpSpec })[]>({
    groupVersionKind: TokenRateLimitPolicyGVK,
    isList: true,
  });

  const policies = React.useMemo(
    () => (crs || []).map(toPolicy).filter((p): p is AiTokenPolicy => !!p),
    [crs],
  );
  // Primary = the enforced one, else the first.
  const primary = policies.find((p) => p.enforced) || policies[0] || null;
  const routeSel = primary
    ? `route_name=~"${primary.routeNamespace}\\\\.${primary.routeName}\\\\..*", reporter="source"`
    : null;

  const [m, setM] = React.useState<{
    tokensPerMin: number | null;
    reqPerMin: number | null;
    throttledPerMin: number | null;
    tokensSeries: number[];
    reqSeries: number[];
    available: boolean;
    ready: boolean;
  }>({ tokensPerMin: null, reqPerMin: null, throttledPerMin: null, tokensSeries: [], reqSeries: [], available: true, ready: false });

  usePollingEffect(
    async (signal) => {
      const [tokensPerMin, reqPerMin, throttledPerMin, tokensSeries, reqSeries] = await Promise.all([
        q('sum(rate(bank_ai_tokens_total[5m])) * 60', signal),
        routeSel ? q(`sum(rate(istio_requests_total{${routeSel}}[5m])) * 60`, signal) : Promise.resolve(null),
        routeSel ? q(`sum(rate(istio_requests_total{${routeSel}, response_code="429"}[5m])) * 60`, signal) : Promise.resolve(null),
        qRange('sum(rate(bank_ai_tokens_total[5m])) * 60', signal),
        routeSel ? qRange(`sum(rate(istio_requests_total{${routeSel}}[5m])) * 60`, signal) : Promise.resolve([]),
      ]);
      if (signal.aborted) return;
      setM({ tokensPerMin, reqPerMin, throttledPerMin, tokensSeries, reqSeries, available: true, ready: true });
    },
    [routeSel],
    { intervalMs: 30_000, enabled: true },
  );

  const budgetPct =
    primary && primary.limitPerMin > 0 && m.tokensPerMin != null
      ? Math.min(100, (m.tokensPerMin / primary.limitPerMin) * 100)
      : null;

  return {
    policies,
    primary,
    tokensPerMin: m.tokensPerMin,
    tokensSeries: m.tokensSeries,
    reqPerMin: m.reqPerMin,
    reqSeries: m.reqSeries,
    throttledPerMin: m.throttledPerMin,
    budgetPct,
    loaded: loaded && m.ready,
    metricsAvailable: m.available,
  };
}
