import * as React from 'react';
import { Card, CardTitle, CardBody, Button } from '@patternfly/react-core';
import { ArrowRightIcon } from '@patternfly/react-icons';
import { Link } from 'react-router-dom';
import { STATUS_META } from '../dns/types';
import { TlsStep } from './types';

/**
 * "Root Cause" panel — the top of the right-hand column. When the flow
 * has any non-healthy step, we surface the primary failure (chosen by
 * useTlsTroubleshooting.primaryFailure) with contextual next steps.
 * When everything is green, the panel congratulates and disappears
 * mostly into the layout.
 */

interface Props {
  primaryFailure: TlsStep | null;
  /** Optional "healthy" state message; the parent supplies it because
   *  it may vary by overall status. */
  healthyMessage?: string;
}

const RECOMMENDATIONS_BY_STEP: Record<string, string[]> = {
  hostname: [
    'Add the hostname to a Gateway listener.',
    'Verify the DNSPolicy is publishing this hostname to a public zone.',
  ],
  tlspolicy: [
    'Create a TLSPolicy targeting the Gateway.',
    'Verify the issuerRef points at a working Issuer / ClusterIssuer.',
  ],
  certificate: [
    'Renew the certificate.',
    'Verify the ACME Challenge is passing.',
    'Verify the issuerRef is valid and reachable.',
  ],
  certrequest: [
    'Inspect the CertificateRequest for the failing reason.',
    'Check the linked Order status.',
  ],
  challenge: [
    'Verify the DNS TXT record for the ACME challenge has propagated.',
    'Check the Challenge resource for the exact validation error.',
    'For HTTP-01 challenges, verify the /.well-known path is reachable.',
  ],
  issuer: [
    'Check the Issuer / ClusterIssuer status.',
    'Verify the ACME account is registered.',
    'Check that the DNS provider credentials Secret exists.',
  ],
  secret: [
    'Verify cert-manager has created the Secret referenced by the Gateway.',
    'Restart the cert-manager controller if the Certificate is Ready but no Secret was written.',
    'Check RBAC on the Secret if it exists but the Gateway cannot mount it.',
  ],
  gateway: [
    'Verify the Gateway has an HTTPS listener for this hostname.',
    'Check that certificateRefs points at the correct Secret.',
    'Verify the Gateway is Programmed.',
  ],
  'https-ready': [
    'Trigger a real HTTPS handshake against the endpoint.',
    'Check the Gateway is presenting the expected certificate.',
    'Verify DNS resolution — the Route or DNS Provider step should show healthy.',
  ],
};

const TLSRootCausePanel: React.FC<Props> = ({ primaryFailure, healthyMessage }) => {
  if (!primaryFailure) {
    return (
      <Card aria-label="Root cause" className="rhcl-tls-side-panel">
        <CardTitle>Root Cause</CardTitle>
        <CardBody>
          <div className="rhcl-tls-empty">{healthyMessage || 'Everything looks healthy.'}</div>
        </CardBody>
      </Card>
    );
  }

  const meta = STATUS_META[primaryFailure.status];
  const recs = RECOMMENDATIONS_BY_STEP[primaryFailure.id] || [
    'Inspect the underlying resource for the exact failure reason.',
  ];

  return (
    <Card aria-label="Root cause" className="rhcl-tls-side-panel">
      <CardTitle>Root Cause</CardTitle>
      <CardBody>
        <div className="rhcl-tls-rootcause-headline" style={{ color: meta.color }}>
          {primaryFailure.title}
          {primaryFailure.resourceName ? ` — ${primaryFailure.resourceName}` : ''}
        </div>
        <div className="rhcl-tls-rootcause-summary">{primaryFailure.summary}</div>
        <div className="rhcl-tls-rec-title">Recommended actions</div>
        <ol className="rhcl-tls-rec-list">
          {recs.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ol>
        {primaryFailure.href && (
          <div style={{ marginTop: 12 }}>
            <Button
              variant="link"
              isInline
              icon={<ArrowRightIcon />}
              iconPosition="end"
              component={(props) => <Link {...props} to={primaryFailure.href!} />}
            >
              Open {primaryFailure.title.toLowerCase()}
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
};

export default TLSRootCausePanel;
