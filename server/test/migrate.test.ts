import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';

describe('migrations', () => {
  before(async () => {
    await query('drop table if exists auth_identities, users, schema_migrations cascade');
  });
  after(async () => { await closePool(); });

  it('creates the identity tables', async () => {
    await runMigrations();
    const res = await query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
    );
    const names = res.rows.map((r) => r.table_name);
    assert.ok(names.includes('users'), 'users table missing');
    assert.ok(names.includes('auth_identities'), 'auth_identities table missing');
  });

  it('is idempotent — running twice applies nothing new', async () => {
    const before = await query<{ count: string }>('select count(*) from schema_migrations');
    await runMigrations();
    const after = await query<{ count: string }>('select count(*) from schema_migrations');
    assert.equal(after.rows[0].count, before.rows[0].count);
  });

  it('enforces uniqueness on (nickname_base, nickname_tag)', async () => {
    await query(
      `insert into users (nickname_base, nickname_tag) values ('TurboKral', '0001')`,
    );
    await assert.rejects(
      () => query(`insert into users (nickname_base, nickname_tag) values ('TurboKral', '0001')`),
      /duplicate key/,
    );
    // Aynı taban, farklı hane serbest olmalı.
    await query(`insert into users (nickname_base, nickname_tag) values ('TurboKral', '0002')`);
    await query(`delete from users where nickname_base = 'TurboKral'`);
  });

  it('rejects an unknown region value', async () => {
    await assert.rejects(
      () => query(
        `insert into users (nickname_base, nickname_tag, region) values ('GridHunter', '0001', 'MARS')`,
      ),
      /users_region_check/,
    );
  });

  it('still reports the migration filename when the rollback itself fails', async () => {
    // Forces a genuine rollback failure: the migration's own SQL kills its
    // backend mid-transaction (pg_terminate_backend), so the failing
    // `client.query(sql)` call is itself the migration error, and the
    // subsequent `rollback` in migrate.ts's catch block rejects too because
    // the connection is already gone. This proves the wrapping
    // "migration failed: <file>" error (with the original error as `cause`)
    // still wins even when rollback can't run — mirroring withTransaction's
    // handling of the same failure mode in src/db/pool.ts.
    const dir = await mkdtemp(join(tmpdir(), 'pit-wall-migrate-'));
    try {
      const file = '001_kill_backend.sql';
      await writeFile(
        join(dir, file),
        // The socket can die before the response for this statement comes
        // back, so the query promise settling either way is expected —
        // what matters is that the connection is dead afterwards.
        'select pg_terminate_backend(pg_backend_pid());',
      );

      await assert.rejects(
        () => runMigrations(dir),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /migration failed: 001_kill_backend\.sql/);
          assert.ok(err.cause, 'expected the original error to be preserved as cause');
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
