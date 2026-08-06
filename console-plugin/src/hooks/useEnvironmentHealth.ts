import * as React from 'react';
import {
  K8sResourceCommon,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  GatewayGVK,
  HTTPRouteGVK,
  APIProductGVK,
  AuthPolicyGVK,
  RateLimitPolicyGVK,
  TokenRateLimitPolicyGVK,
  DNSPolicyGVK,
  TLSPolicyGVK,
} from '../models';
import { HTTPRoute } from '../types/httproute';
import {
  EnvironmentHealthCardData,
  HealthSeverity,
} from '../components/overview/types';
import { useGatewayPodHealth } from './useGatewayPodHealth';

interface StatusCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
}

interface ParentStatus {
  conditions?: StatusCondition[];
}

interface ResourceWithConditions extends K8sResourceCommon {
  status?: {
    conditions?: StatusCondition[];
    parents?: ParentStatus[];
    phase?: string;
  };
}

// Gateway / DNSPolicy / TLSPolicy / cert-manager style: top-level
// status.conditions[type=Accepted/Programmed]. Healthy iff both (when
// present) are True. Missing conditions are treated as "not yet
// reported" → warning, since the controller has had time to write them.
function gatewayHealthy(r: ResourceWithConditions): boolean {
  const conds = r.status?.conditions || [];
  if (conds.length === 0) return false;
  const accepted = conds.find((c) => c.type === 'Accepted');
  const programmed = conds.find((c) => c.type === 'Programmed');
  if (!accepted || !programmed) return false;
  return accepted.status === 'True' && programmed.status === 'True';
}

// HTTPRoute carries conditions per parent (gateway listener). It's
// "accepted" if at least one parent has Accepted=True; that mirrors the
// behaviour of the Gateway API conformance suite.
function httpRouteAccepted(r: ResourceWithConditions): boolean {
  const parents = r.status?.parents || [];
  if (parents.length === 0) return false;
  return parents.some((p) =>
    (p.conditions || []).some((c) => c.type === 'Accepted' && c.status === 'True'),
  );
}

type PolicyState = 'enforced' | 'accepted' | 'overridden' | 'failed';
function policyState(r: ResourceWithConditions): PolicyState {
  const conds = r.status?.conditions || [];
  const accepted = conds.find((c) => c.type === 'Accepted');
  const enforced = conds.find((c) => c.type === 'Enforced');
  if (accepted?.status === 'True' && accepted.reason === 'Overridden') return 'overridden';
  if (enforced?.status === 'True') return 'enforced';
  if (accepted?.status === 'True') return 'accepted';
  return 'failed';
}

// APIProduct: status.phase if present, else Ready condition.
type APIProductState = 'published' | 'draft' | 'deprecated' | 'unknown';
function apiProductState(r: ResourceWithConditions): APIProductState {
  const phase = (r.status?.phase || '').toLowerCase();
  if (phase === 'published') return 'published';
  if (phase === 'draft') return 'draft';
  if (phase === 'deprecated') return 'deprecated';
  const conds = r.status?.conditions || [];
  const ready = conds.find((c) => c.type === 'Ready');
  if (ready?.status === 'True') return 'published';
  return 'unknown';
}

interface Result {
  cards: EnvironmentHealthCardData[];
  loaded: boolean;
}

/**
 * Watches the 5 Environment Health groups (Gateways, HTTPRoutes, Policies,
 * Backends, API Products) and projects them into the same
 * `EnvironmentHealthCardData[]` shape the section component expects.
 *
 * Severity rules:
 *   - Gateway:    Accepted=True && Programmed=True → Healthy, else Warning.
 *   - HTTPRoute:  at least one parent.conditions[Accepted=True] → Healthy.
 *   - Policies:   union of the 5 known policy kinds (AuthPolicy, RLP,
 *                 TokenRLP, DNSPolicy, TLSPolicy). Bucketed Enforced /
 *                 Accepted / Overridden via `policyState`.
 *   - Backends:   unique (namespace, name) pairs taken from every
 *                 HTTPRoute.spec.rules[].backendRefs[]. Severity isn't
 *                 wired here (would need EndpointSlice traversal across
 *                 every backend cluster-wide) — surfaced as a single
 *                 "Detected" count. Per-route health is rendered in the
 *                 dedicated BackendHealthWidget further down the page.
 *   - APIProduct: status.phase (Published/Draft/Deprecated) or Ready cond.
 */
