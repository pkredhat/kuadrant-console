import * as React from 'react';
// `useParams` from v5-compat (reads the v6 context populated by the
// host's `<CompatRouter>`); `Link` from v5 `react-router-dom`. See
// GatewayDetailPage for the full reasoning.
import { useParams, useSearchParams } from 'react-router-dom-v5-compat';
import { Link } from 'react-router-dom';
import {
  PageSection,
  Title,
  Tabs,
  Tab,
  TabTitleText,
  Card,
  CardTitle,
  CardBody,
  Spinner,
  Bullseye,
  Breadcrumb,
  BreadcrumbItem,
  Grid,
  GridItem,
  Label,
  CodeBlock,
  CodeBlockCode,
  Flex,
  FlexItem,
  Icon,
} from '@patternfly/react-core';
import { ShieldAltIcon } from '@patternfly/react-icons';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import yaml from 'js-yaml';
import { HTTPRouteGVK } from '../../models';
import { HTTPRoute, K8sCondition } from '../../types';
import StatusLabel from '../common/StatusLabel';
import ObservabilityMenu from '../common/ObservabilityMenu';
import TrafficPanel from '../common/TrafficPanel';
import ResourceActionsMenu from '../common/ResourceActionsMenu';
import { PolicyAttachmentView } from '../policies/PolicyAttachmentView';
import { EffectivePolicyStack } from '../policies/EffectivePolicyStack';
import { BackendsTab } from './backends/BackendsTab';
import { usePrometheusTraffic } from '../../hooks/usePrometheusTraffic';
import { useGrafanaLink } from '../../utils/grafana';
import {
  HTTPRouteDetailsCard,
  HTTPRouteStatusCard,
  HTTPRouteSecuritySummaryCard,
  HTTPRouteTrafficSummaryCard,
} from './security/SummaryCards';
import { BackendRefsCard } from './security/BackendRefsCard';
import { SecurityDetailsCard } from './security/SecurityDetailsCard';
import { SecurityChecksCard } from './security/SecurityChecksCard';
import { RouteEventsCard } from './security/RouteEventsCard';
import { RouteSecurityTab } from './security/RouteSecurityTab';
import { useHTTPRouteSecurityPosture } from './security/useHTTPRouteSecurityPosture';
import { useHTTPRouteHeadersProber } from './security/useHTTPRouteHeadersProber';
import { useHTTPRouteEvents } from './security/useHTTPRouteEvents';
import { SecurityPostureBadge } from './security/SecurityAtoms';
import '../../styles/plugin-glass.css';

// URL ?tab= codes → tab index. Kept stable so links from other cards
// (e.g. Security Summary → "Open Security tab") work.
const TAB_INDEX: Record<string, number> = {
  details: 0,
  policies: 1,
  backends: 2,
  'effective-policy-stack': 3,
  security: 4,
  metrics: 5,
  yaml: 6,
};
const INDEX_TO_TAB: Record<number, string> = Object.fromEntries(
  Object.entries(TAB_INDEX).map(([k, v]) => [v, k]),
);

