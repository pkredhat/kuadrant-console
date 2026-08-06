/**
 * Normalized frontend model for the HTTPRoute Details security refactoring.
 *
 * The UI never reads AuthPolicy/RateLimitPolicy/TLSPolicy specs directly —
 * every card / check / summary consumes one of these adapters instead. Two
 * reasons:
 *
 *  1. The Gateway API + Kuadrant surface has several ways to say the same
 *     thing (`spec.targetRef` vs `spec.targetRefs[]`, `defaults` vs
 *     `overrides`, listener-inherited TLS vs route-level TLS, etc). If the
 *     UI branches on the raw shape, every new policy field ripples into
 *     every card.
 *  2. The Security posture is derived from EFFECTIVE behavior (post
 *     GEP-713 override merge), not from resource existence. That resolution
 *     lives in one place (useHTTPRouteSecurityPosture) so the summary
 *     card, the checks table, and the deep Security tab agree on "is
 *     Authentication actually enforced here?"
 */

import { AnyPolicyOrGeneric, PolicyAttachment } from '../../../types';

export type SecurityFeatureStatus =
  | 'enabled'
  | 'warning'
  | 'failed'
  | 'not-configured'
  | 'overridden'
  | 'unknown';

export type RouteSecurityPosture =
  | 'secure'
  | 'needs-attention'
  | 'at-risk'
  | 'not-configured'
  | 'unknown';

export type CheckState = 'passed' | 'warning' | 'failed' | 'skipped' | 'unknown';

export interface ResourceReference {
  kind: string;
  name: string;
  namespace?: string;
  /** Plugin URL if one exists (`policyResourceURL`, TLS overview, …). */
  href?: string;
}

export interface SecurityFeatureSummary {
  status: SecurityFeatureStatus;
  /** One-word display label (Enabled / Not Configured / Overridden / …). */
  label: string;
  /** Primary policy or resource behind this feature (link target). */
  policyRef?: ResourceReference;
  /** Long-form explanation used by the drawer or the summary card tooltip. */
  description?: string;
  /** Free-form key/value pairs used by the deep-dive subcards. */
  details?: Record<string, string | number | boolean | string[] | undefined>;
}

export interface RouteOperationalStatus {
  accepted: CheckState;
  resolvedRefs: CheckState;
  programmed: CheckState;
  degraded: CheckState;
  reason?: string;
  message?: string;
}

export interface SecurityCheckAction {
  label: string;
  href?: string;
  /** Fires when clicked. Set instead of href for local UI actions. */
  onClick?: () => void;
}

export interface SecurityCheck {
  id: string;
  label: string;
  status: CheckState;
  details: string;
  lastChecked?: string;
  action?: SecurityCheckAction;
}

/**
 * Auth-mode discriminator used by the Authentication subcard + summary. The
 * console still supports the anonymous escape-hatch that the wizard emits
 * for Public REST APIs, so it's a first-class case here.
 */
export type AuthMode = 'anonymous' | 'api-key' | 'jwt' | 'oidc' | 'oauth2' | 'kubernetes-token' | 'mtls' | 'other';

export interface RouteSecuritySummary {
  posture: RouteSecurityPosture;
  postureReason: string;
  tls: SecurityFeatureSummary;
  authentication: SecurityFeatureSummary;
  rateLimiting: SecurityFeatureSummary;
  headers: SecurityFeatureSummary;
  checks: SecurityCheck[];
  /** Post-GEP-713 policy chain we resolved this posture from. */
  effectiveStack: PolicyAttachment[];
  /** Direct references to the primary policies (used by "View policy" buttons). */
  primaryAuthPolicy?: AnyPolicyOrGeneric;
  primaryRateLimitPolicy?: AnyPolicyOrGeneric;
  primaryTLSPolicy?: AnyPolicyOrGeneric;
  /**
   * Every path pattern this route exposes matched against the fixed risky-path
   * list (`/admin`, `/debug`, `/actuator`, `/metrics`, `/health`, `*`, `/`).
   * Empty when the route only exposes purpose-built paths.
   */
  riskyPaths: string[];
  /**
   * Live security-headers probe result. Absent when the prober companion is
   * not installed or the operator has not clicked "Run check" yet.
   */
  headersProbe?: HeadersProbeSnapshot;
}

/**
 * Live snapshot of the /api/headers/probe response. Kept separately from the
 * SecurityFeatureSummary so the summary card can render the summary status
 * derived from the snapshot (e.g. "Warning — CSP missing") while the deep
 * subcard renders the per-header breakdown.
 */
export interface HeadersProbeSnapshot {
  url: string;
  probedAt: string;
  httpStatus?: number;
  latencyMs?: number;
  headers: HeaderCheckResult[];
  /** Overall summary derived from the individual checks. */
  status: SecurityFeatureStatus;
  /** Set when the fetch itself failed. */
  error?: string;
}

export interface HeaderCheckResult {
  id: 'hsts' | 'csp' | 'x-content-type-options' | 'x-frame-options' | 'referrer-policy' | 'cache-control';
  header: string;
  present: boolean;
  value?: string;
  /** Passed / warning / failed judgement (e.g. HSTS present but no
   *  includeSubDomains → warning). */
  status: CheckState;
  detail: string;
}
