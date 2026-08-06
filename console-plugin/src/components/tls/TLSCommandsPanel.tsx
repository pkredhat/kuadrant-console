import * as React from 'react';
import { Card, CardTitle, CardBody, Button, Tooltip } from '@patternfly/react-core';
import { CopyIcon } from '@patternfly/react-icons';

/**
 * Reference commands the operator would otherwise be typing into a
 * terminal. Each row surfaces one command with a copy button — the row
 * itself is monospaced so it visually reads as terminal input.
 *
 * Commands are parameterised by the current selection (hostname,
 * gateway, certificate, etc.) so a copy-paste at the top of the page
 * turns into a working command paste at the bottom.
 */

interface Props {
  hostname: string;
  gatewayName?: string;
  gatewayNamespace?: string;
  certificateName?: string;
  certificateNamespace?: string;
  tlsPolicyName?: string;
  tlsPolicyNamespace?: string;
  secretName?: string;
  secretNamespace?: string;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // best-effort; the command is still visible on screen.
  }
}

interface Row {
  label: string;
  command: string;
  hint?: string;
}

const TLSCommandsPanel: React.FC<Props> = (props) => {
  const {
    hostname,
    gatewayName,
    gatewayNamespace,
    certificateName,
    certificateNamespace,
    tlsPolicyName,
    tlsPolicyNamespace,
    secretName,
    secretNamespace,
  } = props;

  const rows: Row[] = [];
  if (hostname) {
    rows.push({ label: 'DNS lookup', command: `dig ${hostname}` });
    rows.push({
      label: 'HTTPS handshake',
      command: `openssl s_client -connect ${hostname}:443 -servername ${hostname}`,
    });
    rows.push({ label: 'HTTP request', command: `curl -v https://${hostname}` });
  }
  if (tlsPolicyName && tlsPolicyNamespace) {
    rows.push({
      label: 'Describe TLSPolicy',
      command: `oc describe tlspolicy ${tlsPolicyName} -n ${tlsPolicyNamespace}`,
    });
  }
  if (certificateName && certificateNamespace) {
    rows.push({
      label: 'Describe Certificate',
      command: `oc describe certificate ${certificateName} -n ${certificateNamespace}`,
    });
    rows.push({
      label: 'Get CertificateRequests',
      command: `oc get certificaterequest -n ${certificateNamespace} -l 'cert-manager.io/certificate-name=${certificateName}'`,
    });
    rows.push({
      label: 'Get Challenges',
      command: `oc get challenges -n ${certificateNamespace}`,
    });
  }
  if (gatewayName && gatewayNamespace) {
    rows.push({
      label: 'Describe Gateway',
      command: `oc describe gateway ${gatewayName} -n ${gatewayNamespace}`,
    });
  }
  if (secretName && secretNamespace) {
    rows.push({
      label: 'Inspect TLS Secret',
      command: `oc get secret ${secretName} -n ${secretNamespace} -o jsonpath='{.data.tls\\.crt}' | base64 -d | openssl x509 -text -noout`,
    });
  }
  if (certificateNamespace) {
    rows.push({
      label: 'Recent events',
      command: `oc get events -n ${certificateNamespace} --sort-by='.lastTimestamp' | tail -30`,
    });
  }

  return (
    <Card aria-label="Useful commands" className="rhcl-tls-side-panel">
      <CardTitle>Useful Commands</CardTitle>
      <CardBody>
        {rows.length === 0 ? (
          <div className="rhcl-tls-empty">
            Commands become available once a hostname is selected.
          </div>
        ) : (
          <ul className="rhcl-tls-commands">
            {rows.map((r, i) => (
              <li key={i}>
                <div className="rhcl-tls-command-label">{r.label}</div>
                <div className="rhcl-tls-command-row">
                  <code>{r.command}</code>
                  <Tooltip content="Copy to clipboard">
                    <Button
                      variant="plain"
                      onClick={() => copyToClipboard(r.command)}
                      aria-label={`Copy command: ${r.label}`}
                    >
                      <CopyIcon />
                    </Button>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
};

export default TLSCommandsPanel;
