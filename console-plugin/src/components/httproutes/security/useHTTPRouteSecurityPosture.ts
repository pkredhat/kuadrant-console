import * as React from 'react';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  CertificateGVK,
  GatewayGVK,
  policyResourceURL,
} from '../../../models';
import {
  AnyPolicyOrGeneric,
  AuthPolicy,
  Certificate,
  Gateway,
  HTTPRoute,
  K8sCondition,
  PolicyAttachment,
  RateLimitPolicy,
  TLSPolicy,
  TokenRateLimitPolicy,
} from '../../../types';
import { useAttachedPolicies } from '../../../hooks/useAttachedPolicies';
import { computeEffectivePolicies } from '../../../utils/policyMerge';
import {
  AuthMode,
  CheckState,
  HeadersProbeSnapshot,
  ResourceReference,
  RouteOperationalStatus,
  RouteSecurityPosture,
  RouteSecuritySummary,
  SecurityCheck,
  SecurityFeatureSummary,
} from './routeSecurityTypes';

/**
 * Fixed risky-path list per user directive — surfaced (never
 * auto-classified as insecure) so a security check flags them for review.
 * Order matters when we build the display string.
 */
const RISKY_PATHS = ['/admin', '/debug', '/actuator', '/metrics', '/health', '*', '/'];

interface UseHTTPRouteSecurityPostureArgs {
  route: HTTPRoute | undefined;
  routeNamespace: string;
  parentGatewayName: string;
  parentGatewayNamespace: string;
  /** Live snapshot from useHTTPRouteHeadersProber (undefined until run). */
  headersProbe?: HeadersProbeSnapshot;
}

export interface UseHTTPRouteSecurityPostureResult {
  loaded: boolean;
  summary: RouteSecuritySummary;
  operational: RouteOperationalStatus;
  gateway: Gateway | undefined;
  certificates: Certificate[];
}

/**
 * Derive the RouteSecuritySummary + operational status the HTTPRoute
 * Details page renders. Uses:
 *
 *   - useAttachedPolicies for both the route and its parent Gateway
 *   - computeEffectivePolicies to resolve GEP-713 override math
 *   - the parent Gateway spec (listeners → tls, listener protocol)
 *   - cert-manager Certificates in the gateway's namespace
 *   - the raw HTTPRoute status.parents[].conditions
 *
 * Everything downstream (summary card, checks table, deep subcards) reads
 * this model — none of them poke at policy specs directly. That's how the
 * "Enabled" chip stays truthful even when a Gateway override silences a
 * route policy.
 */
