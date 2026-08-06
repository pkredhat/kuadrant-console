import * as React from 'react';
import { Link } from 'react-router-dom';
import { useParams } from 'react-router-dom-v5-compat';
import {
  PageSection,
  Title,
  Spinner,
  Bullseye,
  EmptyState,
  EmptyStateBody,
  Grid,
  GridItem,
  Card,
  CardBody,
  Label,
  LabelGroup,
  Flex,
  FlexItem,
  Breadcrumb,
  BreadcrumbItem,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Button,
  Gallery,
  ExpandableSection,
  CodeBlock,
  CodeBlockCode,
} from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import yaml from 'js-yaml';
import {
  CubesIcon,
  CatalogIcon,
  TagIcon,
  LayerGroupIcon,
  ServerIcon,
  PlayIcon,
  ConnectedIcon,
  RobotIcon,
  NetworkIcon,
  RouteIcon,
  CubeIcon,
  CheckCircleIcon,
  KeyIcon,
} from '@patternfly/react-icons';
import { MCPServerRegistrationGVK, HTTPRouteGVK } from '../../models';
import { MCPServerRegistration, mcpPrefix, mcpReadiness, HTTPRoute } from '../../types';
import ResourceActionsMenu from '../common/ResourceActionsMenu';
import ObservabilityMenu from '../common/ObservabilityMenu';
import { KpiCard } from '../common/kpi';
import { SectionCard, MetricGrid, Metric, NAValue, SUBTLE } from '../common/dashboardCards';
import GatewayTopologyFlow, { TopoNode, TopoSeverity } from '../gateways/GatewayTopologyFlow';
import { useBackendsStatus } from '../../hooks/useBackendsStatus';
import { useMcpBrokerCatalog } from './useMcpBrokerCatalog';
import { McpTool } from './mcpBrokerClient';
import MCPPlayground from './MCPPlayground';
import '../../styles/plugin-glass.css';

function relativeAge(iso?: string): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function readinessSeverity(color: 'green' | 'red' | 'blue'): TopoSeverity {
  return color === 'green' ? 'healthy' : color === 'red' ? 'critical' : 'progressing';
}

const MetaChip: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <span style={{ fontSize: 12, color: SUBTLE }}>
    {label}:{' '}
    <span style={{ color: 'var(--pf-t--global--text--color--regular)', fontWeight: 600 }}>{value}</span>
  </span>
);

/**
 * Operations dashboard for one MCPServerRegistration — the MCP counterpart to
 * the Gateway ops dashboard. KPIs (tools/prompts/backends/…), registration +
 * health, a Client→Broker→Server→Route→Service→Pods topology, a live tool
 * catalog and the try-it playground, all "real-only, honest gaps": tools and
 * prompts come from the broker (`useMcpBrokerCatalog`), backend readiness from
 * the K8s API; nothing is fabricated when the broker isn't reachable.
 */
