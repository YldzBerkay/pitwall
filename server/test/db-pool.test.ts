import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, getPool, closePool, withTransaction, isLocalConnection } from '../src/db/pool.ts';

describe('db pool', () => {
  after(async () => { await closePool(); });

  it('executes a query against the configured database', async () => {
    const res = await query<{ n: number }>('select 1::int as n');
    assert.equal(res.rows[0].n, 1);
  });

  it('reuses one pool across calls', () => {
    assert.equal(getPool(), getPool());
  });

  it('reports a clear error when DATABASE_URL is missing', async () => {
    const saved = process.env.DATABASE_URL;
    await closePool();            // açık havuzu düşür ki tembel açılış yeniden çalışsın
    delete process.env.DATABASE_URL;
    assert.throws(() => getPool(), /DATABASE_URL/);
    process.env.DATABASE_URL = saved;
  });
});

describe('withTransaction', () => {
  async function ensureProbeTable() {
    await query('create table if not exists _tx_probe (v text)');
  }

  after(async () => {
    await query('drop table if exists _tx_probe');
  });

  it('commits on success and the row is visible afterwards', async () => {
    await ensureProbeTable();
    await query("delete from _tx_probe where v = 'commit-me'");

    await withTransaction(async (client) => {
      await client.query("insert into _tx_probe (v) values ('commit-me')");
    });

    const res = await query("select v from _tx_probe where v = 'commit-me'");
    assert.equal(res.rows.length, 1);
  });

  it('rolls back on throw and the row is NOT visible afterwards', async () => {
    await ensureProbeTable();
    await query("delete from _tx_probe where v = 'rollback-me'");

    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("insert into _tx_probe (v) values ('rollback-me')");
        throw new Error('deliberate failure');
      }),
      /deliberate failure/,
    );

    const res = await query("select v from _tx_probe where v = 'rollback-me'");
    assert.equal(res.rows.length, 0);
  });

  it('re-throws the ORIGINAL error even when rollback fails', async () => {
    await ensureProbeTable();

    // Terminate our own backend from inside the callback. The connection is
    // dead by the time withTransaction's catch block tries to run
    // `rollback`, so that rollback query itself throws — this proves the
    // original error survives a failing rollback rather than being replaced.
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query('select pg_terminate_backend(pg_backend_pid())').catch(() => {
          // the backend may kill the connection before the response comes back
        });
        throw new Error('original failure from callback');
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /original failure from callback/);
        return true;
      },
    );
  });
});

describe('isLocalConnection', () => {
  it('treats plain localhost URLs as local', () => {
    assert.equal(isLocalConnection('postgres://pitwall:pitwall@localhost:5432/pitwall'), true);
  });

  it('treats a URL with no password as local', () => {
    assert.equal(isLocalConnection('postgres://pitwall@localhost:5432/pitwall'), true);
  });

  it('treats 127.0.0.1 as local', () => {
    assert.equal(isLocalConnection('postgres://pitwall:pitwall@127.0.0.1:5432/pitwall'), true);
  });

  it('treats [::1] as local', () => {
    assert.equal(isLocalConnection('postgres://pitwall:pitwall@[::1]:5432/pitwall'), true);
  });

  it('treats a Railway-style remote host as remote', () => {
    assert.equal(
      isLocalConnection('postgres://user:pass@viaduct.proxy.rlwy.net:12345/railway'),
      false,
    );
  });

  it('treats a password containing "@localhost:" as remote (hostname is what matters)', () => {
    assert.equal(
      isLocalConnection('postgres://user:p@ss@localhost:5432@evil.example.com:5432/db'),
      false,
    );
  });

  it('fails safe (treats as remote) when the string cannot be parsed as a URL', () => {
    assert.equal(isLocalConnection('host=localhost dbname=pitwall user=pitwall'), false);
  });
});
