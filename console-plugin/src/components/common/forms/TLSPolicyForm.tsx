import * as React from 'react';
import {
  Alert,
  Content,
  FormGroup,
  FormSelect,
  FormSelectOption,
  TextInput,
} from '@patternfly/react-core';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

/**
 * TLSPolicy form — asks cert-manager to mint the certificate for a
 * Gateway's HTTPS listeners. Fields:
 *
 *   - name / namespace
 *   - target Gateway name
 *   - issuerRef: kind (Issuer namespaced / ClusterIssuer cluster-wide),
 *     name, group (always cert-manager.io)
 *
 * The form does NOT create the Issuer/ClusterIssuer — that's a
 * cluster-admin concern and depends on the CA / ACME account chosen.
 * Same "no local state, re-parse per render" pattern.
 */

type IssuerKind = 'Issuer' | 'ClusterIssuer';

interface Shape {
  apiVersion: string;
  kind: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    targetRef?: { group?: string; kind?: string; name?: string };
    issuerRef?: { group?: string; kind?: string; name?: string };
  };
}

interface FormValues {
  name: string;
  namespace: string;
  targetName: string;
  issuerKind: IssuerKind;
  issuerName: string;
}

function extractValues(obj: Shape | null): FormValues | null {
  if (!obj || typeof obj !== 'object' || obj.kind !== 'TLSPolicy') return null;
  const meta = obj.metadata || {};
  const spec = obj.spec || {};
  return {
    name: meta.name || '',
    namespace: meta.namespace || '',
    targetName: spec.targetRef?.name || '',
    issuerKind: (spec.issuerRef?.kind as IssuerKind) === 'Issuer' ? 'Issuer' : 'ClusterIssuer',
    issuerName: spec.issuerRef?.name || '',
  };
}

function toManifest(v: FormValues): Shape {
  return {
    apiVersion: 'kuadrant.io/v1',
    kind: 'TLSPolicy',
    metadata: { name: v.name, namespace: v.namespace },
    spec: {
      targetRef: {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: v.targetName,
      },
      issuerRef: {
        group: 'cert-manager.io',
        kind: v.issuerKind,
        name: v.issuerName,
      },
    },
  };
}

interface Props {
  yaml: string;
  onChange: (yaml: string) => void;
}

const TLSPolicyForm: React.FC<Props> = ({ yaml, onChange }) => {
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
            : 'The YAML shape does not match TLSPolicy. Edit in the YAML tab.'}
        </Alert>
      </div>
    );
  }
  const update = (patch: Partial<FormValues>) => {
    const next = { ...values, ...patch };
    onChange(yamlDump(toManifest(next), { lineWidth: 0, noRefs: true, sortKeys: false }));
  };
  return (
    <div style={{ padding: 8, display: 'grid', gap: 12 }}>
      <FormGroup label="Name" isRequired>
        <TextInput value={values.name} onChange={(_e, v) => update({ name: v })} />
      </FormGroup>
      <FormGroup label="Namespace" isRequired>
        <TextInput value={values.namespace} onChange={(_e, v) => update({ namespace: v })} />
      </FormGroup>

      <Content>
        <h4 style={{ margin: '4px 0' }}>Target</h4>
      </Content>
      <FormGroup label="Gateway name" isRequired>
        <TextInput
          value={values.targetName}
          onChange={(_e, v) => update({ targetName: v })}
          placeholder="rhcl-apps-gateway"
        />
      </FormGroup>

      <Content>
        <h4 style={{ margin: '4px 0' }}>cert-manager issuer</h4>
      </Content>
      <FormGroup label="Kind">
        <FormSelect
          value={values.issuerKind}
          onChange={(_e, v) => update({ issuerKind: v as IssuerKind })}
        >
          <FormSelectOption value="ClusterIssuer" label="ClusterIssuer (cluster-wide)" />
          <FormSelectOption value="Issuer" label="Issuer (this namespace)" />
        </FormSelect>
      </FormGroup>
      <FormGroup label={`${values.issuerKind} name`} isRequired>
        <TextInput
          value={values.issuerName}
          onChange={(_e, v) => update({ issuerName: v })}
          placeholder="lets-encrypt"
        />
      </FormGroup>

      <Alert variant="info" isInline title="cert-manager required">
        The referenced Issuer/ClusterIssuer must already exist. cert-manager owns issuance —
        without it installed the CR is accepted but no certificate is issued.
      </Alert>
    </div>
  );
};

export default TLSPolicyForm;
