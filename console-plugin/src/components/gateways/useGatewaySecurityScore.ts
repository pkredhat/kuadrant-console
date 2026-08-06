import { useAttachedPolicies } from '../../hooks/useAttachedPolicies';
import { useCertificatesForGateway } from '../../hooks/useCertificatesForGateway';
import { useDNSRecordsForGateway } from '../../hooks/useDNSRecordsForGateway';
import { Gateway, StatusSeverity } from '../../types';

/**
 * Gateway security score — a transparent, real-signal-only posture number.
 *
 * "Real-only, honest gaps": every point is derived from something the cluster
 * actually reports (policy attachment + enforcement, cert-manager cert health,
 * DNS record readiness, Gateway/listener reconciliation). Dimensions we cannot
 * measure today (WAF, passive security headers) are returned as rows but with
 * `evaluated: false` — they are shown to the operator yet EXCLUDED from the
 * denominator, so the score never punishes what it can't see and never invents
 * a value it doesn't have.
 *
 *   score = round( Σ earned(evaluated) / Σ weight(evaluated) × 100 )
 *
 * Weights are exported so the Security Posture card can render the exact
 * contribution of each dimension and the number stays explainable.
 */
export const SECURITY_WEIGHTS = {
  auth: 25,
  ratelimit: 20,
  tls: 25,
  dns: 15,
  reconciliation: 15,
} as const;

export type SecurityDimensionKey =
  | 'auth'
  | 'ratelimit'
  | 'tls'
  | 'dns'
  | 'reconciliation'
  | 'waf'
  | 'headers';

export interface SecurityDimension {
  key: SecurityDimensionKey;
  label: string;
  /** Max points this dimension can contribute (0 for non-evaluated info rows). */
  weight: number;
  /** Points earned (≤ weight). */
  earned: number;
  /** Whether this dimension counts toward the score denominator. */
  evaluated: boolean;
  severity: StatusSeverity | 'na';
  detail: string;
}

export interface GatewaySecurityScore {
  /** 0–100, or null while loading / when nothing is evaluable. */
  score: number | null;
  dimensions: SecurityDimension[];
  /** Sum of weights that were actually evaluated (the score denominator). */
  applicableWeight: number;
  loaded: boolean;
}

function severityForFraction(fraction: number): StatusSeverity {
  if (fraction >= 1) return 'healthy';
  if (fraction > 0) return 'warning';
  return 'critical';
}