const MCPServerDetailPage: React.FC = () => {
  const { ns, name } = useParams<{ ns: string; name: string }>();
  const { t } = useTranslation('plugin__kuadrant-console');
  const [selectedTool, setSelectedTool] = React.useState<McpTool | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  const [servers, loaded] = useK8sWatchResource<MCPServerRegistration[]>({
    groupVersionKind: MCPServerRegistrationGVK,
    isList: true,
  });
  const server = (servers || []).find(
    (s) => s.metadata?.name === name && s.metadata?.namespace === ns,
  );

  const ref = server?.spec?.targetRef;
  const routeNs = ref?.namespace || ns || '';
  const [routes] = useK8sWatchResource<HTTPRoute[]>({ groupVersionKind: HTTPRouteGVK, isList: true });
  const backendRoute = React.useMemo(
    () => (routes || []).find((r) => r.metadata?.name === ref?.name && r.metadata?.namespace === routeNs),
    [routes, ref?.name, routeNs],
  );
  const { backends } = useBackendsStatus(backendRoute);

  const prefix = server ? mcpPrefix(server) : '';
  const catalog = useMcpBrokerCatalog(prefix);

  if (!loaded) {
    return (
      <div className="rhcl-plugin-root">
        <Bullseye>
          <Spinner />
        </Bullseye>
      </div>
    );
  }
  if (!server) {
    return (
      <div className="rhcl-plugin-root">
        <PageSection>
          <EmptyState headingLevel="h2" titleText={t('MCP server not found')}>
            <EmptyStateBody>
              {t('No MCPServerRegistration named {{name}} in namespace {{ns}}.', { name, ns })}
            </EmptyStateBody>
          </EmptyState>
        </PageSection>
      </div>
    );
  }

  const ready = mcpReadiness(server);
  const conditions = server.status?.conditions || [];
  const tags = server.spec?.tags || [];
  const categories = server.spec?.category || [];
  const path = server.spec?.path || '/mcp';
  const state = server.spec?.state || 'Enabled';

  const endpointsReady = backends.reduce((s, b) => s + b.readyEndpoints, 0);
  const endpointsTotal = backends.reduce((s, b) => s + b.totalEndpoints, 0);
  const servicesFound = backends.filter((b) => b.serviceFound).length;

  const brokerSeverity: TopoSeverity =
    catalog.status === 'ready' ? 'healthy' : catalog.status === 'error' ? 'critical' : 'progressing';
  const catalogVal = (n: number): React.ReactNode =>
    catalog.status === 'ready' ? n : catalog.status === 'error' ? 'N/A' : '…';

  const topoNodes: TopoNode[] = [
    { key: 'client', icon: <RobotIcon />, title: t('Client'), primary: t('Agent / LLM'), severity: 'info' },
    {
      key: 'broker',
      icon: <ConnectedIcon />,
      title: t('MCP Gateway'),
      primary: t('Broker + Router'),
      secondary:
        catalog.status === 'ready' ? t('connected') : catalog.status === 'error' ? t('unreachable') : t('connecting'),
      severity: brokerSeverity,
    },
    {
      key: 'server',
      icon: <CubesIcon />,
      title: t('Server'),
      primary: name,
      secondary: prefix || t('no prefix'),
      severity: readinessSeverity(ready.color),
    },
    {
      key: 'route',
      icon: <RouteIcon />,
      title: t('Route'),
      primary: ref?.name || '—',
      severity: backendRoute ? 'healthy' : 'unknown',
    },
    {
      key: 'service',
      icon: <ServerIcon />,
      title: t('Services'),
      primary: `${servicesFound}/${backends.length}`,
      severity: backends.length === 0 ? 'unknown' : servicesFound < backends.length ? 'warning' : 'healthy',
    },
    {
      key: 'pods',
      icon: <CubeIcon />,
      title: t('Endpoints'),
      primary: `${endpointsReady}/${endpointsTotal}`,
      severity: endpointsTotal === 0 ? 'unknown' : endpointsReady < endpointsTotal ? 'warning' : 'healthy',
    },
  ];

  const tryTool = (tool: McpTool) => {
    setSelectedTool(tool);
    setTimeout(() => document.getElementById('mcp-playground')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };

  return (
    <div className="rhcl-plugin-root">
      <PageSection variant="default">
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to="/connectivity-link/mcp-servers">{t('MCP Servers')}</Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{name}</BreadcrumbItem>
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
          <Title headingLevel="h1">
            {name} <Label color={ready.color}>{t(ready.label)}</Label>
          </Title>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <ObservabilityMenu
              grafanaVars={ref?.name ? { httproute: `${routeNs}.${ref.name}` } : undefined}
              dashboards={['api-overview', 'api-consumers']}
              labels={{ 'api-overview': t('Traffic dashboard') }}
              tempoVars={{ serviceName: 'mcp-gateway-istio', lookback: '1h' }}
            />
            <ResourceActionsMenu
              gvk={MCPServerRegistrationGVK}
              namespace={ns || ''}
              name={name || ''}
              listHref="/connectivity-link/mcp-servers"
              resource={server}
              plural="mcpserverregistrations"
            />
          </div>
        </div>

        <div style={{ marginTop: 10, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          <MetaChip label={t('Namespace')} value={ns} />
          <MetaChip label={t('Prefix')} value={prefix ? <code>{prefix}</code> : '—'} />
          <MetaChip label={t('Path')} value={<code>{path}</code>} />
          <MetaChip label={t('State')} value={state} />
          <MetaChip label={t('Age')} value={relativeAge(server.metadata?.creationTimestamp)} />
        </div>
      </PageSection>

      <PageSection>
        {/* KPI row */}
        <Gallery hasGutter minWidths={{ default: '200px' }} style={{ marginBottom: 16 }}>
          <KpiCard
            variant="traffic"
            icon={<CubesIcon />}
            label={t('Tools')}
            value={catalogVal(catalog.tools.length)}
            subtitle={t('federated by the broker')}
          />
          <KpiCard
            variant="routes"
            icon={<CatalogIcon />}
            label={t('Prompts')}
            value={catalogVal(catalog.prompts.length)}
            subtitle={t('exposed by this server')}
          />
          <KpiCard
            variant="backends"
            icon={<ServerIcon />}
            label={t('Backend endpoints')}
            value={endpointsTotal > 0 ? `${endpointsReady}/${endpointsTotal}` : servicesFound}
            subtitle={endpointsTotal > 0 ? t('ready') : t('{{n}} services', { n: backends.length })}
          />
          <KpiCard
            variant="listeners"
            icon={<LayerGroupIcon />}
            label={t('Categories')}
            value={categories.length}
            subtitle={t('discover_tools filters')}
          />
          <KpiCard
            variant="policies"
            icon={<TagIcon />}
            label={t('Tags')}
            value={tags.length}
            subtitle={t('list_tags labels')}
          />
        </Gallery>

        <Grid hasGutter style={{ marginBottom: 16 }}>
          <GridItem lg={6}>
            <SectionCard title={t('Registration')} icon={<KeyIcon />}>
              <DescriptionList isHorizontal isCompact isFluid>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Tool prefix')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {prefix ? <code>{prefix}</code> : <span style={{ color: SUBTLE }}>{t('none')}</span>}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Path')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    <code>{path}</code>
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('State')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    <Label color={state === 'Disabled' ? 'grey' : 'blue'} isCompact>
                      {state}
                    </Label>
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Backend route')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {ref?.name ? (
                      (ref.kind || 'HTTPRoute') === 'HTTPRoute' ? (
                        <Link to={`/connectivity-link/httproutes/${routeNs}/${ref.name}`}>{ref.name}</Link>
                      ) : (
                        <>
                          {ref.kind}/{ref.name}
                        </>
                      )
                    ) : (
                      <span style={{ color: SUBTLE }}>—</span>
                    )}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Per-user tool list')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {server.spec?.userSpecificList || 'Disabled'}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                {server.spec?.hint && (
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('Hint')}</DescriptionListTerm>
                    <DescriptionListDescription>{server.spec.hint}</DescriptionListDescription>
                  </DescriptionListGroup>
                )}
                {(categories.length > 0 || tags.length > 0) && (
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('Categories / tags')}</DescriptionListTerm>
                    <DescriptionListDescription>
                      <LabelGroup>
                        {categories.map((c) => (
                          <Label key={`c-${c}`} isCompact color="teal">
                            {c}
                          </Label>
                        ))}
                        {tags.map((tag) => (
                          <Label key={`t-${tag}`} isCompact color="purple">
                            {tag}
                          </Label>
                        ))}
                      </LabelGroup>
                    </DescriptionListDescription>
                  </DescriptionListGroup>
                )}
              </DescriptionList>
            </SectionCard>
          </GridItem>

          <GridItem lg={6}>
            <SectionCard title={t('Health')} icon={<CheckCircleIcon />}>
              <MetricGrid>
                <Metric
                  label={t('Readiness')}
                  value={<Label isCompact color={ready.color}>{t(ready.label)}</Label>}
                />
                <Metric
                  label={t('Broker')}
                  value={
                    catalog.status === 'ready' ? (
                      <Label isCompact color="green" icon={<ConnectedIcon />}>
                        {t('Connected')}
                      </Label>
                    ) : catalog.status === 'error' ? (
                      <Label isCompact color="red">
                        {t('Unreachable')}
                      </Label>
                    ) : (
                      <Label isCompact color="blue">
                        {t('Connecting')}
                      </Label>
                    )
                  }
                />
                <Metric
                  label={t('Backend resolved')}
                  value={
                    backends.length === 0 ? (
                      <span style={{ color: SUBTLE }}>—</span>
                    ) : servicesFound === backends.length ? (
                      <Label isCompact color="green">
                        {t('Yes')}
                      </Label>
                    ) : (
                      <Label isCompact color="orange">
                        {t('Partial')}
                      </Label>
                    )
                  }
                />
                <Metric label={t('Endpoints ready')} value={endpointsTotal > 0 ? `${endpointsReady}/${endpointsTotal}` : '—'} />
                <Metric
                  label={t('Tool calls / errors')}
                  value={null}
                  na={t('The broker does not expose per-tool invocation metrics.')}
                />
                <Metric label={t('Last transition')} value={relativeAge(conditions.find((c) => c.type === 'Ready')?.lastTransitionTime)} />
              </MetricGrid>
            </SectionCard>
          </GridItem>

          <GridItem lg={12}>
            <SectionCard title={t('MCP topology')} icon={<NetworkIcon />}>
              <GatewayTopologyFlow nodes={topoNodes} />
            </SectionCard>
          </GridItem>
        </Grid>

        <Grid hasGutter style={{ marginBottom: 16 }}>
          <GridItem lg={8}>
            <SectionCard
              title={t('Tools catalog')}
              icon={<CubesIcon />}
              action={
                catalog.status === 'ready' ? (
                  <span style={{ fontSize: 12, color: SUBTLE }}>{t('{{n}} tools', { n: catalog.tools.length })}</span>
                ) : undefined
              }
            >
              {catalog.status === 'connecting' ? (
                <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
                  <FlexItem>
                    <Spinner size="md" />
                  </FlexItem>
                  <FlexItem>{t('Loading tools from the broker…')}</FlexItem>
                </Flex>
              ) : catalog.status === 'error' ? (
                <div>
                  <div style={{ marginBottom: 8 }}>
                    <NAValue reason={catalog.error || t('The MCP broker could not be reached.')} />
                  </div>
                  <p style={{ fontSize: 12, color: SUBTLE }}>
                    {t(
                      'Tool inventory comes from the broker (tools/list) via the console “mcp-broker” proxy. Install the MCP Gateway and wire the proxy alias (see tests/req073) to populate it.',
                    )}
                  </p>
                  <Button variant="link" isInline onClick={catalog.retry} style={{ marginTop: 6 }}>
                    {t('Retry')}
                  </Button>
                </div>
              ) : catalog.tools.length === 0 ? (
                <p style={{ color: SUBTLE }}>{t('The broker reported no tools for this prefix yet.')}</p>
              ) : (
                <Table aria-label={t('Tools')} variant="compact">
                  <Thead>
                    <Tr>
                      <Th>{t('Tool')}</Th>
                      <Th>{t('Description')}</Th>
                      <Th>{t('Args')}</Th>
                      <Th aria-label={t('Actions')} />
                    </Tr>
                  </Thead>
                  <Tbody>
                    {catalog.tools.map((tool) => {
                      const props = (tool.inputSchema?.properties as Record<string, unknown> | undefined) || {};
                      return (
                        <Tr key={tool.name}>
                          <Td>
                            <code>{tool.name}</code>
                          </Td>
                          <Td>
                            <span style={{ color: SUBTLE }}>{tool.description || '—'}</span>
                          </Td>
                          <Td>{Object.keys(props).length}</Td>
                          <Td isActionCell>
                            <Button
                              variant={selectedTool?.name === tool.name ? 'primary' : 'secondary'}
                              isInline
                              icon={<PlayIcon />}
                              onClick={() => tryTool(tool)}
                            >
                              {t('Try')}
                            </Button>
                          </Td>
                        </Tr>
                      );
                    })}
                  </Tbody>
                </Table>
              )}
            </SectionCard>
          </GridItem>

          <GridItem lg={4}>
            <SectionCard title={t('Prompts')} icon={<CatalogIcon />}>
              {catalog.status !== 'ready' ? (
                <span style={{ color: SUBTLE }}>{t('—')}</span>
              ) : catalog.prompts.length === 0 ? (
                <p style={{ color: SUBTLE }}>{t('This server exposes no prompts.')}</p>
              ) : (
                catalog.prompts.map((p) => (
                  <div key={p.name} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      <code>{p.name}</code>
                    </div>
                    {p.description && <div style={{ fontSize: 12, color: SUBTLE }}>{p.description}</div>}
                  </div>
                ))
              )}
            </SectionCard>
          </GridItem>
        </Grid>

        <div id="mcp-playground">
          <SectionCard title={t('Try it')} icon={<PlayIcon />}>
            <MCPPlayground
              session={catalog.session}
              tool={selectedTool}
              status={catalog.status}
              error={catalog.error}
              onRetry={catalog.retry}
            />
          </SectionCard>
        </div>

        <div style={{ marginTop: 8 }}>
          <ExpandableSection
            toggleText={t('Advanced details (Kubernetes resource)')}
            isExpanded={advancedOpen}
            onToggle={() => setAdvancedOpen((o) => !o)}
          >
            <Grid hasGutter>
              <GridItem lg={6}>
                <Card isFullHeight className="rhcl-section-card">
                  <CardBody>
                    <div className="rhcl-section-title">{t('Status conditions')}</div>
                    {conditions.length === 0 ? (
                      <span style={{ color: SUBTLE }}>{t('No conditions reported yet.')}</span>
                    ) : (
                      <Table aria-label={t('Conditions')} variant="compact">
                        <Thead>
                          <Tr>
                            <Th>{t('Type')}</Th>
                            <Th>{t('Status')}</Th>
                            <Th>{t('Reason')}</Th>
                            <Th>{t('Message')}</Th>
                          </Tr>
                        </Thead>
                        <Tbody>
                          {conditions.map((c) => (
                            <Tr key={c.type}>
                              <Td>{c.type}</Td>
                              <Td>
                                <Label
                                  isCompact
                                  color={c.status === 'True' ? 'green' : c.status === 'False' ? 'red' : 'grey'}
                                >
                                  {c.status}
                                </Label>
                              </Td>
                              <Td>{c.reason || '—'}</Td>
                              <Td>{c.message || '—'}</Td>
                            </Tr>
                          ))}
                        </Tbody>
                      </Table>
                    )}
                  </CardBody>
                </Card>
              </GridItem>
              <GridItem lg={6}>
                <Card isFullHeight className="rhcl-section-card">
                  <CardBody>
                    <div className="rhcl-section-title">{t('Metadata')}</div>
                    <DescriptionList isHorizontal isCompact isFluid>
                      <DescriptionListGroup>
                        <DescriptionListTerm>UID</DescriptionListTerm>
                        <DescriptionListDescription>{server.metadata?.uid || '—'}</DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Created')}</DescriptionListTerm>
                        <DescriptionListDescription>
                          {server.metadata?.creationTimestamp || '—'}
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                    </DescriptionList>
                  </CardBody>
                </Card>
              </GridItem>
              <GridItem lg={12}>
                <Card className="rhcl-section-card">
                  <CardBody>
                    <div className="rhcl-section-title">YAML</div>
                    <CodeBlock>
                      <CodeBlockCode>{yaml.dump(server, { noRefs: true, lineWidth: -1 })}</CodeBlockCode>
                    </CodeBlock>
                  </CardBody>
                </Card>
              </GridItem>
            </Grid>
          </ExpandableSection>
        </div>
      </PageSection>
    </div>
  );
};

export default MCPServerDetailPage;
