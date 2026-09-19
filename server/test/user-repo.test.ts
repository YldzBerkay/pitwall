import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import {
  createUserWithIdentity,
  findUserByProviderUid,
  findUserByEmailHash,
  findPasswordHash,
  addIdentity,
  loadUser,
  updateProfile,
} from '../src/auth/userRepo.ts';

describe('userRepo', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => { await query('delete from users'); });
  after(async () => { await closePool(); });

  it('creates a user together with its first identity', async () => {
    const user = await createUserWithIdentity({
      base: 'TurboKral', provider: 'google', providerUid: 'google-uid-1', emailHash: 'hash-1',
    });
    assert.equal(user.nicknameBase, 'TurboKral');
    assert.match(user.nicknameTag, /^[0-9]{4}$/);
    assert.equal(user.gold, 0);
    assert.equal(user.rankPoints, 0);
    assert.equal(user.countryCode, null);
    assert.equal(user.region, null);
  });

  it('finds a user by provider uid', async () => {
    const created = await createUserWithIdentity({
      base: 'GridHunter', provider: 'apple', providerUid: 'apple-uid-1', emailHash: null,
    });
    assert.equal((await findUserByProviderUid('apple', 'apple-uid-1'))?.id, created.id);
    assert.equal(await findUserByProviderUid('apple', 'nope'), null);
  });

  it('finds a user by email hash for cross-provider linking', async () => {
    const created = await createUserWithIdentity({
      base: 'DrsZone', provider: 'google', providerUid: 'g-2', emailHash: 'shared-hash',
    });
    assert.equal((await findUserByEmailHash('shared-hash'))?.id, created.id);
  });

  it('links a second provider to an existing user', async () => {
    const created = await createUserWithIdentity({
      base: 'HotLapHero', provider: 'google', providerUid: 'g-3', emailHash: 'shared-2',
    });
    await addIdentity(created.id, { provider: 'facebook', providerUid: 'fb-3', emailHash: 'shared-2' });
    assert.equal((await findUserByProviderUid('facebook', 'fb-3'))?.id, created.id);
  });

  it('leaves NO orphan user row when the identity insert conflicts', async () => {
    await createUserWithIdentity({
      base: 'BoxBoxLegend', provider: 'google', providerUid: 'dup-uid', emailHash: null,
    });
    await assert.rejects(() => createUserWithIdentity({
      base: 'CircuitGhost', provider: 'google', providerUid: 'dup-uid', emailHash: null,
    }));
    const leftovers = await query('select 1 from users where nickname_base = $1', ['CircuitGhost']);
    assert.equal(leftovers.rowCount, 0, 'orphaned user row left behind');
  });

  it('stores a password hash only for the password provider', async () => {
    const user = await createUserWithIdentity({
      base: 'GripMaster', provider: 'password', providerUid: 'email-hash-9',
      emailHash: 'email-hash-9', passwordHash: 'scrypt$16384$8$1$c2FsdA==$a2V5',
    });
    const found = await findPasswordHash('email-hash-9');
    assert.equal(found?.userId, user.id);
    assert.equal(found?.hash, 'scrypt$16384$8$1$c2FsdA==$a2V5');
    assert.equal(await findPasswordHash('no-such-hash'), null);
  });

  it('updates country and region, leaving other fields untouched', async () => {
    const user = await createUserWithIdentity({
      base: 'TarmacTiger', provider: 'google', providerUid: 'g-4', emailHash: null,
    });
    const updated = await updateProfile(user.id, { countryCode: 'TR', region: 'MENA' });
    assert.equal(updated?.countryCode, 'TR');
    assert.equal(updated?.region, 'MENA');
    assert.equal(updated?.nicknameBase, 'TarmacTiger');
    assert.equal(updated?.nicknameTag, user.nicknameTag);
  });

  it('updates only the field given, leaving the other as it was', async () => {
    const user = await createUserWithIdentity({
      base: 'FastLapPro', provider: 'google', providerUid: 'g-6', emailHash: null,
    });
    await updateProfile(user.id, { countryCode: 'DE', region: 'EU' });
    const onlyCountry = await updateProfile(user.id, { countryCode: 'FR' });
    assert.equal(onlyCountry?.countryCode, 'FR');
    assert.equal(onlyCountry?.region, 'EU', 'region was clobbered by a partial update');
  });

  it('loads a user by id and returns null for an unknown id', async () => {
    const user = await createUserWithIdentity({
      base: 'MidfieldWolf', provider: 'google', providerUid: 'g-5', emailHash: null,
    });
    assert.equal((await loadUser(user.id))?.id, user.id);
    assert.equal(await loadUser('00000000-0000-0000-0000-000000000000'), null);
  });

  it('returns null instead of throwing for a malformed uuid', async () => {
    assert.equal(await loadUser('not-a-uuid'), null);
  });
});
