import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { K8sCondition } from './common';

/**
 * MCP resources — `mcp.kuadrant.io/v1`, from the official Kuadrant MCP Gateway
 * (github.com/Kuadrant/mcp-gateway; Technology Preview, shipped with RHCL 1.4.x).
 *
 * Schema mirrors the authoritative CRD reference docs, NOT any third-party
 * workshop. Notable facts verified against the real CRDs:
 *   - The current served/storage API version is **v1** (v1alpha1 is legacy and
 *     being migrated — see the repo's migrating-mcpgatewayextension guide).
 *   - `MCPServerRegistration.spec.targetRef` points at an **HTTPRoute**.
 *   - The tool prefix field is `prefix` only (there is no `toolPrefix`).
 *   - **`MCPServerRegistrationStatus` carries only `conditions`** — there is no
 *     `discoveredTools` on the CR. The federated tool list lives in the broker's
 *     aggregated config and is obtained by calling the broker (`tools/list`),
 *     which is the Phase 2 playground — not readable from this resource.
 *   - `MCPGatewayExtension.spec.targetRef` points at a **Gateway listener**
 *     (`sectionName` required); OAuth protected-resource metadata is configured
 *     here (`oauthProtectedResource`) and enforced by a Kuadrant AuthPolicy.
 *
 * Every field is optional so a partial or differently-versioned CR never throws.
 */

/** Reference to the HTTPRoute that reaches a backend MCP server. */
export interface MCPTargetReference {
  group?: string; // default gateway.networking.k8s.io
  kind?: string; // default HTTPRoute
  name?: string;
  namespace?: string;
}

export interface MCPServerRegistration extends K8sResourceCommon {
  spec?: {
    /** The HTTPRoute that reaches the backend MCP server. */
    targetRef?: MCPTargetReference;
    /** Prefix added to every federated tool (`^[a-z0-9][a-z0-9_]*$`, immutable). */
    prefix?: string;
    /** Path the broker calls on the backend server. Default `/mcp`. */
    path?: string;
    /** `Enabled` (default) | `Disabled` — Disabled removes the server's tools. */
    state?: 'Enabled' | 'Disabled';
    /** Short description surfaced to agents by the broker's `discover_tools`. */
    hint?: string;
    /** Categories for `discover_tools` filtering (default `["uncategorised"]`). */
    category?: string[];
    /** Free-form labels for `list_tags` / `filter_tools_by_tags`. */
    tags?: string[];
    /** `Enabled` fetches tools per-user (prefix then required). Default `Disabled`. */
    userSpecificList?: 'Enabled' | 'Disabled';
  };
  status?: {
    // Authoritative status is conditions-only (Ready). No discoveredTools here.
    conditions?: K8sCondition[];
  };
}

export interface MCPGatewayExtension extends K8sResourceCommon {
  spec?: {
    /** The Gateway listener to extend with MCP support (`sectionName` required). */
    targetRef?: MCPTargetReference & { sectionName?: string };
    publicHost?: string;
    privateHost?: string;
    /** `Enabled` (default) lets the operator create/manage the /mcp HTTPRoute. */
    httpRouteManagement?: 'Enabled' | 'Disabled';
    backendPingIntervalSeconds?: number;
    /** OAuth protected-resource metadata served at /.well-known/oauth-protected-resource. */
    oauthProtectedResource?: {
      authorizationServers?: string[];
      resourceName?: string;
      resource?: string;
      scopesSupported?: string[];
      bearerMethodsSupported?: string[];
    };
  };
  status?: { conditions?: K8sCondition[] };
}

export interface MCPVirtualServer extends K8sResourceCommon {
  spec?: {
    description?: string;
    /** Curated set of already-prefixed tool names (e.g. `weather_forecast`). Required, ≥1. */
    tools?: string[];
    /** Optional curated prompt names; when omitted all prompts are exposed. */
    prompts?: string[];
  };
  status?: { conditions?: K8sCondition[] };
}

/** The tool prefix the broker publishes a server's tools under. */
export function mcpPrefix(reg: MCPServerRegistration): string {
  return reg.spec?.prefix || '';
}

/**
 * Readiness from `status.conditions[Ready]` (the only status the CRD reports):
 * Ready=True → Ready; Ready=False → Not ready; no Ready condition → Pending.
 */
export function mcpReadiness(
  res: { status?: { conditions?: K8sCondition[] } },
): { label: string; color: 'green' | 'red' | 'blue' } {
  const conds = res.status?.conditions || [];
  const ready = conds.find((c) => c.type === 'Ready');
  if (ready?.status === 'True') return { label: 'Ready', color: 'green' };
  if (ready) return { label: 'Not ready', color: 'red' };
  return { label: 'Pending', color: 'blue' };
}
