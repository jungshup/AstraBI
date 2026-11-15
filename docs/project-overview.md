# AstraBI Foundation v0.1

This repository provides a production-oriented monorepo foundation for AstraBI.

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

## Next steps
1. Add Prisma schema and migrations.
2. Implement auth providers and JWT flows.
3. Connect API to database and domain packages.
4. Build UI pages and admin dashboards.
5. Add CI/CD, environment config, and deployment policies.
