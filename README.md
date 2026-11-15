# AstraBI Foundation v0.1

AstraBI is a modular analytics platform monorepo. The first runnable milestone provides a small HTTP API and a Korean-language status dashboard.

## Requirements
- Node.js 22 or later
- npm 10 or later
- Docker Compose (optional)

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The API listens on <http://localhost:4000>.

Useful endpoints:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/api/v1/status
```

Build and test:

```bash
npm run build
npm test
```

Run with Docker Compose:

```bash
docker compose up --build
```

## Current scope and security

This is the first executable vertical slice, not a production-ready analytics application. It has no database persistence, user login, tenant isolation, or authorization yet. Do not expose it publicly or use it for sensitive data. The existing domain packages are scaffolding and are not yet wired into runtime requests.

## Monorepo areas
- `apps/api` — HTTP API and health/status endpoints
- `apps/web` — status dashboard
- `packages/*` — domain module foundations (Core, Prisma, Auth, User, RBAC, Audit, Security, Feature Flags, Branding, Dynamic Config, Experiments)
- `infra/helm` — Helm chart foundation
