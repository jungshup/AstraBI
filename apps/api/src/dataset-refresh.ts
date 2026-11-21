import { Client } from 'pg';
import { z } from 'zod';
import {
  decryptPostgresConnectorConfig,
  maxPostgresDatasetColumns,
  maxPostgresDatasetRows,
  normalizePostgresHost,
  readPostgresTableSnapshot,
  type PostgresTableSnapshot,
} from './connectors.js';
import type { PrismaClient } from '@astrabi/prisma';
import { prisma as defaultPrisma } from '@astrabi/prisma';

const refreshIntervalSchema = z.number().int().refine(
  (value) => [15, 60, 360, 1440].includes(value),
);
const datasetColumnsSchema = z.array(z.object({
  key: z.string(),
  name: z.string(),
  type: z.enum(['STRING', 'NUMBER', 'DATE', 'BOOLEAN']),
}));
const refreshLockId = '7429197812031';
const refreshBatchSize = 10;
const refreshRetryDelayMs = 5 * 60 * 1000;
const schedulerIntervalMs = 60 * 1000;

export interface DatasetRefreshConfig {
  DATABASE_URL: string;
  ASTRABI_DATA_ENCRYPTION_KEY: string;
  ASTRABI_POSTGRES_HOST_ALLOWLIST: string[];
}

export class DatasetRefreshError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type PostgresSnapshotReader = (
  config: Parameters<typeof readPostgresTableSnapshot>[0],
  schema: string,
  table: string,
) => Promise<PostgresTableSnapshot>;

export async function setDatasetRefreshInterval(
  database: PrismaClient,
  tenantId: string,
  datasetId: string,
  intervalMinutes: number | null,
): Promise<void> {
  if (intervalMinutes !== null && !refreshIntervalSchema.safeParse(intervalMinutes).success) {
    throw new DatasetRefreshError('invalid_refresh_interval');
  }
  const dataset = await database.dataSet.findFirst({
    where: { id: datasetId, tenantId, dataSource: { kind: 'POSTGRES' } },
    select: { id: true },
  });
  if (!dataset) throw new DatasetRefreshError('dataset_not_found');

  const now = new Date();
  await database.dataSet.update({
    where: { id: datasetId },
    data: {
      refreshIntervalMinutes: intervalMinutes,
      nextRefreshAt: intervalMinutes === null
        ? null
        : new Date(now.getTime() + intervalMinutes * 60_000),
      lastRefreshError: null,
    },
  });
}

export async function refreshPostgresDataset(
  database: PrismaClient,
  tenantId: string,
  datasetId: string,
  config: DatasetRefreshConfig,
  snapshotReader: PostgresSnapshotReader = readPostgresTableSnapshot,
): Promise<number> {
  const dataset = await database.dataSet.findFirst({
    where: { id: datasetId, tenantId, dataSource: { kind: 'POSTGRES' } },
    include: { dataSource: true },
  });
  if (!dataset || !dataset.sourceSchema || !dataset.sourceTable) {
    throw new DatasetRefreshError('dataset_not_found');
  }

  let sourceConfig;
  try {
    sourceConfig = decryptPostgresConnectorConfig(
      dataset.dataSource,
      config.ASTRABI_DATA_ENCRYPTION_KEY,
    );
  } catch {
    throw new DatasetRefreshError('invalid_data_source');
  }
  if (!config.ASTRABI_POSTGRES_HOST_ALLOWLIST.includes(normalizePostgresHost(sourceConfig.host))) {
    throw new DatasetRefreshError('postgres_host_not_allowed');
  }

  let snapshot: PostgresTableSnapshot;
  try {
    snapshot = await snapshotReader(sourceConfig, dataset.sourceSchema, dataset.sourceTable);
  } catch {
    throw new DatasetRefreshError('source_unavailable');
  }
  if (snapshot.columns.length === 0) throw new DatasetRefreshError('source_table_not_found');
  if (snapshot.columns.length > maxPostgresDatasetColumns) {
    throw new DatasetRefreshError('too_many_columns');
  }
  if (snapshot.rows.length > maxPostgresDatasetRows) throw new DatasetRefreshError('too_many_rows');

  const storedColumns = datasetColumnsSchema.safeParse(dataset.columns);
  if (!storedColumns.success) throw new DatasetRefreshError('invalid_dataset');
  mapSnapshotColumns(snapshot.columns, storedColumns.data);

  return database.$transaction(async (transaction) => {
    const current = await transaction.dataSet.findFirst({
      where: { id: datasetId, tenantId },
      select: { refreshIntervalMinutes: true, columns: true },
    });
    if (!current) throw new DatasetRefreshError('dataset_not_found');
    const currentColumns = datasetColumnsSchema.safeParse(current.columns);
    if (!currentColumns.success) throw new DatasetRefreshError('invalid_dataset');
    const updatedColumns = mapSnapshotColumns(snapshot.columns, currentColumns.data);

    await transaction.dataRow.deleteMany({ where: { tenantId, datasetId } });
    for (let offset = 0; offset < snapshot.rows.length; offset += 1000) {
      await transaction.dataRow.createMany({
        data: snapshot.rows.slice(offset, offset + 1000).map((values, index) => ({
          tenantId,
          datasetId,
          rowIndex: offset + index,
          data: values,
        })),
      });
    }

    const refreshedAt = new Date();
    const interval = current.refreshIntervalMinutes;
    await transaction.dataSet.update({
      where: { id: datasetId },
      data: {
        columns: updatedColumns.map((column) => ({ ...column })),
        rowCount: snapshot.rows.length,
        lastRefreshedAt: refreshedAt,
        nextRefreshAt: interval === null
          ? null
          : new Date(refreshedAt.getTime() + interval * 60_000),
        lastRefreshError: null,
      },
    });
    return snapshot.rows.length;
  });
}

