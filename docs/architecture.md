# Architecture

Kuadrant Console is an **OpenShift Console dynamic plugin** — a React/TypeScript
bundle that the Console loads at runtime via Webpack module federation. It has
**no backend and no service-account of its own**. Every read is the signed-in
user's own API call, proxied by the Console. The plugin's whole job is to turn
Kuadrant's raw Kubernetes objects into *opinionated*, role-aware views.

```
┌─────────────────────── OpenShift Console (host) ───────────────────────┐
│                                                                        │
│   nav + routes ◄── console-extensions.json                             │
│                                                                        │
│   ┌───────────── Kuadrant Console plugin (federated bundle) ────────┐  │
│   │  Pages (components/*)  ──feeds──  Hooks (hooks/*)               │  │
│   └────────────────────────────────────┬───────────────────────────┘  │
│                                         │ user's bearer token           │
│         ┌───────────────┬───────────────┼─────────────────┐            │
│         ▼               ▼               ▼                 ▼            │
│   Kubernetes API   Prometheus     Console proxy      cert-manager /     │
│   (watch CRs)      (/api/prometheus) aliases         DNS CRs            │
└────────┬───────────────┬───────────────┬─────────────────┬────────────┘
         │               │               │                 │
   Gateway API +    thanos-querier   in-cluster svc     Certificate /
   Kuadrant CRDs    (traffic/tokens) (playgrounds)      DNSRecord status
```

## The data planes

Everything the UI shows comes from one of four sources — all through the
Console, all with the user's identity.

### 1. Kubernetes API — live-watched CRs

The primary source. Pages use the SDK's `useK8sWatchResource` /
`useK8sWatchResources` to watch Gateway API and Kuadrant CRDs and re-render on
change (websocket, no polling). GVKs live in `src/models/`, typed shapes in
`src/types/`. Watched kinds include: `Gateway`, `HTTPRoute`, `GRPCRoute`,
`Service`, `EndpointSlice`, `AuthPolicy`, `RateLimitPolicy`,
`TokenRateLimitPolicy`, `DNSPolicy`, `TLSPolicy`, `DNSRecord`, `Certificate`,
and the MCP `mcp.kuadrant.io` kinds.

> Note: on cluster 4.21 a single-resource watch can return `undefined`
> indefinitely; the plugin uses **list-then-find** in a few detail pages to work
> around it. See `GatewayDetailPage` for the canonical pattern.

### 2. Prometheus — traffic & token metrics

Traffic (req/s, status-code mix, p50/p95/p99) and AI token metrics are queried
against the platform `thanos-querier` through
`/api/prometheus/api/v1/query(_range)`. These are **polled**, via
`usePollingEffect`, which pauses when the browser tab is hidden — so metric
panels are blank in a backgrounded tab and populate in a focused one. Range
queries back the sparklines (`usePrometheusRange`).

### 3. Console proxy aliases — interactive playgrounds

The **AI Gateway chat playground** and **MCP try-it** POST to in-cluster
services. The Console requires HTTPS for plugin proxy targets, so those calls go
through `ConsolePlugin` `spec.proxy` aliases (e.g. `ai-chat`, `mcp-broker`).
The read-only dashboards never need these.

### 4. cert-manager / DNS CRs — reliability signals

TLS health (issuer, expiry with 14-day warning / 3-day critical, chain) reads
`Certificate` status; DNS health reads `DNSRecord` / `DNSPolicy` status. An
optional companion **dns-prober** service can add live resolver / HTTPS-handshake
probes when configured.

## Real-only, honest gaps

The plugin's credibility rule: **every value is derived from live state, and
anything that can't be measured is shown as a greyed "N/A" — never faked, never
counted against a health score.** For example, the Gateway **security score** is
a transparent weighted formula over real signals (auth / rate-limit / TLS / DNS
/ reconciliation); WAF and security headers are *displayed* but excluded from the
denominator because they aren't measurable here. This is what keeps the console
trustworthy to a technical audience.

## RBAC model

- The plugin ships **no token** (NFR-001); it renders for whoever is signed in.
- Reads that fail on RBAC produce **explanatory empty states** ("you need `list`
  on gateways in this namespace"), not 403 toasts.
- Action buttons are **disabled with a tooltip** when the user lacks the verb.
- `useResourceWithRBAC` centralizes the "can-i + watch" pattern.

## Component & hook map

Pages live in `src/components/<area>/`; each is fed by hooks in `src/hooks/`.

| Area | Key pages | Feeding hooks |
|---|---|---|
| **overview** | `OverviewPage` (environment health, needs-attention, traffic) | `useEnvironmentHealth`, `useNeedsAttention`, `useOverviewTraffic`, `useRecentEvents` |
| **gateways** | `GatewayListPage`, `GatewayDetailPage` (ops dashboard), `GatewayTopologyFlow` | `useGatewayOperationalData`, `useGatewayPodHealth`, `useGatewayBackendHealth`, `useCertificatesForGateway`, `useDNSRecordsForGateway`, `useGatewaySecurityScore` |
| **httproutes / grpcroutes** | list + detail, backends & security tabs | `useBackendsStatus`, `useBackendHealth`, `useBackendTraffic`, `useRouteTraffic` |
| **policies** | list + per-kind detail (Auth/RateLimit/TokenRateLimit/DNS/TLS) | `useAttachedPolicies`, `usePolicyImpactRows`, `useDiscoveredPolicyCRDs`, `utils/policyMerge` (effective stack) |
| **api-products / api-keys / plans** | business-friendly API surface, no YAML | resource watches + APIKey Secret reads |
| **ai** | `AIGatewayPage` (token governance lens), `AiChatPlayground` | `useAiTokenGovernance`, `useCostByConsumer` |
| **mcp** | `MCPServersListPage`, `MCPServerDetailPage`, `MCPPlayground`, `AddMCPGatewayWizard` | `useMcpBrokerCatalog` |
| **dns / tls** | Overview + Troubleshooting | `useCertificatesForGateway`, `useDNSRecordsForGateway`, `useServiceProbe`, `useProbeHistory` |
| **cost** | `CostMonitoringPage` | `useCostByConsumer` |
| **common** | shared building blocks | `common/kpi` (KpiCard, RadialRing, Delta, Sparkline), `common/dashboardCards` (SectionCard, MetricGrid, N/A cell), `common/ObservabilityMenu` |

Cross-cutting: `usePollingEffect` (visibility-aware polling), `useAvailableNamespaces`,
`useResourceWithRBAC`, `usePrometheusTraffic` / `usePrometheusRange` (PromQL builders in `src/utils/`).

## Source layout

```
console-plugin/
├── console-extensions.json   # nav items + page routes the Console mounts
├── package.json              # consolePlugin.exposedModules (federated entry points)
└── src/
    ├── components/<area>/     # page + shared UI components
    ├── hooks/                 # data hooks (watch + Prometheus + derivations)
    ├── models/                # K8s GVK constants for every watched CRD
    ├── types/                 # TS interfaces for Gateway API + Kuadrant CRDs
    └── utils/                 # policy merge, hostname helpers, PromQL builders
```

New pages are registered in two places that must agree: the
`consolePlugin.exposedModules` map in `package.json` (the federated module) and
the `console-extensions.json` entry (the nav item + route).
