import * as React from 'react';
import { Card, CardBody, Flex, FlexItem, Tooltip } from '@patternfly/react-core';
import { ArrowUpIcon, ArrowDownIcon, InfoCircleIcon } from '@patternfly/react-icons';
// Reuse the cost dashboard's KPI/sparkline/section styling so both pages
// share one visual language. Importing from the cost folder is a slight
// layering quirk (common → feature), but it keeps a single source of truth
// for the `.rhcl-kpi-*` / `.rhcl-sparkline-*` classes and their accents —
// see the accent-variant + `.rhcl-plugin-root` override blocks in that file.
import '../cost/cost-monitoring.css';

/**
 * Shared hero-KPI primitives — extracted verbatim from CostMonitoringPage so
 * the Gateway Operations Dashboard can reuse the exact same glass tiles,
 * radial ring, trend chip and sparkline. The `variant` drives the accent
 * palette purely through the `.rhcl-kpi--<variant>` CSS class.
 */
export type KpiVariant =
  // cost page
  | 'cost'
  | 'requests'
  | 'tokens'
  | 'consumer'
  | 'budget'
  // gateway ops dashboard
  | 'listeners'
  | 'routes'
  | 'backends'
  | 'policies'
  | 'traffic'
  | 'errors'
  | 'security';

/** ↑ +12.6% in red (cost up) / ↓ -3.2% in green (cost down). */
export const Delta: React.FC<{ pct: number | null; invert?: boolean; suffix?: string }> = ({
  pct,
  invert,
  suffix,
}) => {
  if (pct == null) return <span style={{ color: 'var(--rhcl-text-subtle)' }}>—</span>;
  const rounded = Math.round(pct * 10) / 10;
  const up = rounded > 0;
  const down = rounded < 0;
  const positive = invert ? up : down;
  const color = positive
    ? 'var(--pf-t--global--color--status--success--default)'
    : up || down
    ? 'var(--pf-t--global--color--status--danger--default)'
    : 'var(--rhcl-text-subtle)';
  return (
    <span style={{ color, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {up ? <ArrowUpIcon /> : down ? <ArrowDownIcon /> : null}
      {' '}
      {`${up ? '+' : ''}${rounded.toFixed(1)}%${suffix ? ` ${suffix}` : ''}`}
    </span>
  );
};

/**
 * Sparkline with filled area + last-point highlight. The line + fill
 * inherit `--rhcl-accent-from` from the parent KPI variant, and the
 * trailing dot picks up the same colour at a touch higher opacity so
 * the eye lands on "this is where the period ends".
 */
export const Sparkline: React.FC<{ data: number[]; height?: number }> = ({ data, height = 36 }) => {
  if (data.length < 2) return <div style={{ height }} />;
  const w = 100;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = Math.max(max - min, 1);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = height - ((v - min) / range) * (height - 6) - 3;
    return [x, y] as [number, number];
  });
  // Smooth path via Catmull-Rom-ish quadratic — interpolates each
  // segment using the midpoint between consecutive points so the line
  // reads as a curve without overshooting like a cubic Bezier.
  const path = (() => {
    if (pts.length === 0) return '';
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const mx = (x0 + x1) / 2;
      d += ` Q ${x0.toFixed(1)} ${y0.toFixed(1)}, ${mx.toFixed(1)} ${((y0 + y1) / 2).toFixed(1)}`;
      d += ` T ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    return d;
  })();
  const fillPath = `${path} L ${w} ${height} L 0 ${height} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}
      aria-hidden="true"
    >
      <path className="rhcl-sparkline-fill" d={fillPath} />
      <path className="rhcl-sparkline-stroke" d={path} />
      <circle cx={last[0]} cy={last[1]} r={2.5} className="rhcl-sparkline-tip" />
    </svg>
  );
};

/** SVG donut with N segments + centre label. Keeps zero dependencies. */
export const Donut: React.FC<{
  segments: { label: string; value: number; color: string }[];
  size?: number;
  stroke?: number;
  centerTop?: React.ReactNode;
  centerBottom?: React.ReactNode;
}> = ({ segments, size = 160, stroke = 22, centerTop, centerBottom }) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, d) => s + d.value, 0) || 1;
  let offset = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={stroke}
        />
        {segments.map((s) => {
          const len = (s.value / total) * c;
          const seg = (
            <circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${c}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            />
          );
          offset += len;
          return seg;
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          textAlign: 'center',
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--pf-t--global--text--color--regular)' }}>
            {centerTop}
          </div>
          {centerBottom && (
            <div style={{ fontSize: 11, color: 'var(--rhcl-text-subtle)' }}>
              {centerBottom}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** Radial progress ring (used by the Budget card and the Security score KPI). */
export const RadialRing: React.FC<{
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  label?: React.ReactNode;
}> = ({ value, size = 140, stroke = 12, color = 'var(--pf-t--global--color--status--success--default)', label }) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const off = c - (pct / 100) * c;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={off}
          style={{ transition: 'stroke-dashoffset .6s cubic-bezier(.2,.7,.3,1)' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        {label}
      </div>
    </div>
  );
};

/** Hero KPI card — variant drives the accent palette via CSS. */
export const KpiCard: React.FC<{
  variant: KpiVariant;
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  subtitle?: React.ReactNode;
  delta?: React.ReactNode;
  sparkline?: number[];
  tooltip?: string;
}> = ({ variant, icon, label, value, subtitle, delta, sparkline, tooltip }) => (
  <Card isCompact isPlain className={`rhcl-kpi-card rhcl-kpi--${variant}`}>
    <CardBody>
      <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
        <FlexItem>
          <div className="rhcl-icon-badge">{icon}</div>
        </FlexItem>
        <FlexItem>
          <div className="rhcl-kpi-label">
            {label}
            {tooltip && (
              <Tooltip content={tooltip}>
                <InfoCircleIcon style={{ marginLeft: 4, verticalAlign: 'middle', opacity: 0.6 }} />
              </Tooltip>
            )}
          </div>
        </FlexItem>
      </Flex>
      <div className="rhcl-kpi-value">{value}</div>
      {delta && <div style={{ marginTop: 4 }}>{delta}</div>}
      {subtitle && <div className="rhcl-kpi-subtitle">{subtitle}</div>}
      {sparkline && sparkline.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Sparkline data={sparkline} />
        </div>
      )}
    </CardBody>
  </Card>
);
