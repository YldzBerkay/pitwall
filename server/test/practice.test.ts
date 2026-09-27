import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { seedTeamEconomy } from '../src/economy/repo.ts';
import { carId } from '@pitwall/shared/raceEngine';
import {
  FP1_OFFSET_MS, FP2_OFFSET_MS, FP3_OFFSET_MS, SPRINT_PRACTICE_OFFSET_MS,
  practiceCount, freezeDuePracticeSessions, freezePracticeSession,
  loadPracticeRun, loadPracticeRuns, derivePracticeResult,
} from '../src/lobby/practice.ts';

let seq = 0;

/** A non-sprint round (verified via trackForRound). */
const NORMAL_ROUND = 1;
/** A sprint round (verified via trackForRound) — single practice session. */
const SPRINT_ROUND = 5;

const TEAM = 'bosphorus';

/** Smallest lobby this suite needs. Copied from economy-repo.test.ts's
 *  `makeLobby` and extended with a `nextRaceAt`/`roundNo` the caller controls. */
async function makeLobby(opts: { nextRaceAt: Date; roundNo?: number; label?: string }): Promise<string> {
  const label = opts.label ?? 'Practice';
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at, round_no)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4, $5, $6)
     returning id`,
    [`${label} #${seq}`, label, seq, owner.id, opts.nextRaceAt, opts.roundNo ?? NORMAL_ROUND],
  );
  return res.rows[0].id;
}

/** Gives `TEAM` a human-managed seat with a real car, so `buildFrozenEntries`
 *  actually includes it (an AI seat, or a seat with no economy row, is
 *  skipped — see `runner.ts` `buildFrozenEntries`). */
async function addHumanSeat(lobbyId: string, teamKey = TEAM): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'Driver', provider: 'google', providerUid: `d-${++seq}`, emailHash: null,
  });
  await query(
    `insert into lobby_seats (lobby_id, team_key, user_id, managed) values ($1, $2, $3, 'human')`,
    [lobbyId, teamKey, owner.id],
  );
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, teamKey));
  return owner.id;
}

async function setCompound(lobbyId: string, teamKey: string, compound: string): Promise<void> {
  await query(`update lobby_seats set compound = $3 where lobby_id = $1 and team_key = $2`, [lobbyId, teamKey, compound]);
}

