# AstraBI Foundation

AstraBI is a modular analytics platform foundation. The current vertical
slice includes a PostgreSQL-backed API, tenant-scoped administrator user
management, bearer-token sessions, CSV and PostgreSQL snapshot datasets with
scheduled refresh, a bounded analytics query engine, dashboard panels, a
browser client, and a Helm chart.

## Quick start

Requirements: Node.js 22, npm, and Docker Compose.

See [Development, testing, and deployment](docs/testing.md) for running the
local stack, creating the initial administrator, executing tests, and setting
production configuration.

## Repository layout

- `apps/api` — HTTP API, authentication, connectors, queries, and dashboards
- `apps/web` — browser application for administration and analytics
- `packages/*` — shared domain and infrastructure packages
- `infra/helm/astrabi` — Kubernetes deployment chart for the API and web app

The API exposes `/healthz` for liveness and `/readyz` for database readiness.
User, connector, and CSV import management require an administrator session.
Queries and dashboards are tenant-scoped to the verified session. PostgreSQL
SQL connections are allowlisted and TLS-only; analytics SQL runs against
selected datasets in an isolated, memory-limited DuckDB instance.
PostgreSQL datasets are copied into platform snapshots and can be manually or
automatically refreshed; scheduling is disabled by default.
