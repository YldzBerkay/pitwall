/**
 * Sürücü YAŞLANMASI ve GELİŞİMİ — Faz 3b-2, sezon dönüşünün kadro geçişi.
 *
 * `rollover.ts`in kış resetine (araç geriler) EKLENEN ikinci parça:
 * `drivers/ageing.ts`in `ageDriversForSeason`ı, AYNI taahhütte, her sürücüyü
 * bir yaş büyütür ve bir AI takımının çiftini potansiyele doğru geliştirir
 * (`shared/driverMarket.ts` `developRosterSeason`). İnsan işgal ettiği bir
 * takım yalnızca yaşlanır — istemcinin kendi oyuncu ikilisine yaptığı gibi
 * (`mobile/src/store/slices/driverSlice.ts` `ageDrivers`): büyüme yalnızca
 * antrenmandan gelir, kış geçişinden değil.
 *
 * PAYLAŞILAN test veritabanı: yalnızca burada yaratılan kimlikler izlenir ve
 * yalnızca onlar silinir (`race-season.test.ts`/`rosters-in-recipe.test.ts`
 * ile aynı desen; `makeLobby`/`claimSeat` oradan birebir kopyalandı).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { rolloverRace } from '../src/lobby/rollover.ts';
import { startRaceFor } from '../src/lobby/runner.ts';
import { loadRun } from '../src/lobby/raceRepo.ts';
import { SEASON_ROUNDS } from '@pitwall/shared/season';
import { ageOneSeason, developRosterSeason } from '@pitwall/shared/driverMarket';
import type { Driver, DriverStats } from '@pitwall/shared/teams';

const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

// İki koltuk da INSAN sayılır (user_id dolu) — `managed` yalnızca hafta
// sonluk bir damga (`checkin.ts`), takımın sahipliğini değiştirmez (bkz.
// `lobbyRepo.ts` `loadHumanTeamKeys`in docblock'u).
const HUMAN = SEAT_LADDER[0];
const ASSISTANT = SEAT_LADDER[1];
// Kimse almadı: AI takımı, gelişimin (`developRosterSeason`) test edildiği yer.
const AI_TEAM = SEAT_LADDER[2];

async function claimSeat(lobbyId: string, teamKey: string, managed: 'human' | 'assistant', tag: string) {
  const user = await createUserWithIdentity({
    base: 'Racer', provider: 'google', providerUid: `g-${tag}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(user.id);
  await query(
    `update lobby_seats set user_id = $3, managed = $4, joined_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, user.id, managed],
  );
}

/** En küçük lobi: bir insan, bir asistan koltuğu (ikisi de INSAN sayılır), gerisi AI. */
async function makeLobby(label = 'Ageing'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(owner.id);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbies.push(lobby.id);
  await claimSeat(lobby.id, HUMAN, 'human', `${label}-h-${seq}`);
  await claimSeat(lobby.id, ASSISTANT, 'assistant', `${label}-a-${seq}`);
  return lobby.id;
}

async function markResult(lobbyId: string, seasonNo: number, roundNo: number) {
  await query(
    `update lobbies set phase = 'result', season_no = $2, round_no = $3 where id = $1`,
    [lobbyId, seasonNo, roundNo],
  );
}

async function lobbyRow(lobbyId: string) {
  const res = await query<{ phase: string; season_no: number; round_no: number }>(
    `select phase, season_no, round_no from lobbies where id = $1`,
    [lobbyId],
  );
  return res.rows[0];
}

interface DriverRow { id: string; team_key: string | null; position: string; age: number; potential: number; skill: number; stats: DriverStats }

async function driverRow(lobbyId: string, id: string): Promise<DriverRow> {
  const res = await query<DriverRow>(`select * from lobby_drivers where lobby_id = $1 and id = $2`, [lobbyId, id]);
  const row = res.rows[0];
  assert.ok(row, `driver row missing: ${id}`);
  return row;
}

/** Testin ihtiyaç duyduğu bilinen bir sürücü durumu kurar — takım
 *  varsayılanlarına bağlı olmadan deterministik ölçüm sağlar. */
async function setDriverFixture(lobbyId: string, id: string, age: number, potential: number, stats: DriverStats) {
  await query(
    `update lobby_drivers set age = $3, potential = $4, stats = $5::jsonb where lobby_id = $1 and id = $2`,
    [lobbyId, id, age, potential, JSON.stringify(stats)],
  );
}

