import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import {
  seedTeamEconomy, loadTeamEconomy, loadLobbyEconomy,
  spendRp, addRp, setFactoryLevel, bumpCarStat, bumpUpgradesDone,
} from '../src/economy/repo.ts';

let seq = 0;

/** Testin ihtiyaç duyduğu en küçük lobi. `lobbies` name_base/name_seq ve
 *  NOT NULL creator_user_id istiyor, o yüzden önce bir kullanıcı gerekir. */
async function makeLobby(label = 'Repo'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`${label} #${seq}`, label, seq, owner.id],
  );
  return res.rows[0].id;
}

describe('economy repo', () => {
  let lobbyId: string;
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from lobbies');
    await query('delete from users');
    lobbyId = await makeLobby();
  });
  after(async () => { await closePool(); });

  it('seeds a team with starting rp and a real car', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const econ = await loadTeamEconomy(lobbyId, 'bosphorus');
    assert.ok(econ, 'no row written');
    assert.ok(econ.rp > 0, 'starting rp must be positive');
    assert.ok(econ.car.motor > 0 && econ.car.aero > 0 && econ.car.grip > 0);
    assert.deepEqual(econ.factoryLevels, {});
    assert.deepEqual(econ.upgradesDone, {});
  });

  it('is idempotent — re-seeding must not reset a live economy', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    await withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', 100));
    const before = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    assert.equal((await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp, before,
      're-seeding wiped an existing economy');
  });

  it('loads every team in a lobby at once', async () => {
    await withTransaction(async (c) => {
      await seedTeamEconomy(c, lobbyId, 'bosphorus');
      await seedTeamEconomy(c, lobbyId, 'ridgeline');
    });
    assert.equal((await loadLobbyEconomy(lobbyId)).length, 2);
  });

  it('refuses to spend more rp than the team has', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const start = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    const ok = await withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', start + 1));
    assert.equal(ok, false);
    assert.equal((await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp, start,
      'balance moved on a refused spend');
  });

  it('spends and credits rp', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const start = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    assert.equal(await withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', 100)), true);
    await withTransaction((c) => addRp(c, lobbyId, 'bosphorus', 30));
    assert.equal((await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp, start - 100 + 30);
  });

  it('two concurrent spends cannot both succeed past the balance', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const start = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    const half = Math.floor(start / 2) + 10;
    const [a, b] = await Promise.all([
      withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', half)),
      withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', half)),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1, 'both spends went through');
    assert.ok((await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp >= 0);
  });

  it('records a factory level', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    await withTransaction((c) => setFactoryLevel(c, lobbyId, 'bosphorus', 'wind_tunnel', 2));
    assert.equal((await loadTeamEconomy(lobbyId, 'bosphorus'))!.factoryLevels.wind_tunnel, 2);
  });

  it('bumps a car stat and an upgrade counter', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const before = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.motor;
    await withTransaction((c) => bumpCarStat(c, lobbyId, 'bosphorus', 'motor', 2.5));
    await withTransaction((c) => bumpUpgradesDone(c, lobbyId, 'bosphorus', 'MOTOR'));
    const econ = (await loadTeamEconomy(lobbyId, 'bosphorus'))!;
    assert.equal(econ.car.motor, before + 2.5);
    assert.equal(econ.upgradesDone.MOTOR, 1);
    await withTransaction((c) => bumpUpgradesDone(c, lobbyId, 'bosphorus', 'MOTOR'));
    assert.equal((await loadTeamEconomy(lobbyId, 'bosphorus'))!.upgradesDone.MOTOR, 2);
  });

  it('rejects a negative or non-integer spend rather than silently crediting', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    await assert.rejects(() => withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', -50)));
    await assert.rejects(() => withTransaction((c) => addRp(c, lobbyId, 'bosphorus', 1.5)));
  });
});
