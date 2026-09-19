import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, getPool, closePool } from '../src/db/pool.ts';

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
