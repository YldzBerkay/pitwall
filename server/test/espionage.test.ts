/**
 * Espionage resolves on the SERVER, not the client.
 *
 * Faz 3b-1, task 1. The outcome roll (`resolveMission`, `shared/src/espionage.ts`)
 * is already a pure function there — this suite proves the server drives it
 * from values it knows itself (never from the client's payload), applies its
 * effect exactly once, charges the caught fine through `chargeRpFloor`, and
 * enforces the 48h cooldown.
 *
 * The lobby-creation helper is copied from `economy-repo.test.ts`. Unlike
 * that file (and `economy-jobs.test.ts`), this suite does NOT truncate
 * shared tables in `beforeEach` — other suites' fixtures live in the same
 * database. Only the ids this file creates are tracked and deleted, in
 * `after`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { seedTeamEconomy, loadTeamEconomy } from '../src/economy/repo.ts';
import { startJob, claimJob } from '../src/economy/jobs.ts';
import { runAction } from '../src/economy/actions.ts';
import { bumpGarageHide } from '../src/economy/espionageRepo.ts';
import { runRivalEspionage } from '../src/economy/settle.ts';
import type { Seat } from '../src/lobby/lobbyRepo.ts';
import { FREE_AGENT_RP, RIVAL_GAIN, missionSeed, resolveMission, type SpyMission } from '@pitwall/shared/espionage';
import { goldPrices, rpPrices } from '@pitwall/shared/economy';

let seq = 0;
const createdLobbyIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * Verified lobby-creation helper, copied from `economy-repo.test.ts`. Takes
 * an optional explicit `id`: `resolveMission`'s seed now folds in `lobbyId`
 * (see `shared/src/espionage.ts`'s docblock), so a test that needs a SPECIFIC
 * outcome deterministically must control the real lobby id the roll is seeded
 * on, not just the round — a random one would make the outcome random too.
 */
async function makeLobby(label = 'Spy', id?: string): Promise<{ lobbyId: string; userId: string }> {
  const n = ++seq;
  const owner = await createUserWithIdentity({
    base: 'SpyMaster', provider: 'google', providerUid: `g-spy-${n}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    id
      ? `insert into lobbies (id, name, name_base, name_seq, region, visibility, ai_difficulty,
                            rank_min, rank_max, guests_can_invite, mid_season_join,
                            creator_user_id, next_race_at)
         values ($5, $1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
                 now() + interval '1 day')
         returning id`
      : `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                            rank_min, rank_max, guests_can_invite, mid_season_join,
                            creator_user_id, next_race_at)
         values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
                 now() + interval '1 day')
         returning id`,
    id ? [`${label} #${n}`, label, n, owner.id, id] : [`${label} #${n}`, label, n, owner.id],
  );
  const lobbyId = res.rows[0].id;
  createdLobbyIds.push(lobbyId);
  createdUserIds.push(owner.id);
  return { lobbyId, userId: owner.id };
}

const OWN = 'bosphorus';
const TARGET = 'ridgeline'; // 9 chars — length feeds `resolveMission`'s seed.

async function setup(lobbyId: string): Promise<void> {
  await withTransaction(async (c) => {
    await seedTeamEconomy(c, lobbyId, OWN);
    await seedTeamEconomy(c, lobbyId, TARGET);
  });
}

