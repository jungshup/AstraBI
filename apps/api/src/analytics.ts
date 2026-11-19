import { Client } from 'pg';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { z } from 'zod';
import { decryptSecret } from '@astrabi/security';
import type { PrismaClient } from '@astrabi/prisma';

const MAX_SOURCE_ROWS = 25_000;
const MAX_RESULT_ROWS = 1_000;
const MAX_SELECTED_DATASETS = 5;
const QUERY_TIMEOUT_MS = 10_000;
const COLUMN_KEY = /^c\d{1,3}$/;
let activeQueries = 0;

const columnSchema = z.object({
  key: z.string().regex(COLUMN_KEY),
  name: z.string(),
  type: z.enum(['STRING', 'NUMBER', 'DATE', 'BOOLEAN']),
});

const fieldKeySchema = z.string().regex(COLUMN_KEY);

const filterSchema = z.object({
  column: fieldKeySchema,
  operator: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte']),
  value: z.string().max(500),
});

const metricSchema = z.object({
  operation: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  column: fieldKeySchema.optional(),
});

const visualQuerySchema = z.object({
  mode: z.literal('visual'),
  datasetId: z.string().uuid(),
  dimensions: z.array(fieldKeySchema).max(10),
  metrics: z.array(metricSchema).max(10),
  filters: z.array(filterSchema).max(20).default([]),
  limit: z.number().int().min(1).max(MAX_RESULT_ROWS).default(MAX_RESULT_ROWS),
});

export const sqlQuerySchema = z.object({
  mode: z.literal('sql'),
  datasetIds: z.array(z.string().uuid()).min(1).max(MAX_SELECTED_DATASETS),
  sql: z.string().trim().min(1).max(10_000),
});

export const analyticsQuerySchema = z.discriminatedUnion('mode', [
  visualQuerySchema,
  sqlQuerySchema,
]).superRefine((query, context) => {
  if (query.mode !== 'visual') return;
  if (query.dimensions.length === 0 && query.metrics.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Select a dimension or metric.' });
  }
  for (const metric of query.metrics) {
    if (metric.operation !== 'count' && !metric.column) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'This metric requires a column.' });
    }
  }
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export class AnalyticsError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface PostgresConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

interface LoadedDataset {
  id: string;
  columns: unknown;
  sourceSchema: string | null;
  sourceTable: string | null;
  dataSource: {
    kind: 'CSV' | 'POSTGRES';
    encryptedConfig: string | null;
    encryptionIv: string | null;
    encryptionTag: string | null;
  };
}

interface DatasetColumn {
  key: string;
  name: string;
  type: 'STRING' | 'NUMBER' | 'DATE' | 'BOOLEAN';
}

