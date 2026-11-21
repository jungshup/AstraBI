# AstraBI Foundation v0.1

This repository provides a modular monorepo foundation for AstraBI.

## Included areas
- Core platform contracts and utilities
- Prisma data access layer
- Authentication and session support
- User management
- RBAC and access policies
- Audit log abstraction
- Security helpers
- Feature flag support
- Brand and UI configuration
- Dynamic configuration
- Experiment configuration
- Docker and Helm deployment skeletons

## Monorepo layout

```text
AstraBI/
├── apps/
│   ├── api/
│   └── web/
├── packages/
│   ├── core/
│   ├── prisma/
│   ├── auth/
│   ├── user/
│   ├── rbac/
│   ├── audit/
│   ├── security/
│   ├── feature-flags/
│   ├── branding/
│   ├── dynamic-config/
│   └── experiment/
├── infra/
│   ├── docker/
│   └── helm/
├── README.md
├── package.json
├── tsconfig.base.json
├── tsconfig.json
├── docker-compose.yml
└── .gitignore
```

## Current functionality
- PostgreSQL-backed tenant, user, session, and audit-log models
- Tenant-scoped login, administrator user creation, role changes, and account disabling
- Revocable JWT sessions, rate-limited login, and role-based API access
- Browser UI for administrator sign-in and user management
- Tenant-scoped PostgreSQL and CSV snapshot datasets with scheduled refresh
- Visual query builder and single-statement, selected-dataset SQL editor
- Persisted dashboards with table, number, bar, line, and area panels
- Accessible chart tooltips, keyboard navigation, and dashboard cross-filtering
- PostgreSQL-backed CI integration tests and Helm deployments for API and web

Background refreshes for external data sources and chart zoom remain future
work. See
[testing and deployment](testing.md) for configuration and operational
guidance.
