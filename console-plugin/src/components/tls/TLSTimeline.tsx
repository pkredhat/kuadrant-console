import * as React from 'react';
import { Card, CardTitle, CardBody } from '@patternfly/react-core';
import { STATUS_META } from '../dns/types';
import { TlsTimelineEvent } from './types';

/**
 * Chronological event timeline — CertificateRequest / Order / Challenge
 * state transitions plus any related k8s Events. Same visual grammar as
 * DNSTimeline: 72px time column, 10px dot in the vertical thread, title
 * + detail body.
 */

interface Props {
  events: TlsTimelineEvent[];
}

const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const TLSTimeline: React.FC<Props> = ({ events }) => (
  <Card aria-label="Reconciliation timeline" className="rhcl-tls-panel">
    <CardTitle>Reconciliation Timeline</CardTitle>
    <CardBody>
      {events.length === 0 ? (
        <div className="rhcl-tls-empty">
          No condition transitions or events recorded for this pipeline yet.
        </div>
      ) : (
        <ol className="rhcl-dns-timeline">
          {events.map((e, i) => (
            <li key={`${e.when}-${i}`}>
              <span className="rhcl-dns-timeline-time">{fmtTime(e.when)}</span>
              <span
                className="rhcl-dns-timeline-dot"
                style={{ background: STATUS_META[e.status].color }}
                aria-hidden="true"
              />
              <span>
                <div className="rhcl-dns-timeline-title">{e.title}</div>
                {e.detail && (
                  <div className="rhcl-dns-timeline-detail">{e.detail}</div>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </CardBody>
  </Card>
);

export default TLSTimeline;
