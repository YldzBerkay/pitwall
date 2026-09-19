import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, withTransaction, closePool } from '../src/db/pool.ts';
import { allocateNickname, NicknameSpaceExhaustedError } from '../src/identity/nicknameRepo.ts';

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

  it('gives distinct tags to 60 concurrent allocations of the same base', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, () => allocateNickname('GridHunter')),
    );
    const tags = results.map((r) => r.tag);
    assert.equal(new Set(tags).size, 60, 'duplicate tag allocated under concurrency');
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