export async function executeAnalyticsQuery(
  prisma: PrismaClient,
  tenantId: string,
  encryptionKey: string,
  postgresHostAllowlist: string[],
  query: AnalyticsQuery,
): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
  if (activeQueries >= 2) {
    throw new AnalyticsError(429, 'query_capacity', 'Analytics query capacity is busy.');
  }
  activeQueries++;

  let instance: DuckDBInstance | undefined;
  let connection: DuckDBConnection | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let executingQuery = false;

  try {
    const datasetIds = query.mode === 'visual' ? [query.datasetId] : [...new Set(query.datasetIds)];
    if (datasetIds.length !== (query.mode === 'visual' ? 1 : query.datasetIds.length)) {
      throw new AnalyticsError(400, 'duplicate_dataset', 'Dataset IDs must be unique.');
    }

    const datasets = await prisma.dataSet.findMany({
      where: { tenantId, id: { in: datasetIds } },
      include: { dataSource: true },
    });
    if (datasets.length !== datasetIds.length) {
      throw new AnalyticsError(404, 'dataset_not_found', 'A selected dataset was not found.');
    }

    instance = await DuckDBInstance.create(':memory:', {
      memory_limit: '256MB',
      threads: '1',
      enable_external_access: 'false',
    });
    connection = await instance.connect();

    for (const dataset of datasets) {
      const columns = columnSchema.array().parse(dataset.columns);
      const sourceRows = await loadDatasetRows(
        prisma,
        tenantId,
        encryptionKey,
        postgresHostAllowlist,
        dataset,
      );
      if (sourceRows.length > MAX_SOURCE_ROWS) {
        throw new AnalyticsError(413, 'dataset_too_large', 'A selected dataset exceeds the query row limit.');
      }
      await registerDataset(connection, dataset.id, columns, sourceRows);
    }

    let sql: string;
    let values: Array<string | number | boolean> | undefined;
    let resultLimit = MAX_RESULT_ROWS;
    if (query.mode === 'visual') {
      const dataset = datasets[0];
      const columns = columnSchema.array().parse(dataset.columns);
      ({ sql, values } = buildVisualQuery(query, dataset.id, columns));
      resultLimit = query.limit;
    } else {
      if (!/^\s*SELECT\b/i.test(query.sql)) {
        throw new AnalyticsError(400, 'select_only', 'Only a single SELECT query is allowed.');
      }
      let statements: Awaited<ReturnType<DuckDBConnection['extractStatements']>>;
      try {
        statements = await connection.extractStatements(query.sql);
      } catch {
        throw new AnalyticsError(400, 'invalid_sql', 'The SQL query could not be parsed.');
      }
      if (statements.count !== 1) {
        throw new AnalyticsError(400, 'single_statement_only', 'Run one SELECT statement at a time.');
      }
      const allowedTables = new Set(datasets.map((dataset) => duckTableName(dataset.id)));
      let referencedTables: readonly string[];
      try {
        referencedTables = connection.getTableNames(query.sql, false);
      } catch {
        throw new AnalyticsError(400, 'invalid_sql', 'The SQL query could not be parsed.');
      }
      if (referencedTables.some((table) => !allowedTables.has(table))) {
        throw new AnalyticsError(
          400,
          'dataset_scope_violation',
          'SQL may reference only the selected datasets.',
        );
      }
      sql = `SELECT * FROM (\n${query.sql.replace(/;+\s*$/, '')}\n) AS astrabi_result LIMIT ${MAX_RESULT_ROWS + 1}`;
    }

    timeout = setTimeout(() => {
      timedOut = true;
      connection?.interrupt();
    }, QUERY_TIMEOUT_MS);
    executingQuery = true;
    const result = await connection.runAndReadAll(sql, values);
    if (timedOut) {
      throw new AnalyticsError(408, 'query_timeout', 'The analytics query exceeded its time limit.');
    }

    const allRows = result.getRowsJson();
    return {
      columns: result.columnNames(),
      rows: allRows.slice(0, resultLimit),
      truncated: allRows.length > resultLimit,
    };
  } catch (error) {
    if (timedOut) {
      throw new AnalyticsError(408, 'query_timeout', 'The analytics query exceeded its time limit.');
    }
    if (error instanceof AnalyticsError) throw error;
    throw new AnalyticsError(
      executingQuery ? 400 : 500,
      executingQuery ? 'query_failed' : 'analytics_internal_error',
      executingQuery
        ? 'The analytics query could not be executed.'
        : 'The analytics query could not be prepared.',
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      connection?.closeSync();
    } finally {
      try {
        instance?.closeSync();
      } finally {
        activeQueries--;
      }
    }
  }
}

