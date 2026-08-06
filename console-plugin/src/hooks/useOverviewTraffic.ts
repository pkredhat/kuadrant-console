import * as React from 'react';
import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';
import { usePollingEffect } from './usePollingEffect';
import { usePrometheusRange } from './usePrometheusRange';
import {
  TrafficMetricData,
  SparklinePoint,
} from '../components/overview/types';

// Gateway-wide PromQL. `reporter="source"` keeps us on the gateway-side
// metrics only (otherwise we'd double-count each request via the
// sidecar). When a namespace filter is set, we append a
// `destination_workload_namespace="X"` selector — this scopes the RPS /
// success / error / p95 rollups to requests hitting workloads in that
// namespace, which is what "Overview scoped to namespace X" should mean.
// Instant queries: 5-minute rate windows compared to the equivalent
// window 1 hour ago. That delta is what drives the up/down trend arrow.
function baseSelector(ns: string | null | undefined, extra = ''): string {
  const parts = ['reporter="source"'];
  if (ns) parts.push(`destination_workload_namespace="${ns}"`);
  if (extra) parts.push(extra);
  return `{${parts.join(',')}}`;
}

function buildQueries(ns: string | null | undefined) {
  const b = baseSelector(ns);
  const b2xx3xx = baseSelector(ns, 'response_code=~"2..|3.."');
  const b5xx = baseSelector(ns, 'response_code=~"5.."');
  return {
    RPS_NOW: `sum(rate(istio_requests_total${b}[5m]))`,
    RPS_PREV: `sum(rate(istio_requests_total${b}[5m] offset 1h))`,
    SUCCESS_NOW:
      `100 * sum(rate(istio_requests_total${b2xx3xx}[5m])) ` +
      `/ sum(rate(istio_requests_total${b}[5m]))`,
    SUCCESS_PREV:
      `100 * sum(rate(istio_requests_total${b2xx3xx}[5m] offset 1h)) ` +
      `/ sum(rate(istio_requests_total${b}[5m] offset 1h))`,
    ERROR_NOW:
      `100 * sum(rate(istio_requests_total${b5xx}[5m])) ` +
      `/ sum(rate(istio_requests_total${b}[5m]))`,
    ERROR_PREV:
      `100 * sum(rate(istio_requests_total${b5xx}[5m] offset 1h)) ` +
      `/ sum(rate(istio_requests_total${b}[5m] offset 1h))`,
    P95_NOW: `histogram_quantile(0.95, sum by(le)(rate(istio_request_duration_milliseconds_bucket${b}[5m])))`,
    P95_PREV: `histogram_quantile(0.95, sum by(le)(rate(istio_request_duration_milliseconds_bucket${b}[5m] offset 1h)))`,
    RPS_RANGE: `sum(rate(istio_requests_total${b}[2m]))`,
    SUCCESS_RANGE:
      `100 * sum(rate(istio_requests_total${b2xx3xx}[2m])) ` +
      `/ sum(rate(istio_requests_total${b}[2m]))`,
    ERROR_RANGE:
      `100 * sum(rate(istio_requests_total${b5xx}[2m])) ` +
      `/ sum(rate(istio_requests_total${b}[2m]))`,
    P95_RANGE: `histogram_quantile(0.95, sum by(le)(rate(istio_request_duration_milliseconds_bucket${b}[2m])))`,
  };
}

interface InstantSnapshot {
  rpsNow: number | null;
  rpsPrev: number | null;
  successNow: number | null;
  successPrev: number | null;
  errorNow: number | null;
  errorPrev: number | null;
  p95Now: number | null;
  p95Prev: number | null;
}

const EMPTY_INSTANT: InstantSnapshot = {
  rpsNow: null,
  rpsPrev: null,
  successNow: null,
  successPrev: null,
  errorNow: null,
  errorPrev: null,
  p95Now: null,
  p95Prev: null,
};

interface UseOverviewTrafficResult {
  metrics: TrafficMetricData[];
  loaded: boolean;
  metricsAvailable: boolean;
}

interface Delta {
  pct: number;
  dir: 'up' | 'down';
}

function delta(now: number | null, prev: number | null): Delta {
  if (now == null || prev == null || prev === 0) return { pct: 0, dir: 'up' };
  const d = ((now - prev) / prev) * 100;
  return {
    pct: Math.abs(Math.round(d * 10) / 10),
    dir: d >= 0 ? 'up' : 'down',
  };
}

function fmtRps(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 100) return v.toFixed(0);
  return v.toFixed(1);
}
function fmtPct(v: number | null): string {
  if (v == null) return '—';
  return `${v.toFixed(1)}%`;
}
function fmtMs(v: number | null): string {
  if (v == null) return '—';
  return `${Math.round(v)} ms`;
}

