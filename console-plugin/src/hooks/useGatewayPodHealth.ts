import * as React from 'react';
import {
  K8sResourceCommon,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { GatewayGVK } from '../models';

/**
 * Bridges the Kuadrant view of a gateway ("Gateway CR is Programmed +
 * Accepted, all good") to the OpenShift view ("the pod actually serving
 * that listener is CrashLoopBackOff / not Ready / restarted 12 times in
 * the last 30 minutes"). Without this, the plugin was reporting "Healthy"
 * for gateways whose Envoy was failing to warm certs from istiod — the
 * controller was happy, the data plane was not.
 *
 * We look at three complementary signals against the pods that carry the
 * standard Gateway API label
 * `gateway.networking.k8s.io/gateway-name=<gateway>`:
 *
 *   1. `restart-storm`   — container restartCount ≥ RESTART_STORM_THRESHOLD.
 *                          Catches the classic tight-loop crash (mTLS
 *                          trust bundle mismatch, wasm-shim rejecting
 *                          Envoy config, misconfigured EnvoyFilter).
 *   2. `not-ready`       — pod exists but no container is ready. Different
 *                          from crashloop: pod is up, but SDS hasn't
 *                          warmed the cert / xDS never synced / etc.
 *   3. `recent-warning`  — Event of type=Warning on the pod within
 *                          RECENT_EVENT_WINDOW_MS. Catches
 *                          BackOff/Unhealthy/FailedCreate before the
 *                          restart counter has a chance to climb.
 *
 * Missing signal on purpose: xDS sync lag. It's hidden inside Envoy's
 * admin interface (:15000/config_dump), which the console can't reach
 * from the browser. Would need a separate probe.
 */

// A restart every ~few minutes is normal (probes, image pull retries).
// Three within the same watch window means the pod isn't stabilising.
export const RESTART_STORM_THRESHOLD = 3;

// Events older than this fall off — no point flagging a five-hour-old
// BackOff for a pod that's now Running.
export const RECENT_EVENT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface ContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    running?: { startedAt?: string };
    terminated?: { reason?: string; exitCode?: number };
  };
}

interface Pod extends K8sResourceCommon {
  spec?: {
    nodeName?: string;
  };
  status?: {
    phase?: string;
    containerStatuses?: ContainerStatus[];
    conditions?: Array<{ type: string; status: string }>;
  };
}

interface EventResource extends K8sResourceCommon {
  type?: string; // Normal | Warning
  reason?: string;
  message?: string;
  involvedObject?: {
    kind?: string;
    namespace?: string;
    name?: string;
  };
  lastTimestamp?: string;
  eventTime?: string;
  count?: number;
}

interface GatewayCR extends K8sResourceCommon {
  status?: {
    conditions?: Array<{ type: string; status: string }>;
  };
}

export type PodHealthSignalKind =
  | 'restart-storm'
  | 'not-ready'
  | 'recent-warning';

export interface PodHealthSignal {
  kind: PodHealthSignalKind;
  severity: 'critical' | 'warning';
  podName: string;
  podNamespace: string;
  message: string; // human-readable
  // For 'recent-warning' — the Event.reason (BackOff, Unhealthy, etc.)
  eventReason?: string;
  observedAt?: string;
}

export interface GatewayPodHealth {
  gatewayName: string;
  gatewayNamespace: string;
  podCount: number;
  readyCount: number;
  totalRestarts: number;
  worstSeverity: 'healthy' | 'warning' | 'critical';
  signals: PodHealthSignal[];
}

export interface UseGatewayPodHealthResult {
  byGateway: GatewayPodHealth[];
  loaded: boolean;
}

/**
 * Aggregate view over every Gateway CR in the cluster, joined against
 * the pods carrying the matching gateway-name label and their recent
 * Warning events. Cheap to render — three list-watches that the console
 * SDK already batches into a single websocket.
 */
