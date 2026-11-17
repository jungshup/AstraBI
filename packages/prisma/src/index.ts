import { PrismaClient } from '@prisma/client';

export type DatabaseClient = PrismaClient;

export function createDatabaseClient(databaseUrl?: string): PrismaClient {
  const url =
    databaseUrl ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/astrabi';

  return new PrismaClient({
    datasources: {
      db: { url },
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

/** Seeds demo BI data only. Administrator credentials must be provisioned separately. */
export async function seedBaseData(client: PrismaClient): Promise<void> {
  await client.featureFlag.upsert({
    where: { key: 'dashboard-v2' },
    update: {},
    create: {
      key: 'dashboard-v2',
      enabled: true,
      description: 'New dashboard experience',
    },
  });

  let dashboard = await client.dashboard.findFirst({ where: { isDefault: true } });
  if (!dashboard) {
    dashboard = await client.dashboard.create({
      data: {
        name: 'AstraBI Overview',
        description: 'Core KPI dashboard',
        isDefault: true,
        widgets: {
          create: [
            { title: 'Revenue', type: 'KPI', metric: 'totalRevenue', config: { value: 1284000, unit: 'KRW' } },
            { title: 'Active Users', type: 'KPI', metric: 'activeUsers', config: { value: 284, unit: 'users' } },
            { title: 'Conversion', type: 'KPI', metric: 'conversionRate', config: { value: 4.7, unit: '%' } },
          ],
        },
      },
    });
  }

  const reportSeeds = [
    { title: 'Sales Summary', description: 'Weekly sales summary report', status: 'published', template: 'table' },
    { title: 'User Growth', description: 'Monthly growth report', status: 'draft', template: 'chart' },
  ];
  for (const report of reportSeeds) {
    const existing = await client.report.findFirst({
      where: { title: report.title, createdBy: 'system-seed' },
    });
    if (!existing) {
      await client.report.create({
        data: { ...report, createdBy: 'system-seed' },
      });
    }
  }
}
