import { PrismaClient } from '@prisma/client';
export { PrismaClient };
export type { Prisma, UserRole } from '@prisma/client';

export type PrismaDatasource = {
  provider: 'postgresql' | 'sqlite' | 'mysql';
  url: string;
};

export function getPrismaDatasource(url: string): PrismaDatasource {
  return {
    provider: 'postgresql',
    url,
  };
}

export const prismaModuleName = 'prisma';

const globalPrisma = globalThis as typeof globalThis & { astrabiPrisma?: PrismaClient };

export const prisma = globalPrisma.astrabiPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalPrisma.astrabiPrisma = prisma;
}
