import * as React from 'react';
import {
  Grid,
  GridItem,
  Card,
  CardTitle,
  CardBody,
  Alert,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { HTTPRoute, PolicyAttachment } from '../../../types';
import { RouteSecuritySummary } from './routeSecurityTypes';
import { SecurityPostureBadge } from './SecurityAtoms';
import { FeatureSubCard } from './SecurityDetailsCard';
import { SecurityChecksCard } from './SecurityChecksCard';
import { SecurityHeadersDeepCard } from './SecurityHeadersDeepCard';
import { EffectiveSecurityPolicyStack } from './EffectiveSecurityPolicyStack';
import { RouteEventsCard } from './RouteEventsCard';
import { useHTTPRouteEvents } from './useHTTPRouteEvents';

interface Props {
  route: HTTPRoute;
  summary: RouteSecuritySummary;
  effectiveStack: PolicyAttachment[];
  headers: {
    configured: boolean;
    loading: boolean;
    error: string | null;
    onRun: (url: string) => void;
  };
  defaultProbeUrl: string;
  onReRun: () => void;
}

/**
 * Deep security posture page for the HTTPRoute. The Details tab renders
 * the same data in a summary layout — this tab is for investigation.
 *
 * Sections mirror the spec:
 *   1. Posture summary at the top (chip + reason)
 *   2. Effective security policy stack (GEP-713 chain, filtered to security kinds)
 *   3. Per-domain cards: TLS / Authentication / RateLimit
 *   4. Live Security Headers probe (editable URL)
 *   5. Full security checks table (re-runnable)
 *   6. Route-scoped events
 */
export const RouteSecurityTab: React.FC<Props> = ({
  route,
  summary,
  effectiveStack,
  headers,
  defaultProbeUrl,
  onReRun,
}) => {
  const events = useHTTPRouteEvents(route, effectiveStack);

  return (
    <Grid hasGutter style={{ marginTop: 16 }}>
      <GridItem span={12}>
        <Card>
          <CardTitle>
            <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
              <FlexItem>Security Posture</FlexItem>
              <FlexItem>
                <SecurityPostureBadge posture={summary.posture} reason={summary.postureReason} />
              </FlexItem>
            </Flex>
          </CardTitle>
          <CardBody>
            <Alert
              isInline
              variant={
                summary.posture === 'secure'
                  ? 'success'
                  : summary.posture === 'at-risk'
                  ? 'danger'
                  : summary.posture === 'needs-attention'
                  ? 'warning'
                  : 'info'
              }
              title={summary.postureReason}
            >
              This posture is derived from the effective (post GEP-713 override) policy
              stack, the parent Gateway listener configuration, and any live probes.
            </Alert>
          </CardBody>
        </Card>
      </GridItem>

      <GridItem span={12}>
        <EffectiveSecurityPolicyStack stack={effectiveStack} />
      </GridItem>

      <GridItem md={6} span={12}>
        <FeatureSubCard title="TLS" feature={summary.tls} />
      </GridItem>
      <GridItem md={6} span={12}>
        <FeatureSubCard title="Authentication" feature={summary.authentication} />
      </GridItem>
      <GridItem md={6} span={12}>
        <FeatureSubCard title="Rate Limiting" feature={summary.rateLimiting} />
      </GridItem>
      <GridItem md={6} span={12}>
        <FeatureSubCard title="Security Headers (summary)" feature={summary.headers} />
      </GridItem>

      <GridItem span={12}>
        <SecurityHeadersDeepCard
          configured={headers.configured}
          loading={headers.loading}
          error={headers.error}
          snapshot={summary.headersProbe || null}
          defaultUrl={defaultProbeUrl}
          onRun={headers.onRun}
        />
      </GridItem>

      <GridItem span={12}>
        <SecurityChecksCard checks={summary.checks} onReRun={onReRun} />
      </GridItem>

      <GridItem span={12}>
        <RouteEventsCard events={events} />
      </GridItem>
    </Grid>
  );
};