export function useHTTPRouteSecurityPosture(
  args: UseHTTPRouteSecurityPostureArgs,
): UseHTTPRouteSecurityPostureResult {
  const {
    route,
    routeNamespace,
    parentGatewayName,
    parentGatewayNamespace,
    headersProbe,
  } = args;

  const {
    policies: routePolicies,
    loaded: routeLoaded,
  } = useAttachedPolicies('HTTPRoute', route?.metadata?.name || '', routeNamespace);

  const {
    policies: gatewayPolicies,
    loaded: gatewayLoaded,
  } = useAttachedPolicies('Gateway', parentGatewayName, parentGatewayNamespace);

  const [gateways, gwListLoaded] = useK8sWatchResource<Gateway[]>({
    groupVersionKind: GatewayGVK,
    isList: true,
    namespace: parentGatewayNamespace,
  });
  const gateway = React.useMemo(
    () => (gateways || []).find((g) => g.metadata?.name === parentGatewayName),
    [gateways, parentGatewayName],
  );

  // cert-manager Certificates in the Gateway's namespace — needed for the
  // TLS subcard (expiry / SAN / issuer). Not fatal if absent.
  const [certificates, certsLoaded] = useK8sWatchResource<Certificate[]>({
    groupVersionKind: CertificateGVK,
    isList: true,
    namespace: parentGatewayNamespace,
  });

  const loaded =
    !!route &&
    routeLoaded &&
    gatewayLoaded &&
    gwListLoaded &&
    certsLoaded;

  return React.useMemo<UseHTTPRouteSecurityPostureResult>(() => {
    const effectiveStack = loaded
      ? computeEffectivePolicies(gatewayPolicies || [], routePolicies || [])
      : [];

    const operational = extractOperational(route);
    const tls = buildTlsSummary(effectiveStack, gateway, certificates || []);
    const authentication = buildAuthSummary(effectiveStack);
    const rateLimiting = buildRateLimitSummary(effectiveStack);
    const headers = buildHeadersSummary(headersProbe);
    const riskyPaths = detectRiskyPaths(route);

    const checks = buildChecks({
      operational,
      tls,
      authentication,
      rateLimiting,
      headers,
      riskyPaths,
      route,
      certificates: certificates || [],
    });

    const posture = derivePosture({
      tls,
      authentication,
      rateLimiting,
      operational,
      checks,
    });

    const summary: RouteSecuritySummary = {
      posture: posture.value,
      postureReason: posture.reason,
      tls,
      authentication,
      rateLimiting,
      headers,
      checks,
      effectiveStack,
      primaryAuthPolicy: pickPrimary(effectiveStack, 'AuthPolicy'),
      primaryRateLimitPolicy: pickPrimary(effectiveStack, [
        'RateLimitPolicy',
        'TokenRateLimitPolicy',
      ]),
      primaryTLSPolicy: pickPrimary(effectiveStack, 'TLSPolicy'),
      riskyPaths,
      headersProbe,
    };

    return {
      loaded,
      summary,
      operational,
      gateway,
      certificates: certificates || [],
    };
  }, [
    loaded,
    route,
    routePolicies,
    gatewayPolicies,
    gateway,
    certificates,
    headersProbe,
  ]);
}

/* ------------------------------------------------------------------ */
/* Operational status derivation                                       */
/* ------------------------------------------------------------------ */

function extractOperational(route: HTTPRoute | undefined): RouteOperationalStatus {
  const conditions: K8sCondition[] = route?.status?.parents?.[0]?.conditions || [];
  const byType = (type: string): K8sCondition | undefined =>
    conditions.find((c) => c.type === type);

  const stateFrom = (c: K8sCondition | undefined, positiveWhenTrue = true): CheckState => {
    if (!c || !c.status || c.status === 'Unknown') return 'unknown';
    const isTrue = c.status === 'True';
    if (positiveWhenTrue) return isTrue ? 'passed' : 'failed';
    // Degraded: True is bad, False is good.
    return isTrue ? 'failed' : 'passed';
  };

  const accepted = byType('Accepted');
  const resolved = byType('ResolvedRefs');
  const programmed = byType('Programmed');
  const degraded = byType('Degraded');

  // Prefer the first failing condition for the top-level reason/message —
  // that's what an operator wants to read at a glance.
  const firstBad = [resolved, accepted, programmed].find(
    (c) => c && c.status === 'False',
  ) || (degraded?.status === 'True' ? degraded : undefined);

  return {
    accepted: stateFrom(accepted, true),
    resolvedRefs: stateFrom(resolved, true),
    programmed: stateFrom(programmed, true),
    degraded: stateFrom(degraded, false),
    reason: firstBad?.reason,
    message: firstBad?.message,
  };
}

/* ------------------------------------------------------------------ */
/* Feature summaries                                                   */
/* ------------------------------------------------------------------ */

