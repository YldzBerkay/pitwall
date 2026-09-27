/**
 * Faz 3b-1 "kapanış argümanı" — spec §6'nın sekiz kapısının HER BİRİ için bir
 * test: docs/superpowers/specs/2026-09-27-faz3b1-antrenman-casusluk-kariyer.md.
 *
 * Bu dosya, faza dağılmış testlerin (`practice.test.ts`, `espionage.test.ts`,
 * `race-settle.test.ts`) TEKRARI değil — spesifikasyonun kendi cümleleriyle
 * doğrudan eşleşen, TEK bir yerde toplanmış bir kapanış kanıtı. Her kapının
 * kendi doğrulaması (production'da break/restore ile) ayrı bir görevin
 * parçasıydı; burada yalnızca SONUÇ — kapının hâlâ tuttuğunun kanıtı — kalıcı
 * hale getiriliyor.
 *
 * Paylaşılan test veritabanı: başka dosyalar da aynı şemayı kullanıyor. Bu
 * yüzden tablo geneli `delete` YOK — yalnızca burada yaratılan lobi/kullanıcı
 * kimlikleri izlenir ve yalnızca onlar `after`da silinir (bkz.
 * `espionage.test.ts`/`economy-career-routes.test.ts`'in aynı kuralı).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { loadTeamEconomy, seedTeamEconomy } from '../src/economy/repo.ts';
import { startJob, claimJob } from '../src/economy/jobs.ts';
import { runAction } from '../src/economy/actions.ts';
import { startRaceFor } from '../src/lobby/runner.ts';
import { settleRace, AlreadySettledError } from '../src/economy/settle.ts';
import { loadCareer } from '../src/economy/careerRepo.ts';
import { scoreSeatWeekend } from '../src/economy/weekendAchievements.ts';
import {
  FP1_OFFSET_MS,
  freezeDuePracticeSessions,
  freezePracticeSession,
  loadPracticeRun,
  derivePracticeResult,
} from '../src/lobby/practice.ts';
import { emptyCareer } from '@pitwall/shared/achievements';
import { resolveMission } from '@pitwall/shared/espionage';
import { UPGRADE_GAIN } from '@pitwall/shared/carCustomisation';
import type { MissionOutcome, SpyMission } from '@pitwall/shared/espionage';
import type { FinishEntry, RaceResult, TimedEntry } from '@pitwall/shared/raceEngine';

// ── Yaratılan kimlikler — YALNIZCA bunlar silinir (bkz. dosya docblock'u) ──
const createdLobbyIds: string[] = [];
const createdUserIds: string[] = [];
let seq = 0;

async function makeEconomyLobby(label: string): Promise<{ lobbyId: string; ownerId: string }> {
  const owner = await createUserWithIdentity({
    base: 'Invariant', provider: 'google', providerUid: `g-inv-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  createdUserIds.push(owner.id);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbyIds.push(lobby.id);
  return { lobbyId: lobby.id, ownerId: owner.id };
}

/** Gives `teamKey` a human-managed seat with a real car, so `buildFrozenEntries`
 *  (and therefore practice) actually includes it — an unseated/AI team, or
 *  one with no economy row, is skipped. Copied from `practice.test.ts`'s
 *  own `addHumanSeat`. */
async function addHumanPracticeSeat(lobbyId: string, teamKey: string): Promise<void> {
  const owner = await createUserWithIdentity({
    base: 'PracDriver', provider: 'google', providerUid: `g-pracdriver-${++seq}-${Date.now()}`, emailHash: null,
  });
  createdUserIds.push(owner.id);
  await query(
    `insert into lobby_seats (lobby_id, team_key, user_id, managed) values ($1, $2, $3, 'human')`,
    [lobbyId, teamKey, owner.id],
  );
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, teamKey));
}