describe('practice sessions', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from lobbies');
    await query('delete from users');
  });
  after(async () => { await closePool(); });

  it('freezes a session once its scheduled time arrives', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby({ nextRaceAt: raceAt });
    await addHumanSeat(lobbyId);

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    // Not due yet, one second before FP1.
    await freezeDuePracticeSessions(new Date(fp1At.getTime() - 1000));
    assert.equal(await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 1), null, 'froze before its scheduled time');

    // Due now.
    const result = await freezeDuePracticeSessions(fp1At);
    assert.equal(result.frozen, 1);
    const run = await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 1);
    assert.ok(run, 'FP1 was not frozen at its scheduled time');
    assert.ok(run.entries[TEAM], 'the seated team is missing from the frozen entries');

    // FP2/FP3 are not due yet.
    assert.equal(await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 2), null);
    assert.equal(await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 3), null);
  });

  it('a setup change after a session started does not change its frozen result', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby({ nextRaceAt: raceAt });
    await addHumanSeat(lobbyId);
    await setCompound(lobbyId, TEAM, 'SOFT');

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    await freezeDuePracticeSessions(fp1At);
    const before = await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 1);
    assert.ok(before);
    const resultBefore = derivePracticeResult(before);

    // Change the setup AFTER FP1 already froze.
    await setCompound(lobbyId, TEAM, 'HARD');

    const after = await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 1);
    assert.ok(after);
    assert.deepEqual(after.entries, before.entries, 'a post-freeze setup change leaked into the frozen entries');
    const resultAfter = derivePracticeResult(after);
    assert.deepEqual(resultAfter, resultBefore, 'a post-freeze setup change changed an already-frozen session');
  });

  it('a setup change between sessions does affect the next session', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby({ nextRaceAt: raceAt });
    await addHumanSeat(lobbyId);
    await setCompound(lobbyId, TEAM, 'SOFT');

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    await freezeDuePracticeSessions(fp1At);
    const fp1 = await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 1);
    assert.ok(fp1);

    await setCompound(lobbyId, TEAM, 'HARD');

    const fp2At = new Date(raceAt.getTime() - FP2_OFFSET_MS);
    await freezeDuePracticeSessions(fp2At);
    const fp2 = await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 2);
    assert.ok(fp2);

    assert.notEqual(fp1.entries[TEAM].setup.compound, fp2.entries[TEAM].setup.compound,
      'the setup change between sessions did not reach the next session');

    const id = carId({ teamKey: TEAM, driverIdx: 0, driver: '' });
    const secFp1 = derivePracticeResult(fp1).order.find((e) => carId(e) === id)?.sec;
    const secFp2 = derivePracticeResult(fp2).order.find((e) => carId(e) === id)?.sec;
    assert.ok(secFp1 !== undefined && secFp2 !== undefined);
    assert.notEqual(secFp1, secFp2, 'a compound change between sessions produced identical lap times');
  });

  it('deriving the result from the same frozen session twice agrees', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby({ nextRaceAt: raceAt });
    await addHumanSeat(lobbyId);

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    await freezeDuePracticeSessions(fp1At);
    const run = await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 1);
    assert.ok(run);
    assert.deepEqual(derivePracticeResult(run), derivePracticeResult(run));
  });

  it('a session cannot be frozen twice, even under concurrent callers with no shared state', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby({ nextRaceAt: raceAt });
    await addHumanSeat(lobbyId);
    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);

    // Warm the pool: an unwarmed pool serializes connection setup and only
    // a handful of the "concurrent" callers actually reach the contended
    // window together — see server/README.md's own note on this (also
    // called out in this task's brief). Ten throwaway queries force the
    // pool to actually open its connections before the real race starts.
    await Promise.all(Array.from({ length: 10 }, () => query('select 1')));

    const CONCURRENCY = 30;
    let reached = 0;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        freezePracticeSession(lobbyId, 1, NORMAL_ROUND, 1, fp1At, () => { reached += 1; })),
    );

    const wins = results.filter(Boolean).length;
    assert.equal(wins, 1, `expected exactly one caller to freeze the session, got ${wins} of ${CONCURRENCY}`);
    console.log(`[concurrency] ${CONCURRENCY} callers dispatched, ${reached} reached freezePracticeSession, ${wins} won the insert`);

    const run = await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 1);
    assert.ok(run);
  });

  it('a sprint weekend has exactly one practice session', async () => {
    assert.equal(practiceCount(true), 1);
    assert.equal(practiceCount(false), 3);

    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby({ nextRaceAt: raceAt, roundNo: SPRINT_ROUND });
    await addHumanSeat(lobbyId);

    const spAt = new Date(raceAt.getTime() - SPRINT_PRACTICE_OFFSET_MS);
    await freezeDuePracticeSessions(spAt);

    const runs = await loadPracticeRuns(lobbyId, 1, SPRINT_ROUND);
    assert.equal(runs.length, 1, 'a sprint weekend must freeze exactly one session');
    assert.equal(runs[0].sessionNo, 1);

    // No second session ever becomes due for a sprint weekend, even at the
    // race instant itself.
    await freezeDuePracticeSessions(raceAt);
    assert.equal((await loadPracticeRuns(lobbyId, 1, SPRINT_ROUND)).length, 1);
  });

  it('no session is frozen outside the open phase', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby({ nextRaceAt: raceAt });
    await addHumanSeat(lobbyId);
    await query(`update lobbies set phase = 'checkin' where id = $1`, [lobbyId]);

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    await freezeDuePracticeSessions(fp1At);
    assert.equal(await loadPracticeRun(lobbyId, 1, NORMAL_ROUND, 1), null,
      'a session froze even though the lobby was not in the open phase');
  });
});
