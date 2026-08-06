import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  CardBody,
  Gallery,
  Grid,
  GridItem,
  Flex,
  FlexItem,
  Label,
  Button,
  Tooltip,
  ExpandableSection,
  CodeBlock,
  CodeBlockCode,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Spinner,
} from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import {
  NetworkIcon,
  RouteIcon,
  CubesIcon,
  CubeIcon,
  ChartLineIcon,
  ExclamationTriangleIcon,
  ExclamationCircleIcon,
  ShieldAltIcon,
  GlobeIcon,
  LockIcon,
  CheckCircleIcon,
  InfoCircleIcon,
  ListIcon,
  ServerIcon,
  BellIcon,
  MicrochipIcon,
  MemoryIcon,
  PlugIcon,
  CogIcon,
} from '@patternfly/react-icons';
import yaml from 'js-yaml';
import { useTranslation } from 'react-i18next';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { HTTPRouteGVK } from '../../models';
import { Gateway, HTTPRoute, K8sCondition, StatusSeverity } from '../../types';
import { KpiCard, RadialRing, Delta } from '../common/kpi';
import StatusLabel from '../common/StatusLabel';
import { OpenInGrafanaButton } from '../common/OpenInGrafanaButton';
import { OpenInTempoButton } from '../common/OpenInTempoButton';
import TrafficPanel from '../common/TrafficPanel';
import { PolicyAttachmentView } from '../policies/PolicyAttachmentView';
import TLSHealthCard from '../health/TLSHealthCard';
import DNSHealthCard from '../health/DNSHealthCard';
import { severityToLabelColor } from '../../utils/status';
import { policyKindLabel } from '../../models';
import { usePrometheusTraffic } from '../../hooks/usePrometheusTraffic';
import { usePrometheusRange } from '../../hooks/usePrometheusRange';
import { requestRateQuery, statusCodeRateRangeQuery } from '../../utils/prometheusQueries';
import { useAttachedPolicies } from '../../hooks/useAttachedPolicies';
import { useGatewayBackendHealth } from '../../hooks/useGatewayBackendHealth';
import { useGatewayPodHealth } from '../../hooks/useGatewayPodHealth';
import { useNeedsAttention } from '../../hooks/useNeedsAttention';
import { useGatewaySecurityScore, SecurityDimension } from './useGatewaySecurityScore';
import GatewayTopologyFlow, { TopoNode, TopoSeverity } from './GatewayTopologyFlow';
import {
  SUCCESS,
  WARNING,
  DANGER,
  SUBTLE,
  NAValue,
  SectionCard,
  MetricGrid,
  Metric,
} from '../common/dashboardCards';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function relativeAge(iso?: string): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return 'just now';
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Needs-Attention items build hrefs to the NATIVE console Gateway path; the
 * plugin owns its own gateway route. Rewrite only that shape — pod / policy /
 * apikey hrefs already point at valid console/plugin routes.
 */
