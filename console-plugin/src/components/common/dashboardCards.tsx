import * as React from 'react';
import { Card, CardBody, Tooltip } from '@patternfly/react-core';
import { InfoCircleIcon } from '@patternfly/react-icons';
// The `.rhcl-section-*` / `.rhcl-metric-*` classes ship with the cost/KPI CSS,
// which every dashboard already loads via `common/kpi`. Import here too so this
// module works even if used without a KpiCard on the page.
import './kpi';

/**
 * Shared building blocks for the plugin's operational dashboards (Gateway,
 * MCP Server, …): the glass section card, the responsive metric grid, and the
 * honest "N/A" cell with a tooltip explaining why a signal isn't available.
 * Kept in one place so every dashboard reads and greys gaps identically.
 */

export const SUCCESS = 'var(--pf-t--global--color--status--success--default)';
export const WARNING = 'var(--pf-t--global--color--status--warning--default)';
export const DANGER = 'var(--pf-t--global--color--status--danger--default)';
export const INFO = 'var(--pf-t--global--color--status--info--default)';
export const SUBTLE = 'var(--pf-t--global--text--color--subtle)';

/** A greyed "N/A" with a tooltip explaining, honestly, why it's unavailable. */
export const NAValue: React.FC<{ reason: string }> = ({ reason }) => (
  <Tooltip content={reason}>
    <span style={{ color: SUBTLE, fontWeight: 600, cursor: 'help' }}>
      N/A <InfoCircleIcon style={{ fontSize: 11, opacity: 0.6, verticalAlign: 'middle' }} />
    </span>
  </Tooltip>
);

export const SectionCard: React.FC<{
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon, action, children }) => (
  <Card isFullHeight className="rhcl-section-card">
    <CardBody>
      <div className="rhcl-section-title">
        {icon && <span aria-hidden="true">{icon}</span>}
        <span style={{ flex: 1 }}>{title}</span>
        {action}
      </div>
      {children}
    </CardBody>
  </Card>
);

export const MetricGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rhcl-metric-grid">{children}</div>
);

export const Metric: React.FC<{
  label: React.ReactNode;
  value: React.ReactNode;
  na?: string;
}> = ({ label, value, na }) => (
  <div className={na ? 'rhcl-metric-na' : undefined}>
    <div className="rhcl-metric-label">{label}</div>
    <div className="rhcl-metric-value">{na ? <NAValue reason={na} /> : value}</div>
  </div>
);
