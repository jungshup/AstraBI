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

export async function seedBaseData(client: PrismaClient): Promise<void> {
  const adminUser = await client.user.findFirst({
    where: { email: 'admin@astrabi.local' },
  });

  if (!adminUser) {
    await client.user.create({
      data: {
        email: 'admin@astrabi.local',
        name: 'Platform Admin',
        role: 'ADMIN',
        passwordHash: '$2a$12$u6vZ0C0WBP3gNn0xw/1hROxH9m7I1QDFLeD9zPc0Kf7K0wL3mB6Ce',
      },
    });
  }

  const featureFlag = await client.featureFlag.findFirst({
    where: { key: 'dashboard-v2' },
  });

  if (!featureFlag) {
    await client.featureFlag.create({
      data: {
        key: 'dashboard-v2',
        enabled: true,
        description: 'New dashboard experience',
      },
    });
  }

  const defaultDashboard = await client.dashboard.findFirst({
    where: { isDefault: true },
  });

  if (!defaultDashboard) {
    const dashboard = await client.dashboard.create({
      data: {
        name: 'AstraBI Overview',
        description: 'Core KPI dashboard',
        isDefault: true,
        widgets: {
          create: [
            {
              title: 'Revenue',
              type: 'KPI',
              metric: 'totalRevenue',
              config: { value: 1284000, unit: 'KRW' },
            },
            {
              title: 'Active Users',
              type: 'KPI',
              metric: 'activeUsers',
              config: { value: 284, unit: 'users' },
            },
            {
              title: 'Conversion',
              type: 'KPI',
              metric: 'conversionRate',
              config: { value: 4.7, unit: '%' },
            },
          ],
        },
      },
    });

    await client.report.create({
      data: {
        title: 'Sales Summary',
        description: 'Weekly sales summary report',
        status: 'published',
        template: 'table',
        createdBy: 'admin@astrabi.local',
      },
    });

    await client.report.create({
      data: {
        title: 'User Growth',
        description: 'Monthly growth report',
        status: 'draft',
        template: 'chart',
        createdBy: 'admin@astrabi.local',
      },
    });

    console.info(`Seeded dashboard ${dashboard.id}`);
  }
}
