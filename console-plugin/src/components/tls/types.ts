/**
 * Shared types for the TLS Troubleshooting page.
 *
 * Mirrors the shape of `dns/types.ts` on purpose — the same 3-column
 * layout (flow diagram + main widgets + right side panel) is reused, so
 * the surface each widget consumes lines up 1:1 with what its DNS
 * counterpart accepts, keeping the two pages visually consistent.
 */

export type TlsStepStatus =
  | 'healthy'
  | 'pending'
  | 'warning'
  | 'failing'
  | 'skipped'
  | 'not-configured'
  | 'unknown';

export interface TlsStep {
  id: string;
  /** Human-facing pipeline step label, e.g. `Certificate` or
   *  `ACME Challenge`. */
  title: string;
  /** Name of the underlying CR when one exists. */
  resourceName?: string;
  namespace?: string;
  status: TlsStepStatus;
  /** One-liner shown under the resource name. Should read as an
   *  operator's short verdict, not a raw condition message. */
  summary?: string;
  /** Key/value grid inside the card. Muted rows read as "not
   *  applicable" — e.g. Order/Challenge when the issuer isn't ACME. */
  details?: Array<{ label: string; value: string; muted?: boolean }>;
  /** Deep link into the console detail page for the underlying CR when
   *  applicable — clicking the card jumps straight to it. */
  href?: string;
}

export interface TlsTimelineEvent {
  when: string; // ISO
  title: string;
  detail?: string;
  status: TlsStepStatus;
}

export interface TlsCheck {
  id: string;
  label: string;
  status: TlsStepStatus;
  details?: string;
  /** Rough execution time surfaced in the row — mostly for texture,
   *  since watches are instant. Skipped for checks that never actually
   *  run. */
  durationMs?: number;
  /** Deep link to the resource this check probed, when applicable. */
  href?: string;
}

export type TlsRecommendationSeverity = 'critical' | 'warning' | 'info';

export interface TlsRecommendation {
  id: string;
  severity: TlsRecommendationSeverity;
  title: string;
  detail?: string;
  /** If present, the panel renders a button that navigates here. */
  href?: string;
  /** If present, the button copies this to the clipboard instead of
   *  navigating — used for renewal / manual-fix commands. */
  copyCommand?: string;
}

export interface CertificateSummary {
  name: string;
  namespace: string;
  issuer?: string;
  validFrom?: string; // ISO
  expiresAt?: string; // ISO
  renewalTime?: string; // ISO
  secretName?: string;
  sans?: string[];
  algorithm?: string;
  keyUsages?: string[];
}

export interface OverallTlsStatus {
  overall: TlsStepStatus;
  certificate: {
    status: TlsStepStatus;
    label: string;
    subLabel?: string;
  };
  validUntil: {
    /** Days remaining. Negative when expired. */
    daysRemaining: number | null;
    isoDate: string | null;
    /** Colour bucket used by the KPI card — mirrors what the
     *  Certificate Lifetime bar uses. */
    severity: 'healthy' | 'warning' | 'critical' | 'unknown';
  };
  autoRenewal: {
    status: TlsStepStatus;
    label: string;
    subLabel?: string;
  };
  httpsCheck: {
    status: TlsStepStatus;
    label: string;
    subLabel?: string;
  };
}

export interface TlsFlow {
  hostname: string;
  hostnameOptions: string[];
  overall: OverallTlsStatus;
  steps: TlsStep[];
  timeline: TlsTimelineEvent[];
  checks: TlsCheck[];
  recommendations: TlsRecommendation[];
  certificate: CertificateSummary | null;
  /** The step that most likely explains the current failure —
   *  RootCausePanel keys off this. Null when everything is healthy or
   *  nothing is wired up yet. */
  primaryFailure: TlsStep | null;
  /** True while any underlying watch is still hydrating. */
  loading: boolean;
  /** True when no TLSPolicy exists for the selected hostname — page
   *  renders an empty-state CTA to seed one. */
  needsTlsPolicy: boolean;
  /** The Gateway the empty-state CTA should pre-fill against. */
  targetGateway: { name: string; namespace: string } | null;
  /** Deep links surfaced on the External Links panel. */
  externalLinks: {
    grafana?: string;
    prometheus?: string;
    certManager?: string;
    letsEncryptStatus?: string;
    dnsChecker?: string;
  };
  /** Deep links for the header toolbar. */
  headerLinks: {
    openCertificate?: string;
    openGateway?: string;
    openSecret?: string;
  };
}
