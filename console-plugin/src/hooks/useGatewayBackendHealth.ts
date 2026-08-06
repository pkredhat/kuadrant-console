import * as React from 'react';
import {
  useK8sWatchResource,
  useK8sWatchResources,
  WatchK8sResources,
} from '@openshift-console/dynamic-plugin-sdk';
import { HTTPRouteGVK, EndpointSliceGVK, ServiceGVK } from '../models';
import { HTTPRoute } from '../types/httproute';
import { EndpointSlice, Service } from '../types/backends';

export interface GatewayBackendHealth {
  /** Distinct backend Services referenced by every HTTPRoute on the gateway. */
  serviceCount: number;
  /** How many of those Services actually exist right now. */
  servicesReady: number;
  /** Ready endpoints across all backend Services (`ep.conditions.ready`). */
  endpointsReady: number;
  /** Total endpoints (ready + not-ready) across all backend Services. */
  endpointsTotal: number;
  loaded: boolean;
}

/**
 * Aggregate backend/endpoint health for a whole Gateway — the multi-route
 * companion to `useBackendsStatus` (which resolves a single route). Collects
 * the distinct backend Services across every HTTPRoute attached to the
 * gateway and counts ready endpoints from their EndpointSlices via one
 * dynamic `useK8sWatchResources` map (same pattern as `useBackendsStatus`, so
 * a variable number of Services never breaks the rules of hooks).
 *
 * Endpoint readiness (`ep.conditions.ready === true`) is the closest the K8s
 * API gets to "the backend is alive" without an HTTP probe — real signal, no
 * synthesis.
 */
export function useGatewayBackendHealth(
  gatewayName: string,
  gatewayNamespace: string,
): GatewayBackendHealth {
  const [routes, routesLoaded] = useK8sWatchResource<HTTPRoute[]>({
    groupVersionKind: HTTPRouteGVK,
    isList: true,
  });

  // Distinct backend Services (ns/name) across every route attached to the
  // gateway via parentRefs. Stabilised on content so status heartbeats on the
  // routes don't re-key the Service/EndpointSlice watches every few seconds.
  const servicesKey = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of routes || []) {
      const attaches = (r.spec?.parentRefs || []).some((ref) => {
        if (ref.kind && ref.kind !== 'Gateway') return false;
        const ns = ref.namespace || r.metadata?.namespace;
        return ref.name === gatewayName && ns === gatewayNamespace;
      });
      if (!attaches) continue;
      const routeNs = r.metadata?.namespace || '';
      for (const rule of r.spec?.rules || []) {
        for (const b of rule.backendRefs || []) {
          set.add(`${b.namespace || routeNs}/${b.name}`);
        }
      }
    }
    return Array.from(set).sort().join('|');
  }, [routes, gatewayName, gatewayNamespace]);

  const services = React.useMemo<{ namespace: string; name: string }[]>(() => {
    if (!servicesKey) return [];
    return servicesKey.split('|').map((k) => {
      const [namespace, name] = k.split('/');
      return { namespace, name };
    });
     
  }, [servicesKey]);

  const serviceWatches: WatchK8sResources<Record<string, Service>> = React.useMemo(() => {
    const map: WatchK8sResources<Record<string, Service>> = {};
    for (const s of services) {
      map[`svc:${s.namespace}/${s.name}`] = {
        groupVersionKind: ServiceGVK,
        namespace: s.namespace,
        name: s.name,
      };
    }
    return map;
  }, [services]);

  const endpointWatches: WatchK8sResources<Record<string, EndpointSlice[]>> = React.useMemo(() => {
    const map: WatchK8sResources<Record<string, EndpointSlice[]>> = {};
    for (const s of services) {
      map[`eps:${s.namespace}/${s.name}`] = {
        groupVersionKind: EndpointSliceGVK,
        namespace: s.namespace,
        isList: true,
        selector: { matchLabels: { 'kubernetes.io/service-name': s.name } },
      };
    }
    return map;
  }, [services]);

  const serviceResults = useK8sWatchResources<Record<string, Service>>(serviceWatches);
  const endpointResults = useK8sWatchResources<Record<string, EndpointSlice[]>>(endpointWatches);

  return React.useMemo<GatewayBackendHealth>(() => {
    const watchesLoaded =
      Object.values(serviceResults).every((r) => r.loaded || r.loadError) &&
      Object.values(endpointResults).every((r) => r.loaded || r.loadError);
    const loaded = routesLoaded && watchesLoaded;

    let servicesReady = 0;
    let endpointsReady = 0;
    let endpointsTotal = 0;

    for (const s of services) {
      const svc = serviceResults[`svc:${s.namespace}/${s.name}`]?.data as Service | undefined;
      if (svc && svc.metadata) servicesReady++;
      const slices =
        (endpointResults[`eps:${s.namespace}/${s.name}`]?.data as EndpointSlice[] | undefined) || [];
      for (const slice of slices) {
        for (const ep of slice.endpoints || []) {
          endpointsTotal++;
          if (ep.conditions?.ready === true) endpointsReady++;
        }
      }
    }

    return {
      serviceCount: services.length,
      servicesReady,
      endpointsReady,
      endpointsTotal,
      loaded,
    };
  }, [services, serviceResults, endpointResults, routesLoaded]);
}
