import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import {
  insertSponsorship, deleteDeal, setStreak, loadTeamSponsorships, loadLobbySponsorships,
} from '../src/economy/sponsorshipRepo.ts';
import type { Sponsorship } from '@pitwall/shared/sponsors';

let seq = 0;
const createdLobbyIds: string[] = [];
const createdUserIds: string[] = [];

/** Testin ihtiyaç duyduğu en küçük lobi. `economy-repo.test.ts`'teki
 *  `makeLobby`'nin aynısı, ama bu paylaşılan veritabanında başka suite'ler de
 *  çalıştığı için oluşturduğumuz satırları TAKİP EDİP yalnızca onları
 *  sileriz — `delete from lobbies` gibi tablo geneli bir silme başka bir
 *  suite'in ortasındaki veriyi de süpürür. */
async function makeLobby(label = 'SponsorRepo'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}`, emailHash: null,
  });
  createdUserIds.push(owner.id);
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`${label} #${seq}`, label, seq, owner.id],
  );
  const id = res.rows[0].id;
  createdLobbyIds.push(id);
  return id;
}

function makeDeal(overrides: Partial<Sponsorship> = {}): Sponsorship {
  return {
    dealId: `1-northline-sidepod`,
    brandKey: 'northline',
    slot: 'sidepod',
    perRace: 120,
    targetPosition: 6,
    bonus: 40,
    signedRound: 1,
    expiresRound: 5,
    streakTarget: 3,
    streak: 0,
    ...overrides,
  };
}

describe('sponsorship repo', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    // Yalnızca bu suite'in yarattığı satırları sil — paylaşılan veritabanında
    // başka suite'ler aynı anda `lobbies`/`users` üzerinde çalışıyor olabilir.
    for (const id of createdLobbyIds) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUserIds) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('round-trips a signed sponsorship, numbers intact', async () => {
    const lobbyId = await makeLobby();
    const deal = makeDeal();
    await withTransaction((c) => insertSponsorship(c, lobbyId, 'bosphorus', deal));
    const rows = await loadTeamSponsorships(lobbyId, 'bosphorus');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], deal);
  });

  it('rejects an invalid slot at the database, not just in TypeScript', async () => {
    const lobbyId = await makeLobby();
    await assert.rejects(
      () => query(
        `insert into sponsorships
           (lobby_id, team_key, deal_id, brand_key, slot, per_race, target_position,
            bonus, signed_round, expires_round, streak_target, streak)
         values ($1, 'bosphorus', 'd1', 'northline', 'trunk', 100, 5, 20, 1, 5, 3, 0)`,
        [lobbyId],
      ),
      /violates check constraint/,
    );
  });

  it('rejects an invalid slot tier the same way — enumerations are database-enforced', async () => {
    // slot is the enumerated column actually stored; this proves the check
    // constraint fires on garbage, not merely on a value that happens to be
    // close to a real one.
    const lobbyId = await makeLobby();
    await assert.rejects(
      () => query(
        `insert into sponsorships
           (lobby_id, team_key, deal_id, brand_key, slot, per_race, target_position,
            bonus, signed_round, expires_round, streak_target, streak)
         values ($1, 'bosphorus', 'd1', 'northline', 'SIDEPOD', 100, 5, 20, 1, 5, 3, 0)`,
        [lobbyId],
      ),
      /violates check constraint/,
    );
  });

  it('a team cannot hold two sponsorships in the same slot at once', async () => {
    const lobbyId = await makeLobby();
    await withTransaction((c) => insertSponsorship(c, lobbyId, 'bosphorus', makeDeal()));
    await assert.rejects(
      () => withTransaction((c) => insertSponsorship(
        c, lobbyId, 'bosphorus', makeDeal({ dealId: '2-other-sidepod', brandKey: 'other' }),
      )),
      /duplicate key|violates unique/,
    );
  });

  it('cascades away with its lobby', async () => {
    const lobbyId = await makeLobby();
    await withTransaction((c) => insertSponsorship(c, lobbyId, 'bosphorus', makeDeal()));
    await query('delete from lobbies where id = $1', [lobbyId]);
    const res = await query('select 1 from sponsorships where lobby_id = $1', [lobbyId]);
    assert.equal(res.rowCount, 0);
    // Already deleted — keep the after() cleanup from trying it again.
    createdLobbyIds.splice(createdLobbyIds.indexOf(lobbyId), 1);
  });

  it('advances a streak and reads it back', async () => {
    const lobbyId = await makeLobby();
    await withTransaction((c) => insertSponsorship(c, lobbyId, 'bosphorus', makeDeal()));
    await withTransaction((c) => setStreak(c, lobbyId, 'bosphorus', 'sidepod', 3));
    const rows = await loadTeamSponsorships(lobbyId, 'bosphorus');
    assert.equal(rows[0].streak, 3);
  });

  it('deletes a whole deal by id, releasing every slot it held', async () => {
    const lobbyId = await makeLobby();
    await withTransaction(async (c) => {
      await insertSponsorship(c, lobbyId, 'bosphorus', makeDeal({ slot: 'sidepod' }));
      await insertSponsorship(c, lobbyId, 'bosphorus', makeDeal({ slot: 'halo' }));
    });
    await withTransaction((c) => deleteDeal(c, lobbyId, 'bosphorus', '1-northline-sidepod'));
    assert.equal((await loadTeamSponsorships(lobbyId, 'bosphorus')).length, 0);
  });

  it('loads a team\'s sponsorships in a stable order', async () => {
    const lobbyId = await makeLobby();
    await withTransaction(async (c) => {
      await insertSponsorship(c, lobbyId, 'bosphorus', makeDeal({ slot: 'halo', dealId: 'd-halo' }));
      await insertSponsorship(c, lobbyId, 'bosphorus', makeDeal({ slot: 'coverFront', dealId: 'd-cover' }));
      await insertSponsorship(c, lobbyId, 'bosphorus', makeDeal({ slot: 'sidepod', dealId: 'd-side' }));
    });
    const first = await loadTeamSponsorships(lobbyId, 'bosphorus');
    const second = await loadTeamSponsorships(lobbyId, 'bosphorus');
    assert.deepEqual(first.map((s) => s.slot), second.map((s) => s.slot));
    assert.deepEqual(first.map((s) => s.slot), ['coverFront', 'halo', 'sidepod']);
  });

  it('loads every sponsorship in a lobby across teams', async () => {
    const lobbyId = await makeLobby();
    await withTransaction(async (c) => {
      await insertSponsorship(c, lobbyId, 'bosphorus', makeDeal({ slot: 'sidepod' }));
      await insertSponsorship(c, lobbyId, 'ridgeline', makeDeal({ slot: 'sidepod', dealId: 'other-deal' }));
    });
    assert.equal((await loadLobbySponsorships(lobbyId)).length, 2);
  });
});
