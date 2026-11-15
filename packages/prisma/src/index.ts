import { PrismaClient } from '@prisma/client';

export type DatabaseClient = PrismaClient;

export function createDatabaseClient(databaseUrl?: string): PrismaClient {
  const url = databaseUrl ?? process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/astrabi';

  return new PrismaClient({
    datasources: {
      db: {
        url,
      },
    },
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export async function ensureDatabaseConnected(client: PrismaClient): Promise<boolean> {
  try {
    await client.$connect();
    return true;
  } catch (error) {
    console.warn('Database unavailable during startup:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function seedBaseData(client: PrismaClient): Promise<void> {
  const existing = await client.user.findFirst({
    where: { email: 'admin@astrabi.local' },
  });

  if (!existing) {
    await client.user.create({
      data: {
        email: 'admin@astrabi.local',
        name: 'Platform Admin',
        role: 'admin',
      },
    });
  }
}
