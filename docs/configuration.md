# Configuration

Everything below is **optional and runtime** — driven by a ConfigMap the plugin
watches, so nothing here needs a rebuild. Missing keys fall back to sensible
defaults; missing targets render as disabled buttons with a tooltip, never as
errors.

## Runtime ConfigMap

Create `kuadrant-console-config` in the plugin namespace. The plugin watches
it live; after editing, restart the pod to pick changes up immediately:

```bash
oc -n kuadrant-console rollout restart deploy/kuadrant-console
```

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kuadrant-console-config
  namespace: kuadrant-console
data:
  # --- Grafana ("Open in Grafana" deep links) --------------------------------
  grafanaNamespace: monitoring
  grafanaRouteName: grafana
  grafanaDashboardPrefix: rhcl-        # leave default unless the dashboards were renamed

  # --- Tempo ("View trace" deep links) ---------------------------------------
  tempoNamespace: tempo
  tempoGatewayRouteName: tempo-tempo-rhcl-gateway
  tempoStackName: tempo-rhcl

  # --- Optional sidebar links (set the URL to show the item; omit to hide) ---
  developerPortalUrl: https://developer-portal.example.com
  internalDeveloperHubUrl: https://developer-hub.example.com
```

| Key | Default | Effect |
|---|---|---|
| `grafanaNamespace` / `grafanaRouteName` | `rhcl-grafana` / `rhcl-grafana-route` | Where the "Open in Grafana" links resolve. Discover with `oc get route -A \| grep -i grafana`. |
| `grafanaDashboardPrefix` | `rhcl-` | Prefix of the imported dashboard slugs the deep links target. |
| `tempoNamespace` / `tempoGatewayRouteName` / `tempoStackName` | `tempo` / `tempo-tempo-rhcl-gateway` / `tempo-rhcl` | Where the "View trace" links resolve. |
| `developerPortalUrl` | *(unset)* | When set, adds a **Developer Portal** sidebar item that opens the URL in a new tab. |
| `internalDeveloperHubUrl` | *(unset)* | When set, adds an **Internal Developer Hub** sidebar item. |

Setting `developerPortalUrl` / `internalDeveloperHubUrl` is what toggles the
corresponding sidebar feature flags — there is nothing else to enable.

## API-key Secrets (subscribers)

The **API Keys** page and each API Product's detail page read Kuadrant api-key
Secrets directly from the cluster. Create one per subscriber to populate them.
The label key must match the target AuthPolicy's `apiKey.selector.matchLabels`.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: myapp-api-key-alice
  namespace: myapp
  labels:
    kuadrant.io/apikeys-by: api-key     # must match the AuthPolicy selector
    app: myapp-api
  annotations:
    secret.kuadrant.io/user-id: alice
    secret.kuadrant.io/plan-id: gold    # drives the plan-cards UI
stringData:
  api_key: <a-strong-random-value>
type: Opaque
```

Paired with `APIKey` CRs, the API Keys page also exposes **approve / reject**
actions. The activation signal the plugin honors is the Authorino
`managed-by` label on the Secret (the fast, actually-reconciled signal), not
the approval CR alone.

## Proxy aliases (interactive playgrounds)

The in-console **AI Gateway chat playground** and **MCP try-it** reach their
backends through Console plugin proxy aliases declared on the `ConsolePlugin`
CR (the Console requires HTTPS for proxy targets). These are only needed for
the interactive playgrounds; the read-only dashboards work without them. See
each feature's setup notes for the exact `spec.proxy` entries.
