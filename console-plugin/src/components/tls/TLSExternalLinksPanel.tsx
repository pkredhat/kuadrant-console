import * as React from 'react';
import { Card, CardTitle, CardBody, Button } from '@patternfly/react-core';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import { Link } from 'react-router-dom';
import { TlsFlow } from './types';

interface Props {
  externalLinks: TlsFlow['externalLinks'];
  headerLinks: TlsFlow['headerLinks'];
}

interface LinkEntry {
  label: string;
  href: string;
  /** In-plugin (react-router) vs external new-tab. */
  kind: 'internal' | 'external';
}

const TLSExternalLinksPanel: React.FC<Props> = ({ externalLinks, headerLinks }) => {
  const items: LinkEntry[] = [];
  if (headerLinks.openCertificate)
    items.push({ label: 'Open Certificate', href: headerLinks.openCertificate, kind: 'internal' });
  if (headerLinks.openSecret)
    items.push({ label: 'Open Secret', href: headerLinks.openSecret, kind: 'internal' });
  if (headerLinks.openGateway)
    items.push({ label: 'Open Gateway', href: headerLinks.openGateway, kind: 'internal' });
  if (externalLinks.certManager)
    items.push({ label: 'cert-manager Dashboard', href: externalLinks.certManager, kind: 'internal' });
  if (externalLinks.grafana)
    items.push({ label: 'Grafana Dashboard', href: externalLinks.grafana, kind: 'external' });
  if (externalLinks.prometheus)
    items.push({ label: 'Prometheus', href: externalLinks.prometheus, kind: 'internal' });
  if (externalLinks.letsEncryptStatus)
    items.push({
      label: "Let's Encrypt Status",
      href: externalLinks.letsEncryptStatus,
      kind: 'external',
    });
  if (externalLinks.dnsChecker)
    items.push({ label: 'DNS Checker', href: externalLinks.dnsChecker, kind: 'external' });

  return (
    <Card aria-label="External links" className="rhcl-tls-side-panel">
      <CardTitle>External Links</CardTitle>
      <CardBody>
        {items.length === 0 ? (
          <div className="rhcl-tls-empty">No related links available yet.</div>
        ) : (
          <div className="rhcl-tls-links">
            {items.map((it) =>
              it.kind === 'internal' ? (
                <Button
                  key={it.href}
                  variant="link"
                  isInline
                  component={(props) => <Link {...props} to={it.href} />}
                >
                  {it.label}
                </Button>
              ) : (
                <Button
                  key={it.href}
                  variant="link"
                  isInline
                  component="a"
                  href={it.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  icon={<ExternalLinkAltIcon />}
                  iconPosition="end"
                >
                  {it.label}
                </Button>
              ),
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
};

export default TLSExternalLinksPanel;
