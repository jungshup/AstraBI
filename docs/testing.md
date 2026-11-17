# API and Prisma integration tests

The API integration tests use a real PostgreSQL database and are skipped unless `ASTRABI_TEST_DATABASE_URL` is set. Use a disposable test database only; the test suite creates seed records and temporary users.

Example setup with a local PostgreSQL server:

```bash
createdb astrabi_test
export ASTRABI_TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/astrabi_test'
npx prisma db push --schema packages/prisma/schema.prisma
npm run prisma:generate
npm run test --workspace @astrabi/api
```

Do not point `ASTRABI_TEST_DATABASE_URL` at production or a database containing valuable data. `prisma db push` is shown only for initializing this disposable test database; production schema changes must use reviewed migrations.
