import * as React from 'react';
import { STATUS_META } from '../dns/types';
import { TlsStep } from './types';
import TLSStepCard from './TLSStepCard';

/**
 * 9-node horizontal pipeline. Same layout mechanics as DNSFlowDiagram —
 * fixed-width flex cards + 28px arrow slots — so on wide viewports the
 * whole flow reads left-to-right, and on narrow ones the CSS flips it
 * to a stacked column with rotated arrows.
 *
 * Connector colour is the worst of the two adjacent statuses, so a
 * red-marked step paints the arrow leading INTO it red — the pipeline
 * "points at" what's broken.
 */

interface Props {
  steps: TlsStep[];
}

function connectorColor(a: TlsStep, b: TlsStep): string {
  const priority = ['failing', 'warning', 'pending', 'not-configured', 'skipped', 'healthy'];
  const worst = [a.status, b.status].sort(
    (x, y) => priority.indexOf(x) - priority.indexOf(y),
  )[0];
  return STATUS_META[worst].color;
}

const TLSJourneyFlow: React.FC<Props> = ({ steps }) => (
  <div className="rhcl-dns-flow" role="list">
    {steps.map((s, i) => (
      <React.Fragment key={s.id}>
        <div role="listitem" style={{ display: 'contents' }}>
          <TLSStepCard step={s} index={i} />
        </div>
        {i < steps.length - 1 && (
          <div
            className="rhcl-dns-flow-arrow"
            style={{ color: connectorColor(s, steps[i + 1]) }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" width="24" height="24">
              <path
                d="M4 12h14M13 6l6 6-6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}
      </React.Fragment>
    ))}
  </div>
);

export default TLSJourneyFlow;