export function useGatewaySecurityScore(
  gateway: Gateway | undefined,
  name: string,
  namespace: string,
): GatewaySecurityScore {
  const { policies, loaded: policiesLoaded } = useAttachedPolicies(
    'Gateway',
    name,
    namespace,
    namespace,
  );
  const { certificates, loaded: certsLoaded } = useCertificatesForGateway(gateway, namespace);
  const { entries: dnsEntries, loaded: dnsLoaded } = useDNSRecordsForGateway(name, namespace);

  const loaded = !!gateway && policiesLoaded && certsLoaded && dnsLoaded;

  const dimensions: SecurityDimension[] = [];

  // --- Auth ---
  {
    const w = SECURITY_WEIGHTS.auth;
    const auth = policies.find((p) => p.policyKind === 'AuthPolicy');
    let earned = 0;
    let detail = 'No AuthPolicy attached — requests are not authenticated at the gateway.';
    if (auth) {
      earned = auth.isEnforced ? w : w / 2;
      detail = auth.isEnforced
        ? `AuthPolicy ${auth.policy.metadata?.name} is enforced.`
        : `AuthPolicy ${auth.policy.metadata?.name} is attached but not enforced.`;
    }
    dimensions.push({
      key: 'auth',
      label: 'Authentication',
      weight: w,
      earned,
      evaluated: true,
      severity: severityForFraction(earned / w),
      detail,
    });
  }

  // --- Rate limiting (request or token) ---
  {
    const w = SECURITY_WEIGHTS.ratelimit;
    const rl = policies.find(
      (p) => p.policyKind === 'RateLimitPolicy' || p.policyKind === 'TokenRateLimitPolicy',
    );
    let earned = 0;
    let detail = 'No RateLimitPolicy or TokenRateLimitPolicy attached — traffic is unbounded.';
    if (rl) {
      earned = rl.isEnforced ? w : w / 2;
      detail = rl.isEnforced
        ? `${rl.policyKind} ${rl.policy.metadata?.name} is enforced.`
        : `${rl.policyKind} ${rl.policy.metadata?.name} is attached but not enforced.`;
    }
    dimensions.push({
      key: 'ratelimit',
      label: 'Rate limiting',
      weight: w,
      earned,
      evaluated: true,
      severity: severityForFraction(earned / w),
      detail,
    });
  }

  // --- TLS ---
  {
    const w = SECURITY_WEIGHTS.tls;
    const listeners = gateway?.spec?.listeners || [];
    const httpsListeners = listeners.filter(
      (l) => l.protocol === 'HTTPS' || (l.tls?.certificateRefs?.length ?? 0) > 0,
    );
    const hasCertRefs = httpsListeners.some((l) => (l.tls?.certificateRefs?.length ?? 0) > 0);

    if (httpsListeners.length === 0) {
      // A gateway with only HTTP listeners (e.g. an MCP gateway) legitimately
      // has no TLS to grade — exclude it rather than scoring it a zero.
      dimensions.push({
        key: 'tls',
        label: 'TLS',
        weight: w,
        earned: 0,
        evaluated: false,
        severity: 'na',
        detail: 'No HTTPS listeners on this gateway.',
      });
    } else if (certificates.length > 0) {
      const rank: Record<string, number> = { ok: 0, warning: 1, critical: 2 };
      const worst = certificates.reduce(
        (acc, c) => (rank[c.healthLevel] > rank[acc] ? c.healthLevel : acc),
        'ok' as string,
      );
      const minDays = certificates
        .map((c) => c.daysUntilExpiry)
        .filter((d): d is number => d != null)
        .sort((a, b) => a - b)[0];
      const earned = worst === 'ok' ? w : worst === 'warning' ? w / 2 : 0;
      dimensions.push({
        key: 'tls',
        label: 'TLS',
        weight: w,
        earned,
        evaluated: true,
        severity: severityForFraction(earned / w),
        detail:
          worst === 'ok'
            ? `Certificate valid${minDays != null ? ` (${minDays}d to expiry)` : ''}.`
            : worst === 'warning'
            ? `Certificate expiring soon${minDays != null ? ` (${minDays}d left)` : ''}.`
            : 'Certificate expired or critically close to expiry.',
      });
    } else if (hasCertRefs) {
      // HTTPS is terminated with a referenced Secret, but the matching
      // cert-manager Certificate isn't named after the Secret (so it didn't
      // resolve above). TLS IS applied — if a TLSPolicy is enforced, say so;
      // otherwise note we can't track the cert lifecycle. Either way, don't
      // penalise a working HTTPS listener.
      const tlsPolicy = policies.find((p) => p.policyKind === 'TLSPolicy');
      dimensions.push({
        key: 'tls',
        label: 'TLS',
        weight: w,
        earned: w,
        evaluated: true,
        severity: 'healthy',
        detail: tlsPolicy?.isEnforced
          ? `TLS enforced by TLSPolicy ${tlsPolicy.policy.metadata?.name} (certificate details in the TLS overview).`
          : 'TLS terminated with a referenced certificate (lifecycle shown in the TLS overview).',
      });
    } else {
      dimensions.push({
        key: 'tls',
        label: 'TLS',
        weight: w,
        earned: 0,
        evaluated: true,
        severity: 'critical',
        detail: 'HTTPS listener without a resolvable certificate reference.',
      });
    }
  }

  // --- DNS ---
  {
    const w = SECURITY_WEIGHTS.dns;
    if (dnsEntries.length === 0) {
      // No DNSPolicy → the gateway is not Kuadrant-DNS-managed. We can't judge
      // an external DNS provider from here, so exclude it from the score.
      dimensions.push({
        key: 'dns',
        label: 'DNS',
        weight: w,
        earned: 0,
        evaluated: false,
        severity: 'na',
        detail: 'No DNSPolicy attached (DNS managed externally).',
      });
    } else {
      const healthy = dnsEntries.every((e) => e.propagationHealthy);
      const earned = healthy ? w : w / 2;
      dimensions.push({
        key: 'dns',
        label: 'DNS',
        weight: w,
        earned,
        evaluated: true,
        severity: severityForFraction(earned / w),
        detail: healthy
          ? 'DNSPolicy attached and records are Ready.'
          : 'DNS records are not fully propagated.',
      });
    }
  }

  // --- Reconciliation ---
  {
    const w = SECURITY_WEIGHTS.reconciliation;
    const conds = gateway?.status?.conditions || [];
    const programmed = conds.find((c) => c.type === 'Programmed')?.status === 'True';
    const listenerStatuses = gateway?.status?.listeners || [];
    const allListenersProgrammed =
      listenerStatuses.length === 0 ||
      listenerStatuses.every((l) =>
        (l.conditions || []).some((c) => c.type === 'Programmed' && c.status === 'True'),
      );
    let earned = 0;
    let detail = 'Gateway is not Programmed — the data plane is not fully configured.';
    if (programmed && allListenersProgrammed) {
      earned = w;
      detail = 'Gateway and all listeners are Programmed.';
    } else if (programmed) {
      earned = w / 2;
      detail = 'Gateway is Programmed but some listeners are not.';
    }
    dimensions.push({
      key: 'reconciliation',
      label: 'Reconciliation',
      weight: w,
      earned,
      evaluated: true,
      severity: severityForFraction(earned / w),
      detail,
    });
  }

  // --- Non-evaluated info rows (shown, excluded from the denominator) ---
  dimensions.push({
    key: 'waf',
    label: 'WAF',
    weight: 0,
    earned: 0,
    evaluated: false,
    severity: 'na',
    detail: 'Not evaluated — no WAF signal is exposed to the console.',
  });
  dimensions.push({
    key: 'headers',
    label: 'Security headers',
    weight: 0,
    earned: 0,
    evaluated: false,
    severity: 'na',
    detail: 'Not evaluated — requires an active HTTPS probe (companion not configured).',
  });

  const evaluated = dimensions.filter((d) => d.evaluated);
  const applicableWeight = evaluated.reduce((s, d) => s + d.weight, 0);
  const earnedTotal = evaluated.reduce((s, d) => s + d.earned, 0);
  const score =
    loaded && applicableWeight > 0 ? Math.round((earnedTotal / applicableWeight) * 100) : null;

  return { score, dimensions, applicableWeight, loaded };
}
