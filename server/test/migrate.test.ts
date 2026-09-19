import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
});