function toPluginHref(href: string): string {
  const m = href.match(
    /^\/k8s\/ns\/([^/]+)\/gateway\.networking\.k8s\.io~v1~Gateway\/([^/]+)$/,
  );
  if (m) return `/connectivity-link/gateways/${m[1]}/${m[2]}`;
  return href;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

/** Trend over a series: mean of the second half vs the first half. */
function trendPct(nums: number[]): number | null {
  if (nums.length < 4) return null;
  const half = Math.floor(nums.length / 2);
  const a = avg(nums.slice(0, half));
  const b = avg(nums.slice(half));
  if (a <= 0) return b > 0 ? 100 : null;
  return ((b - a) / a) * 100;
}

function scoreColor(score: number): string {
  if (score >= 90) return SUCCESS;
  if (score >= 70) return WARNING;
  return DANGER;
}

function condSeverity(conditions: K8sCondition[] | undefined, type: string): StatusSeverity {
  const c = (conditions || []).find((x) => x.type === type);
  if (!c) return 'unknown';
  if (c.status === 'True') return 'healthy';
  if (c.status === 'False') return 'critical';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const GatewayOpsDashboard: React.FC<{
  gateway: Gateway;
  name: string;
  namespace: string;
}> = ({ gateway, name, namespace }) => {
  const { t } = useTranslation('plugin__kuadrant-console');
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  const gwClass = gateway.spec?.gatewayClassName;
  const grafanaGwVar = gwClass ? `${name}-${gwClass}` : `${name}-.*`;

  // --- data ---
  const { data: traffic, metricsAvailable, loaded: trafficLoaded } = usePrometheusTraffic(
    'Gateway',
    name,
    namespace,
    60000,
    '5m',
  );
  const rangeQueries = React.useMemo(
    () => [
      { label: 'rps', query: requestRateQuery(namespace, name, 'Gateway', '5m') },
      { label: '5xx', query: statusCodeRateRangeQuery(namespace, name, 'Gateway', '5xx', '5m') },
    ],
    [namespace, name],
  );
  const { series } = usePrometheusRange(rangeQueries, 3600, 120, 60000);
  const rpsSeries = (series.find((s) => s.label === 'rps')?.data || []).map((d) => d.y);
  const fivexxSeries = (series.find((s) => s.label === '5xx')?.data || []).map((d) => d.y);

  const { policies, loaded: policiesLoaded } = useAttachedPolicies('Gateway', name, namespace, namespace);
  const backends = useGatewayBackendHealth(name, namespace);
  const { byGateway: podHealth } = useGatewayPodHealth();
  const security = useGatewaySecurityScore(gateway, name, namespace);
  const { items: alertItems } = useNeedsAttention(namespace);

  const [routes] = useK8sWatchResource<HTTPRoute[]>({
    groupVersionKind: HTTPRouteGVK,
    isList: true,
  });

  // --- derived ---
  const listeners = gateway.spec?.listeners || [];
  const listenerStatuses = gateway.status?.listeners || [];
  const listenersTotal = listeners.length;
  const listenersHealthy = listenerStatuses.length
    ? listenerStatuses.filter((l) =>
        (l.conditions || []).some((c) => c.type === 'Programmed' && c.status === 'True'),
      ).length
    : null;

  const attachedRoutes = React.useMemo(
    () =>
      (routes || []).filter((r) =>
        (r.spec?.parentRefs || []).some((ref) => {
          if (ref.kind && ref.kind !== 'Gateway') return false;
          const ns = ref.namespace || r.metadata?.namespace;
          return ref.name === name && ns === namespace;
        }),
      ),
    [routes, name, namespace],
  );
  const routesTotal = attachedRoutes.length;
  const routesHealthy = attachedRoutes.filter((r) =>
    (r.status?.parents || []).some((p) =>
      (p.conditions || []).some((c) => c.type === 'Accepted' && c.status === 'True'),
    ),
  ).length;

  const pod = podHealth.find((h) => h.gatewayName === name && h.gatewayNamespace === namespace);
  const enforcedCount = policies.filter((p) => p.isEnforced).length;

  // Traffic figures (real, honest — extrapolated rate is labelled as such).
  const rps = traffic.requestRate1m;
  const reqPerMin = rps != null ? Math.round(rps * 60) : null;
  const total = (traffic.rate2xx || 0) + (traffic.rate4xx || 0) + (traffic.rate5xx || 0);
  const errorPct = total > 0 ? ((traffic.rate5xx || 0) / total) * 100 : 0;
  const p95 = traffic.latencyP95;
  const trafficDelta = trendPct(rpsSeries);
  const errorDelta = trendPct(fivexxSeries);

  const openDeep = (key: string) => {
    setOpenKey(key);
    // The plugin renders in the console's own DOM, so a plain id lookup works.
    setTimeout(() => document.getElementById(`deepdive-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  const toggleDeep = (key: string) => setOpenKey((cur) => (cur === key ? null : key));

  // --- KPI tiles ---
  const kpiRow = (
    <Gallery hasGutter minWidths={{ default: '200px' }} style={{ marginBottom: 16 }}>
      <KpiCard
        variant="listeners"
        icon={<NetworkIcon />}
        label={t('Listeners')}
        value={listenersTotal}
        subtitle={
          listenersHealthy != null
            ? t('{{h}}/{{total}} programmed', { h: listenersHealthy, total: listenersTotal })
            : t('status pending')
        }
      />
      <KpiCard
        variant="routes"
        icon={<RouteIcon />}
        label={t('Routes')}
        value={routesTotal}
        subtitle={t('{{h}}/{{total}} accepted', { h: routesHealthy, total: routesTotal })}
      />
      <KpiCard
        variant="backends"
        icon={<CubesIcon />}
        label={t('Backends')}
        value={backends.serviceCount}
        subtitle={
          backends.endpointsTotal > 0
            ? t('{{r}}/{{tot}} endpoints ready', {
                r: backends.endpointsReady,
                tot: backends.endpointsTotal,
              })
            : t('{{n}} services', { n: backends.serviceCount })
        }
      />
      <KpiCard
        variant="policies"
        icon={<ShieldAltIcon />}
        label={t('Policies')}
        value={policiesLoaded ? policies.length : '…'}
        subtitle={t('{{n}} enforced', { n: enforcedCount })}
      />
      <KpiCard
        variant="traffic"
        icon={<ChartLineIcon />}
        label={t('Traffic')}
        value={
          !trafficLoaded ? '…' : !metricsAvailable || reqPerMin == null ? 'N/A' : `${reqPerMin}/min`
        }
        subtitle={
          metricsAvailable && p95 != null ? t('P95 {{ms}} ms', { ms: Math.round(p95) }) : t('req/min (5m avg)')
        }
        delta={metricsAvailable ? <Delta pct={trafficDelta} /> : undefined}
        sparkline={metricsAvailable ? rpsSeries : undefined}
      />
      <KpiCard
        variant="errors"
        icon={<ExclamationTriangleIcon />}
        label={t('Errors')}
        value={!trafficLoaded ? '…' : !metricsAvailable ? 'N/A' : `${errorPct.toFixed(1)}%`}
        subtitle={
          metricsAvailable && traffic.successRate != null
            ? t('{{s}}% success', { s: traffic.successRate.toFixed(1) })
            : t('5xx share of traffic')
        }
        delta={metricsAvailable ? <Delta pct={errorDelta} invert /> : undefined}
      />
      <KpiCard
        variant="security"
        icon={<ShieldAltIcon />}
        label={t('Security score')}
        value={
          <RadialRing
            value={security.score ?? 0}
            size={76}
            stroke={8}
            color={security.score != null ? scoreColor(security.score) : SUBTLE}
            label={
              <span style={{ fontSize: 22, fontWeight: 800 }}>
                {security.loaded && security.score != null ? security.score : '—'}
              </span>
            }
          />
        }
        subtitle={t('{{w}} pts evaluated', { w: security.applicableWeight })}
      />
    </Gallery>
  );

  // --- topology nodes ---
  const dnsDim = security.dimensions.find((d) => d.key === 'dns');
  const tlsDim = security.dimensions.find((d) => d.key === 'tls');
  const edgeSeverity: TopoSeverity = worstSeverity([
    dimSeverity(dnsDim),
    dimSeverity(tlsDim),
  ]);
  const topoNodes: TopoNode[] = [
    { key: 'internet', icon: <GlobeIcon />, title: t('Internet'), primary: t('Ingress'), severity: 'info' },
    {
      key: 'edge',
      icon: <LockIcon />,
      title: t('DNS / TLS'),
      primary: edgeSeverity === 'na' ? '—' : t('Secured'),
      secondary: [tlsDim && tlsDim.evaluated ? 'TLS' : null, dnsDim && dnsDim.evaluated ? 'DNS' : null]
        .filter(Boolean)
        .join(' · ') || t('none'),
      severity: edgeSeverity,
    },
    {
      key: 'gateway',
      icon: <NetworkIcon />,
      title: t('Gateway'),
      primary: name,
      severity: condSeverity(gateway.status?.conditions, 'Programmed'),
    },
    {
      key: 'listeners',
      icon: <ListIcon />,
      title: t('Listeners'),
      primary: `${listenersHealthy ?? listenersTotal}/${listenersTotal}`,
      severity: listenersHealthy != null && listenersHealthy < listenersTotal ? 'warning' : 'healthy',
    },
    {
      key: 'routes',
      icon: <RouteIcon />,
      title: t('Routes'),
      primary: `${routesHealthy}/${routesTotal}`,
      severity: routesTotal === 0 ? 'unknown' : routesHealthy < routesTotal ? 'warning' : 'healthy',
    },
    {
      key: 'services',
      icon: <CubesIcon />,
      title: t('Services'),
      primary: `${backends.servicesReady}/${backends.serviceCount}`,
      severity:
        backends.serviceCount === 0
          ? 'unknown'
          : backends.servicesReady < backends.serviceCount
          ? 'warning'
          : 'healthy',
    },
    {
      key: 'pods',
      icon: <CubeIcon />,
      title: t('Pods'),
      primary: pod ? `${pod.readyCount}/${pod.podCount}` : '—',
      severity: (pod?.worstSeverity as TopoSeverity) || 'unknown',
    },
  ];

  return (
    <>
      {kpiRow}

      {/* Main grid: Health + Security, then full-width Traffic + Topology */}
      <Grid hasGutter style={{ marginBottom: 16 }}>
        <GridItem lg={6}>
          <SectionCard title={t('Gateway health')} icon={<CheckCircleIcon />}>
            <DescriptionList isHorizontal isCompact isFluid>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Accepted')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <StatusLabel
                    severity={condSeverity(gateway.status?.conditions, 'Accepted')}
                    label={
                      (gateway.status?.conditions || []).find((c) => c.type === 'Accepted')?.status ||
                      'Unknown'
                    }
                  />
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Programmed')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <StatusLabel
                    severity={condSeverity(gateway.status?.conditions, 'Programmed')}
                    label={
                      (gateway.status?.conditions || []).find((c) => c.type === 'Programmed')?.status ||
                      'Unknown'
                    }
                  />
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Gateway class')}</DescriptionListTerm>
                <DescriptionListDescription>{gwClass || '—'}</DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Listeners')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {listenersHealthy != null ? `${listenersHealthy}/${listenersTotal}` : listenersTotal}{' '}
                  {t('healthy')}
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Routes')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {routesHealthy}/{routesTotal} {t('accepted')}
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Backends')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {backends.serviceCount} {t('services')} · {backends.endpointsReady}/
                  {backends.endpointsTotal} {t('endpoints')}
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Last reconciliation')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {relativeAge(
                    (gateway.status?.conditions || [])
                      .map((c) => c.lastTransitionTime)
                      .filter((x): x is string => !!x)
                      .sort()
                      .reverse()[0],
                  )}
                </DescriptionListDescription>
              </DescriptionListGroup>
            </DescriptionList>
          </SectionCard>
        </GridItem>

        <GridItem lg={6}>
          <SectionCard
            title={t('Security posture')}
            icon={<ShieldAltIcon />}
            action={
              <Button variant="link" isInline onClick={() => openDeep('policies')}>
                {t('Open security overview')}
              </Button>
            }
          >
            {security.dimensions.map((d) => (
              <div
                key={d.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <span style={{ flex: 1, fontSize: 13 }}>{d.label}</span>
                <SecurityDimLabel dim={d} />
                <span style={{ width: 56, textAlign: 'right', fontSize: 12, color: SUBTLE }}>
                  {d.evaluated ? `${d.earned}/${d.weight}` : '—'}
                </span>
              </div>
            ))}
            <div style={{ marginTop: 10, fontSize: 12, color: SUBTLE }}>
              {t('Score = earned ÷ evaluated points × 100. WAF and headers are shown but excluded (not measurable here).')}
            </div>
          </SectionCard>
        </GridItem>

        <GridItem lg={12}>
          <SectionCard
            title={t('Traffic')}
            icon={<ChartLineIcon />}
            action={
              <Flex spaceItems={{ default: 'spaceItemsSm' }}>
                <FlexItem>
                  <OpenInGrafanaButton
                    dashboard="api-overview"
                    label={t('Gateway traffic')}
                    vars={{ gateway: grafanaGwVar }}
                    variant="link"
                    isInline
                  />
                </FlexItem>
                <FlexItem>
                  <Button variant="link" isInline onClick={() => openDeep('traffic')}>
                    {t('Open charts')}
                  </Button>
                </FlexItem>
              </Flex>
            }
          >
            {!metricsAvailable ? (
              <div style={{ color: SUBTLE }}>
                {t('Metrics are unavailable — user-workload monitoring did not return Istio series for this gateway.')}
              </div>
            ) : (
              <MetricGrid>
                <Metric label={t('Requests / min')} value={reqPerMin != null ? reqPerMin : '—'} />
                <Metric label={t('P95 latency')} value={p95 != null ? `${Math.round(p95)} ms` : '—'} />
                <Metric label={t('Error rate')} value={`${errorPct.toFixed(1)}%`} />
                <Metric
                  label={t('Success rate')}
                  value={traffic.successRate != null ? `${traffic.successRate.toFixed(1)}%` : '—'}
                />
                <Metric label={t('Peak RPS')} value={null} na={t('No max-over-time query is implemented; peak RPS is not computed.')} />
                <Metric label={t('Bandwidth')} value={null} na={t('Istio byte counters are not scraped at the user-workload tier on this cluster.')} />
              </MetricGrid>
            )}
          </SectionCard>
        </GridItem>

        <GridItem lg={12}>
          <SectionCard title={t('Gateway topology')} icon={<NetworkIcon />}>
            <GatewayTopologyFlow nodes={topoNodes} />
          </SectionCard>
        </GridItem>
      </Grid>

      {/* Second row */}
      <Grid hasGutter style={{ marginBottom: 16 }}>
        <GridItem lg={6}>
          <SectionCard title={t('Listeners')} icon={<ListIcon />}>
            <Table aria-label={t('Listeners')} variant="compact">
              <Thead>
                <Tr>
                  <Th>{t('Listener')}</Th>
                  <Th>{t('Protocol')}</Th>
                  <Th>{t('Port')}</Th>
                  <Th>{t('TLS')}</Th>
                  <Th>{t('Routes')}</Th>
                  <Th>{t('Status')}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {listeners.map((l) => {
                  const st = listenerStatuses.find((s) => s.name === l.name);
                  const hasTls = l.protocol === 'HTTPS' || (l.tls?.certificateRefs?.length ?? 0) > 0;
                  return (
                    <Tr key={l.name}>
                      <Td>{l.name}</Td>
                      <Td>{l.protocol}</Td>
                      <Td>{l.port}</Td>
                      <Td>{hasTls ? <LockIcon color={SUCCESS} /> : '—'}</Td>
                      <Td>{st ? st.attachedRoutes : '—'}</Td>
                      <Td>
                        {st ? (
                          <StatusLabel conditions={st.conditions} />
                        ) : (
                          <Label color="grey">{t('Unknown')}</Label>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </SectionCard>
        </GridItem>

        <GridItem lg={6}>
          <SectionCard
            title={t('Policy coverage')}
            icon={<ShieldAltIcon />}
            action={
              <Button variant="link" isInline onClick={() => openDeep('policies')}>
                {t('Open policies')}
              </Button>
            }
          >
            {!policiesLoaded ? (
              <Spinner size="md" />
            ) : policies.length === 0 ? (
              <div style={{ color: SUBTLE }}>{t('No policies attached to this gateway.')}</div>
            ) : (
              <>
                {groupBy(policies, (p) => String(p.policyKind)).map(([kind, list]) => {
                  const enforced = list.filter((p) => p.isEnforced).length;
                  const overridden = list.filter((p) => p.isOverridden).length;
                  return (
                    <div
                      key={kind}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 0',
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                      }}
                    >
                      <span style={{ flex: 1, fontSize: 13 }}>{policyKindLabel(kind)}</span>
                      <Label isCompact color="blue">
                        {list.length}
                      </Label>
                      {enforced > 0 && (
                        <Label isCompact color="green">
                          {t('{{n}} enforced', { n: enforced })}
                        </Label>
                      )}
                      {overridden > 0 && (
                        <Label isCompact color="orange">
                          {t('{{n}} overridden', { n: overridden })}
                        </Label>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </SectionCard>
        </GridItem>

        <GridItem lg={6}>
          <SectionCard title={t('Alerts & needs attention')} icon={<BellIcon />}>
            {alertItems.length === 0 ? (
              <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
                <FlexItem>
                  <CheckCircleIcon color={SUCCESS} />
                </FlexItem>
                <FlexItem>{t('No active issues in this namespace.')}</FlexItem>
              </Flex>
            ) : (
              sortAlerts(alertItems)
                .slice(0, 6)
                .map((a) => (
                  <Link
                    key={a.id}
                    to={toPluginHref(a.href)}
                    style={{
                      display: 'flex',
                      gap: 8,
                      padding: '8px 0',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      textDecoration: 'none',
                    }}
                  >
                    <span aria-hidden="true" style={{ marginTop: 2 }}>
                      {a.severity === 'critical' ? (
                        <ExclamationCircleIcon color={DANGER} />
                      ) : a.severity === 'warning' ? (
                        <ExclamationTriangleIcon color={WARNING} />
                      ) : (
                        <InfoCircleIcon color="var(--pf-t--global--color--status--info--default)" />
                      )}
                    </span>
                    <span style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--pf-t--global--text--color--regular)' }}>
                        {a.title}
                      </div>
                      <div style={{ fontSize: 12, color: SUBTLE }}>{a.detail}</div>
                    </span>
                    <span style={{ fontSize: 11, color: SUBTLE, whiteSpace: 'nowrap' }}>{a.occurredAt}</span>
                  </Link>
                ))
            )}
          </SectionCard>
        </GridItem>

        <GridItem lg={6}>
          <SectionCard title={t('Gateway capacity')} icon={<ServerIcon />}>
            <MetricGrid>
              <Metric
                label={t('Pods ready')}
                value={pod ? `${pod.readyCount}/${pod.podCount}` : '—'}
              />
              <Metric label={t('Restarts')} value={pod ? pod.totalRestarts : '—'} />
              <Metric label={<><MicrochipIcon /> {t('CPU')}</>} value={null} na={t('Gateway pods run in openshift-ingress; cAdvisor CPU is not queried by the plugin.')} />
              <Metric label={<><MemoryIcon /> {t('Memory')}</>} value={null} na={t('Pod memory metrics are not queried by the plugin.')} />
              <Metric label={<><PlugIcon /> {t('Connections')}</>} value={null} na={t('Envoy connection metrics are not emitted at the user-workload scrape.')} />
              <Metric label={<><CogIcon /> {t('Envoy workers')}</>} value={null} na={t('Envoy admin (:15000) is unreachable from the browser.')} />
            </MetricGrid>
          </SectionCard>
        </GridItem>
      </Grid>

      {/* Bottom row */}
      <Grid hasGutter style={{ marginBottom: 16 }}>
        <GridItem lg={6}>
          <SectionCard
            title={t('DNS health')}
            icon={<GlobeIcon />}
            action={
              <Button variant="link" isInline onClick={() => openDeep('dns')}>
                {t('Open DNS overview')}
              </Button>
            }
          >
            <DNSHealthSummary dim={dnsDim} />
          </SectionCard>
        </GridItem>

        <GridItem lg={6}>
          <SectionCard
            title={t('TLS health')}
            icon={<LockIcon />}
            action={
              <Button variant="link" isInline onClick={() => openDeep('tls')}>
                {t('Open TLS overview')}
              </Button>
            }
          >
            <TLSHealthSummary dim={tlsDim} />
          </SectionCard>
        </GridItem>

        <GridItem lg={6}>
          <SectionCard title={t('Observability')} icon={<ChartLineIcon />}>
            <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsXs' }}>
              <FlexItem>
                <OpenInGrafanaButton dashboard="api-overview" label={t('API overview')} vars={{ gateway: grafanaGwVar }} variant="link" isInline />
              </FlexItem>
              <FlexItem>
                <OpenInGrafanaButton dashboard="api-consumers" label={t('Consumers')} variant="link" isInline />
              </FlexItem>
              <FlexItem>
                <OpenInGrafanaButton dashboard="api-costs" label={t('Costs')} variant="link" isInline />
              </FlexItem>
              <FlexItem>
                <OpenInTempoButton label={t('Traces')} vars={{ serviceName: 'rhcl-gateway', lookback: '1h' }} variant="link" isInline />
              </FlexItem>
              <FlexItem>
                <Button variant="link" isInline component={(props) => <Link {...props} to="/monitoring/alerts" />}>
                  {t('Alertmanager')}
                </Button>
              </FlexItem>
              <FlexItem>
                <Tooltip content={t('Loki / logs deep-link requires a LokiStack; not configured on this cluster.')}>
                  <span style={{ color: SUBTLE, fontSize: 13, cursor: 'help' }}>
                    {t('Logs (Loki)')} — <NAValue reason={t('No LokiStack detected.')} />
                  </span>
                </Tooltip>
              </FlexItem>
            </Flex>
          </SectionCard>
        </GridItem>

        <GridItem lg={6}>
          <SectionCard title={t('Quick actions')} icon={<CogIcon />}>
            <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsXs' }}>
              <FlexItem>
                <Button
                  variant="link"
                  isInline
                  component={(props) => (
                    <Link {...props} to={`/k8s/ns/${namespace}/gateway.networking.k8s.io~v1~Gateway/${name}/yaml`} />
                  )}
                >
                  {t('Edit YAML')}
                </Button>
              </FlexItem>
              <FlexItem>
                <Button
                  variant="link"
                  isInline
                  component={(props) => (
                    <Link
                      {...props}
                      to={`/search/ns/${namespace}?kind=Pod&q=gateway.networking.k8s.io%2Fgateway-name%3D${encodeURIComponent(name)}`}
                    />
                  )}
                >
                  {t('View gateway pods')}
                </Button>
              </FlexItem>
              <FlexItem>
                <Button variant="link" isInline onClick={() => openDeep('routes')}>
                  {t('View routes')}
                </Button>
              </FlexItem>
              <FlexItem>
                <Button
                  variant="link"
                  isInline
                  onClick={() => {
                    setAdvancedOpen(true);
                    setTimeout(() => document.getElementById('gw-advanced')?.scrollIntoView({ behavior: 'smooth' }), 60);
                  }}
                >
                  {t('Advanced details')}
                </Button>
              </FlexItem>
            </Flex>
          </SectionCard>
        </GridItem>
      </Grid>

      {/* Deep-dive drawers (opened by the "Open …" buttons above) */}
      <div id="deepdive-policies">
        <ExpandableSection
          toggleText={t('Policies — attachment & enforcement')}
          isExpanded={openKey === 'policies'}
          onToggle={() => toggleDeep('policies')}
        >
          <PolicyAttachmentView targetKind="Gateway" targetName={name} targetNamespace={namespace} />
        </ExpandableSection>
      </div>
      <div id="deepdive-traffic">
        <ExpandableSection
          toggleText={t('Traffic — charts')}
          isExpanded={openKey === 'traffic'}
          onToggle={() => toggleDeep('traffic')}
        >
          <TrafficPanel kind="Gateway" name={name} namespace={namespace} />
        </ExpandableSection>
      </div>
      <div id="deepdive-tls">
        <ExpandableSection
          toggleText={t('TLS — certificate health')}
          isExpanded={openKey === 'tls'}
          onToggle={() => toggleDeep('tls')}
        >
          <TLSHealthCard gateway={gateway} namespace={namespace} />
        </ExpandableSection>
      </div>
      <div id="deepdive-dns">
        <ExpandableSection
          toggleText={t('DNS — records & propagation')}
          isExpanded={openKey === 'dns'}
          onToggle={() => toggleDeep('dns')}
        >
          <DNSHealthCard gatewayName={name} namespace={namespace} />
        </ExpandableSection>
      </div>
      <div id="deepdive-routes">
        <ExpandableSection
          toggleText={t('Routes — attached HTTPRoutes')}
          isExpanded={openKey === 'routes'}
          onToggle={() => toggleDeep('routes')}
        >
          <GatewayRoutesTab gatewayName={name} namespace={namespace} />
        </ExpandableSection>
      </div>

      {/* Advanced Details — K8s metadata, collapsed by default */}
      <div id="gw-advanced" style={{ marginTop: 8 }}>
        <ExpandableSection
          toggleText={t('Advanced details (Kubernetes resource)')}
          isExpanded={advancedOpen}
          onToggle={() => setAdvancedOpen((o) => !o)}
        >
          <Grid hasGutter>
            <GridItem lg={6}>
              <Card isFullHeight className="rhcl-section-card">
                <CardBody>
                  <div className="rhcl-section-title">{t('Metadata')}</div>
                  <DescriptionList isHorizontal isCompact isFluid>
                    <DescriptionListGroup>
                      <DescriptionListTerm>UID</DescriptionListTerm>
                      <DescriptionListDescription>{gateway.metadata?.uid || '—'}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>ResourceVersion</DescriptionListTerm>
                      <DescriptionListDescription>
                        {gateway.metadata?.resourceVersion || '—'}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Created')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {gateway.metadata?.creationTimestamp || '—'} ({relativeAge(gateway.metadata?.creationTimestamp)})
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Labels')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {Object.entries(gateway.metadata?.labels || {}).length === 0
                          ? '—'
                          : Object.entries(gateway.metadata?.labels || {}).map(([k, v]) => (
                              <Label key={k} isCompact style={{ margin: 2 }}>
                                {k}={v}
                              </Label>
                            ))}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Annotations')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {Object.keys(gateway.metadata?.annotations || {}).length}{' '}
                        {t('annotation(s)')}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                  </DescriptionList>
                </CardBody>
              </Card>
            </GridItem>
            <GridItem lg={6}>
              <Card isFullHeight className="rhcl-section-card">
                <CardBody>
                  <div className="rhcl-section-title">{t('Status conditions')}</div>
                  <Table aria-label={t('Status conditions')} variant="compact">
                    <Thead>
                      <Tr>
                        <Th>Type</Th>
                        <Th>{t('Status')}</Th>
                        <Th>Reason</Th>
                        <Th>Last transition</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {(gateway.status?.conditions || []).map((c) => (
                        <Tr key={c.type}>
                          <Td>{c.type}</Td>
                          <Td>
                            <Label color={c.status === 'True' ? 'green' : c.status === 'False' ? 'red' : 'grey'}>
                              {c.status}
                            </Label>
                          </Td>
                          <Td>{c.reason || '—'}</Td>
                          <Td>{relativeAge(c.lastTransitionTime)}</Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </CardBody>
              </Card>
            </GridItem>
            <GridItem lg={12}>
              <Card className="rhcl-section-card">
                <CardBody>
                  <div className="rhcl-section-title">YAML</div>
                  <CodeBlock>
                    <CodeBlockCode>{yaml.dump(gateway, { noRefs: true, lineWidth: -1 })}</CodeBlockCode>
                  </CodeBlock>
                </CardBody>
              </Card>
            </GridItem>
          </Grid>
        </ExpandableSection>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Sub-components + helpers used above
// ---------------------------------------------------------------------------

function dimSeverity(d: SecurityDimension | undefined): TopoSeverity {
  if (!d || !d.evaluated) return 'na';
  return d.severity;
}

const SEV_ORDER: TopoSeverity[] = ['critical', 'warning', 'progressing', 'info', 'healthy', 'unknown', 'na'];
function worstSeverity(list: TopoSeverity[]): TopoSeverity {
  for (const s of SEV_ORDER) {
    if (list.includes(s)) return s;
  }
  return 'na';
}

const SecurityDimLabel: React.FC<{ dim: SecurityDimension }> = ({ dim }) => {
  const { t } = useTranslation('plugin__kuadrant-console');
  if (dim.severity === 'na') {
    return (
      <Tooltip content={dim.detail}>
        <Label isCompact color="grey" icon={<InfoCircleIcon />}>
          {t('Not evaluated')}
        </Label>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={dim.detail}>
      <Label isCompact color={severityToLabelColor(dim.severity)}>
        {dim.severity === 'healthy' ? t('Healthy') : dim.severity === 'warning' ? t('Warning') : t('Critical')}
      </Label>
    </Tooltip>
  );
};

const DNSHealthSummary: React.FC<{ dim: SecurityDimension | undefined }> = ({ dim }) => {
  const { t } = useTranslation('plugin__kuadrant-console');
  if (!dim || !dim.evaluated) {
    return <div style={{ color: SUBTLE }}>{t('No DNSPolicy attached — DNS is managed outside Kuadrant.')}</div>;
  }
  return (
    <DescriptionList isHorizontal isCompact isFluid>
      <DescriptionListGroup>
        <DescriptionListTerm>{t('Status')}</DescriptionListTerm>
        <DescriptionListDescription>
          <Label color={severityToLabelColor(dim.severity === 'na' ? 'unknown' : dim.severity)}>{dim.detail}</Label>
        </DescriptionListDescription>
      </DescriptionListGroup>
      <DescriptionListGroup>
        <DescriptionListTerm>{t('Propagation')}</DescriptionListTerm>
        <DescriptionListDescription>
          <NAValue reason={t('Cross-resolver propagation requires the dns-prober companion.')} />
        </DescriptionListDescription>
      </DescriptionListGroup>
      <DescriptionListGroup>
        <DescriptionListTerm>{t('Resolver latency')}</DescriptionListTerm>
        <DescriptionListDescription>
          <NAValue reason={t('DNS latency requires the dns-prober companion.')} />
        </DescriptionListDescription>
      </DescriptionListGroup>
    </DescriptionList>
  );
};

const TLSHealthSummary: React.FC<{ dim: SecurityDimension | undefined }> = ({ dim }) => {
  const { t } = useTranslation('plugin__kuadrant-console');
  if (!dim) return <div style={{ color: SUBTLE }}>{t('No TLS information.')}</div>;
  if (!dim.evaluated) {
    return <div style={{ color: SUBTLE }}>{dim.detail}</div>;
  }
  return (
    <DescriptionList isHorizontal isCompact isFluid>
      <DescriptionListGroup>
        <DescriptionListTerm>{t('Certificate')}</DescriptionListTerm>
        <DescriptionListDescription>
          <Label color={severityToLabelColor(dim.severity === 'na' ? 'unknown' : dim.severity)}>{dim.detail}</Label>
        </DescriptionListDescription>
      </DescriptionListGroup>
      <DescriptionListGroup>
        <DescriptionListTerm>OCSP</DescriptionListTerm>
        <DescriptionListDescription>
          <NAValue reason={t('OCSP stapling is not evaluated (requires an HTTPS probe).')} />
        </DescriptionListDescription>
      </DescriptionListGroup>
      <DescriptionListGroup>
        <DescriptionListTerm>{t('TLS version')}</DescriptionListTerm>
        <DescriptionListDescription>
          <NAValue reason={t('Negotiated TLS version/cipher requires the tls-prober companion.')} />
        </DescriptionListDescription>
      </DescriptionListGroup>
    </DescriptionList>
  );
};

function groupBy<T>(arr: T[], key: (item: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    const list = map.get(k) || [];
    list.push(item);
    map.set(k, list);
  }
  return Array.from(map.entries());
}

const ALERT_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };
function sortAlerts<T extends { severity: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (ALERT_ORDER[a.severity] ?? 3) - (ALERT_ORDER[b.severity] ?? 3));
}

// Routes deep-dive — the attached-HTTPRoutes table (moved out of the old
// Routes tab). Filters HTTPRoutes by parentRefs client-side.
const GatewayRoutesTab: React.FC<{ gatewayName: string; namespace: string }> = ({ gatewayName, namespace }) => {
  const { t } = useTranslation('plugin__kuadrant-console');
  const [routes, loaded] = useK8sWatchResource<HTTPRoute[]>({ groupVersionKind: HTTPRouteGVK, isList: true });
  const filtered = React.useMemo(
    () =>
      (routes || []).filter((r) =>
        r.spec?.parentRefs?.some(
          (ref) => ref.name === gatewayName && (!ref.namespace || ref.namespace === namespace),
        ),
      ),
    [routes, gatewayName, namespace],
  );
  if (!loaded) return <Spinner size="lg" />;
  return (
    <Table aria-label={t('Routes')} variant="compact">
      <Thead>
        <Tr>
          <Th>{t('Name')}</Th>
          <Th>{t('Namespace')}</Th>
          <Th>{t('Hostnames')}</Th>
          <Th>{t('Status')}</Th>
        </Tr>
      </Thead>
      <Tbody>
        {filtered.map((route) => (
          <Tr key={route.metadata?.uid}>
            <Td>
              <Link to={`/connectivity-link/httproutes/${route.metadata?.namespace}/${route.metadata?.name}`}>
                {route.metadata?.name}
              </Link>
            </Td>
            <Td>{route.metadata?.namespace}</Td>
            <Td>{(route.spec?.hostnames || []).join(', ') || '—'}</Td>
            <Td>
              <StatusLabel conditions={route.status?.parents?.[0]?.conditions} />
            </Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
};

export default GatewayOpsDashboard;
