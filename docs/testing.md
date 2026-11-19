# Development, testing, and deployment

## Local development with Docker Compose

The Compose stack runs PostgreSQL 16, the API, and the web application. The
database uses a named volume and the API waits for PostgreSQL readiness.
Compose credentials and the JWT key are for local development only.

```powershell
docker compose up --build -d
docker compose run --rm api npm run prisma:migrate
$env:ASTRABI_BOOTSTRAP_TENANT_ID = '00000000-0000-4000-8000-000000000001'
$env:ASTRABI_BOOTSTRAP_TENANT_NAME = 'AstraBI'
$env:ASTRABI_BOOTSTRAP_ADMIN_EMAIL = 'admin@example.local'
$env:ASTRABI_BOOTSTRAP_ADMIN_PASSWORD = 'replace-this-local-password'
docker compose run --rm api npm run seed --workspace @astrabi/api
```

Open `http://localhost:3000`, then sign in with the tenant ID and bootstrap
administrator credentials. The API is available at `http://localhost:4000`.
Set a unique password before running the seed command.

## Test and lint

Node.js 22 and npm are required. The tests use a PostgreSQL database and should
run against an isolated test database because migrations change its schema.
Create a test database in the local Compose PostgreSQL service with:

```powershell
docker compose up -d postgres
docker compose exec postgres createdb -U astrabi astrabi_test
$env:DATABASE_URL = 'postgresql://astrabi:local-dev-only@localhost:5432/astrabi_test'
$env:ASTRABI_TEST_DATABASE_URL = $env:DATABASE_URL
npm install
npm run prisma:validate
npm run prisma:generate
npm run prisma:migrate
npm run build
npm run test --workspace @astrabi/api
npm run lint
```

The API integration tests are skipped when `ASTRABI_TEST_DATABASE_URL` is
unset. They exercise login and role enforcement, CSV import, visual and SQL
queries, dashboard panels, tenant isolation, credential encryption, audit
events, expired JWT rejection, and revocation of disabled-account sessions.

## CI

GitHub Actions starts PostgreSQL 16, sets both database URL variables, validates
and generates the Prisma client, initializes the schema, builds, runs API
integration tests, and lints the workspaces.

## Runtime configuration

The API requires `DATABASE_URL` and a `JWT_SECRET` with at least 32 characters.
It also requires `ASTRABI_DATA_ENCRYPTION_KEY`, a stable 64-character hex key
used to encrypt PostgreSQL connector credentials. Generate a production key with
`openssl rand -hex 32`, store it in a secret manager, and back it up securely;
changing it without re-encrypting stored sources makes those connections
unavailable. The local Compose key is only a development placeholder.
`PORT` defaults to 4000 and `WEB_ORIGIN` defaults to `http://localhost:3000`.
The web server uses `ASTRABI_API_URL`, defaulting to `http://localhost:4000`.
Use an externally reachable API URL for the browser in production and configure
`WEB_ORIGIN` to the exact web origin.

PostgreSQL connectors require TLS and an exact host entry in the comma-separated
`ASTRABI_POSTGRES_HOST_ALLOWLIST`; it is empty by default. Allow only trusted
database hosts and use a database account with read-only privileges. Imported
CSV files are limited to 10 MB, 25,000 rows, and 100 columns. Analytics queries
run against an isolated in-memory DuckDB instance, can reference only selected
tenant datasets, and are limited to one `SELECT`, 10 seconds, and 1,000 result
rows. Use generated `ds_<dataset UUID without hyphens>` table names and `c0`,
`c1`, etc. column keys in SQL. Visual queries currently target one dataset; SQL
may join up to five selected datasets. SQL must begin with `SELECT`; CTEs are
not supported yet.

To provision the first administrator, set `ASTRABI_BOOTSTRAP_TENANT_ID`,
`ASTRABI_BOOTSTRAP_TENANT_NAME`, `ASTRABI_BOOTSTRAP_ADMIN_EMAIL`, and
`ASTRABI_BOOTSTRAP_ADMIN_PASSWORD`, then run:

```bash
npm run seed --workspace @astrabi/api
```

The Helm chart deploys the API and web app. Create the Kubernetes Secret named
`astrabi-secrets` (or configure another name in chart values) with keys
`DATABASE_URL`, `JWT_SECRET`, and `ASTRABI_DATA_ENCRYPTION_KEY`. Configure
`postgresHostAllowlist` for the exact approved PostgreSQL hosts and configure
`webOrigin` to the deployed web origin, set `web.apiUrl` to the
browser-reachable API URL, and expose both ClusterIP services through your
ingress. TLS termination and ingress policy are deployment-specific. Apply
database changes with `npm run prisma:migrate` as a release step before rolling
out API replicas; the initial schema is versioned under
`packages/prisma/migrations`.

## Security notes

The login endpoint is rate-limited, password hashes use bcrypt, and bearer
tokens are backed by revocable database sessions. Never use the committed
Compose values or CI secrets in a real deployment. Provide secrets through a
secret manager, use TLS at the ingress, and rotate the JWT signing key through
an operational key-rotation procedure before production use. Passwords must be
at least 12 characters and no more than 72 UTF-8 bytes (bcrypt's input limit).