/**
 * Gateway-wide traffic metrics for the Overview header cards.
 *
 * Powers the 4 TrafficMetricCards (Requests/sec, Success Rate, Error Rate,
 * P95 Latency) plus their sparklines. Trend arrows are computed from a
 * "now vs same window 1 hour ago" delta.
 *
 * Returns the same `TrafficMetricData[]` shape the section component
 * accepted from the mock, so we keep the visual contract intact and only
 * swap the source.
 *
 * No backend filter — every gateway in the cluster contributes. This is
 * what the Overview page means by "summary". For per-gateway numbers see
 * `usePrometheusTraffic` (instant) and the GatewayOperationalCards row
 * further down the page.
 */
export function useOverviewTraffic(
  namespaceFilter?: string | null,
): UseOverviewTrafficResult {
  const [instant, setInstant] = React.useState<InstantSnapshot>(EMPTY_INSTANT);
  const [loaded, setLoaded] = React.useState(false);
  const [metricsAvailable, setMetricsAvailable] = React.useState(true);

  const promql = React.useMemo(() => buildQueries(namespaceFilter), [namespaceFilter]);

  usePollingEffect(
    async (signal) => {
      const queries: Record<keyof InstantSnapshot, string> = {
        rpsNow: promql.RPS_NOW,
        rpsPrev: promql.RPS_PREV,
        successNow: promql.SUCCESS_NOW,
        successPrev: promql.SUCCESS_PREV,
        errorNow: promql.ERROR_NOW,
        errorPrev: promql.ERROR_PREV,
        p95Now: promql.P95_NOW,
        p95Prev: promql.P95_PREV,
      };
      try {
        const entries = await Promise.all(
          Object.entries(queries).map(async ([key, q]) => {
            try {
              const url = `/api/prometheus/api/v1/query?query=${encodeURIComponent(q)}`;
              const r = await consoleFetch(url, { signal }, 10_000);
              const json = await r.json();
              const v = json?.data?.result?.[0]?.value?.[1];
              return [key, v ? parseFloat(v) : null] as const;
            } catch {
              return [key, null] as const;
            }
          }),
        );
        if (signal.aborted) return;
        const next = { ...EMPTY_INSTANT };
        for (const [key, value] of entries) {
          (next as Record<string, number | null>)[key] = value;
        }
        setInstant(next);
        setLoaded(true);
        setMetricsAvailable(true);
      } catch (e) {
        if (signal.aborted) return;
        const err = e instanceof Error ? e : new Error(String(e));
        if (err.message.includes('404') || err.message.includes('503')) {
          setMetricsAvailable(false);
        }
        setLoaded(true);
      }
    },
    [promql],
    { intervalMs: 60_000, enabled: metricsAvailable },
  );

  const rangeQueries = React.useMemo(
    () => [
      { label: 'rps', query: promql.RPS_RANGE },
      { label: 'success', query: promql.SUCCESS_RANGE },
      { label: 'error', query: promql.ERROR_RANGE },
      { label: 'p95', query: promql.P95_RANGE },
    ],
    [promql],
  );
  // 30-minute window, 150s step → 12 sparkline points.
  const { series } = usePrometheusRange(rangeQueries, 1800, 150, 60_000);

  return React.useMemo<UseOverviewTrafficResult>(() => {
    const sparkOf = (label: string): SparklinePoint[] => {
      const s = series.find((x) => x.label === label);
      if (!s) return [];
      return s.data.map((p, i) => ({ t: i, v: p.y }));
    };

    const rpsDelta = delta(instant.rpsNow, instant.rpsPrev);
    const successDelta = delta(instant.successNow, instant.successPrev);
    const errorDelta = delta(instant.errorNow, instant.errorPrev);
    const p95Delta = delta(instant.p95Now, instant.p95Prev);

    const metrics: TrafficMetricData[] = [
      {
        id: 'rps',
        label: 'Requests / sec',
        value: fmtRps(instant.rpsNow),
        trendDeltaPct: rpsDelta.pct,
        trendDirection: rpsDelta.dir,
        // rising rps is healthy traffic, falling rps could be a problem
        trendIsGood: rpsDelta.dir === 'up',
        sparkline: sparkOf('rps'),
      },
      {
        id: 'success',
        label: 'Success Rate',
        value: fmtPct(instant.successNow),
        trendDeltaPct: successDelta.pct,
        trendDirection: successDelta.dir,
        trendIsGood: successDelta.dir === 'up',
        sparkline: sparkOf('success'),
      },
      {
        id: 'errors',
        label: 'Error Rate',
        value: fmtPct(instant.errorNow),
        trendDeltaPct: errorDelta.pct,
        trendDirection: errorDelta.dir,
        // falling error rate is good — arrow color is decoupled from direction
        trendIsGood: errorDelta.dir === 'down',
        sparkline: sparkOf('error'),
      },
      {
        id: 'latency',
        label: 'P95 Latency',
        value: fmtMs(instant.p95Now),
        trendDeltaPct: p95Delta.pct,
        trendDirection: p95Delta.dir,
        trendIsGood: p95Delta.dir === 'down',
        sparkline: sparkOf('p95'),
      },
    ];

    return { metrics, loaded, metricsAvailable };
  }, [instant, series, loaded, metricsAvailable]);
}
