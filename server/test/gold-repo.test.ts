import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import {
  grantGold, grantGoldForAd, spendGold, goldOf, capsFor, bumpAdsWatched, bumpGoldConverted,
} from '../src/gold/repo.ts';
import { ADS_PER_DAY } from '@pitwall/shared/economy';

let seq = 0;
const makeUser = async (): Promise<string> => (await createUserWithIdentity({
  base: 'GripMaster', provider: 'google', providerUid: `g-gold-${++seq}-${randomUUID()}`, emailHash: null,
})).id;
const extId = () => randomUUID();

describe('gold repo', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => { await query('delete from users'); });
  after(async () => { await closePool(); });

  it('grants gold and credits the account', async () => {
    const userId = await makeUser();
    const res = await grantGold({ userId, source: 'ad', externalId: extId(), gold: 1 });
    assert.equal(res.ok, true);
    assert.equal(await goldOf(userId), 1);
  });

  it('REFUSES the same external id twice under the same source', async () => {
    const userId = await makeUser();
    const id = extId();
    assert.equal((await grantGold({ userId, source: 'ad', externalId: id, gold: 1 })).ok, true);
    const second = await grantGold({ userId, source: 'ad', externalId: id, gold: 1 });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, 'duplicate');
    assert.equal(await goldOf(userId), 1, 'the same callback granted gold twice');
  });

  it('treats the same external id under a different source as a separate grant', async () => {
    const userId = await makeUser();
    const id = extId();
    await grantGold({ userId, source: 'ad', externalId: id, gold: 1 });
    assert.equal((await grantGold({ userId, source: 'iap', externalId: id, gold: 60 })).ok, true);
    assert.equal(await goldOf(userId), 61);
  });

  it('does not credit a second user with another user\'s duplicate id', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const id = extId();
    await grantGold({ userId: a, source: 'ad', externalId: id, gold: 5 });
    const second = await grantGold({ userId: b, source: 'ad', externalId: id, gold: 5 });
    assert.equal(second.ok, false, 'a replayed callback credited a different account');
    assert.equal(await goldOf(b), 0);
  });

  it('refuses to spend more gold than the account has', async () => {
    const userId = await makeUser();
    await grantGold({ userId, source: 'ad', externalId: extId(), gold: 2 });
    assert.equal(await withTransaction((c) => spendGold(c, userId, 3)), false);
    assert.equal(await goldOf(userId), 2);
  });

  it('two concurrent spends cannot both succeed past the balance', async () => {
    const userId = await makeUser();
    await grantGold({ userId, source: 'ad', externalId: extId(), gold: 10 });
    const [a, b] = await Promise.all([
      withTransaction((c) => spendGold(c, userId, 7)),
      withTransaction((c) => spendGold(c, userId, 7)),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1, 'both spends went through');
    assert.ok((await goldOf(userId)) >= 0);
  });

  it('spending zero succeeds and changes nothing', async () => {
    const userId = await makeUser();
    await grantGold({ userId, source: 'ad', externalId: extId(), gold: 3 });
    assert.equal(await withTransaction((c) => spendGold(c, userId, 0)), true);
    assert.equal(await goldOf(userId), 3);
  });

  it('rejects a non-positive or fractional grant rather than writing it', async () => {
    const userId = await makeUser();
    await assert.rejects(() => grantGold({ userId, source: 'ad', externalId: extId(), gold: 0 }));
    await assert.rejects(() => grantGold({ userId, source: 'ad', externalId: extId(), gold: -5 }));
    await assert.rejects(() => grantGold({ userId, source: 'ad', externalId: extId(), gold: 1.5 }));
    assert.equal(await goldOf(userId), 0);
  });

  it('counts caps against the SERVER utc day, not the caller\'s local day', async () => {
    const userId = await makeUser();
    // 23:30 UTC ve aynı günün 00:10'u aynı satıra düşmeli.
    await bumpAdsWatched(userId, new Date('2026-03-01T23:30:00Z'), 3);
    assert.equal((await capsFor(userId, new Date('2026-03-01T23:30:00Z'))).adsWatched, 3);
    assert.equal((await capsFor(userId, new Date('2026-03-01T00:10:00Z'))).adsWatched, 3);
    // Ertesi UTC günü sıfırdan başlar.
    assert.equal((await capsFor(userId, new Date('2026-03-02T00:10:00Z'))).adsWatched, 0);
  });

  it('accumulates within a day and isolates the next', async () => {
    const userId = await makeUser();
    const day = new Date('2026-03-05T12:00:00Z');
    await bumpGoldConverted(userId, day, 2);
    await bumpGoldConverted(userId, day, 3);
    assert.equal((await capsFor(userId, day)).goldConverted, 5);
    assert.equal((await capsFor(userId, new Date('2026-03-06T12:00:00Z'))).goldConverted, 0);
  });

  it('reports zeroes for a user with no cap row yet', async () => {
    const userId = await makeUser();
    const caps = await capsFor(userId, new Date());
    assert.equal(caps.adsWatched, 0);
    assert.equal(caps.goldConverted, 0);
  });

  it('takes a user\'s grants and caps with them when the account is deleted', async () => {
    const userId = await makeUser();
    await grantGold({ userId, source: 'ad', externalId: extId(), gold: 1 });
    await bumpAdsWatched(userId, new Date(), 1);
    await query('delete from users where id = $1', [userId]);
    const g = await query('select 1 from gold_grants where user_id = $1', [userId]);
    const c = await query('select 1 from daily_caps where user_id = $1', [userId]);
    assert.equal(g.rowCount, 0);
    assert.equal(c.rowCount, 0);
  });

  describe('grantGoldForAd (atomic ledger + credit + cap bump)', () => {
    it('grants at the cap boundary: the 8th succeeds, the 9th is refused with nothing written', async () => {
      const userId = await makeUser();
      const at = new Date('2026-04-01T10:00:00Z');

      for (let i = 1; i <= ADS_PER_DAY; i += 1) {
        const res = await grantGoldForAd({ userId, externalId: extId(), gold: 1, at, cap: ADS_PER_DAY });
        assert.equal(res.ok, true, `ad #${i} (<= ADS_PER_DAY) must be granted`);
      }
      assert.equal(await goldOf(userId), ADS_PER_DAY);
      assert.equal((await capsFor(userId, at)).adsWatched, ADS_PER_DAY);

      const before = await query('select count(*)::int as n from gold_grants where user_id = $1', [userId]);

      const ninth = await grantGoldForAd({ userId, externalId: extId(), gold: 1, at, cap: ADS_PER_DAY });
      assert.equal(ninth.ok, false);
      assert.equal(ninth.ok === false && ninth.reason, 'cap_reached');

      assert.equal(await goldOf(userId), ADS_PER_DAY, 'the 9th grant must not have credited gold');
      assert.equal((await capsFor(userId, at)).adsWatched, ADS_PER_DAY, 'the 9th grant must not have bumped the counter');
      const after = await query('select count(*)::int as n from gold_grants where user_id = $1', [userId]);
      assert.equal(after.rows[0].n, before.rows[0].n, 'a cap-rejected grant must leave no ledger row behind');
    });

    it('a duplicate external id does not consume an allowance slot', async () => {
      const userId = await makeUser();
      const at = new Date('2026-04-02T10:00:00Z');
      const id = extId();

      const first = await grantGoldForAd({ userId, externalId: id, gold: 1, at, cap: ADS_PER_DAY });
      assert.equal(first.ok, true);
      assert.equal((await capsFor(userId, at)).adsWatched, 1);

      const second = await grantGoldForAd({ userId, externalId: id, gold: 1, at, cap: ADS_PER_DAY });
      assert.equal(second.ok, false);
      assert.equal(second.ok === false && second.reason, 'duplicate');

      assert.equal(await goldOf(userId), 1, 'a duplicate must not credit gold again');
      assert.equal((await capsFor(userId, at)).adsWatched, 1, 'a duplicate must not consume a second allowance slot');
    });

    it('the cap is per UTC day: usage on one day does not consume the next day\'s allowance', async () => {
      const userId = await makeUser();
      const day1 = new Date('2026-04-03T23:00:00Z');
      const day2 = new Date('2026-04-04T01:00:00Z');

      for (let i = 0; i < ADS_PER_DAY; i += 1) {
        const res = await grantGoldForAd({ userId, externalId: extId(), gold: 1, at: day1, cap: ADS_PER_DAY });
        assert.equal(res.ok, true);
      }
      assert.equal((await capsFor(userId, day1)).adsWatched, ADS_PER_DAY);

      const nextDay = await grantGoldForAd({ userId, externalId: extId(), gold: 1, at: day2, cap: ADS_PER_DAY });
      assert.equal(nextDay.ok, true, 'a new UTC day must start with a fresh allowance');
      assert.equal((await capsFor(userId, day2)).adsWatched, 1);
    });

    it('RACE: ADS_PER_DAY + 4 concurrent grants for one user credit exactly ADS_PER_DAY', async () => {
      const userId = await makeUser();
      const at = new Date('2026-04-05T12:00:00Z');
      const attempts = ADS_PER_DAY + 4;

      const results = await Promise.all(
        Array.from({ length: attempts }, () => grantGoldForAd({
          userId, externalId: extId(), gold: 1, at, cap: ADS_PER_DAY,
        })),
      );

      const granted = results.filter((r) => r.ok).length;
      assert.equal(granted, ADS_PER_DAY, 'concurrent grants overshot the daily cap');
      assert.equal(await goldOf(userId), ADS_PER_DAY);
      assert.equal((await capsFor(userId, at)).adsWatched, ADS_PER_DAY);
    });
  });
});
