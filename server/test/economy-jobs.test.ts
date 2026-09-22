import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { seedTeamEconomy, loadTeamEconomy } from '../src/economy/repo.ts';
import { startJob, claimJob, skipJob, openJobs, JobError, type JobKind } from '../src/economy/jobs.ts';

let seq = 0;

/** Testin ihtiyaç duyduğu en küçük lobi + takım ekonomisi. Her çağrı kendi
 *  benzersiz name_base/name_seq ve providerUid'ini kullanır, ki yarım kalmış
 *  bir koşu sonraki koşuları zehirlemesin. */
async function makeLobbyWithTeam(teamKey = 'bosphorus'): Promise<{ lobbyId: string; userId: string }> {
  const n = ++seq;
  const owner = await createUserWithIdentity({
    base: 'PitCrew', provider: 'google', providerUid: `g-jobs-${n}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`JobsLobby #${n}`, 'JobsLobby', n, owner.id],
  );
  const lobbyId = res.rows[0].id;
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, teamKey));
  return { lobbyId, userId: owner.id };
}

describe('economy jobs', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from pending_jobs');
    await query('delete from lobby_economy');
    await query('delete from lobbies');
    await query('delete from users');
  });
  after(async () => { await closePool(); });

  it('starting an upgrade charges rp and reports as not ready', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    const before = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    const now = new Date('2026-01-01T00:00:00Z');
    const res = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'motor' }, now });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.ok(res.rpCost > 0);
    const after = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    assert.equal(after, before - res.rpCost);

    const jobs = await openJobs(lobbyId, 'bosphorus', now);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].ready, false);
    assert.equal(jobs[0].jobId, res.jobId);
  });

  it('refuses a second open upgrade while one is open, and charges nothing for the refusal', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    const now = new Date('2026-01-01T00:00:00Z');
    const first = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'motor' }, now });
    assert.equal(first.ok, true);
    const balanceAfterFirst = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;

    const second = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'aero' }, now });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.reason, 'already_running');

    const balanceAfterSecond = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    assert.equal(balanceAfterSecond, balanceAfterFirst, 'a refused start must not spend rp');
  });

  it('allows a second job of a different kind alongside an open one', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    const now = new Date('2026-01-01T00:00:00Z');
    const upgrade = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'motor' }, now });
    const training = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'training', payload: {}, now });
    assert.equal(upgrade.ok, true);
    assert.equal(training.ok, true);
    const jobs = await openJobs(lobbyId, 'bosphorus', now);
    assert.equal(jobs.length, 2);
  });

  it('refuses a claim before ends_at regardless of what the caller claims the time is', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'training', payload: {}, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const tooEarly = new Date(now.getTime() + 1000);
    const res = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now: tooEarly });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'not_ready');
  });

  it('a claim after ends_at applies the upgrade exactly once', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'motor' }, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const carBefore = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.motor;
    const after = new Date(started.endsAt.getTime() + 1000);

    const claim1 = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now: after });
    assert.equal(claim1.ok, true);
    if (!claim1.ok) return;
    assert.ok(claim1.applied, 'claim did not report what it applied');
    const carAfter = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.motor;
    assert.ok(carAfter > carBefore, 'motor stat did not move on claim');

    const claim2 = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now: after });
    assert.equal(claim2.ok, false);
    if (claim2.ok) return;
    assert.equal(claim2.reason, 'already_claimed');
    const carStill = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.motor;
    assert.equal(carStill, carAfter, 'a repeat claim moved the car again');
  });

  it('two racing claims: exactly one succeeds and exactly one row ends up claimed', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'training', payload: {}, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const after = new Date(started.endsAt.getTime() + 1000);

    const [a, b] = await Promise.all([
      claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now: after }),
      claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now: after }),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    assert.equal(oks.length, 1, 'both racing claims succeeded');

    const rows = await query<{ claimed_at: Date | null }>(
      `select claimed_at from pending_jobs where id = $1`, [started.jobId],
    );
    const claimedRows = rows.rows.filter((r) => r.claimed_at !== null);
    assert.equal(claimedRows.length, 1);
  });

  it('refuses a claim for a job belonging to another team as not_found', async () => {
    const { lobbyId } = await makeLobbyWithTeam('bosphorus');
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'ridgeline'));
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'training', payload: {}, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const res = await claimJob({ lobbyId, teamKey: 'ridgeline', jobId: started.jobId, now: started.endsAt });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'not_found');
  });

  it('skip charges gold proportional to time left and brings ends_at forward to claimable', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    await query('update users set gold = 1000 where id = $1', [userId]);
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'training', payload: {}, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const goldBefore = (await query<{ gold: number }>('select gold from users where id = $1', [userId])).rows[0].gold;
    const res = await skipJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, userId, now });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.ok(res.goldCost > 0);
    const goldAfter = (await query<{ gold: number }>('select gold from users where id = $1', [userId])).rows[0].gold;
    assert.equal(goldAfter, goldBefore - res.goldCost);

    const claim = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now });
    assert.equal(claim.ok, true);
  });

  it('skip fails without spending when the account cannot afford it', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    await query('update users set gold = 0 where id = $1', [userId]);
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'training', payload: {}, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const res = await skipJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, userId, now });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'not_enough_gold');

    const gold = (await query<{ gold: number }>('select gold from users where id = $1', [userId])).rows[0].gold;
    assert.equal(gold, 0);
    // ends_at must not have moved — the job must still not be ready right now.
    const jobs = await openJobs(lobbyId, 'bosphorus', now);
    assert.equal(jobs[0].ready, false);
  });

  it('refuses to skip an already-claimed job', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    await query('update users set gold = 1000 where id = $1', [userId]);
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'training', payload: {}, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const after = new Date(started.endsAt.getTime() + 1000);
    const claim = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now: after });
    assert.equal(claim.ok, true);

    const goldBefore = (await query<{ gold: number }>('select gold from users where id = $1', [userId])).rows[0].gold;
    const res = await skipJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, userId, now: after });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'already_claimed');
    const goldAfter = (await query<{ gold: number }>('select gold from users where id = $1', [userId])).rows[0].gold;
    assert.equal(goldAfter, goldBefore, 'skipping an already-claimed job must not debit gold');
  });

  it('a claim racing a skip on the same fresh job: at most one succeeds, and gold moves only if the skip actually took effect', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    await query('update users set gold = 1000 where id = $1', [userId]);
    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'training', payload: {}, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    // Two independently-stamped `now`s, as two real concurrent requests would
    // carry: the claim arrives once the job is actually ready, the skip
    // arrives (or was in flight) just before that — giving it a positive
    // remaining time, so it has real gold on the line, not the free skip a
    // job past its own ends_at would report.
    const claimNow = new Date(started.endsAt.getTime() + 1000);
    const skipNow = new Date(started.endsAt.getTime() - 1000);

    const goldBefore = (await query<{ gold: number }>('select gold from users where id = $1', [userId])).rows[0].gold;

    const [claimRes, skipRes] = await Promise.all([
      claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now: claimNow }),
      skipJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, userId, now: skipNow }),
    ]);

    const goldAfter = (await query<{ gold: number }>('select gold from users where id = $1', [userId])).rows[0].gold;

    // Both winning is never acceptable — claim applies the economy effect,
    // skip charges gold; a job cannot be simultaneously "still open, just
    // sped up" and "claimed and applied".
    assert.ok(!(claimRes.ok && skipRes.ok), 'both a claim and a skip succeeded on the same job');

    if (skipRes.ok) {
      // The skip actually took effect (won the race before the claim, or the
      // claim was not yet ready) — gold must have moved.
      assert.ok(goldAfter < goldBefore, 'skip reported success but did not debit gold');
    } else {
      // The skip lost the race (the job got claimed first) — the player
      // must keep every last coin of gold. This is the bug: a skip that
      // moves nothing must never charge.
      assert.equal(skipRes.reason, 'already_claimed', `unexpected skip failure reason: ${skipRes.reason}`);
      assert.equal(goldAfter, goldBefore, 'skip lost the race but still debited gold');
    }
  });

  it('throws when starting a job with an unknown kind', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    const now = new Date('2026-01-01T00:00:00Z');
    await assert.rejects(() => startJob({
      lobbyId, teamKey: 'bosphorus', kind: 'sabotage' as JobKind, payload: {}, now,
    }));
  });

  it('refuses an upgrade with an unknown stat label as bad_payload and charges nothing', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    const now = new Date('2026-01-01T00:00:00Z');
    const before = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    const res = await startJob({
      lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'downforce_of_destiny' }, now,
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'bad_payload');
    const after = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    assert.equal(after, before);
  });

  it('exports a JobError class', () => {
    const err = new JobError('x');
    assert.ok(err instanceof Error);
  });
});