async function setCar(lobbyId: string, teamKey: string, value: number): Promise<void> {
  await query(
    `update lobby_economy set car = $3::jsonb where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, JSON.stringify({ motor: value, aero: value, grip: value })],
  );
}

/** Own weaker than target: `resolveMission`'s "target genuinely stronger" branch. */
async function makeTargetStronger(lobbyId: string): Promise<void> {
  await setCar(lobbyId, OWN, 40);
  await setCar(lobbyId, TARGET, 90);
}

async function makeTargetWeaker(lobbyId: string): Promise<void> {
  await setCar(lobbyId, OWN, 90);
  await setCar(lobbyId, TARGET, 40);
}

/**
 * Round pinned for tests that don't care WHICH outcome they get, only that
 * claiming succeeds and returns one of the defined ones — no specific lobby
 * id is needed for these.
 */
const ROUND_SUCCESS = 1;

/**
 * (lobbyId, round) pairs pinned by brute-forcing `resolveMission`'s
 * deterministic roll offline, for (targetTeam='ridgeline', agent='free',
 * season=1, ownTeam='bosphorus') — see the task's step-1 notes. Every
 * lobby id below is passed as `makeLobby`'s explicit `id`, so the roll these
 * tests exercise is under this file's control, not the database's random
 * default.
 *
 * `resolveMission`'s seed now folds in `lobbyId`/`season`/`ownTeam`
 * (`shared/src/espionage.ts`), which is exactly what closes the exploit this
 * task exists to close — but it also means a round number ALONE no longer
 * pins an outcome; the (lobby, round) PAIR does.
 */
const PIN_NOTHING = { id: '00000000-0000-4000-8000-000000000003', round: 1 }; // targetStronger=false -> 'nothing'
const PIN_SUCCESS = { id: '00000000-0000-4000-8000-000000000300', round: 3 }; // targetStronger=true -> 'success'
const PIN_BAD_INTEL = { id: '00000000-0000-4000-8000-000000000301', round: 5 }; // targetStronger=true -> 'badIntel'
const PIN_CAUGHT_A = { id: '00000000-0000-4000-8000-000000000302', round: 7 }; // targetStronger=true -> 'caught'
const PIN_CAUGHT_B = { id: '00000000-0000-4000-8000-000000000303', round: 12 }; // targetStronger=true -> 'caught'
const PIN_CAUGHT_C = { id: '00000000-0000-4000-8000-000000000304', round: 8 }; // targetStronger=true -> 'caught'

function spyPayload(startedRound: number, agent: 'free' | 'premium' = 'free') {
  return { targetTeam: TARGET, stat: 'motor' as const, agent, startedRound, season: 1 };
}

describe('espionage — resolved server-side', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    for (const id of createdLobbyIds) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUserIds) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('1) a claimed mission resolves to one of the defined outcomes', async () => {
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_SUCCESS), now });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const claimed = await claimJob({ lobbyId, teamKey: OWN, jobId: started.jobId, now: started.endsAt });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    const outcome = claimed.applied['outcome'];
    assert.ok(
      ['success', 'nothing', 'badIntel', 'caught', 'blocked'].includes(outcome as string),
      `unexpected outcome: ${JSON.stringify(outcome)}`,
    );
  });

  it("2) ignores a client-supplied 'outcome' in the start payload", async () => {
    const { lobbyId, userId } = await makeLobby('Spy', PIN_NOTHING.id);
    await setup(lobbyId);
    // Round 1 with the target genuinely WEAKER resolves deterministically to
    // 'nothing' (same seed/roll as the success case, different interpretation
    // — see shared/src/espionage.ts's resolveMission). If the server ever
    // read the client's injected 'success' instead, this would incorrectly
    // set a pending upgrade boost.
    await makeTargetWeaker(lobbyId);
    await query(
      `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
       values ($1, $2, $3, 'human', now())`,
      [lobbyId, OWN, userId],
    );
    const now = new Date('2026-01-01T00:00:00Z');

    const start = await runAction({
      lobbyId, userId, teamKey: OWN,
      body: { type: 'startSpyMission', targetTeam: TARGET, stat: 'motor', agent: 'free', outcome: 'success' },
      now,
    });
    assert.equal(start.ok, true);

    const jobRow = (await query<{ id: string; ends_at: Date }>(
      `select id, ends_at from pending_jobs where lobby_id = $1 and team_key = $2 and kind = 'spy' and claimed_at is null`,
      [lobbyId, OWN],
    )).rows[0];
    assert.ok(jobRow, 'startSpyMission did not create a job');

    // Captured AFTER the start charge (FREE_AGENT_RP) has already landed, so
    // this is isolated to what CLAIMING does — the thing this test is about.
    const rpAfterStart = (await loadTeamEconomy(lobbyId, OWN))!.rp;

    const claim = await runAction({
      lobbyId, userId, teamKey: OWN,
      body: { type: 'claimSpyReport', jobId: jobRow.id },
      now: new Date(jobRow.ends_at.getTime() + 1000),
    });
    assert.equal(claim.ok, true);

    // A real 'success' would have set a pending upgrade boost and left RP
    // untouched; a real 'caught' would have deducted RP. Neither happened —
    // proving the injected 'success' was never read.
    const after = (await loadTeamEconomy(lobbyId, OWN))!;
    assert.equal(after.spyState['motor'], undefined, "the client's fake 'success' set a boost");
    assert.equal(after.rp, rpAfterStart, "the client's fake 'success' should not have charged a fine either");
  });

  it('3) is deterministic — the same mission parameters resolve to the same outcome', async () => {
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');
    const payload = spyPayload(ROUND_SUCCESS);

    const first = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload, now });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const claim1 = await claimJob({ lobbyId, teamKey: OWN, jobId: first.jobId, now: first.endsAt });
    assert.equal(claim1.ok, true);
    if (!claim1.ok) return;

    // Past the 48h cooldown, but with the identical stored mission parameters
    // (round/target/agent) that feed resolveMission's seed.
    const secondStart = new Date(first.endsAt.getTime() + 48 * 3600 * 1000 + 1000);
    const second = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload, now: secondStart });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const claim2 = await claimJob({ lobbyId, teamKey: OWN, jobId: second.jobId, now: second.endsAt });
    assert.equal(claim2.ok, true);
    if (!claim2.ok) return;

    assert.equal(claim1.applied['outcome'], claim2.applied['outcome']);
  });

  it('4) success multiplies the next upgrade of that stat by SPY_BOOST, then is consumed', async () => {
    const { lobbyId } = await makeLobby('Spy', PIN_SUCCESS.id);
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(PIN_SUCCESS.round), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
    const claimSpy = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claimSpy.ok, true);
    if (!claimSpy.ok) return;
    assert.equal(claimSpy.applied['outcome'], 'success');

    const motorBefore = (await loadTeamEconomy(lobbyId, OWN))!.car.motor;

    const upgrade1Now = new Date(spy.endsAt.getTime() + 1000);
    const upgrade1 = await startJob({ lobbyId, teamKey: OWN, kind: 'upgrade', payload: { stat: 'motor' }, now: upgrade1Now });
    assert.equal(upgrade1.ok, true);
    if (!upgrade1.ok) return;
    await claimJob({ lobbyId, teamKey: OWN, jobId: upgrade1.jobId, now: upgrade1.endsAt });
    const motorAfterBoosted = (await loadTeamEconomy(lobbyId, OWN))!.car.motor;
    const boostedGain = motorAfterBoosted - motorBefore;

    const upgrade2Now = new Date(upgrade1.endsAt.getTime() + 1000);
    const upgrade2 = await startJob({ lobbyId, teamKey: OWN, kind: 'upgrade', payload: { stat: 'motor' }, now: upgrade2Now });
    assert.equal(upgrade2.ok, true);
    if (!upgrade2.ok) return;
    await claimJob({ lobbyId, teamKey: OWN, jobId: upgrade2.jobId, now: upgrade2.endsAt });
    const motorAfterNormal = (await loadTeamEconomy(lobbyId, OWN))!.car.motor;
    const normalGain = motorAfterNormal - motorAfterBoosted;

    assert.ok(normalGain > 0, 'normal upgrade gain must be positive');
    assert.equal(boostedGain, normalGain * 1.5, `boosted gain ${boostedGain} should be 1.5x the normal gain ${normalGain} — the boost must apply once and only once`);
  });

  it('5) bad intel applies BAD_INTEL_FACTOR to the next upgrade of that stat, then is consumed', async () => {
    const { lobbyId } = await makeLobby('Spy', PIN_BAD_INTEL.id);
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(PIN_BAD_INTEL.round), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
    const claimSpy = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claimSpy.ok, true);
    if (!claimSpy.ok) return;
    assert.equal(claimSpy.applied['outcome'], 'badIntel');

    const motorBefore = (await loadTeamEconomy(lobbyId, OWN))!.car.motor;

    const upgrade1Now = new Date(spy.endsAt.getTime() + 1000);
    const upgrade1 = await startJob({ lobbyId, teamKey: OWN, kind: 'upgrade', payload: { stat: 'motor' }, now: upgrade1Now });
    assert.equal(upgrade1.ok, true);
    if (!upgrade1.ok) return;
    await claimJob({ lobbyId, teamKey: OWN, jobId: upgrade1.jobId, now: upgrade1.endsAt });
    const motorAfterHalved = (await loadTeamEconomy(lobbyId, OWN))!.car.motor;
    const halvedGain = motorAfterHalved - motorBefore;

    const upgrade2Now = new Date(upgrade1.endsAt.getTime() + 1000);
    const upgrade2 = await startJob({ lobbyId, teamKey: OWN, kind: 'upgrade', payload: { stat: 'motor' }, now: upgrade2Now });
    assert.equal(upgrade2.ok, true);
    if (!upgrade2.ok) return;
    await claimJob({ lobbyId, teamKey: OWN, jobId: upgrade2.jobId, now: upgrade2.endsAt });
    const motorAfterNormal = (await loadTeamEconomy(lobbyId, OWN))!.car.motor;
    const normalGain = motorAfterNormal - motorAfterHalved;

    assert.ok(normalGain > 0, 'normal upgrade gain must be positive');
    assert.equal(halvedGain, normalGain * 0.5, `halved gain ${halvedGain} should be 0.5x the normal gain ${normalGain}`);
  });

  it('6a) caught: the reported fine equals the rp actually deducted', async () => {
    const { lobbyId } = await makeLobby('Spy', PIN_CAUGHT_A.id);
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(PIN_CAUGHT_A.round), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
    // Captured AFTER the start charge (FREE_AGENT_RP), so this is isolated to
    // what CLAIMING (the caught fine) does.
    const rpBefore = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    const claimed = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.equal(claimed.applied['outcome'], 'caught');

    const rpAfter = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    const actuallyDeducted = rpBefore - rpAfter;
    assert.ok(actuallyDeducted > 0, 'caught must deduct something');
    assert.equal(claimed.applied['fine'], actuallyDeducted, 'reported fine must equal what was actually charged');
  });

  it('6b) caught: a fine larger than the balance is floored, and the reported fine matches what was charged', async () => {
    const { lobbyId } = await makeLobby('Spy', PIN_CAUGHT_B.id);
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(PIN_CAUGHT_B.round), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
    // The low balance is set AFTER starting (which itself needs enough RP to
    // charge FREE_AGENT_RP) — this test is about claim-time flooring, not
    // about whether a low balance can even afford to start.
    await query(`update lobby_economy set rp = 10 where lobby_id = $1 and team_key = $2`, [lobbyId, OWN]);
    const claimed = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.equal(claimed.applied['outcome'], 'caught');

    const rpAfter = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    assert.equal(rpAfter, 0, 'a floored charge must never go negative');
    assert.equal(claimed.applied['fine'], 10, 'reported fine must equal the actually-charged (floored) amount, not the nominal one');
  });

  it('7) a mission cannot be claimed twice', async () => {
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');
    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_SUCCESS), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
    const claim1 = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claim1.ok, true);

    const claim2 = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claim2.ok, false);
    if (claim2.ok) return;
    assert.equal(claim2.reason, 'already_claimed');
  });

  it('8) a new mission cannot start inside the 48h cooldown', async () => {
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');
    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_SUCCESS), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
    const claimed = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claimed.ok, true);

    const tooSoon = new Date(spy.endsAt.getTime() + 47 * 3600 * 1000);
    const blocked = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_SUCCESS), now: tooSoon });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.reason, 'cooldown');

    const okNow = new Date(spy.endsAt.getTime() + 48 * 3600 * 1000 + 1000);
    const allowed = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_SUCCESS), now: okNow });
    assert.equal(allowed.ok, true);
  });

  it('9a) starting a free-agent mission charges FREE_AGENT_RP', async () => {
    const { lobbyId, userId } = await makeLobby();
    await setup(lobbyId);
    await query(
      `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
       values ($1, $2, $3, 'human', now())`,
      [lobbyId, OWN, userId],
    );
    const rpBefore = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    const now = new Date('2026-01-01T00:00:00Z');

    const res = await runAction({
      lobbyId, userId, teamKey: OWN,
      body: { type: 'startSpyMission', targetTeam: TARGET, stat: 'motor', agent: 'free' },
      now,
    });
    assert.equal(res.ok, true, JSON.stringify(res));

    const rpAfter = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    assert.equal(rpBefore - rpAfter, FREE_AGENT_RP, 'a free-agent mission must charge exactly FREE_AGENT_RP');
  });

  it('9b) starting a premium-agent mission charges goldPrices.premiumAgent', async () => {
    const { lobbyId, userId } = await makeLobby();
    await setup(lobbyId);
    await query(
      `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
       values ($1, $2, $3, 'human', now())`,
      [lobbyId, OWN, userId],
    );
    await query(`update users set gold = 100 where id = $1`, [userId]);
    const now = new Date('2026-01-01T00:00:00Z');

    const res = await runAction({
      lobbyId, userId, teamKey: OWN,
      body: { type: 'startSpyMission', targetTeam: TARGET, stat: 'motor', agent: 'premium' },
      now,
    });
    assert.equal(res.ok, true, JSON.stringify(res));

    const goldAfter = (await query<{ gold: number }>(`select gold from users where id = $1`, [userId])).rows[0].gold;
    assert.equal(100 - goldAfter, goldPrices.premiumAgent, 'a premium mission must charge exactly goldPrices.premiumAgent');
  });

  it('9c) insufficient RP refuses a free-agent mission and charges nothing', async () => {
    const { lobbyId, userId } = await makeLobby();
    await setup(lobbyId);
    await query(
      `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
       values ($1, $2, $3, 'human', now())`,
      [lobbyId, OWN, userId],
    );
    await query(`update lobby_economy set rp = 0 where lobby_id = $1 and team_key = $2`, [lobbyId, OWN]);
    const now = new Date('2026-01-01T00:00:00Z');

    const res = await runAction({
      lobbyId, userId, teamKey: OWN,
      body: { type: 'startSpyMission', targetTeam: TARGET, stat: 'motor', agent: 'free' },
      now,
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.code, 'not_enough_rp');
    const rpAfter = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    assert.equal(rpAfter, 0, 'a refused mission must charge nothing');
  });

  it('9d) insufficient gold refuses a premium-agent mission and charges nothing', async () => {
    const { lobbyId, userId } = await makeLobby();
    await setup(lobbyId);
    await query(
      `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
       values ($1, $2, $3, 'human', now())`,
      [lobbyId, OWN, userId],
    );
    await query(`update users set gold = 0 where id = $1`, [userId]);
    const now = new Date('2026-01-01T00:00:00Z');

    const res = await runAction({
      lobbyId, userId, teamKey: OWN,
      body: { type: 'startSpyMission', targetTeam: TARGET, stat: 'motor', agent: 'premium' },
      now,
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.code, 'not_enough_gold');
    const goldAfter = (await query<{ gold: number }>(`select gold from users where id = $1`, [userId])).rows[0].gold;
    assert.equal(goldAfter, 0, 'a refused mission must charge nothing');
  });

  it('10) hiding the garage charges the right price for each duration', async () => {
    const { lobbyId, userId } = await makeLobby();
    await setup(lobbyId);
    await query(
      `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
       values ($1, $2, $3, 'human', now())`,
      [lobbyId, OWN, userId],
    );
    await query(`update users set gold = 100 where id = $1`, [userId]);
    const now = new Date('2026-01-01T00:00:00Z');

    const rpBefore = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    const hide1 = await runAction({ lobbyId, userId, teamKey: OWN, body: { type: 'hideGarage', days: 1 }, now });
    assert.equal(hide1.ok, true, JSON.stringify(hide1));
    const rpAfter = (await loadTeamEconomy(lobbyId, OWN))!.rp;
    assert.equal(rpBefore - rpAfter, rpPrices.hide1Day, '1-day hide must charge rpPrices.hide1Day');

    const goldBefore3 = (await query<{ gold: number }>(`select gold from users where id = $1`, [userId])).rows[0].gold;
    const hide3 = await runAction({ lobbyId, userId, teamKey: OWN, body: { type: 'hideGarage', days: 3 }, now });
    assert.equal(hide3.ok, true, JSON.stringify(hide3));
    const goldAfter3 = (await query<{ gold: number }>(`select gold from users where id = $1`, [userId])).rows[0].gold;
    assert.equal(goldBefore3 - goldAfter3, goldPrices.hide3Days, '3-day hide must charge goldPrices.hide3Days');

    const hide7 = await runAction({ lobbyId, userId, teamKey: OWN, body: { type: 'hideGarage', days: 7 }, now });
    assert.equal(hide7.ok, true, JSON.stringify(hide7));
    const goldAfter7 = (await query<{ gold: number }>(`select gold from users where id = $1`, [userId])).rows[0].gold;
    assert.equal(goldAfter3 - goldAfter7, goldPrices.hide7Days, '7-day hide must charge goldPrices.hide7Days');
  });

  it('11) a hidden garage blocks a mission against it — the outcome is "blocked"', async () => {
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');

    // Hide the TARGET (the one being spied on) well past ROUND_SUCCESS —
    // `startedRound`/round-at-claim is 1 for a fresh lobby, so 7 days from
    // round 1 covers rounds 1..7.
    await withTransaction(async (c) => {
      await bumpGarageHide(c, lobbyId, TARGET, 1, 7);
    });

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_SUCCESS), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
    const claimed = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.equal(claimed.applied['outcome'], 'blocked');
  });

  it('12) being caught bumps the target team\'s spied-on car stat by RIVAL_GAIN', async () => {
    const { lobbyId } = await makeLobby('Spy', PIN_CAUGHT_C.id);
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');
    const motorBefore = (await loadTeamEconomy(lobbyId, TARGET))!.car.motor;

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(PIN_CAUGHT_C.round), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
    const claimed = await claimJob({ lobbyId, teamKey: OWN, jobId: spy.jobId, now: spy.endsAt });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.equal(claimed.applied['outcome'], 'caught');

    const motorAfter = (await loadTeamEconomy(lobbyId, TARGET))!.car.motor;
    // Floating-point addition (RIVAL_GAIN = 0.4 has no exact binary form), not
    // an exact-equality case — mirrors how this file already tolerates that
    // elsewhere with a ratio check; here a small epsilon does the same job.
    assert.ok(Math.abs((motorAfter - motorBefore) - RIVAL_GAIN) < 1e-9, "the target's spied-on stat must gain RIVAL_GAIN");
  });

  it('13) a rival attempt against a front-runner bumps the rival on success, and a hidden garage blocks it', async () => {
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    // Round 10 / season 1 / championship position 1 / rivals=[TARGET] is
    // pinned offline (brute-forced against `rivalAttempt`, shared/src/
    // espionage.ts) to attempt-and-succeed against TARGET when OWN is not
    // hidden, and attempt-and-fail when it is.
    const ROUND = 10;
    const SEASON = 1;
    const seats: Seat[] = [{ teamKey: OWN, userId: null, managed: 'human', nickname: null, countryCode: null }];
    const positionOf = new Map([[OWN, 1]]);

    const motorBefore = (await loadTeamEconomy(lobbyId, TARGET))!.car.motor;
    await withTransaction(async (c) => {
      await runRivalEspionage(c, lobbyId, SEASON, ROUND, seats, positionOf, [OWN, TARGET]);
    });
    const afterSuccess = (await loadTeamEconomy(lobbyId, TARGET))!.car;
    assert.ok(Math.abs((afterSuccess.motor - motorBefore) - RIVAL_GAIN) < 1e-9, 'a successful rival attempt must bump the rival by RIVAL_GAIN');
    assert.ok(Math.abs((afterSuccess.aero - motorBefore) - RIVAL_GAIN) < 1e-9, 'the bump applies uniformly across the team\'s car stats');

    // Now hide OWN for this same round and repeat: the attempt must still
    // roll (it is the SAME seed) but must not succeed, so TARGET gains
    // nothing further.
    await withTransaction(async (c) => {
      await bumpGarageHide(c, lobbyId, OWN, ROUND, 1);
    });
    const beforeSecond = (await loadTeamEconomy(lobbyId, TARGET))!.car.motor;
    await withTransaction(async (c) => {
      await runRivalEspionage(c, lobbyId, SEASON, ROUND, seats, positionOf, [OWN, TARGET]);
    });
    const afterSecond = (await loadTeamEconomy(lobbyId, TARGET))!.car.motor;
    assert.equal(afterSecond, beforeSecond, 'a hidden garage must block a rival attempt against it');
  });

  it('14) the seed differs across lobbies for the same round/target/agent', async () => {
    // Pinned offline (brute force over `resolveMission`, same round/target/
    // agent/season/ownTeam, only `lobbyId` varying): 'lobby-0' resolves to
    // 'success', 'lobby-2' resolves to 'badIntel' for the identical
    // (round=1, target='ridgeline', agent='free', season=1, ownTeam=
    // 'bosphorus', targetStronger=true) inputs — proving the outcome is not
    // a function of round/target/agent alone.
    const base = {
      id: 'x', targetTeam: TARGET, stat: 'motor' as const, agent: 'free' as const,
      startedRound: ROUND_SUCCESS, startedAt: 0, endsAt: 0, season: 1, ownTeam: OWN,
    };
    const missionA: SpyMission = { ...base, lobbyId: 'lobby-0' };
    const missionB: SpyMission = { ...base, lobbyId: 'lobby-2' };

    assert.notEqual(missionSeed(missionA), missionSeed(missionB), 'different lobbies must roll different seeds');
    assert.equal(resolveMission(missionA, false, true), 'success');
    assert.equal(resolveMission(missionB, false, true), 'badIntel');
  });

  it('15) FREE_AGENT_RP and RIVAL_GAIN have exactly one definition, in shared/', async () => {
    const roots = [
      fileURLToPath(new URL('../src/', import.meta.url)),
      fileURLToPath(new URL('../../mobile/src/', import.meta.url)),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop()!;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            const text = await readFile(full, 'utf8');
            if (/\bconst\s+FREE_AGENT_RP\s*=/.test(text)) offenders.push(`${full}: FREE_AGENT_RP`);
            if (/\bconst\s+RIVAL_GAIN\s*=/.test(text)) offenders.push(`${full}: RIVAL_GAIN`);
          }
        }
      }
    }
    assert.deepEqual(offenders, [], `found a private redefinition: ${offenders.join(', ')}`);
  });
});
