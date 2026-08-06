import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Dropdown,
  DropdownList,
  DropdownItem,
  MenuToggle,
  MenuToggleElement,
  Divider,
} from '@patternfly/react-core';
import { ChartLineIcon, BellIcon, ExternalLinkAltIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { useGrafanaLink, GrafanaDashboard, GrafanaVars, GrafanaLink } from '../../utils/grafana';
import { useTempoLink, TempoSearchVars } from '../../utils/tempo';

/**
 * Reusable "Observability ▾" menu — one consistent home for a resource's
 * Grafana + Tempo deep-links + the console alerting page, used across the
 * Gateway, HTTPRoute, API Product and MCP Server detail pages so every
 * operational view surfaces observability the same way.
 *
 * Rules-of-hooks note: the five RHCL dashboards are a fixed set, so all five
 * `useGrafanaLink` hooks are called unconditionally every render; callers just
 * choose which to *render* via `dashboards` and pass the context `grafanaVars`
 * (a Grafana template var the dashboard doesn't use is a harmless no-op).
 * Unavailable stacks render disabled (the hooks report `available:false`).
 */

export interface ObservabilityMenuProps {
  /** Grafana template vars applied to every dashboard link (gateway/httproute/…). */
  grafanaVars?: GrafanaVars;
  /** Which dashboards to show, in order. Defaults to all five. */
  dashboards?: GrafanaDashboard[];
  /** Per-dashboard label overrides. */
  labels?: Partial<Record<GrafanaDashboard, string>>;
  /** Trace-explorer context. Omit to hide the "Trace explorer" item. */
  tempoVars?: TempoSearchVars;
  /** Link to the console Observe → Alerting page. Default true. */
  showAlerts?: boolean;
  toggleVariant?: 'primary' | 'secondary';
}

const DEFAULT_LABELS: Record<GrafanaDashboard, string> = {
  'api-overview': 'Traffic dashboard',
  'api-consumers': 'Consumer dashboard',
  authorino: 'Authorino',
  limitador: 'Limitador',
  'api-costs': 'Costs',
};

export const ObservabilityMenu: React.FC<ObservabilityMenuProps> = ({
  grafanaVars,
  dashboards = ['api-overview', 'api-consumers', 'authorino', 'limitador', 'api-costs'],
  labels,
  tempoVars,
  showAlerts = true,
  toggleVariant = 'secondary',
}) => {
  const { t } = useTranslation('plugin__kuadrant-console');
  const [open, setOpen] = React.useState(false);

  // Fixed set of hooks — never conditional, never in a loop over props.
  const links: Record<GrafanaDashboard, GrafanaLink> = {
    'api-overview': useGrafanaLink('api-overview', grafanaVars),
    'api-consumers': useGrafanaLink('api-consumers', grafanaVars),
    authorino: useGrafanaLink('authorino', grafanaVars),
    limitador: useGrafanaLink('limitador', grafanaVars),
    'api-costs': useGrafanaLink('api-costs', grafanaVars),
  };
  const traces = useTempoLink(tempoVars || {});

  const labelFor = (d: GrafanaDashboard) => labels?.[d] || t(DEFAULT_LABELS[d]);

  return (
    <Dropdown
      isOpen={open}
      onSelect={() => setOpen(false)}
      onOpenChange={(o) => setOpen(o)}
      toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
        <MenuToggle
          ref={toggleRef}
          variant={toggleVariant}
          icon={<ChartLineIcon />}
          isExpanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {t('Observability')}
        </MenuToggle>
      )}
    >
      <DropdownList>
        {dashboards.map((d) =>
          links[d].available ? (
            // Open via window.open, NOT a `component="a"` DropdownItem: PF v6's
            // DropdownItem swallows the anchor click (only the react-router
            // <Link> items navigated), so the Grafana deep-links never opened.
            <DropdownItem
              key={d}
              icon={<ExternalLinkAltIcon />}
              onClick={() => window.open(links[d].url ?? '#', '_blank', 'noopener,noreferrer')}
            >
              {labelFor(d)}
            </DropdownItem>
          ) : (
            <DropdownItem key={d} isDisabled isAriaDisabled icon={<ExternalLinkAltIcon />}>
              {labelFor(d)} — {t('unavailable')}
            </DropdownItem>
          ),
        )}
        {tempoVars &&
          (traces.available ? (
            <React.Fragment key="traces-frag">
              <Divider component="li" />
              <DropdownItem
                key="traces"
                icon={<ChartLineIcon />}
                component={(props) => <Link {...props} to={traces.url ?? '#'} />}
              >
                {t('Trace explorer')}
              </DropdownItem>
            </React.Fragment>
          ) : (
            <React.Fragment key="traces-frag">
              <Divider component="li" />
              <DropdownItem key="traces" isDisabled isAriaDisabled icon={<ChartLineIcon />}>
                {t('Trace explorer')} — {t('unavailable')}
              </DropdownItem>
            </React.Fragment>
          ))}
        {showAlerts && (
          <DropdownItem
            key="alerts"
            icon={<BellIcon />}
            component={(props) => <Link {...props} to="/monitoring/alerts" />}
          >
            {t('Alerts')}
          </DropdownItem>
        )}
      </DropdownList>
    </Dropdown>
  );
};

export default ObservabilityMenu;
