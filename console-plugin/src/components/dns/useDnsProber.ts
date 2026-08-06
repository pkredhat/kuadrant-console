import * as React from 'react';
import { usePluginConfig } from '../../utils/pluginConfig';
import { DnsResolver, StepStatus } from './types';

/**
 * Bridges the DNS Troubleshooting page to the external DNS Prober
 * companion service. The prober lives in the customer cluster (see
 * `rhcl-lab/apps/backend/dns-prober` for the reference implementation)
 * and is deliberately NOT bundled with the plugin — DNS resolution
 * doesn't work from a browser sandbox, so real cross-resolver checks
 * require a cluster-side helper.
 *
 * Contract with the prober:
 *
 *   POST <dnsProberUrl>/api/probe
 *   Content-Type: application/json
 *   Body: { hostname: string, resolvers?: Array<{ name, ip }> }
 *   → 200 { hostname, results: Array<ProberResult> }
 *
 * `resolvers` is optional; when omitted the prober uses its own
 * default set. The plugin sends the same 8-resolver ladder the
 * simulated fallback uses so the table stays consistent across the two
 * paths.
 *
 * States the caller sees:
 *
 *   - `configured: false` → the plugin config has no dnsProberUrl.
 *     Renderer shows the "install the prober" callout.
 *   - `configured: true, loading: true` → prober is being called.
 *   - `configured: true, error: X` → prober is unreachable or errored.
 *     Renderer shows the error inline and falls back to the simulated
 *     view so the page never goes completely blank.
 *   - `configured: true, resolvers: [...]` → real data ready.
 */

interface ProberResult {
  resolver: string;
  status: string;
  answer: string;
  latencyMs?: number;
  probedAt?: string;
}

interface ProberResponse {
  hostname: string;
  results: ProberResult[];
}

export interface UseDnsProberResult {
  configured: boolean;
  loading: boolean;
  error: string | null;
  resolvers: DnsResolver[] | null;
  /** Rough "last probed" stamp — refreshes on every successful call. */
  probedAt: string | null;
}

/** The default resolver ladder we send to the prober. Coordinates are
 *  the resolver's HQ / representative location for the geo-map — real
 *  anycast networks answer wherever the prober's egress lands, but for
 *  the visualisation we treat each resolver as a point. */
export const DEFAULT_RESOLVERS: Array<{
  name: string;
  ip: string;
  location: string;
  /** WGS84 latitude, north positive. */
  lat: number;
  /** WGS84 longitude, east positive. */
  lng: number;
}> = [
  { name: 'Cloudflare',    ip: '1.1.1.1',         location: 'San Francisco, US', lat: 37.77,  lng: -122.42 },
  { name: 'Google',        ip: '8.8.8.8',         location: 'Mountain View, US', lat: 37.39,  lng: -122.08 },
  { name: 'Quad9',         ip: '9.9.9.9',         location: 'Zurich, CH',        lat: 47.37,  lng: 8.54 },
  { name: 'OpenDNS',       ip: '208.67.222.222',  location: 'San Francisco, US', lat: 37.77,  lng: -122.42 },
  { name: 'Verisign',      ip: '64.6.64.6',       location: 'Reston, US',        lat: 38.96,  lng: -77.36 },
  { name: 'Cisco OpenDNS', ip: '208.67.220.220',  location: 'San Jose, US',      lat: 37.34,  lng: -121.89 },
  { name: 'AdGuard',       ip: '94.140.14.14',    location: 'Nicosia, CY',       lat: 35.17,  lng: 33.36 },
  { name: 'Yandex',        ip: '77.88.8.8',       location: 'Moscow, RU',        lat: 55.75,  lng: 37.62 },
];

/** Normalise the prober's status string to the StepStatus enum used
 *  across the page. */
function toStepStatus(s: string): StepStatus {
  const lower = (s || '').toLowerCase();
  if (lower === 'healthy' || lower === 'ok' || lower === 'noerror') return 'healthy';
  if (lower === 'pending' || lower === 'servfail' || lower === 'timeout') return 'pending';
  if (lower === 'failing' || lower === 'nxdomain' || lower === 'refused' || lower === 'error') return 'failing';
  return 'unknown';
}

/**
 * @param hostname current selection from the page dropdown
 * @param nonce    bump to force a fresh POST /api/probe even when the
 *                 hostname hasn't changed. Wired to the page's Refresh
 *                 and Run-all-checks buttons.
 */
/**
 * Path served by the OpenShift console when the ConsolePlugin CR declares
 * `spec.proxy[].alias = dns-prober` pointing at the companion Service.
 * Using this same-origin path (instead of the prober's own Route) sidesteps
 * every browser cross-origin gotcha: no CORS preflight, no CSP connect-src
 * mismatch, no self-signed-cert wall for the prober's Route. The console
 * itself does the proxying and re-uses its own TLS + auth.
 *
 * Kept as a fixed path — the plugin name matches the ConsolePlugin CR name,
 * which we ship. If someone renames the CR they have to update this too.
 */
const PROXY_PATH = '/api/proxy/plugin/kuadrant-console/dns-prober';

export function useDnsProber(hostname: string | null, nonce: number = 0): UseDnsProberResult {
  const { config } = usePluginConfig();
  // dnsProberUrl in the ConfigMap is now used purely as a "the operator
  // has installed the companion" flag — the actual URL fetched is the
  // console proxy path (see PROXY_PATH). Legacy value shape is kept so
  // existing installs don't need a ConfigMap edit at upgrade time.
  const configured = !!config.dnsProberUrl?.trim();

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [resolvers, setResolvers] = React.useState<DnsResolver[] | null>(null);
  const [probedAt, setProbedAt] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!configured || !hostname) {
      setResolvers(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Hit the console-provided proxy path, not the prober's Route.
        // See PROXY_PATH above for the rationale. This is a same-origin
        // request; plain `fetch` is fine (no consoleFetch — the prober
        // needs no console-session cookie, and consoleFetch's CSRF
        // header only makes sense on Kubernetes API calls).
        const res = await fetch(`${PROXY_PATH}/api/probe`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hostname,
            resolvers: DEFAULT_RESOLVERS.map((r) => ({ name: r.name, ip: r.ip })),
          }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as ProberResponse;
        if (cancelled) return;
        const mapped: DnsResolver[] = body.results.map((r) => {
          const meta = DEFAULT_RESOLVERS.find((d) => d.name === r.resolver);
          return {
            name: r.resolver,
            location: meta?.location || 'Unknown',
            ip: meta?.ip || '',
            status: toStepStatus(r.status),
            result: r.answer,
            latencyMs: r.latencyMs,
            lastCheckedIso: r.probedAt || new Date().toISOString(),
          };
        });
        setResolvers(mapped);
        setProbedAt(new Date().toISOString());
      } catch (e) {
        if (cancelled) return;
        setError((e as Error)?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configured, hostname, nonce]);

  return { configured, loading, error, resolvers, probedAt };
}