function buildTlsSummary(
  stack: PolicyAttachment[],
  gateway: Gateway | undefined,
  certificates: Certificate[],
): SecurityFeatureSummary {
  const tlsAttach = pickEffectivePolicy(stack, 'TLSPolicy');
  const listeners = gateway?.spec?.listeners || [];
  const tlsListener = listeners.find(
    (l) => l.protocol?.toUpperCase() === 'HTTPS' || l.tls?.certificateRefs?.length,
  );

  // Nothing at all — no HTTPS listener AND no TLSPolicy → not configured.
  if (!tlsListener && !tlsAttach) {
    return {
      status: 'not-configured',
      label: 'Not Configured',
      description: 'This route is served without TLS.',
    };
  }

  const details: Record<string, string | number | boolean | string[] | undefined> = {};
  if (tlsListener) {
    details['Listener'] = tlsListener.name;
    details['Protocol'] = tlsListener.protocol;
    details['Mode'] = tlsListener.tls?.mode || 'Terminate';
    const certRef = tlsListener.tls?.certificateRefs?.[0];
    if (certRef) details['Certificate ref'] = certRef.name;
  }
  if (tlsAttach) {
    const p = tlsAttach.policy as TLSPolicy;
    details['TLS Policy'] = p.metadata?.name || '';
    if (p.spec?.issuerRef?.name) details['Issuer'] = p.spec.issuerRef.name;
    if (p.spec?.duration) details['Duration'] = p.spec.duration;
    if (p.spec?.renewBefore) details['Renew before'] = p.spec.renewBefore;
  }

  // Certificate lifecycle → warning window 14d, critical 3d, failed on expired.
  const cert = certificates.find((c) => {
    const ref = tlsListener?.tls?.certificateRefs?.[0]?.name;
    return ref ? c.metadata?.name === ref : false;
  });
  if (cert?.status?.notAfter) {
    details['Valid until'] = cert.status.notAfter;
    const days = Math.floor(
      (new Date(cert.status.notAfter).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
    details['Days remaining'] = days;
    if (days < 0) {
      return withRef({
        status: 'failed',
        label: 'Failed',
        description: `Certificate expired ${Math.abs(days)} day(s) ago.`,
        details,
      }, tlsAttach);
    }
    if (days < 3) {
      return withRef({
        status: 'failed',
        label: 'Failed',
        description: `Certificate expires in ${days} day(s).`,
        details,
      }, tlsAttach);
    }
    if (days < 14) {
      return withRef({
        status: 'warning',
        label: 'Warning',
        description: `Certificate expires in ${days} day(s).`,
        details,
      }, tlsAttach);
    }
  }

  // Overridden by a Gateway TLSPolicy override? The effective stack marks it.
  if (tlsAttach?.isOverridden) {
    return withRef({
      status: 'overridden',
      label: 'Overridden',
      description: 'A Gateway-level TLSPolicy override is active.',
      details,
    }, tlsAttach);
  }

  // No enforced condition and no HTTPS listener → warning.
  if (!tlsListener && tlsAttach && !tlsAttach.isEnforced) {
    return withRef({
      status: 'warning',
      label: 'Warning',
      description: 'TLSPolicy is attached but not yet Enforced.',
      details,
    }, tlsAttach);
  }

  return withRef({
    status: 'enabled',
    label: 'Enabled',
    description: tlsAttach
      ? 'TLS is enforced through the effective TLSPolicy.'
      : 'TLS is inherited from the Gateway listener configuration.',
    details,
  }, tlsAttach);
}

function buildAuthSummary(stack: PolicyAttachment[]): SecurityFeatureSummary {
  const authAttach = pickEffectivePolicy(stack, 'AuthPolicy');
  if (!authAttach) {
    return {
      status: 'not-configured',
      label: 'Not Configured',
      description: 'No AuthPolicy is attached to this route.',
    };
  }
  const policy = authAttach.policy as AuthPolicy;
  const rules =
    policy.spec?.rules ||
    policy.spec?.defaults?.rules ||
    policy.spec?.overrides?.rules;
  const authentication = rules?.authentication || {};
  const identityNames = Object.keys(authentication);

  // AuthPolicies in the wizard's templates commonly declare MULTIPLE identity
  // blocks (e.g. jwt-keycloak + api-key-header + api-key-query + public-*),
  // each gated by a `when:` predicate that scopes it to a subset of routes.
  // A previous implementation reported the whole policy as "Anonymous" when
  // ANY block was anonymous, which misled the operator into thinking the
  // route accepted no auth. We now:
  //   - list EVERY distinct mode present in the policy
  //   - pick the strongest mode (OIDC > JWT > API Key > Kubernetes token
  //     > OAuth2 > mTLS > Anonymous > Other) for the primary label
  //   - only fall back to the "Anonymous" warning label when anonymous is
  //     the ONLY mode (the wizard's Public REST escape hatch)
  const presentModes = detectAllAuthModes(authentication);
  const primaryMode = pickPrimaryMode(presentModes);
  const hasAnonymous = presentModes.includes('anonymous');
  const strongModes = presentModes.filter((m) => m !== 'anonymous');
  const modeLabel = describeModes(presentModes);

  const details: Record<string, string | number | boolean | string[] | undefined> = {
    'Auth Policy': policy.metadata?.name || '',
    'Namespace': policy.metadata?.namespace || '',
    'Identity blocks': identityNames,
    'Modes': presentModes.map(labelForAuthMode),
  };

  // Pull the first non-anonymous block's fields so the deep card shows
  // useful details (issuer/credential source) rather than the anonymous
  // block's near-empty spec.
  const firstProtected =
    identityNames
      .map((n) => ({ name: n, block: authentication[n] }))
      .find(({ block }) => !block?.anonymous) ||
    (identityNames[0] ? { name: identityNames[0], block: authentication[identityNames[0]] } : undefined);
  const first = firstProtected?.block;
  if (first?.jwt?.issuerUrl) details['JWT issuer'] = first.jwt.issuerUrl;
  if (first?.jwt?.audiences?.length) details['JWT audiences'] = first.jwt.audiences.join(', ');
  if (first?.oidc?.endpoint) details['OIDC issuer'] = first.oidc.endpoint;
  const creds = first?.credentials || first?.oidc?.credentials;
  if (creds?.customHeader?.name) details['Credential source'] = `Header: ${creds.customHeader.name}`;
  else if (creds?.queryString?.name) details['Credential source'] = `Query: ${creds.queryString.name}`;
  else if (creds?.cookie?.name) details['Credential source'] = `Cookie: ${creds.cookie.name}`;
  else if (creds?.authorizationHeader) {
    const p = creds.authorizationHeader.prefix || 'Bearer';
    details['Credential source'] = `Authorization: ${p}`;
  }

  if (authAttach.isOverridden) {
    return withRef({
      status: 'overridden',
      label: 'Overridden',
      description: 'A Gateway-level AuthPolicy override is active for this route.',
      details,
    }, authAttach);
  }

  // Only pure-anonymous = wizard's Public REST escape hatch — warn but
  // don't fail. A policy with anonymous PLUS other auth blocks is a
  // deliberate mixed policy (e.g. anonymous OPTIONS for CORS preflight
  // + JWT for everything else) — that's Enabled with a note.
  if (strongModes.length === 0 && hasAnonymous) {
    return withRef({
      status: 'warning',
      label: 'Anonymous',
      description: 'This route accepts unauthenticated requests via anonymous access.',
      details,
    }, authAttach);
  }

  if (!authAttach.isEnforced) {
    return withRef({
      status: 'warning',
      label: 'Not Enforced',
      description: `AuthPolicy is attached (${modeLabel}) but not yet Enforced.`,
      details,
    }, authAttach);
  }

  return withRef({
    status: 'enabled',
    label: strongModes.length > 1 ? 'Multi-mode' : labelForAuthMode(primaryMode),
    description: hasAnonymous
      ? `Requests are authenticated (${modeLabel}); some scoped routes accept anonymous access via when predicates.`
      : `Requests are authenticated (${modeLabel}).`,
    details,
  }, authAttach);
}

// Enumerate every distinct auth mechanism declared by the policy —
// duplicates collapse (e.g. two api-key blocks return ['api-key']).
function detectAllAuthModes(
  authentication: Record<string, {
    apiKey?: unknown;
    jwt?: unknown;
    oidc?: unknown;
    oauth2?: unknown;
    anonymous?: unknown;
    kubernetesTokenReview?: unknown;
  }>,
): AuthMode[] {
  const modes = new Set<AuthMode>();
  for (const block of Object.values(authentication)) {
    if (block.anonymous) modes.add('anonymous');
    if (block.oidc) modes.add('oidc');
    if (block.oauth2) modes.add('oauth2');
    if (block.jwt) modes.add('jwt');
    if (block.apiKey) modes.add('api-key');
    if (block.kubernetesTokenReview) modes.add('kubernetes-token');
  }
  // Preserve display order: strongest first, anonymous last.
  const order: AuthMode[] = ['oidc', 'jwt', 'api-key', 'kubernetes-token', 'oauth2', 'mtls', 'other', 'anonymous'];
  return order.filter((m) => modes.has(m));
}

// The primary label shown when only ONE mode is picked. Prefers the
// strongest protected mode over anonymous.
function pickPrimaryMode(modes: AuthMode[]): AuthMode {
  const protectedOnly = modes.filter((m) => m !== 'anonymous');
  return protectedOnly[0] || modes[0] || 'other';
}

function describeModes(modes: AuthMode[]): string {
  if (modes.length === 0) return 'no identities';
  return modes.map(labelForAuthMode).join(' + ');
}

function buildRateLimitSummary(stack: PolicyAttachment[]): SecurityFeatureSummary {
  const rlAttach = pickEffectivePolicy(stack, 'RateLimitPolicy');
  const tokenAttach = pickEffectivePolicy(stack, 'TokenRateLimitPolicy');
  if (!rlAttach && !tokenAttach) {
    return {
      status: 'not-configured',
      label: 'Not Configured',
      description: 'No rate limiting policy is attached to this route.',
    };
  }

  const details: Record<string, string | number | boolean | string[] | undefined> = {};

  if (rlAttach) {
    const p = rlAttach.policy as RateLimitPolicy;
    const limits = p.spec?.limits || p.spec?.defaults?.limits || p.spec?.overrides?.limits || {};
    const limitNames = Object.keys(limits);
    details['Rate Limit Policy'] = p.metadata?.name || '';
    details['Limit blocks'] = limitNames;
    const first = limitNames[0] ? limits[limitNames[0]] : undefined;
    if (first?.rates?.length) {
      details['Primary limit'] = `${first.rates[0].limit} per ${first.rates[0].window}`;
    } else if (first) {
      details['Primary limit'] = 'Unlimited';
    }
  }
  if (tokenAttach) {
    const p = tokenAttach.policy as TokenRateLimitPolicy;
    const limits = p.spec?.defaults?.limits || p.spec?.overrides?.limits || {};
    const limitNames = Object.keys(limits);
    details['Token Rate Limit Policy'] = p.metadata?.name || '';
    details['Token limit blocks'] = limitNames;
    const first = limitNames[0] ? limits[limitNames[0]] : undefined;
    if (first) {
      details['Primary token limit'] = `${first.tokens} tokens per ${first.window}`;
    }
  }

  const overridden = (rlAttach?.isOverridden ?? false) && (tokenAttach?.isOverridden ?? true);
  if (overridden && (rlAttach || tokenAttach)) {
    return withRef({
      status: 'overridden',
      label: 'Overridden',
      description: 'A Gateway-level RateLimit override is active for this route.',
      details,
    }, rlAttach || tokenAttach);
  }

  const enforced =
    (rlAttach && rlAttach.isEnforced) || (tokenAttach && tokenAttach.isEnforced);
  if (!enforced) {
    return withRef({
      status: 'warning',
      label: 'Not Enforced',
      description: 'A rate limit policy is attached but not yet Enforced.',
      details,
    }, rlAttach || tokenAttach);
  }

  return withRef({
    status: 'enabled',
    label: 'Enabled',
    description: 'Requests to this route are rate-limited.',
    details,
  }, rlAttach || tokenAttach);
}

function buildHeadersSummary(
  headersProbe: HeadersProbeSnapshot | undefined,
): SecurityFeatureSummary {
  if (!headersProbe) {
    return {
      status: 'unknown',
      label: 'Not probed',
      description: 'Click Run check to probe live security response headers.',
    };
  }
  if (headersProbe.error) {
    return {
      status: 'unknown',
      label: 'Probe failed',
      description: headersProbe.error,
    };
  }
  const missing = headersProbe.headers.filter((h) => !h.present && h.status === 'failed');
  const warnings = headersProbe.headers.filter((h) => h.status === 'warning');
  if (missing.length > 0) {
    return {
      status: 'failed',
      label: `${missing.length} missing`,
      description: `Missing: ${missing.map((h) => h.header).join(', ')}`,
      details: headerDetails(headersProbe),
    };
  }
  if (warnings.length > 0) {
    return {
      status: 'warning',
      label: `${warnings.length} warning(s)`,
      description: warnings.map((h) => `${h.header}: ${h.detail}`).join('; '),
      details: headerDetails(headersProbe),
    };
  }
  return {
    status: 'enabled',
    label: 'Enabled',
    description: 'All checked security response headers are present with safe values.',
    details: headerDetails(headersProbe),
  };
}

function headerDetails(
  probe: HeadersProbeSnapshot,
): Record<string, string | number | boolean | string[] | undefined> {
  const out: Record<string, string | number | boolean | string[] | undefined> = {
    'Probed URL': probe.url,
    'Probed at': probe.probedAt,
    'HTTP status': probe.httpStatus,
    'Latency (ms)': probe.latencyMs,
  };
  for (const h of probe.headers) {
    out[h.header] = h.present ? h.value || '(present)' : '(missing)';
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Auth-mode discriminator                                             */
/* ------------------------------------------------------------------ */

function labelForAuthMode(mode: AuthMode): string {
  switch (mode) {
    case 'anonymous':
      return 'Anonymous access';
    case 'api-key':
      return 'API Key';
    case 'jwt':
      return 'JWT';
    case 'oidc':
      return 'OIDC';
    case 'oauth2':
      return 'OAuth2';
    case 'kubernetes-token':
      return 'Kubernetes token review';
    case 'mtls':
      return 'mTLS identity';
    default:
      return 'Other';
  }
}

/* ------------------------------------------------------------------ */
/* Checks + posture derivation                                          */
/* ------------------------------------------------------------------ */

interface BuildChecksArgs {
  operational: RouteOperationalStatus;
  tls: SecurityFeatureSummary;
  authentication: SecurityFeatureSummary;
  rateLimiting: SecurityFeatureSummary;
  headers: SecurityFeatureSummary;
  riskyPaths: string[];
  route: HTTPRoute | undefined;
  certificates: Certificate[];
}

function buildChecks(args: BuildChecksArgs): SecurityCheck[] {
  const { operational, tls, authentication, rateLimiting, headers, riskyPaths, route } = args;
  const checks: SecurityCheck[] = [];

  // 1. Backend references resolved
  checks.push({
    id: 'backend-refs',
    label: 'Backend references are resolved',
    status: operational.resolvedRefs,
    details:
      operational.resolvedRefs === 'passed'
        ? 'All backends referenced by this route were resolved.'
        : operational.message ||
          'One or more backendRefs could not be resolved — check the Service exists in the target namespace.',
  });

  // 2. Route accepted / programmed
  checks.push({
    id: 'route-accepted',
    label: 'HTTPRoute is Accepted by the parent Gateway',
    status: operational.accepted,
    details:
      operational.accepted === 'passed'
        ? 'The parent Gateway accepted this route.'
        : operational.message || 'The parent Gateway has not accepted this route.',
  });
  checks.push({
    id: 'route-programmed',
    label: 'HTTPRoute is Programmed on the data plane',
    status: operational.programmed,
    details:
      operational.programmed === 'passed'
        ? 'The route is programmed on the gateway data plane.'
        : operational.message || 'The route has not been programmed on the data plane yet.',
  });

  // 3. TLS checks
  if (tls.status === 'not-configured') {
    checks.push({
      id: 'tls-configured',
      label: 'TLS is configured on the listener',
      status: 'failed',
      details: 'The parent Gateway does not expose an HTTPS listener for this route.',
    });
  } else if (tls.status === 'failed') {
    checks.push({
      id: 'tls-valid',
      label: 'TLS certificate is valid',
      status: 'failed',
      details: tls.description || 'TLS certificate has issues that block secure serving.',
    });
  } else if (tls.status === 'warning') {
    checks.push({
      id: 'tls-lifecycle',
      label: 'TLS certificate lifecycle is healthy',
      status: 'warning',
      details: tls.description || 'Certificate is approaching renewal.',
    });
  } else {
    checks.push({
      id: 'tls-valid',
      label: 'TLS certificate is valid',
      status: 'passed',
      details: tls.description || 'TLS is enabled for this route.',
    });
  }

  // 4. Authentication enforced
  const authState: CheckState =
    authentication.status === 'enabled'
      ? 'passed'
      : authentication.status === 'not-configured'
      ? 'failed'
      : authentication.status === 'overridden'
      ? 'warning'
      : 'warning';
  checks.push({
    id: 'auth-enforced',
    label: 'Authentication is enforced',
    status: authState,
    details:
      authentication.description ||
      (authentication.status === 'not-configured'
        ? 'No effective AuthPolicy protects this route.'
        : 'AuthPolicy is not fully enforced.'),
  });

  // 5. Rate limit enforced (soft — warn, not fail, when absent)
  const rlState: CheckState =
    rateLimiting.status === 'enabled'
      ? 'passed'
      : rateLimiting.status === 'not-configured'
      ? 'warning'
      : rateLimiting.status === 'overridden'
      ? 'warning'
      : 'warning';
  checks.push({
    id: 'ratelimit-enforced',
    label: 'Rate limiting is enforced',
    status: rlState,
    details:
      rateLimiting.description ||
      (rateLimiting.status === 'not-configured'
        ? 'No rate limit policy protects this route — consider attaching one to prevent abuse.'
        : 'Rate limit policy is not fully enforced.'),
  });

  // 6. Risky paths
  checks.push({
    id: 'risky-paths',
    label: 'No exposed administrative paths detected',
    status: riskyPaths.length === 0 ? 'passed' : 'warning',
    details:
      riskyPaths.length === 0
        ? 'No admin or debug paths detected in the route rules.'
        : `The following risky paths are exposed: ${riskyPaths.join(', ')}. Review whether they require additional protection.`,
  });

  // 7. Security headers
  const headersState: CheckState =
    headers.status === 'enabled'
      ? 'passed'
      : headers.status === 'unknown'
      ? 'skipped'
      : headers.status === 'warning'
      ? 'warning'
      : 'failed';
  checks.push({
    id: 'security-headers',
    label: 'Security response headers are present',
    status: headersState,
    details:
      headers.description ||
      (headersState === 'skipped'
        ? 'Headers probe has not been run yet — click Run check in the Security Headers card.'
        : 'One or more recommended security response headers are missing.'),
  });

  // 8. No conflicting/overridden policy silently disabling a feature
  const overriddenFeatures = [tls, authentication, rateLimiting].filter(
    (f) => f.status === 'overridden',
  );
  if (overriddenFeatures.length > 0) {
    checks.push({
      id: 'no-conflicts',
      label: 'No conflicting or overridden policy leaves an unexpected gap',
      status: 'warning',
      details: `${overriddenFeatures.length} feature(s) are overridden by a parent Gateway policy — review the effective policy stack.`,
    });
  } else {
    checks.push({
      id: 'no-conflicts',
      label: 'No conflicting or overridden policy leaves an unexpected gap',
      status: 'passed',
      details: 'Effective policies were resolved without conflicting overrides.',
    });
  }

  // Stable per-check lastChecked (route resource-version drives it — refreshes
  // when the cluster observed a change).
  const ts = route?.metadata?.resourceVersion
    ? `rv:${route.metadata.resourceVersion}`
    : undefined;
  return checks.map((c) => ({ ...c, lastChecked: ts }));
}

function derivePosture(args: {
  tls: SecurityFeatureSummary;
  authentication: SecurityFeatureSummary;
  rateLimiting: SecurityFeatureSummary;
  operational: RouteOperationalStatus;
  checks: SecurityCheck[];
}): { value: RouteSecurityPosture; reason: string } {
  const { tls, authentication, rateLimiting, operational, checks } = args;

  // At Risk: any critical TLS / Auth / operational failure.
  if (operational.accepted === 'failed' || operational.resolvedRefs === 'failed' || operational.programmed === 'failed') {
    return {
      value: 'at-risk',
      reason: 'This route is not operational — investigate before considering it protected.',
    };
  }
  if (tls.status === 'failed') {
    return { value: 'at-risk', reason: 'TLS is broken or the certificate is expired.' };
  }
  if (authentication.status === 'not-configured' && !isPublicByDesign(authentication)) {
    return {
      value: 'at-risk',
      reason: 'No effective AuthPolicy protects this route.',
    };
  }

  // Needs Attention: any warning, overridden feature, or check
  const warningFeature = [tls, authentication, rateLimiting].some(
    (f) => f.status === 'warning' || f.status === 'overridden',
  );
  const anyWarningCheck = checks.some((c) => c.status === 'warning');
  if (warningFeature || anyWarningCheck) {
    const reason =
      tls.status === 'warning'
        ? tls.description
        : authentication.status === 'warning' || authentication.status === 'overridden'
        ? authentication.description
        : rateLimiting.status === 'warning' || rateLimiting.status === 'overridden'
        ? rateLimiting.description
        : 'One or more security checks require attention.';
    return { value: 'needs-attention', reason: reason || 'See security checks below.' };
  }

  // Not Configured: nothing has been set up at all
  if (
    tls.status === 'not-configured' &&
    authentication.status === 'not-configured' &&
    rateLimiting.status === 'not-configured'
  ) {
    return {
      value: 'not-configured',
      reason: 'No security controls exist and no policy expectation is defined.',
    };
  }

  return {
    value: 'secure',
    reason: 'All required security controls are effectively enforced.',
  };
}

// Anonymous is the wizard's Public REST escape hatch — that's a "warning"
// posture (declared intent) rather than an "at risk" one.
function isPublicByDesign(auth: SecurityFeatureSummary): boolean {
  return auth.label === 'Anonymous';
}

/* ------------------------------------------------------------------ */
/* Risky path detection                                                */
/* ------------------------------------------------------------------ */

function detectRiskyPaths(route: HTTPRoute | undefined): string[] {
  if (!route) return [];
  const hits = new Set<string>();
  for (const rule of route.spec?.rules || []) {
    for (const match of rule.matches || []) {
      const value = match.path?.value;
      const type = match.path?.type;
      // Explicit path patterns
      if (value) {
        for (const risky of RISKY_PATHS) {
          if (risky === '*' || risky === '/') {
            if (value === '/' && risky === '/') hits.add('/');
          } else if (value.startsWith(risky)) {
            hits.add(risky);
          }
        }
      }
      // Gateway API: absent match ~ prefix "/"
      if (!value && !type) hits.add('/');
    }
    // Rule with NO matches: catch-all — treat as "/"
    if (!rule.matches || rule.matches.length === 0) hits.add('/');
  }
  return Array.from(hits).sort();
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function pickEffectivePolicy(
  stack: PolicyAttachment[],
  kind: string,
): PolicyAttachment | undefined {
  // Effective = not overridden. When only overridden entries exist we still
  // return the first one so the UI can render an "Overridden" chip pointing
  // at the actual policy the operator wrote.
  const enforced = stack.find((p) => p.policyKind === kind && !p.isOverridden);
  if (enforced) return enforced;
  return stack.find((p) => p.policyKind === kind);
}

function pickPrimary(
  stack: PolicyAttachment[],
  kinds: string | string[],
): AnyPolicyOrGeneric | undefined {
  const arr = Array.isArray(kinds) ? kinds : [kinds];
  for (const k of arr) {
    const hit = pickEffectivePolicy(stack, k);
    if (hit) return hit.policy;
  }
  return undefined;
}

function withRef(
  base: SecurityFeatureSummary,
  attach: PolicyAttachment | undefined,
): SecurityFeatureSummary {
  if (!attach) return base;
  const kind = attach.policyKind;
  const ns = attach.policy.metadata?.namespace || '';
  const name = attach.policy.metadata?.name || '';
  const ref: ResourceReference = {
    kind,
    name,
    namespace: ns,
    href: policyResourceURL(kind, ns, name),
  };
  return { ...base, policyRef: ref };
}

/* Re-export for consumers that just want the risky path list. */
export const HTTPROUTE_RISKY_PATHS = RISKY_PATHS;
