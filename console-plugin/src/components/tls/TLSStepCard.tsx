import * as React from 'react';
import { Link } from 'react-router-dom';
import { Tooltip } from '@patternfly/react-core';
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  OutlinedQuestionCircleIcon,
  ArrowRightIcon,
} from '@patternfly/react-icons';
import { STATUS_META } from '../dns/types';
import { TlsStep, TlsStepStatus } from './types';

/**
 * One card in the horizontal TLS Journey. Same structural pattern as
 * DNSStepCard — same 220px width, same status-tinted top border, same
 * PatternFly Tooltip on every text field for long-value overflow. If a
 * card carries `href`, the "View details" link at the bottom jumps to
 * the underlying CR's page.
 */

const TruncatedText: React.FC<{ text: string; className?: string }> = ({ text, className }) => (
  <Tooltip content={text} position="top">
    <span className={className}>{text}</span>
  </Tooltip>
);

const StatusIcon: React.FC<{ status: TlsStepStatus; size?: number }> = ({ status, size = 14 }) => {
  const style: React.CSSProperties = { color: STATUS_META[status].color, fontSize: size };
  switch (STATUS_META[status].icon) {
    case 'check':
      return <CheckCircleIcon style={style} aria-hidden="true" />;
    case 'clock':
      return <ClockIcon style={style} aria-hidden="true" />;
    case 'exclamation':
      return <ExclamationTriangleIcon style={style} aria-hidden="true" />;
    case 'x':
      return <ExclamationCircleIcon style={style} aria-hidden="true" />;
    case 'minus':
      return <MinusCircleIcon style={style} aria-hidden="true" />;
    case 'question':
    default:
      return <OutlinedQuestionCircleIcon style={style} aria-hidden="true" />;
  }
};

interface Props {
  step: TlsStep;
  index: number;
}

const TLSStepCard: React.FC<Props> = ({ step, index }) => {
  const meta = STATUS_META[step.status];
  return (
    <div
      className={`rhcl-dns-step is-${step.status}`}
      style={{ borderTopColor: meta.color }}
      data-step-id={step.id}
    >
      <div className="rhcl-dns-step-head">
        <span className="rhcl-dns-step-index">{index + 1}. {step.title}</span>
        <span className="rhcl-dns-step-badge" style={{ color: meta.color }}>
          <StatusIcon status={step.status} /> {meta.label}
        </span>
      </div>
      {step.resourceName && (
        <div className="rhcl-dns-step-resource">
          <TruncatedText text={step.resourceName} />
        </div>
      )}
      {step.namespace && (
        <div className="rhcl-dns-step-namespace">
          <TruncatedText text={step.namespace} />
        </div>
      )}
      {step.summary && <p className="rhcl-dns-step-summary">{step.summary}</p>}
      {step.details && step.details.length > 0 && (
        <dl className="rhcl-dns-step-details">
          {step.details.map((d) => (
            <React.Fragment key={d.label}>
              <dt>
                <TruncatedText text={d.label} />
              </dt>
              <dd className={d.muted ? 'is-muted' : undefined}>
                <TruncatedText text={d.value} />
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {step.href && (
        <div className="rhcl-dns-step-more">
          <Link to={step.href}>
            View details <ArrowRightIcon />
          </Link>
        </div>
      )}
    </div>
  );
};

export default TLSStepCard;
