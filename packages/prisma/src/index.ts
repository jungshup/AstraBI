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
