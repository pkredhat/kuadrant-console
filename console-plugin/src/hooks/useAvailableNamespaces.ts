import * as React from 'react';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
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

interface Named {
  metadata?: { namespace?: string };
}

/**
 * Populates the Overview page's namespace picker with only the namespaces
 * that actually contain something RHCL-related. Otherwise the dropdown
 * lists every project on the cluster (dozens on real installs) and the
 * operator has to hunt for `rhcl-apps` among openshift-console,
 * openshift-monitoring, kube-system, and the rest.
 *
 * We watch the same CRs the other Overview hooks already do; the SDK
 * dedupes the underlying informer, so this is effectively free — no
 * additional API calls, we just fan out to another consumer of the same
 * cached list.
 *
 * Union of namespaces where any of these exist:
 *   Gateway, HTTPRoute, APIProduct, AuthPolicy, RateLimitPolicy,
 *   TokenRateLimitPolicy, DNSPolicy, TLSPolicy.
 */
export function useAvailableNamespaces(): {
  namespaces: string[];
  loaded: boolean;
} {
  const [gateways, gwLoaded] = useK8sWatchResource<Named[]>({
    groupVersionKind: GatewayGVK,
    isList: true,
  });
  const [routes, rtLoaded] = useK8sWatchResource<Named[]>({
    groupVersionKind: HTTPRouteGVK,
    isList: true,
  });
  const [apiProducts, apLoaded] = useK8sWatchResource<Named[]>({
    groupVersionKind: APIProductGVK,
    isList: true,
  });
  const [authP, authLoaded] = useK8sWatchResource<Named[]>({
    groupVersionKind: AuthPolicyGVK,
    isList: true,
  });
  const [rlp, rlpLoaded] = useK8sWatchResource<Named[]>({
    groupVersionKind: RateLimitPolicyGVK,
    isList: true,
  });
  const [trlp, trlpLoaded] = useK8sWatchResource<Named[]>({
    groupVersionKind: TokenRateLimitPolicyGVK,
    isList: true,
  });
  const [dnsP, dnsLoaded] = useK8sWatchResource<Named[]>({
    groupVersionKind: DNSPolicyGVK,
    isList: true,
  });
  const [tlsP, tlsLoaded] = useK8sWatchResource<Named[]>({
    groupVersionKind: TLSPolicyGVK,
    isList: true,
  });

  const loaded =
    gwLoaded &&
    rtLoaded &&
    apLoaded &&
    authLoaded &&
    rlpLoaded &&
    trlpLoaded &&
    dnsLoaded &&
    tlsLoaded;

  const namespaces = React.useMemo(() => {
    const set = new Set<string>();
    const push = (arr: Named[] | undefined) => {
      for (const r of arr || []) {
        const ns = r?.metadata?.namespace;
        if (ns) set.add(ns);
      }
    };
    push(gateways);
    push(routes);
    push(apiProducts);
    push(authP);
    push(rlp);
    push(trlp);
    push(dnsP);
    push(tlsP);
    return [...set].sort();
  }, [gateways, routes, apiProducts, authP, rlp, trlp, dnsP, tlsP]);

  return { namespaces, loaded };
}