function mapSnapshotColumns(
  snapshotColumns: PostgresTableSnapshot['columns'],
  storedColumns: z.infer<typeof datasetColumnsSchema>,
): PostgresTableSnapshot['columns'] {
  const storedByName = new Map(storedColumns.map((column) => [column.name, column]));
  const nextNames = new Set(snapshotColumns.map((column) => column.name));
  if (storedColumns.some((column) => !nextNames.has(column.name))) {
    throw new DatasetRefreshError('source_schema_changed');
  }

  const usedKeys = new Set(storedColumns.map((column) => column.key));
  let nextKey = 0;
  return snapshotColumns.map((column) => {
    const existing = storedByName.get(column.name);
    if (existing) return { ...column, key: existing.key };
    while (usedKeys.has(`c${nextKey}`)) nextKey++;
    const key = `c${nextKey}`;
    usedKeys.add(key);
    nextKey++;
    return { ...column, key };
  });
}

export async function refreshPostgresDatasetAndRecordStatus(
  database: PrismaClient,
  tenantId: string,
  datasetId: string,
  config: DatasetRefreshConfig,
  snapshotReader?: PostgresSnapshotReader,
): Promise<number> {
  try {
    return await refreshPostgresDataset(database, tenantId, datasetId, config, snapshotReader);
  } catch (error) {
    await recordDatasetRefreshFailure(database, datasetId, refreshErrorCode(error));
    throw error;
  }
}

export async function recordDatasetRefreshFailure(
  database: PrismaClient,
  datasetId: string,
  code: string,
): Promise<void> {
  const dataset = await database.dataSet.findUnique({
    where: { id: datasetId },
    select: { refreshIntervalMinutes: true },
  });
  if (!dataset) return;
  await database.dataSet.update({
    where: { id: datasetId },
    data: {
      lastRefreshError: code,
      nextRefreshAt: dataset.refreshIntervalMinutes === null
        ? null
        : new Date(Date.now() + refreshRetryDelayMs),
    },
  });
}

export async function withDatasetRefreshLock<T>(
  databaseUrl: string,
  action: () => Promise<T>,
): Promise<{ acquired: boolean; result?: T }> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  let acquired = false;
  try {
    const lockResult = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [refreshLockId],
    );
    acquired = lockResult.rows[0]?.locked === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, result: await action() };
  } finally {
    try {
      if (acquired) {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [refreshLockId]);
      }
    } finally {
      await client.end();
    }
  }
}

export async function refreshDuePostgresDatasets(
  database: PrismaClient,
  config: DatasetRefreshConfig,
): Promise<{ refreshed: number; failed: number }> {
  const lock = await withDatasetRefreshLock(config.DATABASE_URL, async () => {
    const dueDatasets = await database.dataSet.findMany({
      where: {
        refreshIntervalMinutes: { not: null },
        nextRefreshAt: { lte: new Date() },
        dataSource: { kind: 'POSTGRES' },
      },
      orderBy: { nextRefreshAt: 'asc' },
      take: refreshBatchSize,
      select: { id: true, tenantId: true },
    });
    let refreshed = 0;
    let failed = 0;
    for (const dataset of dueDatasets) {
      try {
        await refreshPostgresDatasetAndRecordStatus(
          database,
          dataset.tenantId,
          dataset.id,
          config,
        );
        refreshed++;
      } catch {
        failed++;
      }
    }
    return { refreshed, failed };
  });
  return lock.acquired ? lock.result ?? { refreshed: 0, failed: 0 } : { refreshed: 0, failed: 0 };
}

export function startDatasetRefreshScheduler(
  config: DatasetRefreshConfig,
  logger: {
    info: (data: object, message: string) => void;
    error: (data: object, message: string) => void;
  },
  database: PrismaClient = defaultPrisma,
): () => Promise<void> {
  let activeTick: Promise<void> | undefined;
  const tick = () => {
    if (activeTick) return activeTick;
    activeTick = (async () => {
      try {
        const result = await refreshDuePostgresDatasets(database, config);
        if (result.refreshed > 0) {
          logger.info({ count: result.refreshed }, 'Refreshed PostgreSQL dataset snapshots.');
        }
        if (result.failed > 0) {
          logger.error({ count: result.failed }, 'Some PostgreSQL dataset refreshes failed.');
        }
      } catch (error) {
        logger.error({ err: error }, 'PostgreSQL dataset refresh scheduler failed.');
      }
    })().finally(() => {
      activeTick = undefined;
    });
    return activeTick;
  };
  const timer = setInterval(() => { void tick(); }, schedulerIntervalMs);
  timer.unref();
  void tick();
  return async () => {
    clearInterval(timer);
    await activeTick;
  };
}

function refreshErrorCode(error: unknown): string {
  return error instanceof DatasetRefreshError ? error.code : 'refresh_failed';
}
