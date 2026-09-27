/**
 * `lobby_drivers` repo — Faz 3b-2 Aşama A: sürücüler sunucuda var.
 *
 * Spec: docs/superpowers/specs/2026-09-27-faz3b2-surucu-personel.md §3, §4.
 * Bu görev yalnızca şema + tohumlama: her takımın iki asıl koltuğu
 * `teams.ts` varsayılanlarından dolduruluyor. Yarışa kablolama (rosters'ın
 * motor tarafına gitmesi) sonraki bir görev.
 *
 * Paylaşılan test veritabanı: yalnızca burada yaratılan lobi/kullanıcı
 * kimlikleri izlenir ve `after`da yalnızca onlar silinir (bkz.
 * `faz3b1-invariants.test.ts`'in aynı kuralı).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { teamByKey } from '@pitwall/shared/teams';
import { seedTeamDrivers, loadTeamDrivers, loadLobbyDrivers } from '../src/drivers/repo.ts';

const createdLobbyIds: string[] = [];
const createdUserIds: string[] = [];
let seq = 0;

async function makeLobby(label: string): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'DriverOwner', provider: 'google', providerUid: `g-drv-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  createdUserIds.push(owner.id);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbyIds.push(lobby.id);
  return lobby.id;
}

describe('lobby_drivers repo', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    if (createdLobbyIds.length) await query(`delete from lobbies where id = any($1::uuid[])`, [createdLobbyIds]);
    if (createdUserIds.length) await query(`delete from users where id = any($1::uuid[])`, [createdUserIds]);
    await closePool();
  });

  it('createLobby fills every team\'s two race seats from teams.ts defaults', async () => {
    const lobbyId = await makeLobby('seed');
    for (const teamKey of SEAT_LADDER) {
      const seats = await loadTeamDrivers(lobbyId, teamKey);
      assert.ok(seats, `${teamKey} has no seated pair`);
      const team = teamByKey(teamKey);
      assert.equal(seats![0].name, team.drivers[0].name);
      assert.equal(seats![1].name, team.drivers[1].name);
    }
  });

  it('a driver cannot occupy two places — the database rejects a second driver in the same seat', async () => {
    const lobbyId = await makeLobby('collision');
    await assert.rejects(
      () =>
        query(
          `insert into lobby_drivers (lobby_id, id, team_key, position, name, number, skill, stats, age, potential)
           values ($1, 'intruder', 'bosphorus', 'seat_0', 'X. Intruder', 99, 50,
                   '{"pace":50,"consistency":50,"racecraft":50,"wet":50,"reaction":50,"dev":50}'::jsonb, 25, 60)`,
          [lobbyId],
        ),
      /duplicate key|unique/i,
    );
  });

  it('reseeding is idempotent and never overwrites an evolved roster', async () => {
    const lobbyId = await makeLobby('evolve');
    await query(
      `update lobby_drivers set skill = 12, stats = jsonb_set(stats, '{pace}', '12') where lobby_id = $1 and id = 'bosphorus:0'`,
      [lobbyId],
    );
    await withTransaction((c) => seedTeamDrivers(c, lobbyId, 'bosphorus'));
    const seats = await loadTeamDrivers(lobbyId, 'bosphorus');
    assert.equal(seats![0].skill, 12, 'reseeding overwrote an evolved skill');
    assert.equal(seats![0].stats.pace, 12, 'reseeding overwrote an evolved stat');
  });

  it('driver stats round-trip byte-identical', async () => {
    const lobbyId = await makeLobby('roundtrip');
    const seats = await loadTeamDrivers(lobbyId, 'aurelia');
    const team = teamByKey('aurelia');
    assert.deepEqual(seats![0].stats, team.drivers[0].stats);
    assert.deepEqual(seats![1].stats, team.drivers[1].stats);
  });

  it('rejects an invalid enumerated position value', async () => {
    const lobbyId = await makeLobby('badposition');
    await assert.rejects(
      () =>
        query(
          `insert into lobby_drivers (lobby_id, id, team_key, position, name, number, skill, stats, age, potential)
           values ($1, 'lowercase-bad', 'bosphorus', 'Seat_0', 'X. Bad', 98, 50,
                   '{"pace":50,"consistency":50,"racecraft":50,"wet":50,"reaction":50,"dev":50}'::jsonb, 25, 60)`,
          [lobbyId],
        ),
      /check constraint|violates/i,
    );
  });

  it('drivers cascade away with their lobby', async () => {
    const owner = await createUserWithIdentity({
      base: 'CascadeOwner', provider: 'google', providerUid: `g-drv-cascade-${++seq}-${Date.now()}`, emailHash: null,
    });
    const lobby = await createLobby(owner.id, {
      region: 'EU', visibility: 'private', aiDifficulty: 'normal',
      rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
    });
    const before = await loadLobbyDrivers(lobby.id);
    assert.ok(before.length > 0);
    await query('delete from lobbies where id = $1', [lobby.id]);
    const after = await loadLobbyDrivers(lobby.id);
    assert.equal(after.length, 0);
    await query('delete from users where id = $1', [owner.id]);
  });
});
