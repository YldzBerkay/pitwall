/**
 * Sezon ve tur dönüşü — hafta sonu bitince lobinin bir sonrakine geçtiğinin
 * testi.
 *
 * `runner.ts`in `flag()`i `result`e kadar götürüyor ama orada bırakıyor:
 * `result` `acquireDueLobbies`in taradığı evrelerden biri değil (`lease.ts`
 * `DUE_PHASES`), yani ONU ORADAN İTECEK KİMSE YOK. Bu dosya, o itmeyi yapan
 * `rollover.ts`in testidir: `result` → `open` (bir sonraki tur), tur takvimin
 * sonuna gelince sezon artışı, sezon artışında tablo sıfırlanması (aslında
 * `standingsBeforeRound`in `seasonNo`ya göre taradığının doğal sonucu, bkz.
 * `runner.ts`) ve kış reseti (araç geriler, fabrika kalır).
 *
 * PAYLAŞILAN test veritabanı: BAŞKA ajanlar da aynı şemayı kullanıyor. Bu
 * yüzden tablo geneli `delete` YOK — yalnızca burada yaratılan kimlikler
 * izlenir ve yalnızca onlar silinir (`race-runner.test.ts`/`race-settle.test.ts`
 * ile aynı desen).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { startRaceFor } from '../src/lobby/runner.ts';
import { settleRace } from '../src/economy/settle.ts';
import { loadTeamEconomy, setFactoryLevel, bumpCarStat } from '../src/economy/repo.ts';
import { rolloverRace } from '../src/lobby/rollover.ts';
import { freshStandings } from '@pitwall/shared/season';
import { regressCar } from '@pitwall/shared/season';
import { factoryEffects } from '@pitwall/shared/factory';
import { SEASON_ROUNDS } from '@pitwall/shared/season';

const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const HUMAN = SEAT_LADDER[0];
const ASSISTANT = SEAT_LADDER[1];

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

/** Testin ihtiyaç duyduğu en küçük lobi: bir insan, bir asistan koltuğu, gerisi AI. */
async function makeLobby(label = 'Season'): Promise<string> {
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

/** Bir turu ışıklardan bayrağa kadar koşturur ve muhasebeleştirir, ama lobiyi
 *  BİLEREK `result` evresinde bırakır — `flag()`in kendisinin yaptığı gibi. */
async function raceToResult(lobbyId: string, seasonNo: number, roundNo: number, now: Date): Promise<void> {
  await startRaceFor({ lobbyId, seasonNo, roundNo, now });
  await settleRace({ lobbyId, seasonNo, roundNo, now });
  await query(
    `update lobbies set phase = 'result', season_no = $2, round_no = $3 where id = $1`,
    [lobbyId, seasonNo, roundNo],
  );
}

async function lobbyRow(lobbyId: string) {
  const res = await query<{ phase: string; season_no: number; round_no: number; next_race_at: Date }>(
    `select phase, season_no, round_no, next_race_at from lobbies where id = $1`,
    [lobbyId],
  );
  return res.rows[0];
}

describe('race season — the rollover that keeps a lobby racing', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('advances a finished lobby from result to open, next round, future next_race_at', async () => {
    const lobbyId = await makeLobby('advance');
    const now = new Date();
    await raceToResult(lobbyId, 1, 5, now);

    await rolloverRace(lobbyId, 1, 5, now);

    const row = await lobbyRow(lobbyId);
    assert.equal(row.phase, 'open', 'lobby did not return to open');
    assert.equal(row.season_no, 1, 'season should not have changed mid-season');
    assert.equal(row.round_no, 6, 'round did not advance to the next one');
    assert.ok(row.next_race_at.getTime() > now.getTime(), 'next_race_at must be in the future');
  });

  it('rolls the season over at the last round: round back to 1, season +1', async () => {
    const lobbyId = await makeLobby('wrap');
    const now = new Date();
    await raceToResult(lobbyId, 1, SEASON_ROUNDS, now);

    await rolloverRace(lobbyId, 1, SEASON_ROUNDS, now);

    const row = await lobbyRow(lobbyId);
    assert.equal(row.phase, 'open');
    assert.equal(row.round_no, 1, 'round must wrap back to 1');
    assert.equal(row.season_no, 2, 'season must increment');
  });

  it('resets the standings on a season rollover', async () => {
    const lobbyId = await makeLobby('standings');
    const now = new Date();
    // Bir önceki sezonun son yarışı koşulur ve ödenir — tablo artık BOŞ değil.
    await raceToResult(lobbyId, 1, SEASON_ROUNDS, now);

    await rolloverRace(lobbyId, 1, SEASON_ROUNDS, now);

    const row = await lobbyRow(lobbyId);
    assert.equal(row.season_no, 2);
    assert.equal(row.round_no, 1);

    // Yeni sezonun ilk turunun tarifi taze bir tabloyla mı kuruluyor?
    // `standingsBeforeRound` (runner.ts) `seasonNo`ya göre tarıyor; sezon 2
    // round 1'den ÖNCE hiçbir koşu yoktur, dolayısıyla `freshStandings()`e
    // düşmesi gerekir.
    const { snapshot } = await startRaceFor({ lobbyId, seasonNo: 2, roundNo: 1, now });
    assert.deepEqual(snapshot.standings, freshStandings(), 'new season did not start from a fresh table');
  });

  it('regresses car stats on a season rollover but carries factory levels over', async () => {
    const lobbyId = await makeLobby('winter');
    const now = new Date();

    // Bilinen bir fabrika seviyesi ve bilinen bir araç statı kur.
    await withTransaction((c) => setFactoryLevel(c, lobbyId, HUMAN, 'engine_lab', 2));
    await withTransaction((c) => bumpCarStat(c, lobbyId, HUMAN, 'motor', 20));
    const before = (await loadTeamEconomy(lobbyId, HUMAN))!;
    assert.equal(before.factoryLevels.engine_lab, 2);

    await raceToResult(lobbyId, 1, SEASON_ROUNDS, now);
    await rolloverRace(lobbyId, 1, SEASON_ROUNDS, now);

    const after = (await loadTeamEconomy(lobbyId, HUMAN))!;
    assert.deepEqual(after.factoryLevels, before.factoryLevels, 'factory levels must carry over unchanged');

    const floor = factoryEffects(before.factoryLevels).winterFloorBonus;
    const expectedMotor = regressCar(before.car.motor, floor);
    assert.equal(after.car.motor, expectedMotor, 'car stat was not regressed by the shared winter formula');
    assert.notEqual(after.car.motor, before.car.motor, 'a regression that changes nothing proves nothing here');
  });

  it('is idempotent: rolling the same finished lobby twice advances it exactly once', async () => {
    const lobbyId = await makeLobby('idempotent');
    const now = new Date();
    await raceToResult(lobbyId, 1, 10, now);

    await rolloverRace(lobbyId, 1, 10, now);
    const once = await lobbyRow(lobbyId);
    assert.equal(once.round_no, 11);

    // Aynı (seasonNo, roundNo) ile ikinci çağrı: lobi artık `result`te değil
    // (`open`, round 11) ve UPDATE'in kendi `where`i eşleşmemeli.
    await rolloverRace(lobbyId, 1, 10, now);
    const twice = await lobbyRow(lobbyId);
    assert.equal(twice.round_no, 11, 'a second rollover call advanced the lobby a second time');
    assert.equal(twice.phase, 'open');
  });

  it('leaves a lobby that is not in result untouched', async () => {
    const lobbyId = await makeLobby('untouched');
    const now = new Date();
    // Hiç yarış koşulmadı; lobi hâlâ varsayılan `open`, sezon 1 tur 1.

    await rolloverRace(lobbyId, 1, 1, now);

    const row = await lobbyRow(lobbyId);
    assert.equal(row.phase, 'open');
    assert.equal(row.season_no, 1);
    assert.equal(row.round_no, 1, 'a lobby not in result must not be advanced');
  });
});
