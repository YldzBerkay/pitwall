import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, withTransaction, closePool, getPool } from '../src/db/pool.ts';
import {
  allocateNickname,
  NicknameSpaceExhaustedError,
  type AllocatedNickname,
} from '../src/identity/nicknameRepo.ts';

/**
 * Counts, for the duration of `fn`, how many times the pool issues the
 * nickname INSERT (on-conflict-do-nothing) and the scan-fallback SELECT.
 * Restores the pool's original `query` no matter how `fn` finishes, so
 * instrumentation never leaks into other tests.
 */
async function countNicknameQueries<T>(fn: () => Promise<T>): Promise<{
  result: T;
  insertAttempts: number;
  scanInvocations: number;
}> {
  const pool = getPool();
  const originalQuery = pool.query.bind(pool);
  let insertAttempts = 0;
  let scanInvocations = 0;

  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0] as string | { text?: string };
    const text = typeof first === 'string' ? first : (first?.text ?? '');
    if (text.includes('on conflict (nickname_base, nickname_tag) do nothing')) {
      insertAttempts += 1;
    } else if (text.includes('select nickname_tag from users where nickname_base')) {
      scanInvocations += 1;
    }
    return (originalQuery as (...a: unknown[]) => unknown)(...args);
  };

  try {
    const result = await fn();
    return { result, insertAttempts, scanInvocations };
  } finally {
    (pool as unknown as { query: unknown }).query = originalQuery;
  }
}

