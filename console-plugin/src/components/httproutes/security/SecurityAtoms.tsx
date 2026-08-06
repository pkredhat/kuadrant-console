import * as React from 'react';
import { Label, Icon, Tooltip } from '@patternfly/react-core';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ExclamationCircleIcon,
  QuestionCircleIcon,
  MinusCircleIcon,
  ShieldAltIcon,
} from '@patternfly/react-icons';
import {
  CheckState,
  RouteSecurityPosture,
  SecurityFeatureStatus,
} from './routeSecurityTypes';

/**
 * Atomic status widgets shared by the HTTPRoute security cards, checks
 * table, and posture badge. Kept centralized so a11y (icon + text, never
 * color alone) is enforced consistently.
 */

// PatternFly 5 Label supports these color tokens for status meaning.
// We map "warning" → 'orange' because there is no 'gold' in the type.
export const POSTURE_COPY: Record<RouteSecurityPosture, { label: string; color: 'green' | 'orange' | 'red' | 'grey' }> = {
  secure: { label: 'Secure', color: 'green' },
  'needs-attention': { label: 'Needs Attention', color: 'orange' },
  'at-risk': { label: 'At Risk', color: 'red' },
  'not-configured': { label: 'Not Configured', color: 'grey' },
  unknown: { label: 'Unknown', color: 'grey' },
};

export const SecurityPostureBadge: React.FC<{
  posture: RouteSecurityPosture;
  reason?: string;
}> = ({ posture, reason }) => {
  const { label, color } = POSTURE_COPY[posture];
  const chip = (
    <Label color={color} icon={<ShieldAltIcon />}>
      {label}
    </Label>
  );
  return reason ? <Tooltip content={reason}>{chip}</Tooltip> : chip;
};

export const FEATURE_ICONS: Record<SecurityFeatureStatus, React.ReactNode> = {
  enabled: (
    <Icon status="success"><CheckCircleIcon /></Icon>
  ),
  warning: (
    <Icon status="warning"><ExclamationTriangleIcon /></Icon>
  ),
  failed: (
    <Icon status="danger"><ExclamationCircleIcon /></Icon>
  ),
  'not-configured': (
    <Icon status="info"><MinusCircleIcon /></Icon>
  ),
  overridden: (
    <Icon status="warning"><ExclamationTriangleIcon /></Icon>
  ),
  unknown: (
    <Icon><QuestionCircleIcon /></Icon>
  ),
};

export const FeatureStatusLabel: React.FC<{
  status: SecurityFeatureStatus;
  label: string;
}> = ({ status, label }) => {
  const color: 'green' | 'orange' | 'red' | 'grey' =
    status === 'enabled'
      ? 'green'
      : status === 'warning' || status === 'overridden'
      ? 'orange'
      : status === 'failed'
      ? 'red'
      : status === 'not-configured'
      ? 'grey'
      : 'grey';
  return (
    <Label color={color} icon={FEATURE_ICONS[status]}>
      {label}
    </Label>
  );
};

export const CHECK_ICONS: Record<CheckState, React.ReactNode> = {
  passed: <Icon status="success"><CheckCircleIcon /></Icon>,
  warning: <Icon status="warning"><ExclamationTriangleIcon /></Icon>,
  failed: <Icon status="danger"><ExclamationCircleIcon /></Icon>,
  skipped: <Icon status="info"><MinusCircleIcon /></Icon>,
  unknown: <Icon><QuestionCircleIcon /></Icon>,
};

export const CheckStatusLabel: React.FC<{ status: CheckState }> = ({ status }) => {
  const color: 'green' | 'orange' | 'red' | 'grey' | 'blue' =
    status === 'passed'
      ? 'green'
      : status === 'warning'
      ? 'orange'
      : status === 'failed'
      ? 'red'
      : status === 'skipped'
      ? 'blue'
      : 'grey';
  const label =
    status === 'passed'
      ? 'Passed'
      : status === 'warning'
      ? 'Warning'
      : status === 'failed'
      ? 'Failed'
      : status === 'skipped'
      ? 'Skipped'
      : 'Unknown';
  return (
    <Label color={color} icon={CHECK_ICONS[status]}>
      {label}
    </Label>
  );
};
