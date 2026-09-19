/**
 * Sequential SQL migration runner.
 *
 * Every file in ./migrations is applied once, in filename order, each inside
 * its own transaction. Applied filenames are recorded in schema_migrations.
 *
 * Run standalone with: npm run migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getPool, closePool } from './pool.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

// Each migration below runs inside its own `begin`/`commit` transaction, so a
// future migration must NOT use `create index concurrently` — PostgreSQL
// refuses that statement inside a transaction block. Such an index needs its
// own non-transactional migration path if it's ever needed.
export async function runMigrations(migrationsDir: string = MIGRATIONS_DIR): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ filename: string }>('select filename from schema_migrations'))
      .rows.map((r) => r.filename),
  );

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const freshlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    // Set only when the migration failed, so `finally` can tell the pool to
    // destroy the client instead of recycling it — see the matching comment
    // in withTransaction (src/db/pool.ts) for why.
    let failure: unknown;
    // A connection that dies mid-migration (e.g. the backend is terminated,
    // or the network drops) can emit a stray 'error' event directly on this
    // checked-out client — separate from the rejection of whatever query was
    // in flight. With no listener, that's an unhandled 'error' event, which
    // crashes the process; log it instead. Mirrors withTransaction in
    // src/db/pool.ts.
    const onClientError = (clientErr: unknown) => {
      console.error(`Postgres client error during migration ${file}:`, clientErr);
    };
    client.on('error', onClientError);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      freshlyApplied.push(file);
      console.log(`migrated: ${file}`);
    } catch (err) {
      failure = err;
      try {
        await client.query('rollback');
      } catch (rollbackErr) {
        // The rollback itself failed (e.g. the connection died mid-migration).
        // That's diagnosable but must never replace or hide the real failure,
        // nor swallow which migration file caused it — attach it to the
        // original error and keep going so the wrapping throw below still
        // runs with `err` as its cause.
        if (err && typeof err === 'object') {
          (err as { rollbackError?: unknown }).rollbackError = rollbackErr;
        }
        console.error(`Rollback failed after a migration error in ${file}:`, rollbackErr);
      }
      throw new Error(`migration failed: ${file}\n${String(err)}`, { cause: err });
    } finally {
      client.removeListener('error', onClientError);
      client.release(failure instanceof Error ? failure : failure !== undefined);
    }
  }
  return freshlyApplied;
}

// Doğrudan çalıştırıldığında koş; import edildiğinde koşma.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then((f) => { console.log(f.length ? `${f.length} migration applied` : 'already up to date'); })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => closePool());
}
