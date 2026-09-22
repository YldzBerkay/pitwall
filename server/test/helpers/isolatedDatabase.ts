import { Client } from 'pg';

/**
 * Gives the calling test FILE a Postgres database of its own.
 *
 * `node --test` runs test files in separate processes and is free to run them
 * at the same time, while several files in this suite clear shared tables
 * (`delete from users`) between cases. A file that builds multi-row fixtures
 * and then asserts about a global query — the lobby matchmaking pool, for
 * instance — cannot survive another file wiping the table underneath it, and
 * cannot protect itself by filtering either.
 *
 * So instead of coordinating, such a file takes its own database. It must be
 * called BEFORE anything opens the pool (i.e. first thing in `before`), since
 * `getPool` reads DATABASE_URL once and caches the pool.
 *
 * The database is created if it does not exist and then left in place; the
 * next run re-applies migrations onto it, which are idempotent.
 */
export async function useIsolatedDatabase(name: string): Promise<void> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set — see server/.env.example');

  // A database name goes into `create database` unquoted, where it cannot be
  // parameterised, so it is restricted to a safe shape rather than escaped.
  if (!/^[a-z][a-z0-9_]{0,50}$/.test(name)) {
    throw new Error(`useIsolatedDatabase: unsafe database name ${JSON.stringify(name)}`);
  }

  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
    // `create database` cannot run inside a transaction, so it is issued on
    // its own. A concurrent creation losing the race raises 42P04
    // (duplicate_database), which means the database is there — the point of
    // the call — so it is not an error here.
    if (!exists.rowCount) {
      try {
        await admin.query(`create database ${name}`);
      } catch (err) {
        if ((err as { code?: string }).code !== '42P04') throw err;
      }
    }
  } finally {
    await admin.end();
  }

  const url = new URL(base);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
}
