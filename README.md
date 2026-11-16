# AstraBI Foundation v0.1

AstraBI is a modular analytics platform monorepo. The runnable foundation includes a PostgreSQL-backed API, login sessions, role-based access control, and an administrator console.

## Run with Docker

```bash
cp .env.example .env
# Change ADMIN_PASSWORD and SESSION_SECRET in .env to unique local values.
docker compose up --build
```

Open <http://localhost:3000>. The initial administrator is configured through `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Never use the example credentials outside a disposable local environment.

## Run locally

Requirements: Node.js 22+, npm 10+, and PostgreSQL 16+.

```bash
cp .env.example .env
# Set a private SESSION_SECRET (32+ bytes) and ADMIN_PASSWORD (12+ characters).
set -a && . ./.env && set +a
npm install
npm run prisma:generate
npm run db:migrate -- --name init
npm run dev
```

API endpoints are served through the web origin at `/api/v1`:
- `POST /api/v1/auth/login` — email/password login; sets an HttpOnly session cookie
- `POST /api/v1/auth/logout` and `GET /api/v1/auth/session`
- `GET /api/v1/admin/users` — administrator only
- `PATCH /api/v1/admin/users/:id` — update role (`ADMIN`, `ANALYST`, `VIEWER`) or active state; administrator only
- `GET /api/v1/admin/audit` — recent administrative audit records

## Security and scope

Passwords are stored as bcrypt hashes. Sessions are signed, expire after eight hours, and use HttpOnly/SameSite cookies; role and active status are re-read from PostgreSQL for protected requests. Login attempts are rate-limited per process. The web server proxies API calls so browsers use same-origin cookies. Production deployments must set a strong random `SESSION_SECRET`, unique administrator credentials, HTTPS, and an appropriate `WEB_ORIGIN`.

This is an initial implementation, not a security-reviewed production identity system. It does not yet include password reset, MFA, email verification, session revocation, distributed rate limiting, or account creation UI. Configure secure backups and database credentials before any non-local deployment.
