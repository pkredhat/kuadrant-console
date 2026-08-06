import * as React from 'react';
import { Card, CardTitle, CardBody } from '@patternfly/react-core';
import { STATUS_META } from '../dns/types';
import { CertificateSummary } from './types';

/**
 * Horizontal timeline of the certificate's lifetime — issued on the
 * left, today's marker slides across the bar, expiry on the right. Bar
 * fill colour buckets:
 *   healthy  — >30 days remaining
 *   warning  — 7-30 days remaining
 *   critical — <7 days or already expired
 *
 * Deliberately compact — an operator glancing at this should know
 * "am I about to lose HTTPS?" without doing arithmetic.
 */

interface Props {
  cert: CertificateSummary | null;
}

function clamp(pct: number): number {
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

const TLSCertificateLifetimeCard: React.FC<Props> = ({ cert }) => {
  const validFromMs = cert?.validFrom ? new Date(cert.validFrom).getTime() : null;
  const expiresMs = cert?.expiresAt ? new Date(cert.expiresAt).getTime() : null;

  let pct = 0;
  let daysRemaining: number | null = null;
  if (validFromMs && expiresMs) {
    const total = expiresMs - validFromMs;
    const elapsed = Date.now() - validFromMs;
    pct = clamp((elapsed / total) * 100);
    daysRemaining = Math.floor((expiresMs - Date.now()) / 86_400_000);
  }

  const severity: 'healthy' | 'warning' | 'critical' | 'unknown' =
    daysRemaining == null
      ? 'unknown'
      : daysRemaining < 7
      ? 'critical'
      : daysRemaining < 30
      ? 'warning'
      : 'healthy';

  const barColor =
    severity === 'critical'
      ? STATUS_META.failing.color
      : severity === 'warning'
      ? STATUS_META.warning.color
      : severity === 'healthy'
      ? STATUS_META.healthy.color
      : STATUS_META.unknown.color;

  return (
    <Card aria-label="Certificate lifetime" className="rhcl-tls-panel">
      <CardTitle>Certificate Lifetime</CardTitle>
      <CardBody>
        {!cert ? (
          <div className="rhcl-tls-empty">No Certificate resolved.</div>
        ) : (
          <>
            <div className="rhcl-tls-lifetime-heading">
              {daysRemaining != null && daysRemaining < 0
                ? 'This certificate has expired'
                : daysRemaining != null
                ? `${daysRemaining} days remaining`
                : 'Lifetime unknown'}
            </div>
            <div className="rhcl-tls-lifetime-bar" role="img" aria-label="Certificate lifetime">
              <div
                className="rhcl-tls-lifetime-fill"
                style={{ width: `${pct}%`, background: barColor }}
              />
              <div
                className="rhcl-tls-lifetime-marker"
                style={{ left: `${pct}%`, borderColor: barColor }}
                title={`Today · ${pct.toFixed(0)}% elapsed`}
              />
            </div>
            <div className="rhcl-tls-lifetime-legend">
              <span>
                Issued
                <br />
                <strong>
                  {cert.validFrom
                    ? new Date(cert.validFrom).toLocaleDateString()
                    : '—'}
                </strong>
              </span>
              <span style={{ textAlign: 'right' }}>
                Expires
                <br />
                <strong>
                  {cert.expiresAt
                    ? new Date(cert.expiresAt).toLocaleDateString()
                    : '—'}
                </strong>
              </span>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
};

export default TLSCertificateLifetimeCard;