async function setCar(lobbyId: string, teamKey: string, value: number): Promise<void> {
  await query(
    `update lobby_economy set car = $3::jsonb where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, JSON.stringify({ motor: value, aero: value, grip: value })],
  );
}

/** Brute-forces the smallest `startedRound` for which `resolveMission` (a
 *  pure, seeded function — no DB) yields `desired`, for a FIXED lobby/season/
 *  team combination. Mirrors what `espionage.test.ts`'s offline-pinned
 *  constants do, but computed at test time against THIS suite's own
 *  (randomly created) lobby id rather than a hardcoded uuid — so this file
 *  never has to share a fixture id with another suite. */
function findRoundFor(
  desired: MissionOutcome, lobbyId: string, ownTeam: string, targetTeam: string, season: number,
  targetStronger: boolean,
): number {
  for (let round = 1; round < 5000; round += 1) {
    const mission: SpyMission = {
      id: 'brute-force', targetTeam, stat: 'motor', agent: 'free',
      startedRound: round, startedAt: 0, endsAt: 0, lobbyId, season, ownTeam,
    };
    if (resolveMission(mission, false, targetStronger) === desired) return round;
  }
  throw new Error(`findRoundFor: no round under 5000 resolves to ${desired}`);
}

describe('Faz 3b-1 — kapanış argümanı (spec §6, sekiz kapı)', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    if (createdLobbyIds.length) await query(`delete from lobbies where id = any($1::uuid[])`, [createdLobbyIds]);
    if (createdUserIds.length) await query(`delete from users where id = any($1::uuid[])`, [createdUserIds]);
    await closePool();
  });

  // ── 1) Antrenman herkese aynı ────────────────────────────────────────────
  it('1) practice is the same for everyone — two independent reads of the same session match', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const owner = await createUserWithIdentity({
      base: 'PracOwner', provider: 'google', providerUid: `g-prac1-${++seq}-${Date.now()}`, emailHash: null,
    });
    createdUserIds.push(owner.id);
    const res = await query<{ id: string }>(
      `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                            rank_min, rank_max, guests_can_invite, mid_season_join,
                            creator_user_id, next_race_at, round_no)
       values ('P1 #1', 'P1', 1, 'EU', 'private', 'normal', 1, 10, false, true, $1, $2, 1)
       returning id`,
      [owner.id, raceAt],
    );
    const lobbyId = res.rows[0].id;
    createdLobbyIds.push(lobbyId);
    await addHumanPracticeSeat(lobbyId, SEAT_LADDER[0]);

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    await freezeDuePracticeSessions(fp1At);

    // Two independent reads — as if two different players' devices asked the
    // server for the same session's timesheet — must derive byte-identical
    // results from the same stored recipe.
    const readA = await loadPracticeRun(lobbyId, 1, 1, 1);
    const readB = await loadPracticeRun(lobbyId, 1, 1, 1);
    assert.ok(readA && readB, 'FP1 did not freeze');
    const resultA = derivePracticeResult(readA!);
    const resultB = derivePracticeResult(readB!);
    assert.deepEqual(resultA, resultB, 'two independent reads of the same practice session produced different timesheets');
  });

  // ── 2) Antrenman seans başında donuyor ───────────────────────────────────
  it('2) practice freezes at session start — re-freezing must never overwrite the stored recipe', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const owner = await createUserWithIdentity({
      base: 'PracOwner', provider: 'google', providerUid: `g-prac2-${++seq}-${Date.now()}`, emailHash: null,
    });
    createdUserIds.push(owner.id);
    const res = await query<{ id: string }>(
      `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                            rank_min, rank_max, guests_can_invite, mid_season_join,
                            creator_user_id, next_race_at, round_no)
       values ('P2 #1', 'P2', 1, 'EU', 'private', 'normal', 1, 10, false, true, $1, $2, 1)
       returning id`,
      [owner.id, raceAt],
    );
    const lobbyId = res.rows[0].id;
    createdLobbyIds.push(lobbyId);
    const TEAM = SEAT_LADDER[0];
    await addHumanPracticeSeat(lobbyId, TEAM);
    await query(`update lobby_seats set compound = 'SOFT' where lobby_id = $1 and team_key = $2`, [lobbyId, TEAM]);

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    await freezeDuePracticeSessions(fp1At);
    const before = await loadPracticeRun(lobbyId, 1, 1, 1);
    assert.ok(before, 'FP1 did not freeze');
    assert.equal(before!.entries[TEAM]?.setup.compound, 'SOFT');
    const resultBefore = derivePracticeResult(before!);

    // Simulate a change to the field AFTER the session already froze — the
    // seated team's tyre choice — then re-invoke the freeze call directly (as
    // a second scheduler tick, or a race with itself, might).
    await query(`update lobby_seats set compound = 'HARD' where lobby_id = $1 and team_key = $2`, [lobbyId, TEAM]);
    await freezePracticeSession(lobbyId, 1, 1, 1, fp1At);

    const after = await loadPracticeRun(lobbyId, 1, 1, 1);
    assert.ok(after);
    assert.deepEqual(after!.entries, before!.entries, 'a re-freeze changed the already-frozen entries');
    assert.deepEqual(derivePracticeResult(after!), resultBefore, 'a re-freeze changed an already-frozen session\'s result');
  });

  // ── 3) Casusluk sonucu istemciden gelmiyor ───────────────────────────────
  it("3) the espionage outcome does not come from the client — a forged 'outcome' in the claim payload is ignored", async () => {
    const { lobbyId, ownerId } = await makeEconomyLobby('spy3');
    const OWN = SEAT_LADDER[0];
    const TARGET = SEAT_LADDER[1];
    await setCar(lobbyId, OWN, 30);
    await setCar(lobbyId, TARGET, 90);
    const round = findRoundFor('caught', lobbyId, OWN, TARGET, 1, true);
    // `startSpyMission` captures `startedRound`/`season` from the lobby's OWN
    // row at start time (`actions.ts`), not from anything the test passes in
    // the body — so the round the seed must be pinned to is set on the lobby
    // itself, before the action runs.
    await query(`update lobbies set round_no = $2 where id = $1`, [lobbyId, round]);
    const now = new Date('2026-01-01T00:00:00Z');

    const started = await runAction({
      lobbyId, userId: ownerId, teamKey: OWN, now,
      body: { type: 'startSpyMission', targetTeam: TARGET, stat: 'motor', agent: 'free' },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const job = started.state.jobs.find((j) => j.kind === 'spy');
    assert.ok(job, 'no spy job in the returned slot state');

    const claimAt = new Date(now.getTime() + 25 * 60 * 60 * 1000); // past the 24h resolve window
    const claimed = await runAction({
      lobbyId, userId: ownerId, teamKey: OWN, now: claimAt,
      body: {
        type: 'claimSpyReport', jobId: job!.jobId,
        // Forged fields a malicious client might send — every one of them
        // must be dropped on the floor, never echoed back.
        outcome: 'success', fine: 0, targetTeam: 'bad-team',
      },
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.ok(claimed.spyResult, 'claimSpyReport returned no spyResult');
    assert.equal(claimed.spyResult!.outcome, 'caught', 'the resolved outcome was not the server-computed one');
    assert.ok((claimed.spyResult!.fine ?? 0) > 0, 'a caught mission must report a real, nonzero fine');
    assert.notEqual(claimed.spyResult!.targetTeam, 'bad-team', 'the forged targetTeam leaked through');
  });

  // ── 4) Casusluk artık kilitlenmiyor ──────────────────────────────────────
  it('4) espionage no longer locks — an expired mission resolves on claim, and a new one can start after it', async () => {
    const { lobbyId } = await makeEconomyLobby('spy4');
    const OWN = SEAT_LADDER[0];
    const TARGET = SEAT_LADDER[1];
    await setCar(lobbyId, OWN, 90);
    await setCar(lobbyId, TARGET, 40);
    const now = new Date('2026-02-01T00:00:00Z');

    const spy = await startJob({
      lobbyId, teamKey: OWN, kind: 'spy',
      payload: { targetTeam: TARGET, stat: 'motor', agent: 'free', startedRound: 1, season: 1 },
      now,
    });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;

    // Far past the 24h resolve window — the old client bug left a mission
    // like this permanently unresolved and blocking every new one.
    const longAfter = new Date(spy.endsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const claimed = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: longAfter });
    assert.equal(claimed.ok, true, 'an expired mission must still resolve when claimed');
    if (!claimed.ok) return;
    assert.ok(
      ['success', 'nothing', 'badIntel', 'caught', 'blocked'].includes(claimed.applied['outcome'] as string),
      'claim did not resolve to one of the defined outcomes',
    );

    const tooSoon = new Date(spy.endsAt.getTime() + 47 * 60 * 60 * 1000);
    const blocked = await startJob({
      lobbyId, teamKey: OWN, kind: 'spy',
      payload: { targetTeam: TARGET, stat: 'motor', agent: 'free', startedRound: 1, season: 1 },
      now: tooSoon,
    });
    assert.equal(blocked.ok, false);

    const afterCooldown = new Date(spy.endsAt.getTime() + 48 * 60 * 60 * 1000 + 1000);
    const started2 = await startJob({
      lobbyId, teamKey: OWN, kind: 'spy',
      payload: { targetTeam: TARGET, stat: 'motor', agent: 'free', startedRound: 1, season: 1 },
      now: afterCooldown,
    });
    assert.equal(started2.ok, true, 'a new mission could not start after the claimed one plus its cooldown');
  });

  // ── 5) Başarılı istihbarat bir sonraki yükseltmeyi büyütüyor, YALNIZCA BİR KEZ ──
  it('5) successful intel enlarges the NEXT upgrade of that stat, exactly once', async () => {
    const { lobbyId } = await makeEconomyLobby('spy5');
    const OWN = SEAT_LADDER[0];
    const TARGET = SEAT_LADDER[1];
    await setCar(lobbyId, OWN, 30);
    await setCar(lobbyId, TARGET, 90);
    const round = findRoundFor('success', lobbyId, OWN, TARGET, 1, true);
    const now = new Date('2026-03-01T00:00:00Z');

    const spy = await startJob({
      lobbyId, teamKey: OWN, kind: 'spy',
      payload: { targetTeam: TARGET, stat: 'motor', agent: 'free', startedRound: round, season: 1 },
      now,
    });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
    const spyClaim = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(spyClaim.ok, true);
    if (!spyClaim.ok) return;
    assert.equal(spyClaim.applied['outcome'], 'success');

    // First upgrade of `motor` — boosted.
    const up1 = await startJob({ lobbyId, teamKey: OWN, kind: 'upgrade', payload: { stat: 'motor' }, now: spy.endsAt });
    assert.equal(up1.ok, true);
    if (!up1.ok) return;
    const claim1 = await claimJob({ lobbyId, teamKey: OWN, jobId: up1.jobId, now: up1.endsAt });
    assert.equal(claim1.ok, true);
    if (!claim1.ok) return;
    assert.equal(claim1.applied['gain'], UPGRADE_GAIN * 1.5, 'the first upgrade after success was not boosted by SPY_BOOST');

    // Second upgrade of `motor` — the boost must already be consumed.
    const up2 = await startJob({ lobbyId, teamKey: OWN, kind: 'upgrade', payload: { stat: 'motor' }, now: up1.endsAt });
    assert.equal(up2.ok, true);
    if (!up2.ok) return;
    const claim2 = await claimJob({ lobbyId, teamKey: OWN, jobId: up2.jobId, now: up2.endsAt });
    assert.equal(claim2.ok, true);
    if (!claim2.ok) return;
    assert.equal(claim2.applied['gain'], UPGRADE_GAIN, 'the boost applied to a SECOND upgrade — it must be consumed exactly once');
  });

  // ── 6) Yakalanma cezası bildirilen = düşülen ─────────────────────────────
  it('6) the caught fine reported equals the RP actually deducted (including when floored)', async () => {
    const { lobbyId } = await makeEconomyLobby('spy6');
    const OWN = SEAT_LADDER[0];
    const TARGET = SEAT_LADDER[1];
    await setCar(lobbyId, OWN, 30);
    await setCar(lobbyId, TARGET, 90);
    const round = findRoundFor('caught', lobbyId, OWN, TARGET, 1, true);
    const now = new Date('2026-04-01T00:00:00Z');

    const spy = await startJob({
      lobbyId, teamKey: OWN, kind: 'spy',
      payload: { targetTeam: TARGET, stat: 'motor', agent: 'free', startedRound: round, season: 1 },
      now,
    });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;

    // Force the floor: a balance far below what the nominal fine would ask for.
    await query(`update lobby_economy set rp = 10 where lobby_id = $1 and team_key = $2`, [lobbyId, OWN]);
    const rpBefore = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    assert.equal(rpBefore, 10);

    const claimed = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.equal(claimed.applied['outcome'], 'caught');

    const rpAfter = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    const actuallyDeducted = rpBefore - rpAfter;
    assert.equal(rpAfter, 0, 'a floored charge must never go negative');
    assert.equal(claimed.applied['fine'], actuallyDeducted, 'the reported fine did not equal the RP actually deducted');
  });

  // ── 7) Kariyer idempotent ────────────────────────────────────────────────
  it('7) career is idempotent — the same race never writes the career twice', async () => {
    const owner = await createUserWithIdentity({
      base: 'CareerRacer', provider: 'google', providerUid: `g-career7-${++seq}-${Date.now()}`, emailHash: null,
    });
    createdUserIds.push(owner.id);
    const lobby = await createLobby(owner.id, {
      region: 'EU', visibility: 'private', aiDifficulty: 'normal',
      rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
    });
    createdLobbyIds.push(lobby.id);

    const HUMAN = SEAT_LADDER[0];
    const human = await createUserWithIdentity({
      base: 'CareerSeat', provider: 'google', providerUid: `g-careerseat7-${++seq}-${Date.now()}`, emailHash: null,
    });
    createdUserIds.push(human.id);
    await query(
      `update lobby_seats set user_id = $3, managed = 'human', joined_at = now()
       where lobby_id = $1 and team_key = $2`,
      [lobby.id, HUMAN, human.id],
    );

    assert.deepEqual(await loadCareer(human.id), emptyCareer(), 'career must start empty');

    await startRaceFor({ lobbyId: lobby.id, seasonNo: 1, roundNo: 1, now: new Date() });
    await settleRace({ lobbyId: lobby.id, seasonNo: 1, roundNo: 1, now: new Date() });
    const afterFirst = await loadCareer(human.id);
    assert.equal(afterFirst.races, 1, 'the first settlement did not advance the career');

    await assert.rejects(
      () => settleRace({ lobbyId: lobby.id, seasonNo: 1, roundNo: 1, now: new Date() }),
      AlreadySettledError,
    );
    const afterSecond = await loadCareer(human.id);
    assert.deepEqual(afterSecond, afterFirst, 'a second settlement of the same race advanced the career again');
    assert.equal(afterSecond.races, 1);
  });

  // ── 8) Clean Sweep hesaplanabiliyor ──────────────────────────────────────
  it('8) Clean Sweep is computable — awarded only to the seat that led every practice session, qualifying, and the race', async () => {
    const WINNER = 'aurelia';
    const OTHER = 'silberpfad';

    const winnerFinish: FinishEntry = {
      teamKey: WINNER, driverIdx: 0, driver: 'W. Inner', position: 1, gridPosition: 1,
      dnf: false, lapsLed: 30, bestLapSec: 80, stops: 1, gapSec: 0,
    };
    const otherFinish: FinishEntry = {
      teamKey: OTHER, driverIdx: 0, driver: 'O. Ther', position: 2, gridPosition: 2,
      dnf: false, lapsLed: 5, bestLapSec: 81, stops: 1, gapSec: 3,
    };
    const race: RaceResult = {
      order: [winnerFinish, otherFinish],
      playerFinish: 1,
      playerFinishes: [1, 0],
      standings: [],
      wet: false,
      fastestLap: { teamKey: WINNER, driver: 'W. Inner', sec: 80, lap: 20 },
      pole: { teamKey: WINNER, driverIdx: 0, driver: 'W. Inner' },
      laps: 50,
      session: 'race',
      control: { yellow: 0, vsc: 0, sc: 0, red: 0 },
    };
    const qualifyingGrid: TimedEntry[] = [
      { teamKey: WINNER, driverIdx: 0, driver: 'W. Inner', sec: 79 },
      { teamKey: OTHER, driverIdx: 0, driver: 'O. Ther', sec: 79.5 },
    ];
    const led = (team: string): TimedEntry[] => [{ teamKey: team, driverIdx: 0, driver: 'X', sec: 80 }];

    // Positive: the winning seat led all three practice sessions too.
    const allLed = scoreSeatWeekend(
      { race, qualifyingGrid, practiceSessions: [led(WINNER), led(WINNER), led(WINNER)], sprint: false },
      WINNER,
    );
    assert.ok(allLed.earned.includes('cleanSweep'), 'Clean Sweep was not awarded to a seat that led everything');

    // Negative: the SAME winner, but session 2 was led by another team.
    const oneMissed = scoreSeatWeekend(
      { race, qualifyingGrid, practiceSessions: [led(WINNER), led(OTHER), led(WINNER)], sprint: false },
      WINNER,
    );
    assert.ok(!oneMissed.earned.includes('cleanSweep'), 'Clean Sweep was awarded despite not leading every practice session');
  });
});
