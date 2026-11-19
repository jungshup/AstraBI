import { z } from 'zod';
import { normalizePostgresHost } from './connectors.js';
import { createServer } from './server.js';
import { prisma } from '@astrabi/prisma';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  ASTRABI_DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  ASTRABI_POSTGRES_HOST_ALLOWLIST: z.string().default('')
    .transform((value) => value.split(',').map(normalizePostgresHost).filter(Boolean)),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
});

const config = configSchema.parse(process.env);
const app = await createServer({ prisma, config });

try {
  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info(`AstraBI API listening on port ${config.PORT}`);
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await prisma.$disconnect();
  });
}
