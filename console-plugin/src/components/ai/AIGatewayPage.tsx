import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  PageSection,
  Title,
  Breadcrumb,
  BreadcrumbItem,
  Grid,
  GridItem,
  Gallery,
  Label,
  Progress,
  ProgressSize,
  ProgressMeasureLocation,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  Spinner,
  Bullseye,
} from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import {
  BoltIcon,
  ShieldAltIcon,
  ChartLineIcon,
  ExclamationTriangleIcon,
  UsersIcon,
  WalletIcon,
  RobotIcon,
  CubesIcon,
  PlayIcon,
} from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { KpiCard, RadialRing, Sparkline } from '../common/kpi';
import { SectionCard, MetricGrid, Metric, SUBTLE, SUCCESS, WARNING, DANGER } from '../common/dashboardCards';
import StatusLabel from '../common/StatusLabel';
import { OpenInGrafanaButton } from '../common/OpenInGrafanaButton';
import { useAiTokenGovernance } from '../../hooks/useAiTokenGovernance';
import { useCostByConsumer } from '../../hooks/useCostByConsumer';
import AiChatPlayground from './AiChatPlayground';
import { policyResourceURL } from '../../models';
import '../../styles/plugin-glass.css';

const tierColor: Record<string, 'yellow' | 'grey' | 'orange' | 'blue' | 'red' | 'green'> = {
  gold: 'yellow',
  silver: 'grey',
  bronze: 'orange',
  anonymous: 'blue',
  unknown: 'red',
};

function budgetColor(pct: number): string {
  if (pct >= 90) return DANGER;
  if (pct >= 70) return WARNING;
  return SUCCESS;
}