const FIXTURE_STATS: DriverStats = { pace: 60, consistency: 60, racecraft: 60, wet: 60, reaction: 60, dev: 50 };

describe('driver ageing — season rollover ages and develops the roster', () => {
  before(async () => {
    process.env.SESSION_SECRET ??= 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER ??= 'test-pepper-value';
    await runMigrations();
  });
  after(async () => {
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('1. a season rollover ages every driver by one year', async () => {
    const lobbyId = await makeLobby('EveryDriver');
    const before0 = await driverRow(lobbyId, `${HUMAN}:0`);
    const before1 = await driverRow(lobbyId, `${HUMAN}:1`);
    const beforeAi0 = await driverRow(lobbyId, `${AI_TEAM}:0`);
    const beforeAi1 = await driverRow(lobbyId, `${AI_TEAM}:1`);

    await markResult(lobbyId, 1, SEASON_ROUNDS);
    await rolloverRace(lobbyId, 1, SEASON_ROUNDS, new Date());

    const after0 = await driverRow(lobbyId, `${HUMAN}:0`);
    const after1 = await driverRow(lobbyId, `${HUMAN}:1`);
    const afterAi0 = await driverRow(lobbyId, `${AI_TEAM}:0`);
    const afterAi1 = await driverRow(lobbyId, `${AI_TEAM}:1`);

    assert.equal(after0.age, before0.age + 1, 'human seat 0 did not age');
    assert.equal(after1.age, before1.age + 1, 'human seat 1 did not age');
    assert.equal(afterAi0.age, beforeAi0.age + 1, 'AI seat 0 did not age');
    assert.equal(afterAi1.age, beforeAi1.age + 1, 'AI seat 1 did not age');
  });

  it('2. a driver aged 34+ loses pace and reaction per shared\'s rule', async () => {
    const lobbyId = await makeLobby('Decay');
    const id = `${HUMAN}:0`;
    // Sağlanan yaş, sırasıyla shared/src/driverMarket.ts'nin `ageOneSeason`
    // eşiği: 33 -> 34 tam bu geçişte düşüyor.
    await setDriverFixture(lobbyId, id, 33, 90, FIXTURE_STATS);

    await markResult(lobbyId, 1, SEASON_ROUNDS);
    await rolloverRace(lobbyId, 1, SEASON_ROUNDS, new Date());

    const after = await driverRow(lobbyId, id);
    assert.equal(after.age, 34);
    assert.equal(after.stats.pace, 59, 'pace did not fade past 34 per ageOneSeason');
    assert.equal(after.stats.reaction, 59, 'reaction did not fade past 34 per ageOneSeason');
    assert.equal(after.stats.consistency, 60, 'a stat ageOneSeason never touches changed anyway');
  });

  it('3. a young AI-team driver develops toward potential per shared\'s rule', async () => {
    const lobbyId = await makeLobby('Develop');
    const id = `${AI_TEAM}:0`;
    await setDriverFixture(lobbyId, id, 22, 99, FIXTURE_STATS);

    await markResult(lobbyId, 1, SEASON_ROUNDS);
    await rolloverRace(lobbyId, 1, SEASON_ROUNDS, new Date());

    const after = await driverRow(lobbyId, id);
    assert.equal(after.age, 23);
    assert.ok(after.stats.pace > FIXTURE_STATS.pace, 'a young driver with huge headroom did not grow at all');
    assert.ok(after.skill > 60, 'overall skill did not move toward potential');
  });

  it('4. rolling over the same season twice ages drivers exactly once', async () => {
    const lobbyId = await makeLobby('Idempotent');
    const id = `${HUMAN}:0`;
    const before0 = await driverRow(lobbyId, id);

    await markResult(lobbyId, 1, SEASON_ROUNDS);
    await rolloverRace(lobbyId, 1, SEASON_ROUNDS, new Date());
    const once = await driverRow(lobbyId, id);
    assert.equal(once.age, before0.age + 1);

    // İkinci çağrı AYNI (seasonNo, roundNo) ile: lobi artık `result`te değil,
    // UPDATE'in `where`i eşleşmemeli — koruma `rollover.ts`ten miras.
    await rolloverRace(lobbyId, 1, SEASON_ROUNDS, new Date());
    const twice = await driverRow(lobbyId, id);
    assert.equal(twice.age, before0.age + 1, 'a second rollover call aged the same driver twice');
  });

  it('5. deterministic — the same lobby and season always produce the same development', () => {
    const roster: [Driver, Driver] = [
      { name: 'A', number: 1, skill: 60, stats: { ...FIXTURE_STATS }, age: 22, potential: 99 },
      { name: 'B', number: 2, skill: 60, stats: { ...FIXTURE_STATS }, age: 24, potential: 95 },
    ];
    const once = developRosterSeason(roster, 'aurelia', 5, 'lobby-fixed-id');
    const twice = developRosterSeason(roster, 'aurelia', 5, 'lobby-fixed-id');
    assert.deepEqual(once, twice);
  });

  it('6. different lobbies develop differently — the seed is not shared across lobbies', () => {
    const roster: [Driver, Driver] = [
      { name: 'A', number: 1, skill: 60, stats: { ...FIXTURE_STATS }, age: 22, potential: 99 },
      { name: 'B', number: 2, skill: 60, stats: { ...FIXTURE_STATS }, age: 24, potential: 95 },
    ];
    const lobbyA = developRosterSeason(roster, 'aurelia', 5, 'lobby-aaaa');
    const lobbyB = developRosterSeason(roster, 'aurelia', 5, 'lobby-bbbb');
    assert.notDeepEqual(lobbyA, lobbyB, 'two different lobbies developed the same team identically — the seed leaks across lobbies');
  });

  it('7. a failure mid-rollover leaves drivers unaged and the season un-wrapped', async () => {
    const lobbyId = await makeLobby('Crash');
    const probeSeat = `${HUMAN}:1`;
    const siblingSeat = `${HUMAN}:0`;
    const siblingBefore = await driverRow(lobbyId, siblingSeat);

    // Bu satırı `_ageing_probe`ye yeniden adlandırıyoruz ki aşağıdaki tetik
    // TAM olarak `ageDriversForSeason`in bu satıra yazma DENEMESİNDE patlasın
    // — takım/koltuk değişmediği için okuma tarafı (grup anahtarı) etkilenmez.
    await query(`update lobby_drivers set id = '_ageing_probe' where lobby_id = $1 and id = $2`, [lobbyId, probeSeat]);
    await query(`
      create or replace function _ageing_probe_boom() returns trigger as $$
      begin
        if NEW.id = '_ageing_probe' then
          raise exception 'ageing test: deliberate mid-rollover failure';
        end if;
        return NEW;
      end;
      $$ language plpgsql;
    `);
    await query(`
      create trigger _ageing_probe_boom_trigger
        before update on lobby_drivers
        for each row execute function _ageing_probe_boom();
    `);

    try {
      await markResult(lobbyId, 1, SEASON_ROUNDS);
      await assert.rejects(
        rolloverRace(lobbyId, 1, SEASON_ROUNDS, new Date()),
        /deliberate mid-rollover failure/,
      );

      const row = await lobbyRow(lobbyId);
      assert.equal(row.phase, 'result', 'the phase moved on even though the roster pass failed mid-transaction');
      assert.equal(row.season_no, 1, 'the season wrapped even though the roster pass failed mid-transaction');
      assert.equal(row.round_no, SEASON_ROUNDS, 'the round advanced even though the roster pass failed mid-transaction');

      const sibling = await driverRow(lobbyId, siblingSeat);
      assert.equal(sibling.age, siblingBefore.age, 'a sibling seat aged even though the season rollover it belonged to was rolled back');
    } finally {
      await query('drop trigger if exists _ageing_probe_boom_trigger on lobby_drivers');
      await query('drop function if exists _ageing_probe_boom()');
    }
  });

  it('8. a race started after the rollover sees the aged drivers; a race run before it replays unchanged', async () => {
    const lobbyId = await makeLobby('FutureVsPast');
    const now = new Date();

    const before = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: SEASON_ROUNDS, now });
    await markResult(lobbyId, 1, SEASON_ROUNDS);
    await rolloverRace(lobbyId, 1, SEASON_ROUNDS, now);
    const after = await startRaceFor({ lobbyId, seasonNo: 2, roundNo: 1, now });

    assert.notDeepEqual(
      after.snapshot.rosters,
      before.snapshot.rosters,
      'a race started after the rollover did not see the aged/developed rosters',
    );

    const pastRun = await loadRun(lobbyId, 1, SEASON_ROUNDS);
    assert.ok(pastRun, 'the pre-rollover run is missing');
    assert.deepEqual(
      pastRun.snapshot.rosters,
      before.snapshot.rosters,
      'a race run before the rollover changed after the fact',
    );
  });
});