const HTTPRouteDetailPage: React.FC = () => {
  const { ns, name } = useParams<{ ns: string; name: string }>();
  const { t } = useTranslation('plugin__kuadrant-console');
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = TAB_INDEX[searchParams.get('tab') || ''] ?? 0;
  const [activeTab, setActiveTab] = React.useState(initialTab);

  const setTab = React.useCallback(
    (idx: number) => {
      setActiveTab(idx);
      const key = INDEX_TO_TAB[idx];
      if (key) {
        const params = new URLSearchParams(searchParams);
        params.set('tab', key);
        setSearchParams(params, { replace: true });
      }
    },
    [searchParams, setSearchParams],
  );

  // Same SDK 4.21 quirk: single-resource watch returns undefined forever
  // on this cluster. Listing in the namespace and finding by name works.
  const [routes, loaded] = useK8sWatchResource<HTTPRoute[]>({
    groupVersionKind: HTTPRouteGVK,
    isList: true,
    namespace: ns,
  });
  const route = React.useMemo(
    () => (routes || []).find((r) => r.metadata?.name === name),
    [routes, name],
  );

  const parentRef = route?.spec?.parentRefs?.[0];
  const parentGatewayName = parentRef?.name || '';
  const parentGatewayNamespace = parentRef?.namespace || ns || '';

  // Live headers probe — kept as its own hook so the summary card can
  // read the snapshot AND the deep card can trigger a fresh probe.
  const {
    configured: headersConfigured,
    loading: headersLoading,
    error: headersError,
    snapshot: headersSnapshot,
    runProbe: runHeadersProbe,
  } = useHTTPRouteHeadersProber();

  // Normalized security posture — single source of truth. Everything
  // downstream (summary card, checks table, security tab) reads this.
  const {
    loaded: postureLoaded,
    summary,
    operational,
  } = useHTTPRouteSecurityPosture({
    route,
    routeNamespace: ns || '',
    parentGatewayName,
    parentGatewayNamespace,
    headersProbe: headersSnapshot || undefined,
  });

  // Traffic for the summary card.
  const { data: trafficData, loaded: trafficLoaded } = usePrometheusTraffic(
    'HTTPRoute',
    name || '',
    ns || '',
    60000,
    '5m',
  );

  const grafanaLink = useGrafanaLink('api-overview', { httproute: `${ns}.${name}` });
  const openGrafana = React.useCallback(() => {
    if (grafanaLink.available && grafanaLink.url) {
      window.open(grafanaLink.url, '_blank', 'noopener,noreferrer');
    }
  }, [grafanaLink.available, grafanaLink.url]);

  const events = useHTTPRouteEvents(route, summary.effectiveStack);

  // Keep the plugin surface even during load, otherwise the page flashes
  // black on the Console dark theme before HTTPRoute data arrives.
  if (!loaded || !route) {
    return (
      <div className="rhcl-plugin-root">
        <PageSection isFilled>
          <Bullseye><Spinner size="xl" /></Bullseye>
        </PageSection>
      </div>
    );
  }

  const hostnames = route.spec?.hostnames || [];
  const parentConditions = route.status?.parents?.[0]?.conditions;
  const primaryHostname = hostnames[0];
  const defaultProbeUrl = primaryHostname ? `https://${primaryHostname}/` : '';

  const requestRatePerMin = trafficData.requestRate5m != null ? trafficData.requestRate5m * 60 : undefined;
  const errorPct =
    trafficData.rate5xx != null && trafficData.requestRate5m
      ? (trafficData.rate5xx / Math.max(trafficData.requestRate5m, 0.0001)) * 100
      : trafficData.successRate != null
      ? 100 - trafficData.successRate * 100
      : undefined;
  const p95 = trafficData.latencyP95 != null ? Math.round(trafficData.latencyP95) : undefined;

  return (
    <div className="rhcl-plugin-root">
      <PageSection variant="default">
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to="/connectivity-link/httproutes">{t('HTTPRoutes')}</Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>
            {ns}/{name}
          </BreadcrumbItem>
        </Breadcrumb>
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>
              <Title headingLevel="h1">{name}</Title>
            </FlexItem>
            <FlexItem>
              <StatusLabel conditions={parentConditions} />
            </FlexItem>
            {postureLoaded && (
              <FlexItem>
                <SecurityPostureBadge posture={summary.posture} reason={summary.postureReason} />
              </FlexItem>
            )}
          </Flex>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <ObservabilityMenu
              grafanaVars={{ httproute: `${ns}.${name}` }}
              dashboards={['api-overview', 'api-consumers', 'api-costs']}
              tempoVars={{
                serviceName: 'rhcl-gateway',
                tags: { 'http.route': name || '' },
                lookback: '1h',
              }}
            />
            <ResourceActionsMenu
              gvk={{ group: 'gateway.networking.k8s.io', version: 'v1', kind: 'HTTPRoute' }}
              namespace={ns || ''}
              name={name || ''}
              listHref="/connectivity-link/httproutes"
              resource={route}
              plural="httproutes"
            />
          </div>
        </div>
      </PageSection>
      <PageSection>
        <Tabs
          activeKey={activeTab}
          onSelect={(_e, idx) => setTab(idx as number)}
          aria-label={t('Details')}
        >
          {/* ------ Details tab ------ */}
          <Tab eventKey={0} title={<TabTitleText>{t('Details')}</TabTitleText>}>
            <Grid hasGutter style={{ marginTop: 16 }}>
              {/* Top summary row: 4 cards */}
              <GridItem xl={3} md={6} span={12}>
                <HTTPRouteDetailsCard
                  route={route}
                  parentGatewayName={parentGatewayName}
                  parentGatewayNamespace={parentGatewayNamespace}
                />
              </GridItem>
              <GridItem xl={3} md={6} span={12}>
                <HTTPRouteStatusCard operational={operational} />
              </GridItem>
              <GridItem xl={3} md={6} span={12}>
                <HTTPRouteSecuritySummaryCard
                  summary={summary}
                  onNavigateToSecurityTab={() => setTab(TAB_INDEX['security'])}
                />
              </GridItem>
              <GridItem xl={3} md={6} span={12}>
                <HTTPRouteTrafficSummaryCard
                  requestsPerMin={requestRatePerMin}
                  errorPct={errorPct}
                  p95LatencyMs={p95}
                  loaded={trafficLoaded}
                  onOpenGrafana={openGrafana}
                />
              </GridItem>

              {/* Two-column body: Backend Refs + Events | Security Details + Checks */}
              <GridItem xl={5} span={12}>
                <Grid hasGutter>
                  <GridItem span={12}>
                    <BackendRefsCard route={route} />
                  </GridItem>
                  <GridItem span={12}>
                    <RouteEventsCard events={events} />
                  </GridItem>
                </Grid>
              </GridItem>
              <GridItem xl={7} span={12}>
                <Grid hasGutter>
                  <GridItem span={12}>
                    <SecurityDetailsCard
                      summary={summary}
                      headersLoading={headersLoading}
                      headersConfigured={headersConfigured}
                      headersError={headersError}
                      onRunHeaderProbe={() => runHeadersProbe(defaultProbeUrl)}
                      routeName={name || ''}
                      routeNamespace={ns || ''}
                    />
                  </GridItem>
                  <GridItem span={12}>
                    <SecurityChecksCard
                      checks={summary.checks}
                      onReRun={() => runHeadersProbe(defaultProbeUrl)}
                    />
                  </GridItem>
                </Grid>
              </GridItem>

              {/* Footer metadata (collapsed by default via <details>) */}
              <GridItem span={12}>
                <Card>
                  <CardTitle>{t('Metadata')}</CardTitle>
                  <CardBody>
                    <details>
                      <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                        {t('Show Kubernetes metadata')}
                      </summary>
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        <div>UID: <code>{route.metadata?.uid || '-'}</code></div>
                        <div>Resource version: <code>{route.metadata?.resourceVersion || '-'}</code></div>
                        <div>Created: {route.metadata?.creationTimestamp || '-'}</div>
                        {route.metadata?.labels && (
                          <div style={{ marginTop: 8 }}>
                            <strong>Labels:</strong>{' '}
                            {Object.entries(route.metadata.labels).map(([k, v]) => (
                              <Label key={k} isCompact style={{ marginRight: 4 }}>
                                {k}={v}
                              </Label>
                            ))}
                          </div>
                        )}
                      </div>
                    </details>
                  </CardBody>
                </Card>
              </GridItem>
            </Grid>
          </Tab>

          <Tab eventKey={1} title={<TabTitleText>{t('Policies')}</TabTitleText>}>
            <div style={{ marginTop: 16 }}>
              <PolicyAttachmentView
                targetKind="HTTPRoute"
                targetName={name || ''}
                targetNamespace={ns || ''}
              />
            </div>
          </Tab>

          <Tab eventKey={2} title={<TabTitleText>{t('Backends')}</TabTitleText>}>
            <div style={{ marginTop: 16 }}>
              <BackendsTab route={route} />
            </div>
          </Tab>

          <Tab eventKey={3} title={<TabTitleText>{t('Effective policy stack')}</TabTitleText>}>
            <div style={{ marginTop: 16 }}>
              <EffectivePolicyStack
                routeName={name || ''}
                routeNamespace={ns || ''}
                parentGatewayName={parentGatewayName}
                parentGatewayNamespace={parentGatewayNamespace}
              />
            </div>
          </Tab>

          <Tab
            eventKey={4}
            title={
              <TabTitleText>
                <Flex spaceItems={{ default: 'spaceItemsXs' }} alignItems={{ default: 'alignItemsCenter' }}>
                  <FlexItem>
                    <Icon size="sm"><ShieldAltIcon /></Icon>
                  </FlexItem>
                  <FlexItem>{t('Security')}</FlexItem>
                </Flex>
              </TabTitleText>
            }
          >
            <RouteSecurityTab
              route={route}
              summary={summary}
              effectiveStack={summary.effectiveStack}
              headers={{
                configured: headersConfigured,
                loading: headersLoading,
                error: headersError,
                onRun: runHeadersProbe,
              }}
              defaultProbeUrl={defaultProbeUrl}
              onReRun={() => runHeadersProbe(defaultProbeUrl)}
            />
          </Tab>

          <Tab eventKey={5} title={<TabTitleText>{t('Metrics')}</TabTitleText>}>
            <div style={{ marginTop: 16 }}>
              <TrafficPanel kind="HTTPRoute" name={name || ''} namespace={ns || ''} />
            </div>
          </Tab>

          <Tab eventKey={6} title={<TabTitleText>{t('YAML')}</TabTitleText>}>
            <div style={{ marginTop: 16 }}>
              <CodeBlock>
                <CodeBlockCode>
                  {yaml.dump(route, { noRefs: true, lineWidth: -1 })}
                </CodeBlockCode>
              </CodeBlock>
            </div>
          </Tab>
        </Tabs>
      </PageSection>
    </div>
  );
};

