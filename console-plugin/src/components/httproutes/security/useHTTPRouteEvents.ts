import * as React from 'react';
import { HTTPRoute, K8sCondition, PolicyAttachment } from '../../../types';
import { RecentEvent } from '../../overview/types';

/**
 * Route-scoped event feed for the HTTPRoute Details page.
 *
 * The Kuadrant + Gateway API controllers write reconciliation state into
 * `status.conditions` instead of the Events API, so this hook takes the
 * SAME synthesis approach `useRecentEvents` (the Overview one) takes but
 * scopes the source data to the route + its attached policies. The result
 * is a lightweight "what's happened lately for THIS route" panel — no
 * cluster-wide noise.
 *
 * Ordering: newest transition first. Cap at 12 (enough for a scroll-free
 * card on a 13" laptop; the "View all events" link points at the raw
 * Events API for the full firehose).
 */

const MAX_EVENTS = 12;

const POSITIVE = new Set(['Accepted', 'Programmed', 'Ready', 'Enforced', 'ResolvedRefs']);
const NEGATIVE = new Set(['Degraded', 'Failed', 'Error', 'Rejected', 'Overridden']);

function severity(c: K8sCondition): RecentEvent['severity'] {
  if (NEGATIVE.has(c.type)) return c.status === 'True' ? 'critical' : 'success';
  if (POSITIVE.has(c.type)) return c.status === 'True' ? 'success' : 'warning';
  return 'info';
}

function transitionVerb(c: K8sCondition): string {
  const isTrue = c.status === 'True';
  if (NEGATIVE.has(c.type)) {
    return isTrue ? `is ${c.type.toLowerCase()}` : `recovered from ${c.type.toLowerCase()}`;
  }
  if (POSITIVE.has(c.type)) {
    return isTrue ? `is now ${c.type.toLowerCase()}` : `no longer ${c.type.toLowerCase()}`;
  }
  return `${c.type} = ${c.status}`;
}

function relativeAgo(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return 'just now';
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function useHTTPRouteEvents(
  route: HTTPRoute | undefined,
  effectiveStack: PolicyAttachment[],
): RecentEvent[] {
  return React.useMemo(() => {
    if (!route) return [];
    const routeName = route.metadata?.name || '';
    const routeNs = route.metadata?.namespace || '';
    const out: (RecentEvent & { _ts: number })[] = [];

    const routeConds = (route.status?.parents || []).flatMap((p) => p.conditions || []);
    for (const c of routeConds) {
      if (!c.lastTransitionTime) continue;
      const ts = new Date(c.lastTransitionTime).getTime();
      if (!Number.isFinite(ts) || ts === 0) continue;
      out.push({
        _ts: ts,
        id: `HTTPRoute-${routeNs}-${routeName}-${c.type}-${c.lastTransitionTime}`,
        occurredAt: relativeAgo(ts),
        title: `HTTPRoute ${routeName} ${transitionVerb(c)}`,
        detail: c.message || c.reason || '',
        severity: severity(c),
        href: `/connectivity-link/httproutes/${routeNs}/${routeName}`,
      });
    }

    for (const pa of effectiveStack) {
      const kind = pa.policyKind;
      const ns = pa.policy.metadata?.namespace || '';
      const name = pa.policy.metadata?.name || '';
      const conds = pa.conditions || [];
      // Synthetic "override" event — surface the fact that this policy
      // was silenced by a parent so operators see it in the timeline.
      if (pa.isOverridden) {
        const anyCond = conds.find((c) => c.lastTransitionTime);
        const ts = anyCond?.lastTransitionTime
          ? new Date(anyCond.lastTransitionTime).getTime()
          : Date.now();
        out.push({
          _ts: ts,
          id: `${kind}-${ns}-${name}-Overridden-synth`,
          occurredAt: relativeAgo(ts),
          title: `${kind} ${name} is overridden by a Gateway-level policy`,
          detail: 'This route\'s policy is not effective because a Gateway-level override wins.',
          severity: 'warning',
          href: `/connectivity-link/httproutes/${routeNs}/${routeName}`,
        });
      }
      for (const c of conds) {
        if (!c.lastTransitionTime) continue;
        const ts = new Date(c.lastTransitionTime).getTime();
        if (!Number.isFinite(ts) || ts === 0) continue;
        out.push({
          _ts: ts,
          id: `${kind}-${ns}-${name}-${c.type}-${c.lastTransitionTime}`,
          occurredAt: relativeAgo(ts),
          title: `${kind} ${name} ${transitionVerb(c)}`,
          detail: c.message || c.reason || '',
          severity: severity(c),
          href: `/connectivity-link/httproutes/${routeNs}/${routeName}`,
        });
      }
    }

    // Dedup by id (a single transition can end up in the stack twice
    // through the target/alt namespace watches — same policy UID surfaces
    // once per attachment).
    const seen = new Set<string>();
    const deduped = out.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    deduped.sort((a, b) => b._ts - a._ts);
    return deduped.slice(0, MAX_EVENTS).map(({ _ts: _, ...e }) => e);
  }, [route, effectiveStack]);
}
