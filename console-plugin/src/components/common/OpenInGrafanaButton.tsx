import * as React from 'react';
import { Button, Tooltip } from '@patternfly/react-core';
import ExternalLinkAltIcon from '@patternfly/react-icons/dist/esm/icons/external-link-alt-icon';
import { useTranslation } from 'react-i18next';
import { useGrafanaLink, GrafanaDashboard, GrafanaVars } from '../../utils/grafana';

interface Props {
  dashboard: GrafanaDashboard;
  vars?: GrafanaVars;
  /** Human-friendly dashboard label, e.g. "API metrics" or "Consumers". */
  label?: string;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'link';
  isInline?: boolean;
}

/**
 * Deep-link to a RHCL Grafana dashboard, contextualised to the surrounding
 * resource (gateway / httproute / consumer). When Grafana isn't installed
 * in the cluster the button stays visible but disabled, with a tooltip
 * explaining what the user is missing — better than silently hiding it.
 */
export const OpenInGrafanaButton: React.FC<Props> = ({
  dashboard,
  vars,
  label,
  variant = 'secondary',
  isInline,
}) => {
  const { t } = useTranslation('plugin__kuadrant-console');
  const { url, loading, available } = useGrafanaLink(dashboard, vars);

  const text = label ? t('Open in Grafana: {{label}}', { label }) : t('Open in Grafana');

  if (!available) {
    return (
      <Tooltip
        content={t(
          'Grafana is not installed on this cluster. Apply tests/req041/manifests/ to enable.',
        )}
      >
        <Button
          variant={variant}
          isDisabled
          isAriaDisabled
          isInline={isInline}
          icon={<ExternalLinkAltIcon />}
          iconPosition="end"
        >
          {text}
        </Button>
      </Tooltip>
    );
  }

  return (
    <Button
      variant={variant}
      component="a"
      href={url ?? '#'}
      target="_blank"
      rel="noopener noreferrer"
      isInline={isInline}
      isLoading={loading}
      icon={<ExternalLinkAltIcon />}
      iconPosition="end"
    >
      {text}
    </Button>
  );
};
