import * as React from 'react';
import { Card, CardTitle, CardBody, Button } from '@patternfly/react-core';
import { Link } from 'react-router-dom';
import { CertificateSummary } from './types';

/**
 * Left column of the middle row. Shows the metadata operators would
 * otherwise dig out of `oc describe certificate` — issuer, validity
 * window, secret name, SANs, algorithm.
 */

interface Props {
  cert: CertificateSummary | null;
  openCertificate?: string;
}

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <>
    <dt>{label}</dt>
    <dd>{value ?? '—'}</dd>
  </>
);

const fmt = (iso?: string): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const TLSCertificateDetailsCard: React.FC<Props> = ({ cert, openCertificate }) => {
  return (
    <Card aria-label="Certificate details" className="rhcl-tls-panel">
      <CardTitle>Certificate Details</CardTitle>
      <CardBody>
        {!cert ? (
          <div className="rhcl-tls-empty">No Certificate resolved for this hostname.</div>
        ) : (
          <>
            <dl className="rhcl-tls-details-grid">
              <Row label="Certificate Name" value={cert.name} />
              <Row label="Issuer" value={cert.issuer} />
              <Row label="Valid From" value={fmt(cert.validFrom)} />
              <Row label="Expires" value={fmt(cert.expiresAt)} />
              <Row
                label="Remaining Days"
                value={
                  cert.expiresAt
                    ? (() => {
                        const d = Math.floor(
                          (new Date(cert.expiresAt).getTime() - Date.now()) / 86_400_000,
                        );
                        return d < 0 ? `Expired ${Math.abs(d)} days ago` : `${d} days`;
                      })()
                    : '—'
                }
              />
              <Row label="Renewal Time" value={fmt(cert.renewalTime)} />
              <Row label="Secret" value={cert.secretName} />
              <Row
                label="SANs"
                value={
                  cert.sans && cert.sans.length > 0
                    ? cert.sans.join(', ')
                    : '—'
                }
              />
              <Row label="Algorithm" value={cert.algorithm} />
              <Row
                label="Key Usage"
                value={
                  cert.keyUsages && cert.keyUsages.length > 0
                    ? cert.keyUsages.join(', ')
                    : '—'
                }
              />
            </dl>
            {openCertificate && (
              <div style={{ marginTop: 12 }}>
                <Button
                  variant="link"
                  isInline
                  component={(props) => <Link {...props} to={openCertificate} />}
                >
                  View Certificate →
                </Button>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
};

export default TLSCertificateDetailsCard;
