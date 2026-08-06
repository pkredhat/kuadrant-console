import * as React from 'react';
import {
  K8sResourceCommon,
  consoleFetch,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  AuthPolicyGVK,
  RateLimitPolicyGVK,
  TokenRateLimitPolicyGVK,
  DNSPolicyGVK,
  TLSPolicyGVK,
  APIKeyGVK,
  policyResourceURL,
} from '../models';
import { APIKey, getAPIKeyPhase } from '../types';
import { NeedsAttentionItem } from '../components/overview/types';
import { usePollingEffect } from './usePollingEffect';
import { useGatewayPodHealth } from './useGatewayPodHealth';

interface StatusCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

interface PolicyResource extends K8sResourceCommon {
  status?: { conditions?: StatusCondition[] };
}

function findCondition(
  conds: StatusCondition[] | undefined,
  type: string,
): StatusCondition | undefined {
  return (conds || []).find((c) => c.type === type);
}

// Human-friendly relative time. Keeps the same vocabulary as the mock
// ("10m ago", "1h ago", "2d ago") so the panel reads consistently with
// timestamps that originate from the cluster vs ones derived from
// Prometheus snapshots.
function relativeAgo(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return 'just now';
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface PerGatewayErrorRate {
  gateway: string;
  namespace: string;
  errorPct: number;
}

const GATEWAY_ERROR_QUERY =
  '100 * sum by (source_workload, source_workload_namespace) ' +
  '(rate(istio_requests_total{reporter="source",response_code=~"5.."}[5m])) ' +
  '/ sum by (source_workload, source_workload_namespace) ' +
  '(rate(istio_requests_total{reporter="source"}[5m]))';

const ERROR_THRESHOLD_PCT = 5;

interface UseNeedsAttentionResult {
  items: NeedsAttentionItem[];
  loaded: boolean;
}

/**
 * Synthesizes the Needs Attention panel from live cluster + Prometheus state:
 *
 *   - Policies whose status is Accepted=True but Enforced=False
 *     ("accepted but not enforced" — usually means no target attached) →
 *     surfaced as a warning per policy.
 *   - Policies whose Accepted condition is False or missing → critical.
 *   - Gateways whose 5-minute error rate exceeds the threshold (5%) →
 *     critical, one item per affected gateway.
 *   - APIKey resources in phase=Pending → a single info item with the
 *     count (we collapse instead of spamming the panel).
 *
 * Items are returned in insertion order; the panel sorts critical →
 * warning → info internally, so we don't have to.
 */
function inNs<T extends { metadata?: { namespace?: string } }>(
  arr: T[] | undefined,
  ns: string | null | undefined,
): T[] {
  if (!arr) return [];
  if (!ns) return arr;
  return arr.filter((r) => r?.metadata?.namespace === ns);
}

export function useNeedsAttention(
  namespaceFilter?: string | null,
): UseNeedsAttentionResult {
  const [authP, authLoaded] = useK8sWatchResource<PolicyResource[]>({
    groupVersionKind: AuthPolicyGVK,
    isList: true,
  });
  const [rlp, rlpLoaded] = useK8sWatchResource<PolicyResource[]>({
    groupVersionKind: RateLimitPolicyGVK,
    isList: true,
  });
  const [trlp, trlpLoaded] = useK8sWatchResource<PolicyResource[]>({
    groupVersionKind: TokenRateLimitPolicyGVK,
    isList: true,
  });
  const [dnsP, dnsLoaded] = useK8sWatchResource<PolicyResource[]>({
    groupVersionKind: DNSPolicyGVK,
    isList: true,
  });
  const [tlsP, tlsLoaded] = useK8sWatchResource<PolicyResource[]>({
    groupVersionKind: TLSPolicyGVK,
    isList: true,
  });
  const [apiKeys, apiKeysLoaded] = useK8sWatchResource<APIKey[]>({
    groupVersionKind: APIKeyGVK,
    isList: true,
  });

  // Gateway data-plane pod health — restart storms, sustained
  // not-ready, recent Warning events (BackOff / Unhealthy / Failed).
  // Complements the Kuadrant CR view (Programmed + Accepted) with the
  // "is the pod actually serving traffic?" perspective.
  const { byGateway: gwPodHealth, loaded: gwPodLoaded } = useGatewayPodHealth();

  const [gatewayErrors, setGatewayErrors] = React.useState<PerGatewayErrorRate[]>([]);
  const [gwErrorsLoaded, setGwErrorsLoaded] = React.useState(false);

  usePollingEffect(
    async (signal) => {
      try {
        const url = `/api/prometheus/api/v1/query?query=${encodeURIComponent(GATEWAY_ERROR_QUERY)}`;
        const r = await consoleFetch(url, { signal }, 10_000);
        const json = await r.json();
        const results = json?.data?.result || [];
        const rows: PerGatewayErrorRate[] = [];
        for (const row of results) {
          const v = row?.value?.[1];
          const pct = v ? parseFloat(v) : NaN;
          if (Number.isFinite(pct) && pct > ERROR_THRESHOLD_PCT) {
            rows.push({
              gateway: row?.metric?.source_workload || '',
              namespace: row?.metric?.source_workload_namespace || '',
              errorPct: pct,
            });
          }
        }
        if (signal.aborted) return;
        setGatewayErrors(rows);
        setGwErrorsLoaded(true);
      } catch {
        if (signal.aborted) return;
        setGatewayErrors([]);
        setGwErrorsLoaded(true);
      }
    },
    [],
    { intervalMs: 60_000, enabled: true },
  );

  return React.useMemo<UseNeedsAttentionResult>(() => {
    const loaded =
      authLoaded &&
      rlpLoaded &&
      trlpLoaded &&
      dnsLoaded &&
      tlsLoaded &&
      apiKeysLoaded &&
      gwErrorsLoaded &&
      gwPodLoaded;

    const items: NeedsAttentionItem[] = [];

    type PolicyWithKind = { p: PolicyResource; kind: string };
    const allPolicies: PolicyWithKind[] = [
      ...inNs(authP, namespaceFilter).map((p) => ({ p, kind: 'AuthPolicy' })),
      ...inNs(rlp, namespaceFilter).map((p) => ({ p, kind: 'RateLimitPolicy' })),
      ...inNs(trlp, namespaceFilter).map((p) => ({ p, kind: 'TokenRateLimitPolicy' })),
      ...inNs(dnsP, namespaceFilter).map((p) => ({ p, kind: 'DNSPolicy' })),
      ...inNs(tlsP, namespaceFilter).map((p) => ({ p, kind: 'TLSPolicy' })),
    ];

    for (const { p, kind } of allPolicies) {
      const conds = p.status?.conditions;
      const accepted = findCondition(conds, 'Accepted');
      const enforced = findCondition(conds, 'Enforced');
      const name = p.metadata?.name || '';
      const ns = p.metadata?.namespace || '';
      const href = policyResourceURL(kind, ns, name);

      if (!accepted || accepted.status !== 'True') {
        items.push({
          id: `pol-failed-${kind}-${ns}-${name}`,
          severity: 'critical',
          title: `${kind} ${name} is not accepted`,
          detail:
            accepted?.message ||
            accepted?.reason ||
            'The controller did not accept this policy.',
          href,
          occurredAt: relativeAgo(accepted?.lastTransitionTime || p.metadata?.creationTimestamp),
        });
        continue;
      }

      if (enforced?.status !== 'True' && accepted.reason !== 'Overridden') {
        items.push({
          id: `pol-not-enforced-${kind}-${ns}-${name}`,
          severity: 'warning',
          title: `${kind} ${name} is not enforced`,
          detail:
            enforced?.message ||
            enforced?.reason ||
            'Accepted but no target is currently attached.',
          href,
          occurredAt: relativeAgo(enforced?.lastTransitionTime || accepted.lastTransitionTime),
        });
      }
    }

    // When scoped to a namespace, only surface gateway-error / gateway-pod
    // signals whose gateway lives in that namespace. Gateways in another
    // namespace shouldn't clutter the current scope's Needs Attention.
    const gwInScope = (g: { namespace: string }) =>
      !namespaceFilter || g.namespace === namespaceFilter;

    for (const g of gatewayErrors.filter(gwInScope)) {
      items.push({
        id: `gw-errors-${g.namespace}-${g.gateway}`,
        severity: 'critical',
        title: `${g.errorPct.toFixed(1)}% errors detected on ${g.gateway}`,
        detail: `Error rate is higher than the configured threshold (${ERROR_THRESHOLD_PCT}%)`,
        href: `/k8s/ns/${g.namespace}/gateway.networking.k8s.io~v1~Gateway/${g.gateway}`,
        occurredAt: 'now',
      });
    }

    // Gateway pod-level failures. Each signal (crashloop / not-ready /
    // recent Warning event) becomes its own item so the operator can
    // click straight to the affected pod. Grouping by pod within a
    // single item would hide the fact that a gateway with two crashing
    // pods and one merely-not-ready pod has TWO problems, not one.
    for (const h of gwPodHealth.filter(
      (h) => !namespaceFilter || h.gatewayNamespace === namespaceFilter,
    )) {
      const gwUrl = `/k8s/ns/${h.gatewayNamespace}/gateway.networking.k8s.io~v1~Gateway/${h.gatewayName}`;
      for (const s of h.signals) {
        const podUrl = `/k8s/ns/${s.podNamespace}/pods/${s.podName}`;
        if (s.kind === 'restart-storm') {
          items.push({
            id: `gw-pod-restart-${h.gatewayNamespace}-${h.gatewayName}-${s.podName}`,
            severity: 'critical',
            title: `Gateway ${h.gatewayName} pod is crashing (${s.podName})`,
            detail: s.message,
            href: podUrl,
            occurredAt: 'now',
          });
        } else if (s.kind === 'not-ready') {
          items.push({
            id: `gw-pod-not-ready-${h.gatewayNamespace}-${h.gatewayName}-${s.podName}`,
            severity: 'warning',
            title: `Gateway ${h.gatewayName} pod is not Ready (${s.podName})`,
            detail: s.message,
            href: podUrl,
            occurredAt: 'now',
          });
        } else if (s.kind === 'recent-warning') {
          items.push({
            id: `gw-pod-event-${h.gatewayNamespace}-${h.gatewayName}-${s.podName}-${s.eventReason || 'warn'}`,
            severity: s.severity,
            title: `Gateway ${h.gatewayName}: ${s.eventReason || 'Warning'} on ${s.podName}`,
            detail: s.message,
            href: podUrl,
            occurredAt: relativeAgo(s.observedAt) || 'now',
          });
        }
      }
      // If a gateway has zero pods at all, the CR is deployed but
      // nothing is serving. Flag it — that's the "Gateway Programmed
      // but no data plane" case, common after a bad rollout.
      if (h.podCount === 0) {
        items.push({
          id: `gw-no-pods-${h.gatewayNamespace}-${h.gatewayName}`,
          severity: 'critical',
          title: `Gateway ${h.gatewayName} has no pods`,
          detail:
            'The Gateway CR exists but no pod is running with the matching gateway-name label.',
          href: gwUrl,
          occurredAt: 'now',
        });
      }
    }

    const pendingApiKeys = inNs(apiKeys, namespaceFilter).filter((k) => getAPIKeyPhase(k) === 'Pending');
    if (pendingApiKeys.length > 0) {
      items.push({
        id: 'apikeys-pending',
        severity: 'info',
        title: `${pendingApiKeys.length} API ${pendingApiKeys.length === 1 ? 'key' : 'keys'} waiting approval`,
        detail: 'Require your attention',
        href: '/connectivity-link/apikeys',
        occurredAt: relativeAgo(
          pendingApiKeys
            .map((k) => k.metadata?.creationTimestamp)
            .filter((t): t is string => !!t)
            .sort()[0],
        ),
      });
    }

    return { items, loaded };
  }, [
    authP,
    rlp,
    trlp,
    dnsP,
    tlsP,
    apiKeys,
    gatewayErrors,
    gwPodHealth,
    authLoaded,
    rlpLoaded,
    trlpLoaded,
    dnsLoaded,
    tlsLoaded,
    apiKeysLoaded,
    gwErrorsLoaded,
    gwPodLoaded,
    namespaceFilter,
  ]);
}
