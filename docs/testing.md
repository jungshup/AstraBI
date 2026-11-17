# API and Prisma integration tests

Integration tests use a real PostgreSQL database and are skipped unless `ASTRABI_TEST_DATABASE_URL` is set. Use a disposable test database only; the suite creates temporary users and audit records.

Example setup with a local PostgreSQL server:

```bash
createdb astrabi_test
export ASTRABI_TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/astrabi_test'
npx prisma db push --schema packages/prisma/schema.prisma
npm run prisma:generate
npm run test --workspace @astrabi/api
```

The suite verifies:
- Prisma connectivity and idempotent seed data.
- Login success, bad password, unknown user, and malformed credentials.
- Admin-only user routes and role-change authorization, including protection against self-demotion.
- Audit log creation after administrator role changes.
- Expired JWT rejection and invalidation of sessions for deactivated users.

Do not point `ASTRABI_TEST_DATABASE_URL` at production or a database containing valuable data. `prisma db push` is only for initializing this disposable test database; production schema changes must use reviewed migrations.
