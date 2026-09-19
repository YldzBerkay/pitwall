/**
 * Lazily-opened Postgres pool.
 *
 * Opening is deferred so that unit tests which never touch the database can
 * import modules in this tree without DATABASE_URL being set.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

/**
 * Decides whether a Postgres connection string points at the local machine,
 * based on the PARSED hostname rather than a regex over the raw string — a
 * regex can be fooled by a password or path segment that happens to contain
 * "@localhost:" while the real host is remote.
 *
 * Anything that isn't recognisably local (including a connection string we
 * can't parse as a URL, e.g. libpq's `key=value` form) is treated as remote
 * so we fail SAFE by enabling TLS rather than silently talking plaintext to
 * a real host.
 */
export function isLocalConnection(connectionString: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  // URL hostnames for IPv6 literals keep their brackets, e.g. "[::1]".
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

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
    ssl: isLocalConnection(connectionString) ? undefined : { rejectUnauthorized: false },
  });
  // Without this, an error on an IDLE pooled client (e.g. the network drops
  // a connection nobody is currently using) is an unhandled 'error' event on
  // the Pool, which crashes the whole process — unacceptable for a server
  // that holds long-lived WebSocket connections for a live race. Logging and
  // swallowing it here lets the pool recover (or fail individual queries)
  // without taking the process down.
  pool.on('error', (err) => {
    console.error('Postgres pool error on an idle client:', err);
  });
  return pool;
}

export function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<R>> {
  // `pg` only reads this array (it never mutates or stores it beyond the
  // call), so widening the readonly type to satisfy its signature is sound —
  // don't start mutating `params` in a future refactor without re-checking.
  return getPool().query<R>(text, params as unknown[]);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  // Set only when the transaction failed, so `finally` can tell the pool to
  // destroy the client instead of recycling it — a client whose transaction
  // (or its rollback) blew up may be left in a broken or inconsistent state
  // (e.g. its connection was dropped), and handing that back to the next
  // caller would surface as confusing, unrelated failures later.
  let failure: unknown;
  // A connection that dies mid-transaction (e.g. the network drops, or the
  // backend is terminated) can emit a stray 'error' event directly on this
  // checked-out client — separate from the rejection of whatever query was
  // in flight. With no listener, that is an unhandled 'error' event, which
  // crashes the process; log it instead.
  const onClientError = (clientErr: unknown) => {
    console.error('Postgres client error during transaction:', clientErr);
  };
  client.on('error', onClientError);
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    failure = err;
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      // The rollback itself failed (e.g. the connection died mid-transaction).
      // That's diagnosable but must never replace or hide the real failure —
      // attach it to the original error and keep going so `err` still wins.
      if (err && typeof err === 'object') {
        (err as { rollbackError?: unknown }).rollbackError = rollbackErr;
      }
      console.error('Rollback failed after a transaction error:', rollbackErr);
    }
    throw err;
  } finally {
    client.removeListener('error', onClientError);
    client.release(failure instanceof Error ? failure : failure !== undefined);
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
