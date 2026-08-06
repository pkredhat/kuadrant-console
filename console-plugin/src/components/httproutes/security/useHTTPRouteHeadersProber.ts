import * as React from 'react';
import { usePluginConfig } from '../../../utils/pluginConfig';
import {
  CheckState,
  HeaderCheckResult,
  HeadersProbeSnapshot,
  SecurityFeatureStatus,
} from './routeSecurityTypes';

/**
 * Bridges the HTTPRoute Details Security tab to the dns-prober companion's
 * `/api/headers/probe` endpoint. Same companion, third endpoint — see
 * dns-prober/src/main/java/.../HeadersProbeResource.java. Routed via the
 * ConsolePlugin's existing `dns-prober` proxy alias so no console-operator
 * proxy config change is needed to pick up this endpoint.
 *
 * Contract mirrors useTlsProber:
 *   - configured=false → prober not installed, hide the Run button and
 *     surface the install callout on the parent card.
 *   - configured=true, nonce=0 → idle, no probe on mount (avoid burning a
 *     backend request on every page visit).
 *   - runProbe() → fire a probe against the currently-selected URL.
 */

const PROXY_PATH = '/api/proxy/plugin/kuadrant-console/dns-prober';

interface RawHeadersResponse {
  url: string;
  probedAt: string;
  httpStatus?: number;
  httpStatusReason?: string;
  latencyMs?: number;
  headers?: {
    id: string;
    header: string;
    present: boolean;
    value?: string;
    status: string;
    detail: string;
  }[];
  error?: string;
}

export interface UseHTTPRouteHeadersProberResult {
  configured: boolean;
  loading: boolean;
  error: string | null;
  snapshot: HeadersProbeSnapshot | null;
  runProbe: (url: string) => void;
}

const VALID_IDS: HeaderCheckResult['id'][] = [
  'hsts',
  'csp',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'cache-control',
];

export function useHTTPRouteHeadersProber(): UseHTTPRouteHeadersProberResult {
  const { config } = usePluginConfig();
  const configured = !!config.dnsProberUrl?.trim();

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<HeadersProbeSnapshot | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);

  const runProbe = React.useCallback(
    (url: string) => {
      if (!configured || !url) return;
      setPending(url);
    },
    [configured],
  );

  React.useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`${PROXY_PATH}/api/headers/probe`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: pending, followRedirects: false }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const raw = (await res.json()) as RawHeadersResponse;
        if (cancelled) return;
        setSnapshot(mapSnapshot(raw));
      } catch (e) {
        if (cancelled) return;
        setError((e as Error)?.message || String(e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setPending(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pending]);

  return { configured, loading, error, snapshot, runProbe };
}

function mapSnapshot(raw: RawHeadersResponse): HeadersProbeSnapshot {
  const headers: HeaderCheckResult[] = (raw.headers || [])
    .filter((h) => (VALID_IDS as string[]).includes(h.id))
    .map((h) => ({
      id: h.id as HeaderCheckResult['id'],
      header: h.header,
      present: !!h.present,
      value: h.value,
      status: mapState(h.status),
      detail: h.detail,
    }));
  const status = deriveOverallStatus(headers, raw.error);
  return {
    url: raw.url,
    probedAt: raw.probedAt,
    httpStatus: raw.httpStatus,
    latencyMs: raw.latencyMs,
    headers,
    status,
    error: raw.error,
  };
}

function mapState(raw: string | undefined): CheckState {
  switch (raw) {
    case 'passed':
    case 'warning':
    case 'failed':
    case 'skipped':
      return raw;
    default:
      return 'unknown';
  }
}

function deriveOverallStatus(
  headers: HeaderCheckResult[],
  error?: string,
): SecurityFeatureStatus {
  if (error) return 'unknown';
  if (headers.some((h) => h.status === 'failed')) return 'failed';
  if (headers.some((h) => h.status === 'warning')) return 'warning';
  return 'enabled';
}
