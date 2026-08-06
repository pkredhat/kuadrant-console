import * as React from 'react';
import { usePluginConfig } from '../../utils/pluginConfig';

/**
 * Bridges the TLS Troubleshooting page to the dns-prober companion
 * service. Same companion, second endpoint — see
 * `dns-prober/src/main/java/.../TlsProbeResource.java`. Since we route
 * through the ConsolePlugin's `dns-prober` proxy alias, no console
 * operator config change is required to pick up the TLS endpoint.
 *
 * States:
 *   - `configured: false` → plugin config has no dnsProberUrl (the
 *     shared "companion installed" flag). UI hides the Run button and
 *     shows the install callout.
 *   - `configured: true, loading: true` → probe in flight.
 *   - `configured: true, result: {...}` → live handshake data ready.
 *   - `configured: true, error: X` → prober is unreachable; UI keeps
 *     the pipeline-derived "expected" rows.
 */

const PROXY_PATH = '/api/proxy/plugin/kuadrant-console/dns-prober';

export interface TlsProbeCert {
  subject?: string;
  issuer?: string;
  sans?: string[];
  notBefore?: string;
  notAfter?: string;
  serialNumber?: string;
  signatureAlgorithm?: string;
  expired?: boolean;
  notYetValid?: boolean;
}

export interface TlsProbeResult {
  hostname: string;
  port: number;
  handshake: 'ok' | 'failed';
  tlsVersion?: string;
  cipherSuite?: string;
  chainDepth?: number;
  cert?: TlsProbeCert;
  httpStatus?: number;
  httpStatusReason?: string;
  trusted?: boolean;
  latencyMs?: number;
  probedAt?: string;
  error?: string;
}

export interface UseTlsProberResult {
  configured: boolean;
  loading: boolean;
  error: string | null;
  result: TlsProbeResult | null;
  /** Fire a fresh probe. Called by the "Run HTTPS Check" button. */
  runProbe: () => void;
}

/**
 * @param hostname current selection from the page dropdown
 * @param port     TCP port (default 443)
 */
export function useTlsProber(hostname: string | null, port = 443): UseTlsProberResult {
  const { config } = usePluginConfig();
  const configured = !!config.dnsProberUrl?.trim();

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<TlsProbeResult | null>(null);
  // Nonce increments on each Run button click; the effect below fires
  // whenever nonce or hostname changes but NOT on every render.
  const [nonce, setNonce] = React.useState(0);
  const runProbe = React.useCallback(() => {
    if (!configured || !hostname) return;
    setNonce((n) => n + 1);
  }, [configured, hostname]);

  React.useEffect(() => {
    // First render with nonce=0: skip. Otherwise every page load would
    // fire a probe against the currently-selected host, which is
    // wasteful — an HTTPS handshake to a real cluster is ~100-300ms
    // and the plugin's user hasn't asked for it yet.
    if (nonce === 0) return;
    if (!configured || !hostname) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`${PROXY_PATH}/api/tls/probe`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hostname, port }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as TlsProbeResult;
        if (cancelled) return;
        setResult(body);
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
  }, [configured, hostname, port, nonce]);

  return { configured, loading, error, result, runProbe };
}
