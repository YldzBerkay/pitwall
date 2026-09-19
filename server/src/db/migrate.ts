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

export async function runMigrations(): Promise<string[]> {
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

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const freshlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      freshlyApplied.push(file);
      console.log(`migrated: ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration failed: ${file}\n${String(err)}`, { cause: err });
    } finally {
      client.release();
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
