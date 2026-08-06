# Contributing

Thanks for helping shape Kuadrant Console. This guide gets you running locally
and lays out the conventions that keep the plugin coherent.

## Local development

You need two terminals — one for the plugin dev server, one for a local
OpenShift Console that loads it.

**Terminal 1 — plugin dev server**

```bash
cd console-plugin
npm install
npm run start          # webpack-dev-server on http://localhost:9001
```

**Terminal 2 — local OpenShift Console pointed at your cluster**

```bash
oc login <cluster-api-url>
cd console-plugin
./start-console.sh     # runs the Console container (Podman/Docker), loading the plugin
```

Open <http://localhost:9000>. The script reads the cluster endpoint and token
from your current `oc` session — log in first.

## Scripts

| Command | What it does |
|---|---|
| `npm run start` | Dev server with hot reload (port 9001) |
| `npm run build` | Production build → `dist/` |
| `npm run build-dev` | Dev build (source maps, no minification) |
| `npm test` | Jest + React Testing Library |
| `npm run lint` | ESLint with `--fix` (zero warnings allowed) |
| `npm run i18n` | Runs i18next-parser — **see the i18n note below before relying on it** |

## Conventions

**Real-only, honest gaps.** Never invent or estimate a value to fill a cell. If
a signal can't be measured (no Prometheus, no companion probe, no such label),
render the greyed **N/A** cell from `common/dashboardCards` — and never let it
affect a health/score number. This rule is the product's credibility; hold it.

**RBAC-aware, always.** A read that can fail on permissions gets an explanatory
empty state ("you need `list` on X"), not a 403 toast. An action the user can't
perform is a disabled control with a tooltip, not a button that errors. Reuse
`useResourceWithRBAC`.

**Registering a page takes two edits that must agree.** Add the federated module
to `consolePlugin.exposedModules` in `package.json` **and** the nav item / route
to `console-extensions.json`. A page in one but not the other silently fails to
mount.

**i18n — hand-merge new strings.** Every user-facing string goes through
`t('…')` in the `plugin__kuadrant-console` namespace. New keys must be added
to `locales/en/plugin__kuadrant-console.json` **by hand** — do not rely on
`npm run i18n` to sync them (the parser has mangled/zeroed existing keys in the
past). Missing keys show up as raw key strings in the browser.

**UI.** PatternFly 6 components and design tokens only; match the surrounding
dark-console surface. Data-dense screens are *information design* — surface the
summary before the detail, encode state in form (pill / chip / severity dot),
and give sparklines the same care as the type.

**TypeScript.** Strict mode; no `any` escape hatches in new code. Shared K8s
shapes live in `src/types/`, GVKs in `src/models/`.

## Opening a change

1. Branch from the default branch.
2. Keep the change focused; run `npm run lint` and `npm test` before pushing.
3. **Cite the requirement.** This repo is spec-driven — reference the relevant
   `FR-xxx` / `NFR-xxx` from [`SPECIFICATION.md`](../SPECIFICATION.md) in the PR
   description (and add one if you're introducing new behavior).
4. Include a screenshot for any visual change.
5. Keep it region-agnostic: no customer names, private domains, or
   environment-specific hostnames in code, docs or examples — use
   `example.com` and generic placeholders.

## Companion service (dns-prober)

The optional `dns-prober/` is a small Quarkus service (package
`io.gatewaysmashes.dnsprober`) that serves live DNS-resolver and HTTPS-handshake
probes for the DNS/TLS Troubleshooting pages. It's independent of the plugin;
build and deploy it only if you want those live-probe panels.
