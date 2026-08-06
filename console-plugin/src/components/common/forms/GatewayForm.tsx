import * as React from 'react';
import {
  Alert,
  Button,
  Content,
  FormGroup,
  FormSelect,
  FormSelectOption,
  TextInput,
} from '@patternfly/react-core';
import { MinusCircleIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

/**
 * Gateway form — one card per listener since that's the shape operators
 * think in when publishing multiple hosts on the same gateway. Fields:
 *
 *   - name / namespace
 *   - gatewayClassName (istio / envoy-gateway / other)
 *   - listeners[]: name, hostname, port, protocol (HTTP / HTTPS / TLS),
 *     certificateRefs[0].name for HTTPS, allowedRoutes.namespaces.from
 *
 * We only expose the *first* certificateRef per HTTPS listener — the CR
 * accepts more, but 1 cert per listener covers 95% of the customer
 * cases and keeps the form manageable. YAML tab is the escape hatch
 * for multi-cert setups.
 */

type Protocol = 'HTTP' | 'HTTPS' | 'TLS';
type AllowedFrom = 'All' | 'Same' | 'Selector';

interface Listener {
  name: string;
  hostname: string;
  port: number;
  protocol: Protocol;
  certificateRefName: string;
  allowedFrom: AllowedFrom;
}

interface ListenerShape {
  name?: string;
  hostname?: string;
  port?: number;
  protocol?: string;
  allowedRoutes?: { namespaces?: { from?: string } };
  tls?: {
    mode?: string;
    certificateRefs?: Array<{ name?: string; kind?: string }>;
  };
}

interface Shape {
  apiVersion: string;
  kind: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    gatewayClassName?: string;
    listeners?: ListenerShape[];
  };
}

interface FormValues {
  name: string;
  namespace: string;
  gatewayClassName: string;
  listeners: Listener[];
}

function defaultListener(): Listener {
  return {
    name: 'http',
    hostname: '',
    port: 80,
    protocol: 'HTTP',
    certificateRefName: '',
    allowedFrom: 'All',
  };
}

function extractValues(obj: Shape | null): FormValues | null {
  if (!obj || typeof obj !== 'object' || obj.kind !== 'Gateway') return null;
  const meta = obj.metadata || {};
  const spec = obj.spec || {};
  const listeners: Listener[] = (spec.listeners || []).map((l) => {
    const cert = l.tls?.certificateRefs?.[0]?.name || '';
    const proto = (l.protocol as Protocol) || 'HTTP';
    return {
      name: l.name || 'http',
      hostname: l.hostname || '',
      port: l.port ?? (proto === 'HTTPS' ? 443 : 80),
      protocol: (['HTTP', 'HTTPS', 'TLS'].includes(proto) ? proto : 'HTTP') as Protocol,
      certificateRefName: cert,
      allowedFrom: (l.allowedRoutes?.namespaces?.from as AllowedFrom) || 'All',
    };
  });
  return {
    name: meta.name || '',
    namespace: meta.namespace || '',
    gatewayClassName: spec.gatewayClassName || 'istio',
    listeners: listeners.length > 0 ? listeners : [defaultListener()],
  };
}

function toManifest(v: FormValues): Shape {
  return {
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'Gateway',
    metadata: { name: v.name, namespace: v.namespace },
    spec: {
      gatewayClassName: v.gatewayClassName,
      listeners: v.listeners.map((l) => {
        const base: ListenerShape = {
          name: l.name,
          port: l.port,
          protocol: l.protocol,
          allowedRoutes: { namespaces: { from: l.allowedFrom } },
        };
        // hostname is optional at the CRD level — leaving it undefined
        // makes the listener a wildcard. Emit only when the operator
        // typed something.
        if (l.hostname.trim()) base.hostname = l.hostname.trim();
        if (l.protocol === 'HTTPS' && l.certificateRefName.trim()) {
          base.tls = {
            mode: 'Terminate',
            certificateRefs: [{ name: l.certificateRefName.trim() }],
          };
        }
        return base;
      }),
    },
  };
}

interface Props {
  yaml: string;
  onChange: (yaml: string) => void;
}