const AIGatewayPage: React.FC = () => {
  const { t } = useTranslation('plugin__kuadrant-console');
  const gov = useAiTokenGovernance();
  const cost = useCostByConsumer();

  const p = gov.primary;
  const activeConsumers = cost.rows.filter((r) => r.calls > 0);
  const namedActive = activeConsumers.filter((r) => r.tier !== 'anonymous' && r.tier !== 'unknown');

  if (!gov.loaded && gov.policies.length === 0) {
    return (
      <div className="rhcl-plugin-root">
        <PageSection isFilled>
          <Bullseye>
            <Spinner size="xl" />
          </Bullseye>
        </PageSection>
      </div>
    );
  }

  return (
    <div className="rhcl-plugin-root">
      <PageSection variant="default">
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to="/connectivity-link">{t('Connectivity Link')}</Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{t('AI Gateway')}</BreadcrumbItem>
        </Breadcrumb>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Title headingLevel="h1">
            <RobotIcon /> {t('AI Gateway')}
          </Title>
          {p ? (
            <StatusLabel
              severity={p.enforced ? 'healthy' : 'warning'}
              label={p.enforced ? t('Token governance enforced') : t('Token governance not enforced')}
            />
          ) : (
            <Label color="grey">{t('No TokenRateLimitPolicy')}</Label>
          )}
        </div>
        {p && (
          <div style={{ marginTop: 10, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: SUBTLE }}>
              {t('Governed route')}:{' '}
              <Link to={`/connectivity-link/httproutes/${p.routeNamespace}/${p.routeName}`} style={{ fontWeight: 600 }}>
                {p.routeName}
              </Link>
            </span>
            <span style={{ fontSize: 12, color: SUBTLE }}>
              {t('AI surface')}: <code>{p.pathHint || '/api/v1/chat/completions'}</code>
            </span>
            <span style={{ fontSize: 12, color: SUBTLE }}>
              {t('Budget')}:{' '}
              <span style={{ color: 'var(--pf-t--global--text--color--regular)', fontWeight: 600 }}>
                {p.limit} tok / {p.window}
              </span>
            </span>
          </div>
        )}
      </PageSection>

      <PageSection>
        {/* KPI row */}
        <Gallery hasGutter minWidths={{ default: '200px' }} style={{ marginBottom: 16 }}>
          <KpiCard
            variant="tokens"
            icon={<BoltIcon />}
            label={t('Token rate')}
            value={gov.tokensPerMin != null ? `${Math.round(gov.tokensPerMin)}/min` : '…'}
            subtitle={t('tokens/min (5m avg)')}
            sparkline={gov.tokensSeries}
          />
          <KpiCard
            variant="security"
            icon={<ShieldAltIcon />}
            label={t('Token budget')}
            value={
              <RadialRing
                value={gov.budgetPct ?? 0}
                size={76}
                stroke={8}
                color={gov.budgetPct != null ? budgetColor(gov.budgetPct) : SUBTLE}
                label={<span style={{ fontSize: 20, fontWeight: 800 }}>{gov.budgetPct != null ? `${Math.round(gov.budgetPct)}%` : '—'}</span>}
              />
            }
            subtitle={p ? t('{{used}}/{{lim}} tok/min', { used: Math.round(gov.tokensPerMin ?? 0), lim: Math.round(p.limitPerMin) }) : t('no budget set')}
          />
          <KpiCard
            variant="requests"
            icon={<ChartLineIcon />}
            label={t('AI requests')}
            value={gov.reqPerMin != null ? `${Math.round(gov.reqPerMin)}/min` : '…'}
            subtitle={t('on the governed route')}
            sparkline={gov.reqSeries}
          />
          <KpiCard
            variant="errors"
            icon={<ExclamationTriangleIcon />}
            label={t('Throttled')}
            value={gov.throttledPerMin != null ? `${Math.round(gov.throttledPerMin)}/min` : '…'}
            subtitle={t('429 — over token budget')}
          />
          <KpiCard
            variant="consumer"
            icon={<UsersIcon />}
            label={t('Consumers')}
            value={cost.loaded ? activeConsumers.length : '…'}
            subtitle={t('{{n}} identified', { n: namedActive.length })}
          />
          <KpiCard
            variant="cost"
            icon={<WalletIcon />}
            label={t('Cost (24h)')}
            value={cost.hasPricing ? `${cost.totals.cost.toFixed(2)} ${cost.currency}` : 'N/A'}
            subtitle={t('calls + tokens · per tier')}
          />
        </Gallery>

        <Grid hasGutter style={{ marginBottom: 16 }}>
          <GridItem lg={6}>
            <SectionCard
              title={t('Token governance')}
              icon={<ShieldAltIcon />}
              action={
                p ? (
                  <Link to={policyResourceURL('TokenRateLimitPolicy', p.namespace, p.name)} style={{ fontSize: 12 }}>
                    {t('Open policy')}
                  </Link>
                ) : undefined
              }
            >
              {!p ? (
                <EmptyState headingLevel="h4" titleText={t('No TokenRateLimitPolicy')}>
                  <EmptyStateBody>
                    {t('Deploy a TokenRateLimitPolicy (kuadrant.io/v1alpha1) targeting your AI route to meter tokens. See tests/req060.')}
                  </EmptyStateBody>
                </EmptyState>
              ) : (
                <>
                  <DescriptionList isHorizontal isCompact isFluid>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Policy')}</DescriptionListTerm>
                      <DescriptionListDescription><code>{p.name}</code></DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Budget')}</DescriptionListTerm>
                      <DescriptionListDescription>{p.limit} tokens / {p.window}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Applies to')}</DescriptionListTerm>
                      <DescriptionListDescription><code>{p.pathHint || '/api/v1/chat/completions'}</code></DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Enforcement')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        <StatusLabel severity={p.enforced ? 'healthy' : 'warning'} label={p.enforced ? t('Enforced') : t('Not enforced')} />
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                  </DescriptionList>
                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: SUBTLE, marginBottom: 4 }}>
                      <span>{t('Consumed vs budget (per min)')}</span>
                      <span>{Math.round(gov.tokensPerMin ?? 0)} / {Math.round(p.limitPerMin)}</span>
                    </div>
                    <Progress
                      value={gov.budgetPct ?? 0}
                      measureLocation={ProgressMeasureLocation.none}
                      size={ProgressSize.lg}
                      aria-label={t('Token budget usage')}
                    />
                  </div>
                </>
              )}
            </SectionCard>
          </GridItem>

          <GridItem lg={6}>
            <SectionCard
              title={t('Consumers')}
              icon={<UsersIcon />}
              action={<OpenInGrafanaButton dashboard="api-consumers" label={t('Consumers')} variant="link" isInline />}
            >
              {!cost.loaded ? (
                <Spinner size="md" />
              ) : activeConsumers.length === 0 ? (
                <div style={{ color: SUBTLE }}>{t('No consumer traffic in the period.')}</div>
              ) : (
                <Table aria-label={t('Consumers')} variant="compact">
                  <Thead>
                    <Tr>
                      <Th>{t('Consumer')}</Th>
                      <Th>{t('Tier')}</Th>
                      <Th>{t('Requests (24h)')}</Th>
                      {cost.hasPricing && <Th>{t('Cost')}</Th>}
                    </Tr>
                  </Thead>
                  <Tbody>
                    {activeConsumers.slice(0, 8).map((r) => (
                      <Tr key={r.consumerId}>
                        <Td>{r.consumerId}</Td>
                        <Td>
                          <Label isCompact color={tierColor[r.tier] || 'grey'}>
                            {r.tier}
                          </Label>
                        </Td>
                        <Td>{r.calls.toLocaleString()}</Td>
                        {cost.hasPricing && <Td>{r.cost != null ? `${r.cost.toFixed(2)} ${cost.currency}` : '—'}</Td>}
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
              <div style={{ marginTop: 10, fontSize: 11, color: SUBTLE }}>
                {t('Per-consumer requests are real (istio x-consumer-id). Per-consumer token split is not shown — the app reports token usage globally as "anonymous".')}
              </div>
            </SectionCard>
          </GridItem>

          <GridItem lg={12}>
            <SectionCard title={t('Token throughput')} icon={<BoltIcon />}>
              <MetricGrid>
                <Metric label={t('Tokens / min')} value={gov.tokensPerMin != null ? Math.round(gov.tokensPerMin) : '—'} />
                <Metric label={t('Budget / min')} value={p ? Math.round(p.limitPerMin) : '—'} />
                <Metric label={t('Budget used')} value={gov.budgetPct != null ? `${Math.round(gov.budgetPct)}%` : '—'} />
                <Metric label={t('Throttled / min')} value={gov.throttledPerMin != null ? Math.round(gov.throttledPerMin) : '—'} />
                <Metric label={t('Per-model split')} value={null} na={t('The mock surface reports a single model; per-model metrics are not emitted.')} />
              </MetricGrid>
              {gov.tokensSeries.length > 1 && (
                <div className="rhcl-kpi--tokens" style={{ marginTop: 14 }}>
                  <Sparkline data={gov.tokensSeries} height={90} />
                  <div style={{ fontSize: 11, color: SUBTLE, marginTop: 4, textAlign: 'center' }}>
                    {t('tokens/min · last hour')}
                  </div>
                </div>
              )}
            </SectionCard>
          </GridItem>
        </Grid>

        <Grid hasGutter style={{ marginBottom: 16 }}>
          <GridItem lg={12}>
            <SectionCard title={t('Try it — live chat completion')} icon={<PlayIcon />}>
              <AiChatPlayground />
            </SectionCard>
          </GridItem>
        </Grid>

        <Grid hasGutter>
          <GridItem lg={12}>
            <SectionCard title={t('Explore in Grafana')} icon={<CubesIcon />}>
              <Flex spaceItems={{ default: 'spaceItemsMd' }} flexWrap={{ default: 'wrap' }}>
                <FlexItem><OpenInGrafanaButton dashboard="api-costs" label={t('AI costs')} variant="secondary" /></FlexItem>
                <FlexItem><OpenInGrafanaButton dashboard="api-consumers" label={t('Consumers')} variant="secondary" /></FlexItem>
                <FlexItem><OpenInGrafanaButton dashboard="limitador" label={t('Limitador')} variant="secondary" /></FlexItem>
              </Flex>
            </SectionCard>
          </GridItem>
        </Grid>
      </PageSection>
    </div>
  );
};

export default AIGatewayPage;
