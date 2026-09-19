/**
 * Lazily-opened Postgres pool.
 *
 * Opening is deferred so that unit tests which never touch the database can
 * import modules in this tree without DATABASE_URL being set.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — see server/.env.example');
  }
  pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    // Railway'in yönetilen Postgres'i TLS ister ama sertifikayı kendi CA'sıyla
    // imzalar; yerelde TLS yok.
    ssl: /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)
      ? undefined
      : { rejectUnauthorized: false },
  });
  return pool;
}

export function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<R>> {
  return getPool().query<R>(text, params as unknown[]);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
