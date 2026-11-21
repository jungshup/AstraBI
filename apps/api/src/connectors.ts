import { Client } from 'pg';
import { z } from 'zod';
import { decryptSecret } from '@astrabi/security';

export const maxPostgresDatasetRows = 25_000;
export const maxPostgresDatasetColumns = 100;

const postgresConnectionConfigSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  user: z.string(),
  password: z.string(),
});

export interface PostgresConnectorConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface DatasetColumnMetadata {
  key: string;
  name: string;
  type: 'STRING' | 'NUMBER' | 'DATE' | 'BOOLEAN';
}

export interface PostgresTableSnapshot {
  columns: DatasetColumnMetadata[];
  rows: Array<Array<string | null>>;
}

export function decryptPostgresConnectorConfig(
  source: {
    encryptedConfig: string | null;
    encryptionIv: string | null;
    encryptionTag: string | null;
  },
  key: string,
): PostgresConnectorConfig {
  if (!source.encryptedConfig || !source.encryptionIv || !source.encryptionTag) {
    throw new Error('PostgreSQL source configuration is incomplete.');
  }
  try {
    return postgresConnectionConfigSchema.parse(JSON.parse(decryptSecret({
      ciphertext: source.encryptedConfig,
      iv: source.encryptionIv,
      authTag: source.encryptionTag,
    }, key)));
  } catch {
    throw new Error('PostgreSQL source configuration could not be decrypted.');
  }
}

interface PostgresColumn {
  column_name: string;
  data_type: string;
}

export function normalizePostgresHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

export async function verifyPostgresConnection(config: PostgresConnectorConfig): Promise<void> {
  const client = createClient(config);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT 1');
    await client.query('ROLLBACK');
  } finally {
    if (connected) await client.end();
  }
}

export async function listPostgresTables(
  config: PostgresConnectorConfig,
): Promise<Array<{ schema: string; name: string }>> {
  const client = createClient(config);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query<{
      table_schema: string;
      table_name: string;
    }>(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_type = 'BASE TABLE'
         AND table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name
       LIMIT 1000`,
    );
    await client.query('COMMIT');
    return result.rows.map(({ table_schema, table_name }) => ({
      schema: table_schema,
      name: table_name,
    }));
  } finally {
    if (connected) await client.end();
  }
}

export async function inspectPostgresTable(
  config: PostgresConnectorConfig,
  schema: string,
  table: string,
): Promise<DatasetColumnMetadata[]> {
  const client = createClient(config);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const tableResult = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
      [schema, table],
    );
    if (tableResult.rowCount !== 1) {
      await client.query('ROLLBACK');
      return [];
    }
    const result = await client.query<PostgresColumn>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table],
    );
    await client.query('COMMIT');
    return result.rows.map(({ column_name, data_type }, index) => ({
      key: `c${index}`,
      name: column_name,
      type: postgresColumnType(data_type),
    }));
  } finally {
    if (connected) await client.end();
  }
}

export async function readPostgresTableSnapshot(
  config: PostgresConnectorConfig,
  schema: string,
  table: string,
): Promise<PostgresTableSnapshot> {
  const columns = await inspectPostgresTable(config, schema, table);
  if (columns.length === 0 || columns.length > maxPostgresDatasetColumns) {
    return { columns, rows: [] };
  }
  const client = createClient(config);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(
      `SELECT * FROM ${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)} LIMIT $1`,
      [maxPostgresDatasetRows + 1],
    );
    await client.query('COMMIT');
    const rows = result.rows.map((row) =>
      columns.map(({ name }) => {
        const value = row[name];
        if (value === null || value === undefined) return null;
        if (value instanceof Date) return value.toISOString();
        return Buffer.isBuffer(value) ? value.toString('base64') : String(value);
      }),
    );
    return { columns, rows };
  } finally {
    if (connected) await client.end();
  }
}

export function inferCsvColumnType(values: string[]): DatasetColumnMetadata['type'] {
  const present = values.filter((value) => value !== '');
  if (present.length === 0) return 'STRING';
  if (present.every((value) => value === 'true' || value === 'false')) return 'BOOLEAN';
  if (present.every((value) => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value))) {
    return 'NUMBER';
  }
  if (present.every((value) => /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+-]+Z?)?$/.test(value))) {
    return 'DATE';
  }
  return 'STRING';
}

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function createClient(config: PostgresConnectorConfig): Client {
  return new Client({
    ...config,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
}

function postgresColumnType(dataType: string): DatasetColumnMetadata['type'] {
  if ([
    'smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision',
    'decimal',
  ].includes(dataType)) return 'NUMBER';
  if (dataType === 'boolean') return 'BOOLEAN';
  if (dataType === 'date' || dataType.startsWith('timestamp')) return 'DATE';
  return 'STRING';
}
