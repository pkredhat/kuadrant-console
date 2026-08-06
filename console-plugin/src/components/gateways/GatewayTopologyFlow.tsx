import * as React from 'react';
import { Card, CardBody, Flex, FlexItem } from '@patternfly/react-core';
import { AngleRightIcon } from '@patternfly/react-icons';
import { StatusSeverity } from '../../types';

export type TopoSeverity = StatusSeverity | 'na' | 'info';

export interface TopoNode {
  key: string;
  icon: React.ReactNode;
  title: string;
  /** Primary value line (e.g. "3/3" or "Internet"). */
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  severity: TopoSeverity;
}

const DOT_COLOR: Record<TopoSeverity, string> = {
  healthy: 'var(--pf-t--global--color--status--success--default)',
  warning: 'var(--pf-t--global--color--status--warning--default)',
  critical: 'var(--pf-t--global--color--status--danger--default)',
  progressing: 'var(--pf-t--global--color--status--info--default)',
  info: 'var(--pf-t--global--color--status--info--default)',
  unknown: 'var(--pf-t--global--text--color--subtle)',
  na: 'var(--pf-t--global--text--color--subtle)',
};

/**
 * The gateway request path drawn as a simple left-to-right flow of PatternFly
 * cards joined by chevrons — Internet → DNS/TLS → Gateway → Listeners →
 * Routes → Services → Pods. Deliberately NOT a node/edge graph library
 * (`@patternfly/react-topology` isn't a dependency and would be heavy); the
 * card-flow idiom already used across the plugin keeps it visually native.
 *
 * Pure renderer: the dashboard computes the counts + per-node severity from
 * real data and passes them in.
 */
export const GatewayTopologyFlow: React.FC<{ nodes: TopoNode[] }> = ({ nodes }) => (
  <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
    <Flex
      alignItems={{ default: 'alignItemsStretch' }}
      flexWrap={{ default: 'nowrap' }}
      spaceItems={{ default: 'spaceItemsXs' }}
      style={{ minWidth: 'max-content' }}
    >
      {nodes.map((node, i) => (
        <React.Fragment key={node.key}>
          <FlexItem>
            <Card isCompact className="rhcl-topo-node" style={{ height: '100%' }}>
              <CardBody style={{ padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 16, opacity: 0.85 }}>{node.icon}</span>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: DOT_COLOR[node.severity],
                      display: 'inline-block',
                    }}
                  />
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--pf-t--global--text--color--subtle)',
                  }}
                >
                  {node.title}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.2 }}>{node.primary}</div>
                {node.secondary != null && (
                  <div style={{ fontSize: 11, color: 'var(--pf-t--global--text--color--subtle)' }}>
                    {node.secondary}
                  </div>
                )}
              </CardBody>
            </Card>
          </FlexItem>
          {i < nodes.length - 1 && (
            <FlexItem alignSelf={{ default: 'alignSelfCenter' }}>
              <AngleRightIcon className="rhcl-topo-connector" />
            </FlexItem>
          )}
        </React.Fragment>
      ))}
    </Flex>
  </div>
);

export default GatewayTopologyFlow;