// Kept for backward-compat: the old Details tab previously exposed a full
// Conditions table. Not used by the new layout, but callers may still import
// ConditionsCard so we keep the export.
export const ConditionsCard: React.FC<{ conditions?: K8sCondition[] }> = ({ conditions }) => {
  const { t } = useTranslation('plugin__kuadrant-console');
  if (!conditions || conditions.length === 0) return null;
  return (
    <Card>
      <CardTitle>{t('Status')}</CardTitle>
      <CardBody>
        <Table aria-label={t('Status')} variant="compact">
          <Thead>
            <Tr>
              <Th>Type</Th>
              <Th>{t('Status')}</Th>
              <Th>Reason</Th>
              <Th>{t('Message')}</Th>
              <Th>Last transition</Th>
            </Tr>
          </Thead>
          <Tbody>
            {conditions.map((c) => (
              <Tr key={c.type}>
                <Td>{c.type}</Td>
                <Td>
                  <Label
                    color={c.status === 'True' ? 'green' : c.status === 'False' ? 'red' : 'grey'}
                  >
                    {c.status}
                  </Label>
                </Td>
                <Td>{c.reason || '-'}</Td>
                <Td>{c.message || '-'}</Td>
                <Td>{c.lastTransitionTime || '-'}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </CardBody>
    </Card>
  );
};

export default HTTPRouteDetailPage;
