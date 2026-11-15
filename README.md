# AstraBI Foundation v0.1

AstraBI is a modular analytics platform foundation designed as a monorepo with shared packages and application services.

## Included modules
- CoreModule
- Prisma
- Auth
- User
- RBAC
- Audit
- Security
- FeatureFlag
- Branding
- DynamicConfig
- Experiment

## Architecture
- `apps/api` — backend API service
- `apps/web` — frontend web app shell
- `packages/*` — reusable domain modules
- `infra/docker` — container runtime setup
- `infra/helm` — Kubernetes deployment chart

## Getting started

```bash
npm install
npm run build
npm run dev
```

## Notes
This scaffold is intentionally minimal and production-ready as a foundation for extension, not a full application buildout.
