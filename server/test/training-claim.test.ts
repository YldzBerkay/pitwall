/**
 * Claiming a training job writes to the driver — Faz 3b-2 Stage B follow-up.
 *
 * `jobs.ts`'s `applyJobEffect` used to have nowhere to write a training
 * result (drivers did not live on the server). Now they do
 * (`drivers/repo.ts`). This file pins that a claim actually improves the
 * targeted seat, by `shared/driverMarket.ts`'s own `trainingGain`, scaled by
 * the driver academy's `trainingScale` (`shared/factory.ts`) — never a
 * private copy of either formula.
 *
 * Only the lobbies/users this file creates are deleted afterwards (tracked
 * in `madeLobbies`/`madeUsers`) — other suites share this database.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { startJob, claimJob } from '../src/economy/jobs.ts';
import { setFactoryLevel } from '../src/economy/repo.ts';
import { loadDriverRow, seatStopgapDriver } from '../src/drivers/repo.ts';
import { loadRun } from '../src/lobby/raceRepo.ts';
import { replayRace } from '../src/lobby/replay.ts';
import { startRaceFor } from '../src/lobby/runner.ts';
import { trainingGain } from '@pitwall/shared/driverMarket';
import { factoryEffects } from '@pitwall/shared/factory';
import { overallOf } from '@pitwall/shared/teams';

let seq = 0;

const madeLobbies: string[] = [];
const madeUsers: string[] = [];

const TEAM = SEAT_LADDER[0];

/** Smallest fixture: a fresh lobby, every team's economy + drivers already
 *  seeded by `createLobby` itself (see `lobbyRepo.ts`'s own `seedTeamDrivers`
 *  call) — no separate driver-seeding step needed here. */