const GatewayForm: React.FC<Props> = ({ yaml, onChange }) => {
  let parsed: Shape | null = null;
  let parseError: string | null = null;
  try {
    parsed = yamlLoad(yaml) as Shape;
  } catch (e) {
    parseError = (e as Error).message;
  }
  const values = extractValues(parsed);
  if (!values) {
    return (
      <div style={{ padding: 8 }}>
        <Alert variant="warning" isInline title="Cannot render form">
          {parseError
            ? `YAML failed to parse: ${parseError}.`
            : 'The YAML shape does not match Gateway. Edit in the YAML tab.'}
        </Alert>
      </div>
    );
  }
  const update = (patch: Partial<FormValues>) => {
    const next = { ...values, ...patch };
    onChange(yamlDump(toManifest(next), { lineWidth: 0, noRefs: true, sortKeys: false }));
  };
  const updateListener = (i: number, patch: Partial<Listener>) => {
    const next = [...values.listeners];
    // Keep the port in sync with a protocol switch — the operator's
    // rarely changing that intentionally, and 80/443 mismatches are the
    // most common "why isn't traffic reaching the gateway" gotcha.
    const merged = { ...next[i], ...patch };
    if (patch.protocol && !patch.port) {
      if (patch.protocol === 'HTTPS' && next[i].port === 80) merged.port = 443;
      if (patch.protocol === 'HTTP' && next[i].port === 443) merged.port = 80;
    }
    next[i] = merged;
    update({ listeners: next });
  };
  const addListener = () =>
    update({
      listeners: [
        ...values.listeners,
        {
          name: `https-${values.listeners.length + 1}`,
          hostname: '',
          port: 443,
          protocol: 'HTTPS',
          certificateRefName: '',
          allowedFrom: 'All',
        },
      ],
    });
  const removeListener = (i: number) => {
    if (values.listeners.length <= 1) {
      update({ listeners: [defaultListener()] });
      return;
    }
    update({ listeners: values.listeners.filter((_, j) => j !== i) });
  };
  return (
    <div style={{ padding: 8, display: 'grid', gap: 12 }}>
      <FormGroup label="Name" isRequired>
        <TextInput value={values.name} onChange={(_e, v) => update({ name: v })} />
      </FormGroup>
      <FormGroup label="Namespace" isRequired>
        <TextInput value={values.namespace} onChange={(_e, v) => update({ namespace: v })} />
      </FormGroup>
      <FormGroup label="Gateway class">
        <FormSelect
          value={values.gatewayClassName}
          onChange={(_e, v) => update({ gatewayClassName: v })}
        >
          <FormSelectOption value="istio" label="istio (RHCL / Kuadrant default)" />
          <FormSelectOption value="envoy-gateway" label="envoy-gateway" />
          <FormSelectOption value="custom" label="custom (type in YAML)" />
        </FormSelect>
      </FormGroup>

      <Content>
        <h4 style={{ margin: '4px 0' }}>Listeners</h4>
      </Content>
      <div style={{ display: 'grid', gap: 12 }}>
        {values.listeners.map((l, i) => (
          <div
            key={i}
            style={{
              border: '1px solid var(--pf-t--global--border--color--default)',
              borderRadius: 6,
              padding: 12,
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Listener {i + 1}</strong>
              <Button
                variant="plain"
                aria-label="Remove listener"
                onClick={() => removeListener(i)}
                isDisabled={values.listeners.length === 1 && !l.hostname && !l.certificateRefName}
              >
                <MinusCircleIcon />
              </Button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <FormGroup label="Name">
                <TextInput
                  value={l.name}
                  onChange={(_e, v) => updateListener(i, { name: v })}
                />
              </FormGroup>
              <FormGroup label="Protocol">
                <FormSelect
                  value={l.protocol}
                  onChange={(_e, v) => updateListener(i, { protocol: v as Protocol })}
                >
                  <FormSelectOption value="HTTP" label="HTTP" />
                  <FormSelectOption value="HTTPS" label="HTTPS" />
                  <FormSelectOption value="TLS" label="TLS (passthrough)" />
                </FormSelect>
              </FormGroup>
              <FormGroup label="Hostname (blank = wildcard)">
                <TextInput
                  value={l.hostname}
                  onChange={(_e, v) => updateListener(i, { hostname: v })}
                  placeholder="banking-api.example.com"
                />
              </FormGroup>
              <FormGroup label="Port">
                <TextInput
                  type="number"
                  value={l.port}
                  onChange={(_e, v) => updateListener(i, { port: Number(v) || 0 })}
                />
              </FormGroup>
            </div>
            {l.protocol === 'HTTPS' && (
              <FormGroup label="Certificate Secret (certificateRefs[0].name)">
                <TextInput
                  value={l.certificateRefName}
                  onChange={(_e, v) => updateListener(i, { certificateRefName: v })}
                  placeholder="banking-api-tls"
                />
              </FormGroup>
            )}
            <FormGroup label="Allow routes from">
              <FormSelect
                value={l.allowedFrom}
                onChange={(_e, v) => updateListener(i, { allowedFrom: v as AllowedFrom })}
              >
                <FormSelectOption value="All" label="All namespaces" />
                <FormSelectOption value="Same" label="Same namespace only" />
                <FormSelectOption value="Selector" label="Selector (edit in YAML)" />
              </FormSelect>
            </FormGroup>
          </div>
        ))}
        <div>
          <Button variant="link" icon={<PlusCircleIcon />} isInline onClick={addListener}>
            Add listener
          </Button>
        </div>
      </div>
    </div>
  );
};

export default GatewayForm;
