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
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { seedTeamEconomy, loadTeamEconomy } from '../src/economy/repo.ts';
import { startJob, claimJob } from '../src/economy/jobs.ts';
import { runAction } from '../src/economy/actions.ts';

let seq = 0;
const createdLobbyIds: string[] = [];
const createdUserIds: string[] = [];

/** Verified lobby-creation helper, copied from `economy-repo.test.ts`. */
async function makeLobby(label = 'Spy'): Promise<{ lobbyId: string; userId: string }> {
  const n = ++seq;
  const owner = await createUserWithIdentity({
    base: 'SpyMaster', provider: 'google', providerUid: `g-spy-${n}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`${label} #${n}`, label, n, owner.id],
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
 * Rounds pinned by brute-forcing `resolveMission`'s deterministic roll for
 * (targetTeam='ridgeline', agent='free', targetStronger=true) offline — see
 * the task's step-1 notes. Round 1 -> success, round 6 -> badIntel, round 20
 * -> caught, all with the target genuinely stronger.
 */
const ROUND_SUCCESS = 1;
const ROUND_BAD_INTEL = 6;
const ROUND_CAUGHT = 20;

function spyPayload(startedRound: number, agent: 'free' | 'premium' = 'free') {
  return { targetTeam: TARGET, stat: 'motor' as const, agent, startedRound };
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
    const { lobbyId, userId } = await makeLobby();
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
    const rpBefore = (await loadTeamEconomy(lobbyId, OWN))!.rp;

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
    assert.equal(after.rp, rpBefore, "the client's fake 'success' should not have charged a fine either");
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
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_SUCCESS), now });
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
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_BAD_INTEL), now });
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
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    const now = new Date('2026-01-01T00:00:00Z');
    const rpBefore = (await loadTeamEconomy(lobbyId, OWN))!.rp;

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_CAUGHT), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
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
    const { lobbyId } = await makeLobby();
    await setup(lobbyId);
    await makeTargetStronger(lobbyId);
    await query(`update lobby_economy set rp = 10 where lobby_id = $1 and team_key = $2`, [lobbyId, OWN]);
    const now = new Date('2026-01-01T00:00:00Z');

    const spy = await startJob({ lobbyId, teamKey: OWN, kind: 'spy', payload: spyPayload(ROUND_CAUGHT), now });
    assert.equal(spy.ok, true);
    if (!spy.ok) return;
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
});