describe('allocateNickname', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => { await query('delete from users'); });
  after(async () => { await closePool(); });

  it('creates a user and returns the allocated pair', async () => {
    const allocated = await allocateNickname('TurboKral');
    assert.equal(allocated.base, 'TurboKral');
    assert.match(allocated.tag, /^[0-9]{4}$/);

    const row = await query<{ id: string }>('select id from users where id = $1', [allocated.userId]);
    assert.equal(row.rowCount, 1);
  });

  it('smoke test: 60 concurrent allocations at default width (4) usually succeed without collision', async () => {
    // NOTE: at width 4 the tag space is 9999-wide, so 60 concurrent inserts
    // collide only ~16% of the time — this test can (and regularly does)
    // pass against a naive implementation with no ON CONFLICT clause at
    // all. It is a cheap sanity check on the default path, NOT proof that
    // the retry/scan machinery works — see the two tests below for that.
    const results = await Promise.all(
      Array.from({ length: 60 }, () => allocateNickname('GridHunter')),
    );
    const tags = results.map((r) => r.tag);
    assert.equal(new Set(tags).size, 60, 'duplicate tag allocated under concurrency');
  });

  it('concurrency proof: 90 concurrent allocations at width 2 force real retries and a scan-fallback run', async () => {
    // Width 2 is a 99-tag space (1..99). 90 concurrent requests against a
    // 99-slot space guarantees heavy collisions on every run — this is
    // deterministic contention, not a dice roll like the width-4 smoke test
    // above. It must exercise BOTH the optimistic on-conflict retry loop
    // AND the exhaustive scan fallback every time this runs.
    const { result: results, insertAttempts, scanInvocations } = await countNicknameQueries(() =>
      Promise.all(
        Array.from({ length: 90 }, () => allocateNickname('DrsSqueeze', { width: 2 })),
      ),
    );

    assert.equal(results.length, 90);
    const tags = results.map((r) => r.tag);
    assert.equal(new Set(tags).size, 90, 'duplicate tag allocated under contention');
    for (const tag of tags) assert.match(tag, /^[0-9]{2}$/);

    // 90 successful inserts is the floor; any collision adds at least one
    // more attempt on top, so more than 90 total attempts proves the
    // optimistic-retry path actually fired (not just succeeded on the
    // first try for every allocation).
    assert.ok(
      insertAttempts > 90,
      `expected retried inserts beyond the 90 successes, got ${insertAttempts} total insert attempts`,
    );
    // The scan fallback only runs once the RANDOM_ATTEMPTS budget for a
    // width is exhausted without finding a free slot. At 90-in-99 that is
    // expected to happen repeatedly across the concurrent callers.
    assert.ok(
      scanInvocations > 0,
      `expected the scan fallback to fire at least once, got ${scanInvocations}`,
    );
  });

  it('exhaustion proof: 120 concurrent allocations at width 2 (capped) reject cleanly past the 99-tag ceiling', async () => {
    // Same 99-tag space, but capped so it CANNOT widen (maxWidth: 2) and
    // asked for more callers (120) than slots (99). Exactly 99 must
    // succeed and exactly 21 must be rejected — and that rejection must be
    // our own NicknameSpaceExhaustedError, never a raw Postgres unique
    // violation (23505 / "duplicate key") leaking out of the retry loop.
    const settled = await Promise.allSettled(
      Array.from({ length: 120 }, () => allocateNickname('GridOverflowZone', { width: 2, maxWidth: 2 })),
    );

    const fulfilled = settled.filter(
      (s): s is PromiseFulfilledResult<AllocatedNickname> => s.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (s): s is PromiseRejectedResult => s.status === 'rejected',
    );

    assert.equal(fulfilled.length, 99, `expected exactly 99 successes, got ${fulfilled.length}`);
    assert.equal(rejected.length, 21, `expected exactly 21 overflow rejections, got ${rejected.length}`);

    const tags = fulfilled.map((f) => f.value.tag);
    assert.equal(new Set(tags).size, 99, 'duplicate tag allocated under exhaustion');

    for (const r of rejected) {
      assert.ok(
        r.reason instanceof NicknameSpaceExhaustedError,
        `expected NicknameSpaceExhaustedError, got ${r.reason instanceof Error ? r.reason.constructor.name : String(r.reason)}`,
      );
      const code = (r.reason as { code?: unknown }).code;
      assert.equal(code, undefined, `raw Postgres error leaked through with code ${String(code)}`);
    }
  });

  it('widens the tag space once every tag of a width is taken', async () => {
    // Genişliği 1'e daraltarak tükenmeyi ucuza simüle et: '1'..'9' dolu.
    // Tahsis aynı genişlikteki haneleri taradığı için tagler tek haneli olmalı.
    for (let n = 1; n <= 9; n += 1) {
      await query('insert into users (nickname_base, nickname_tag) values ($1, $2)', [
        'DrsZone', String(n),
      ]);
    }
    const allocated = await allocateNickname('DrsZone', { width: 1, maxWidth: 2 });
    assert.equal(allocated.tag.length, 2, `expected a widened tag, got ${allocated.tag}`);
  });

  it('throws when the tag space cannot be widened any further', async () => {
    for (let n = 1; n <= 9; n += 1) {
      await query('insert into users (nickname_base, nickname_tag) values ($1, $2)', [
        'PaddockKing', String(n),
      ]);
    }
    await assert.rejects(
      () => allocateNickname('PaddockKing', { width: 1, maxWidth: 1 }),
      NicknameSpaceExhaustedError,
    );
  });

  it('rejects an invalid base before touching the database', async () => {
    await assert.rejects(() => allocateNickname('ab'), /too_short/);
    await assert.rejects(() => allocateNickname('adminPanel'), /blocked/);
  });

  it('allocates on a supplied transaction client: visible after commit, gone after rollback', async () => {
    let committedUserId = '';
    await withTransaction(async (client) => {
      const allocated = await allocateNickname('PitCrewBoss', { client });
      committedUserId = allocated.userId;
    });
    const afterCommit = await query('select id from users where id = $1', [committedUserId]);
    assert.equal(afterCommit.rowCount, 1, 'row should be visible after commit');

    let rolledBackUserId = '';
    await assert.rejects(
      () => withTransaction(async (client) => {
        const allocated = await allocateNickname('PitCrewBoss', { client });
        rolledBackUserId = allocated.userId;
        throw new Error('force rollback');
      }),
      /force rollback/,
    );
    const afterRollback = await query('select id from users where id = $1', [rolledBackUserId]);
    assert.equal(afterRollback.rowCount, 0, 'row should be absent after rollback');
  });
});