async function makeLobby(label = 'Training'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'Boxbox', provider: 'google', providerUid: `g-train-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  madeUsers.push(owner.id);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  madeLobbies.push(lobby.id);
  return lobby.id;
}

describe('claiming a training job improves the driver', () => {
  before(async () => {
    process.env.SESSION_SECRET ??= 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER ??= 'test-pepper-value';
    await runMigrations();
  });
  after(async () => {
    for (const id of madeLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of madeUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('1. a claim after ends_at improves the targeted seat by shared\'s trainingGain', async () => {
    const lobbyId = await makeLobby('Gain');
    const before = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!;
    const now = new Date('2026-01-01T00:00:00Z');

    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'training', payload: { driverIdx: 0, stat: 'pace' }, now,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const after = new Date(started.endsAt.getTime() + 1000);
    const claimed = await claimJob({ lobbyId, teamKey: TEAM, jobId: started.jobId, now: after });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    // Oracle: shared's own rule, scaled by the (level-0, so 1x) factory effect.
    const expectedGain = Math.round(trainingGain(before.driver, 'pace') * factoryEffects({}).trainingScale * 100) / 100;
    assert.ok(expectedGain > 0, 'fixture produced a zero gain — test proves nothing');
    assert.deepEqual(claimed.applied, { driverIdx: 0, stat: 'pace', gain: expectedGain });

    const row = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!;
    const expectedPace = Math.min(99, Math.round((before.driver.stats.pace + expectedGain) * 100) / 100);
    assert.equal(row.driver.stats.pace, expectedPace, 'the driver row was not updated by the claim');
    assert.equal(row.driver.stats.consistency, before.driver.stats.consistency, 'an untargeted stat moved');
    assert.equal(row.driver.skill, overallOf(row.driver.stats), 'skill was not recomputed from the new stats');
  });

  it('2. the driver academy\'s trainingScale changes the gain', async () => {
    const lobbyId = await makeLobby('Scale');
    // A high driver_academy level so the scale is clearly not 1x.
    await withTransaction((c) => setFactoryLevel(c, lobbyId, TEAM, 'driver_academy', 5));

    const before = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!;
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'training', payload: { driverIdx: 0, stat: 'pace' }, now,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const claimed = await claimJob({ lobbyId, teamKey: TEAM, jobId: started.jobId, now: new Date(started.endsAt.getTime() + 1000) });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const scale = factoryEffects({ driver_academy: 5 }).trainingScale;
    assert.notEqual(scale, 1, 'fixture level produced no scale — test proves nothing');
    const expectedGain = Math.round(trainingGain(before.driver, 'pace') * scale * 100) / 100;
    assert.deepEqual(claimed.applied, { driverIdx: 0, stat: 'pace', gain: expectedGain });

    const unscaledGain = Math.round(trainingGain(before.driver, 'pace') * 100) / 100;
    assert.notEqual(expectedGain, unscaledGain, 'the scaled and unscaled gains happened to match — test cannot show scale mattered');
  });

  it('3. a job claimed twice improves the driver exactly once', async () => {
    const lobbyId = await makeLobby('Twice');
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'training', payload: { driverIdx: 0, stat: 'pace' }, now,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const after = new Date(started.endsAt.getTime() + 1000);

    const first = await claimJob({ lobbyId, teamKey: TEAM, jobId: started.jobId, now: after });
    assert.equal(first.ok, true);
    const paceAfterFirst = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!.driver.stats.pace;

    const second = await claimJob({ lobbyId, teamKey: TEAM, jobId: started.jobId, now: after });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.reason, 'already_claimed');

    const paceAfterSecond = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!.driver.stats.pace;
    assert.equal(paceAfterSecond, paceAfterFirst, 'a repeat claim moved the driver stat again');
  });

  it('4. an unfinished job cannot be claimed and changes nothing', async () => {
    const lobbyId = await makeLobby('Early');
    const before = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!;
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'training', payload: { driverIdx: 0, stat: 'pace' }, now,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const tooEarly = new Date(now.getTime() + 1000);
    const res = await claimJob({ lobbyId, teamKey: TEAM, jobId: started.jobId, now: tooEarly });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'not_ready');

    const after = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!;
    assert.deepEqual(after.driver.stats, before.driver.stats, 'an unclaimed job changed the driver');
  });

  it('5. a stopgap driver cannot be trained', async () => {
    const lobbyId = await makeLobby('Stopgap');
    await withTransaction((c) => seatStopgapDriver(c, lobbyId, TEAM, 0));
    const before = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!;
    assert.equal(before.isStopgap, true, 'fixture failed to seat a stopgap');

    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'training', payload: { driverIdx: 0, stat: 'pace' }, now,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const claimed = await claimJob({ lobbyId, teamKey: TEAM, jobId: started.jobId, now: new Date(started.endsAt.getTime() + 1000) });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const after = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!;
    assert.deepEqual(after.driver.stats, before.driver.stats, 'a stopgap driver was trained');
    assert.equal(after.isStopgap, true);
  });

  it('6. a race started after the claim sees the improved driver; a race run before it replays unchanged', async () => {
    const lobbyId = await makeLobby('Freeze');

    const earlyStart = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const before = replayRace({ seed: earlyStart.seed, round: 1, snapshot: earlyStart.snapshot, decisions: [] });

    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({
      lobbyId, teamKey: TEAM, kind: 'training', payload: { driverIdx: 0, stat: 'pace' }, now,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const claimed = await claimJob({ lobbyId, teamKey: TEAM, jobId: started.jobId, now: new Date(started.endsAt.getTime() + 1000) });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    // The already-run race replays byte-identical — its frozen recipe never
    // saw the claim that landed after its own lights-out.
    const run1 = await loadRun(lobbyId, 1, 1);
    assert.ok(run1, 'round 1 run missing');
    const replayed = replayRace({ seed: run1.seed, round: 1, snapshot: run1.snapshot, decisions: [] });
    assert.deepEqual(replayed.cars, before.cars, 'a post-lights-out training claim reached a race already run');
    assert.deepEqual(replayed.events, before.events);

    // A NEW race, started after the claim, freezes the improved driver.
    const laterStart = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 2, now: new Date() });
    const trainedPace = (await loadDriverRow(lobbyId, TEAM, 'seat_0'))!.driver.stats.pace;
    assert.equal(laterStart.snapshot.rosters[TEAM]?.[0].stats.pace, trainedPace,
      'a race started after the claim did not freeze the improved driver');
    assert.notEqual(
      laterStart.snapshot.rosters[TEAM]?.[0].stats.pace,
      earlyStart.snapshot.rosters[TEAM]?.[0].stats.pace,
      'the later race froze the same, un-trained stat as the earlier one',
    );
  });
});