export function useGatewayPodHealth(): UseGatewayPodHealthResult {
  const [gateways, gwLoaded] = useK8sWatchResource<GatewayCR[]>({
    groupVersionKind: GatewayGVK,
    isList: true,
  });

  // Core Pod. Watched cluster-wide so a Gateway CR in ns A whose pods
  // live in ns B (openshift-ingress is the common case) still gets
  // joined. The label filter keeps the list narrow.
  const [pods, podsLoaded] = useK8sWatchResource<Pod[]>({
    groupVersionKind: { version: 'v1', kind: 'Pod' },
    isList: true,
    selector: {
      matchExpressions: [
        {
          key: 'gateway.networking.k8s.io/gateway-name',
          operator: 'Exists',
        },
      ],
    },
  });

  // Events on those pods. Also cluster-wide; we filter by
  // involvedObject.kind === 'Pod' + name matching a gateway-labelled pod.
  // Watching all Events is fine — the console does this constantly for
  // its own dashboards.
  const [events, evLoaded] = useK8sWatchResource<EventResource[]>({
    groupVersionKind: { version: 'v1', kind: 'Event' },
    isList: true,
  });

  return React.useMemo<UseGatewayPodHealthResult>(() => {
    const loaded = gwLoaded && podsLoaded && evLoaded;
    if (!loaded) return { byGateway: [], loaded: false };

    const now = Date.now();
    const recentCutoff = now - RECENT_EVENT_WINDOW_MS;

    // Index pods by (gatewayName, gatewayNamespace) so we can walk
    // gateways and pull only the pods that matched.
    // Gateway API is loose about which namespace the pods live in, so
    // we match on the label value + fall back to
    // `gateway.networking.k8s.io/gateway-namespace` when set. When
    // the namespace label isn't set (older versions), we accept the
    // pod as a candidate for the Gateway CR with that name in any ns
    // — a very narrow risk in practice because gateway names are
    // rarely duplicated across namespaces.
    const podsByGateway = new Map<string, Pod[]>();
    const podKey = (name?: string, ns?: string) => `${ns || '*'}/${name || ''}`;
    for (const p of pods || []) {
      const labels = p.metadata?.labels || {};
      const gwName = labels['gateway.networking.k8s.io/gateway-name'];
      if (!gwName) continue;
      const gwNs =
        labels['gateway.networking.k8s.io/gateway-namespace'] || '*';
      const k = podKey(gwName, gwNs);
      const arr = podsByGateway.get(k) || [];
      arr.push(p);
      podsByGateway.set(k, arr);
    }

    // Index recent Warning events by pod (ns, name).
    const eventsByPod = new Map<string, EventResource[]>();
    for (const e of events || []) {
      if (e.type !== 'Warning') continue;
      if (e.involvedObject?.kind !== 'Pod') continue;
      const stamp = e.lastTimestamp || e.eventTime;
      if (!stamp) continue;
      const t = new Date(stamp).getTime();
      if (!Number.isFinite(t) || t < recentCutoff) continue;
      const key = `${e.involvedObject.namespace || ''}/${e.involvedObject.name || ''}`;
      const arr = eventsByPod.get(key) || [];
      arr.push(e);
      eventsByPod.set(key, arr);
    }

    const results: GatewayPodHealth[] = [];

    for (const gw of gateways || []) {
      const gwName = gw.metadata?.name || '';
      const gwNs = gw.metadata?.namespace || '';

      // Try exact-namespace pods first, fall through to * matches.
      const matched: Pod[] = [
        ...(podsByGateway.get(podKey(gwName, gwNs)) || []),
        ...(podsByGateway.get(podKey(gwName, '*')) || []),
      ];
      const signals: PodHealthSignal[] = [];
      let ready = 0;
      let totalRestarts = 0;

      for (const p of matched) {
        const podName = p.metadata?.name || '';
        const podNs = p.metadata?.namespace || '';
        const statuses = p.status?.containerStatuses || [];

        // Container ready — the OpenShift Console shows the same
        // "N/M ready" that we compute here.
        const containerReady = statuses.every((s) => s.ready);
        if (containerReady && statuses.length > 0) ready++;

        // 1. Restart storm — sum across all containers (istio-proxy +
        //    any sidecar). One bounce is fine; many is not.
        const restartCount = statuses.reduce(
          (sum, s) => sum + (s.restartCount || 0),
          0,
        );
        totalRestarts += restartCount;
        if (restartCount >= RESTART_STORM_THRESHOLD) {
          const waiting = statuses.find((s) => s.state?.waiting?.reason)?.state
            ?.waiting;
          const terminated = statuses.find((s) => s.state?.terminated?.reason)
            ?.state?.terminated;
          const reason =
            waiting?.reason || terminated?.reason || 'CrashLoop suspected';
          signals.push({
            kind: 'restart-storm',
            severity: 'critical',
            podName,
            podNamespace: podNs,
            message: `Container restarted ${restartCount} time${restartCount === 1 ? '' : 's'} (${reason})`,
          });
        }

        // 2. Not ready sustained. We can't measure "sustained" from a
        //    single snapshot, so we approximate: containerReady is
        //    false AND phase is Running AND at least one container has
        //    a startedAt older than 60s. That filters out fresh pods.
        if (!containerReady && p.status?.phase === 'Running') {
          const oldest = statuses
            .map((s) => s.state?.running?.startedAt)
            .filter((t): t is string => !!t)
            .map((t) => new Date(t).getTime())
            .filter((t) => Number.isFinite(t))
            .sort()[0];
          if (oldest && now - oldest > 60_000) {
            const waiting = statuses.find((s) => !s.ready && s.state?.waiting)
              ?.state?.waiting;
            signals.push({
              kind: 'not-ready',
              severity: 'warning',
              podName,
              podNamespace: podNs,
              message: waiting?.message
                ? `Container not ready: ${waiting.message}`
                : 'Container has been Running but not Ready for more than 60s',
            });
          }
        }

        // 3. Recent Warning event on this pod. Deduplicate by reason so
        //    a pod that fired 4 BackOff events doesn't spam 4 items.
        const podEvents = eventsByPod.get(`${podNs}/${podName}`) || [];
        const seenReasons = new Set<string>();
        for (const e of podEvents) {
          const reason = e.reason || 'Warning';
          if (seenReasons.has(reason)) continue;
          seenReasons.add(reason);
          const severity: PodHealthSignal['severity'] =
            reason === 'BackOff' || reason === 'Failed' ? 'critical' : 'warning';
          signals.push({
            kind: 'recent-warning',
            severity,
            podName,
            podNamespace: podNs,
            eventReason: reason,
            observedAt: e.lastTimestamp || e.eventTime,
            message:
              e.message?.split('\n')[0] ||
              `${reason} event on pod`,
          });
        }
      }

      const worstSeverity: GatewayPodHealth['worstSeverity'] =
        signals.some((s) => s.severity === 'critical')
          ? 'critical'
          : signals.some((s) => s.severity === 'warning')
            ? 'warning'
            : 'healthy';

      results.push({
        gatewayName: gwName,
        gatewayNamespace: gwNs,
        podCount: matched.length,
        readyCount: ready,
        totalRestarts,
        worstSeverity,
        signals,
      });
    }

    return { byGateway: results, loaded: true };
  }, [gateways, pods, events, gwLoaded, podsLoaded, evLoaded]);
}