/**
 * `namespaceFilter` scopes every card on the Overview page to a single
 * namespace. `null` / `undefined` means "cluster-wide" (the original
 * behaviour). We keep watching cluster-wide and filter after — the
 * SDK's list watch cache is shared across hooks, and post-filtering
 * lets the operator flip between namespaces without any re-fetch.
 */
function inNs<T extends { metadata?: { namespace?: string } }>(
  arr: T[] | undefined,
  ns: string | null | undefined,
): T[] {
  if (!arr) return [];
  if (!ns) return arr;
  return arr.filter((r) => r?.metadata?.namespace === ns);
}

export function useEnvironmentHealth(
  namespaceFilter?: string | null,
): Result {
  const [gateways, gwLoaded] = useK8sWatchResource<ResourceWithConditions[]>({
    groupVersionKind: GatewayGVK,
    isList: true,
  });
  const [routes, rtLoaded] = useK8sWatchResource<HTTPRoute[]>({
    groupVersionKind: HTTPRouteGVK,
    isList: true,
  });
  const [apiProducts, apLoaded] = useK8sWatchResource<ResourceWithConditions[]>({
    groupVersionKind: APIProductGVK,
    isList: true,
  });
  const [authP, authLoaded] = useK8sWatchResource<ResourceWithConditions[]>({
    groupVersionKind: AuthPolicyGVK,
    isList: true,
  });
  const [rlp, rlpLoaded] = useK8sWatchResource<ResourceWithConditions[]>({
    groupVersionKind: RateLimitPolicyGVK,
    isList: true,
  });
  const [trlp, trlpLoaded] = useK8sWatchResource<ResourceWithConditions[]>({
    groupVersionKind: TokenRateLimitPolicyGVK,
    isList: true,
  });
  const [dnsP, dnsLoaded] = useK8sWatchResource<ResourceWithConditions[]>({
    groupVersionKind: DNSPolicyGVK,
    isList: true,
  });
  const [tlsP, tlsLoaded] = useK8sWatchResource<ResourceWithConditions[]>({
    groupVersionKind: TLSPolicyGVK,
    isList: true,
  });

  // Data-plane view — pod health for the workloads actually serving
  // each Gateway CR's listeners. Kuadrant's own status only reflects
  // its controller's happy path; a Programmed Gateway can still be
  // CrashLoopBackOff on the pod side (mTLS trust bundle out of sync,
  // wasm-shim rejecting an Envoy field, etc.).
  const { byGateway: gwPodHealth, loaded: gwPodLoaded } = useGatewayPodHealth();

  return React.useMemo<Result>(() => {
    const loaded =
      gwLoaded &&
      rtLoaded &&
      apLoaded &&
      authLoaded &&
      rlpLoaded &&
      trlpLoaded &&
      dnsLoaded &&
      tlsLoaded &&
      gwPodLoaded;

    const gws = inNs(gateways, namespaceFilter);
    const rts = inNs(routes, namespaceFilter);
    const aps = inNs(apiProducts, namespaceFilter);

    // Gateways — the Kuadrant CR view says "Programmed + Accepted →
    // Healthy", the pod-health hook overrides to Critical/Warning when
    // the underlying pod is misbehaving (crashloop / not ready / recent
    // BackOff event). A single Critical downgrades the card, so
    // Overview surfaces the issue even when just one out of N gateways
    // is unhealthy.
    const podHealthByKey = new Map<string, 'healthy' | 'warning' | 'critical'>();
    for (const h of gwPodHealth) {
      podHealthByKey.set(`${h.gatewayNamespace}/${h.gatewayName}`, h.worstSeverity);
    }
    let gwHealthyCount = 0;
    let gwWarning = 0;
    let gwCritical = 0;
    for (const g of gws) {
      const key = `${g.metadata?.namespace || ''}/${g.metadata?.name || ''}`;
      const podSeverity = podHealthByKey.get(key);
      const crHealthy = gatewayHealthy(g);
      if (podSeverity === 'critical') {
        gwCritical++;
      } else if (!crHealthy || podSeverity === 'warning') {
        gwWarning++;
      } else {
        gwHealthyCount++;
      }
    }
    const gwTotal = gws.length;

    // HTTPRoutes
    const rtHealthy = rts.filter((r) =>
      httpRouteAccepted(r as ResourceWithConditions),
    ).length;
    const rtTotal = rts.length;
    const rtWarning = rtTotal - rtHealthy;

    // Policies (union over 5 kinds)
    const allPolicies = [
      ...inNs(authP, namespaceFilter),
      ...inNs(rlp, namespaceFilter),
      ...inNs(trlp, namespaceFilter),
      ...inNs(dnsP, namespaceFilter),
      ...inNs(tlsP, namespaceFilter),
    ];
    let polEnforced = 0;
    let polAccepted = 0;
    let polOverridden = 0;
    let polFailed = 0;
    for (const p of allPolicies) {
      switch (policyState(p)) {
        case 'enforced':
          polEnforced++;
          break;
        case 'accepted':
          polAccepted++;
          break;
        case 'overridden':
          polOverridden++;
          break;
        default:
          polFailed++;
      }
    }

    // Backends — unique (ns, name) refs across all HTTPRoutes
    const backendSet = new Set<string>();
    for (const r of rts) {
      const ns = r.metadata?.namespace;
      const rules = r.spec?.rules || [];
      for (const rule of rules) {
        for (const ref of rule.backendRefs || []) {
          const refNs = ref.namespace || ns;
          if (ref.name && refNs) backendSet.add(`${refNs}/${ref.name}`);
        }
      }
    }
    const backendsTotal = backendSet.size;

    // API Products
    let apPublished = 0;
    let apDraft = 0;
    let apDeprecated = 0;
    let apUnknown = 0;
    for (const a of aps) {
      switch (apiProductState(a)) {
        case 'published':
          apPublished++;
          break;
        case 'draft':
          apDraft++;
          break;
        case 'deprecated':
          apDeprecated++;
          break;
        default:
          apUnknown++;
      }
    }

    const cards: EnvironmentHealthCardData[] = [
      {
        id: 'gateways',
        title: 'Gateways',
        total: gwTotal,
        breakdown: [
          { label: 'Healthy', count: gwHealthyCount, severity: 'healthy' as HealthSeverity },
          ...(gwWarning > 0
            ? [{ label: 'Warning', count: gwWarning, severity: 'warning' as HealthSeverity }]
            : []),
          ...(gwCritical > 0
            ? [{ label: 'Critical', count: gwCritical, severity: 'critical' as HealthSeverity }]
            : []),
        ],
        href: '/connectivity-link/gateways',
      },
      {
        id: 'httproutes',
        title: 'HTTPRoutes',
        total: rtTotal,
        breakdown: [
          { label: 'Healthy', count: rtHealthy, severity: 'healthy' as HealthSeverity },
          { label: 'Warning', count: rtWarning, severity: 'warning' as HealthSeverity },
        ],
        href: '/connectivity-link/httproutes',
      },
      {
        id: 'policies',
        title: 'Policies',
        total: allPolicies.length,
        breakdown: [
          { label: 'Enforced', count: polEnforced, severity: 'healthy' as HealthSeverity },
          { label: 'Accepted', count: polAccepted, severity: 'accepted' as HealthSeverity },
          { label: 'Overridden', count: polOverridden, severity: 'info' as HealthSeverity },
          ...(polFailed > 0
            ? [{ label: 'Failed', count: polFailed, severity: 'critical' as HealthSeverity }]
            : []),
        ],
        href: '/connectivity-link/policies',
      },
      {
        id: 'backends',
        title: 'Backends',
        total: backendsTotal,
        breakdown: [
          { label: 'Detected', count: backendsTotal, severity: 'info' as HealthSeverity },
        ],
        href: '/connectivity-link/httproutes',
      },
      {
        id: 'api-products',
        title: 'API Products',
        total: aps.length,
        breakdown: [
          { label: 'Published', count: apPublished, severity: 'healthy' as HealthSeverity },
          { label: 'Draft', count: apDraft, severity: 'info' as HealthSeverity },
          { label: 'Deprecated', count: apDeprecated, severity: 'warning' as HealthSeverity },
          ...(apUnknown > 0
            ? [{ label: 'Unknown', count: apUnknown, severity: 'warning' as HealthSeverity }]
            : []),
        ],
        href: '/connectivity-link/api-products',
      },
    ];

    return { cards, loaded };
  }, [
    gateways,
    routes,
    apiProducts,
    authP,
    rlp,
    trlp,
    dnsP,
    tlsP,
    gwPodHealth,
    gwLoaded,
    rtLoaded,
    apLoaded,
    authLoaded,
    rlpLoaded,
    trlpLoaded,
    dnsLoaded,
    tlsLoaded,
    gwPodLoaded,
    namespaceFilter,
  ]);
}