async function loadDatasetRows(
  prisma: PrismaClient,
  tenantId: string,
  encryptionKey: string,
  postgresHostAllowlist: string[],
  dataset: LoadedDataset,
): Promise<Array<Array<string | null>>> {
  if (dataset.dataSource.kind === 'CSV') {
    const records = await prisma.dataRow.findMany({
      where: { tenantId, datasetId: dataset.id },
      orderBy: { rowIndex: 'asc' },
      take: MAX_SOURCE_ROWS + 1,
      select: { data: true },
    });
    return records.map(({ data }) => {
      if (!Array.isArray(data)) {
        throw new AnalyticsError(500, 'invalid_dataset', 'Stored CSV data is invalid.');
      }
      return data.map((value) => value === null ? null : String(value));
    });
  }

  if (!dataset.dataSource.encryptedConfig || !dataset.dataSource.encryptionIv ||
      !dataset.dataSource.encryptionTag || !dataset.sourceSchema || !dataset.sourceTable) {
    throw new AnalyticsError(500, 'invalid_data_source', 'The PostgreSQL source configuration is incomplete.');
  }

  let sourceConfig: PostgresConnectionConfig;
  try {
    sourceConfig = z.object({
      host: z.string(),
      port: z.number().int(),
      database: z.string(),
      user: z.string(),
      password: z.string(),
    }).parse(JSON.parse(decryptSecret({
      ciphertext: dataset.dataSource.encryptedConfig,
      iv: dataset.dataSource.encryptionIv,
      authTag: dataset.dataSource.encryptionTag,
    }, encryptionKey)));
  } catch {
    throw new AnalyticsError(500, 'invalid_data_source', 'The PostgreSQL source configuration could not be decrypted.');
  }
  if (!postgresHostAllowlist.includes(sourceConfig.host.toLowerCase())) {
    throw new AnalyticsError(403, 'postgres_host_not_allowed', 'This PostgreSQL host is no longer allowed.');
  }

  const client = new Client({
    ...sourceConfig,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(
      `SELECT * FROM ${quotePostgresIdentifier(dataset.sourceSchema)}.${quotePostgresIdentifier(dataset.sourceTable)} LIMIT $1`,
      [MAX_SOURCE_ROWS + 1],
    );
    await client.query('COMMIT');
    if (result.rows.length > MAX_SOURCE_ROWS) {
      throw new AnalyticsError(413, 'dataset_too_large', 'A selected PostgreSQL table exceeds the query row limit.');
    }
    const columns = columnSchema.array().parse(dataset.columns);
    return result.rows.map((row) =>
      columns.map(({ name }) => toCell(row[name])),
    );
  } catch (error) {
    if (error instanceof AnalyticsError) throw error;
    throw new AnalyticsError(502, 'source_query_failed', 'The PostgreSQL source query failed.');
  } finally {
    if (connected) await client.end();
  }
}

async function registerDataset(
  connection: DuckDBConnection,
  datasetId: string,
  columns: DatasetColumn[],
  rows: Array<Array<string | null>>,
): Promise<void> {
  const table = duckTableName(datasetId);
  const definitions = columns.map(({ key }) => `${quoteDuckDbIdentifier(key)} VARCHAR`).join(', ');
  await connection.run(`CREATE TABLE ${quoteDuckDbIdentifier(table)} (${definitions})`);
  const appender = await connection.createAppender(table);
  try {
    for (const row of rows) {
      if (row.length !== columns.length) {
        throw new AnalyticsError(500, 'invalid_dataset', 'Stored data does not match its dataset schema.');
      }
      for (const value of row) {
        if (value === null) appender.appendNull();
        else appender.appendVarchar(value);
      }
      appender.endRow();
    }
    appender.closeSync();
  } catch (error) {
    appender.closeSync();
    throw error;
  }
}

function buildVisualQuery(
  query: Extract<AnalyticsQuery, { mode: 'visual' }>,
  datasetId: string,
  columns: DatasetColumn[],
): { sql: string; values: Array<string | number | boolean> } {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const table = quoteDuckDbIdentifier(duckTableName(datasetId));
  const values: Array<string | number | boolean> = [];
  const fieldExpression = (key: string) => {
    const column = byKey.get(key);
    if (!column) throw new AnalyticsError(400, 'invalid_column', 'A requested dataset column does not exist.');
    const field = `${table}.${quoteDuckDbIdentifier(key)}`;
    if (column.type === 'NUMBER') return `TRY_CAST(${field} AS DOUBLE)`;
    if (column.type === 'BOOLEAN') return `TRY_CAST(${field} AS BOOLEAN)`;
    if (column.type === 'DATE') return `TRY_CAST(${field} AS DATE)`;
    return field;
  };
  const dimensions = query.dimensions.map((key) => `${fieldExpression(key)} AS ${quoteDuckDbIdentifier(key)}`);
  const metrics = query.metrics.map(({ operation, column }, index) => {
    if (operation === 'count' && !column) return `COUNT(*) AS "metric_${index}"`;
    const metadata = byKey.get(column!);
    if (!metadata) throw new AnalyticsError(400, 'invalid_column', 'A requested dataset column does not exist.');
    if (['sum', 'avg'].includes(operation) && metadata.type !== 'NUMBER') {
      throw new AnalyticsError(400, 'invalid_metric', 'Sum and average metrics require a numeric column.');
    }
    const field = fieldExpression(column!);
    return `${operation.toUpperCase()}(${field}) AS "metric_${index}"`;
  });
  const select = [...dimensions, ...metrics].join(', ');
  const predicates = query.filters.map(({ column, operator, value }) => {
    const metadata = byKey.get(column);
    if (!metadata) throw new AnalyticsError(400, 'invalid_column', 'A requested dataset column does not exist.');
    if (operator === 'contains' && metadata.type !== 'STRING') {
      throw new AnalyticsError(400, 'invalid_filter', 'Contains filters require a string column.');
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(operator) && metadata.type !== 'NUMBER') {
      throw new AnalyticsError(400, 'invalid_filter', 'Comparison filters require a numeric column.');
    }
    if (metadata.type === 'NUMBER') {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) {
        throw new AnalyticsError(400, 'invalid_filter', 'Numeric filters require a valid number.');
      }
      values.push(numberValue);
    } else if (metadata.type === 'BOOLEAN') {
      if (value !== 'true' && value !== 'false') {
        throw new AnalyticsError(400, 'invalid_filter', 'Boolean filters must be true or false.');
      }
      values.push(value === 'true');
    } else if (metadata.type === 'DATE') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new AnalyticsError(400, 'invalid_filter', 'Date filters must use YYYY-MM-DD.');
      }
      values.push(value);
    } else {
      values.push(operator === 'contains' ? value.toLowerCase() : value);
    }
    const expression = fieldExpression(column);
    const placeholder = `$${values.length}`;
    switch (operator) {
      case 'eq':
        return metadata.type === 'DATE'
          ? `${expression} = CAST(${placeholder} AS DATE)`
          : `${expression} = ${placeholder}`;
      case 'neq':
        return metadata.type === 'DATE'
          ? `${expression} <> CAST(${placeholder} AS DATE)`
          : `${expression} <> ${placeholder}`;
      case 'contains': return `strpos(lower(${expression}), ${placeholder}) > 0`;
      case 'gt': return `${expression} > TRY_CAST(${placeholder} AS DOUBLE)`;
      case 'gte': return `${expression} >= TRY_CAST(${placeholder} AS DOUBLE)`;
      case 'lt': return `${expression} < TRY_CAST(${placeholder} AS DOUBLE)`;
      case 'lte': return `${expression} <= TRY_CAST(${placeholder} AS DOUBLE)`;
    }
  });
  const groupBy = dimensions.length > 0 && metrics.length > 0
    ? ` GROUP BY ${query.dimensions.map((key) => fieldExpression(key)).join(', ')}`
    : '';
  const distinct = dimensions.length > 0 && metrics.length === 0 ? 'DISTINCT ' : '';
  const where = predicates.length > 0 ? ` WHERE ${predicates.join(' AND ')}` : '';
  return {
    sql: `SELECT ${distinct}${select} FROM ${table}${where}${groupBy} LIMIT ${query.limit + 1}`,
    values,
  };
}

function duckTableName(datasetId: string): string {
  return `ds_${datasetId.replace(/-/g, '')}`;
}

function quoteDuckDbIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function toCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return JSON.stringify(value);
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return String(value);
}
