import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { seedTeamEconomy } from '../src/economy/repo.ts';
import { sweepReadyJobs, type JobNotification } from '../src/notify/scheduler.ts';

let seq = 0;

/** En küçük lobi + takım ekonomisi + koltuk. Her çağrı kendi benzersiz
 *  name_base/name_seq ve providerUid'ini kullanır. */
async function makeLobby(): Promise<{ lobbyId: string; ownerId: string }> {
  const n = ++seq;
  const owner = await createUserWithIdentity({
    base: 'PitCrew', provider: 'google', providerUid: `g-notify-${n}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`NotifyLobby #${n}`, 'NotifyLobby', n, owner.id],
  );
  return { lobbyId: res.rows[0].id, ownerId: owner.id };
}

async function makeSeat(
  lobbyId: string, teamKey: string, userId: string | null,
): Promise<void> {
  await query(
    `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
     values ($1, $2, $3, $4, case when $3::uuid is null then null else now() end)`,
    [lobbyId, teamKey, userId, userId ? 'human' : 'ai'],
  );
}

async function makeTeam(lobbyId: string, teamKey: string, userId: string | null): Promise<void> {
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, teamKey));
  await makeSeat(lobbyId, teamKey, userId);
}

async function insertJob(opts: {
  lobbyId: string; teamKey: string; kind?: string; endsAt: Date;
  claimedAt?: Date | null; notifiedAt?: Date | null;
}): Promise<string> {
  const res = await query<{ id: string }>(
    `insert into pending_jobs (lobby_id, team_key, kind, payload, started_at, ends_at, claimed_at, notified_at)
     values ($1, $2, $3, '{}'::jsonb, now(), $4, $5, $6)
     returning id`,
    [opts.lobbyId, opts.teamKey, opts.kind ?? 'training', opts.endsAt, opts.claimedAt ?? null, opts.notifiedAt ?? null],
  );
  return res.rows[0].id;
}

/** Ekonominin parmak izi: her `lobby_economy` satırının rp/factory_levels/
 *  car/upgrades_done'ı, artı tüm `users.gold` toplamı. Taramanın ekonomiye
 *  gerçekten dokunmadığını kanıtlayan tek iddia budur — genişletmeden değil,
 *  daraltmadan önce iki kez düşün. */
async function economyFingerprint(): Promise<string> {
  const eco = await query(
    `select lobby_id, team_key, rp, factory_levels, car, upgrades_done
     from lobby_economy order by lobby_id, team_key`,
  );
  const gold = await query<{ sum: string }>(`select coalesce(sum(gold), 0)::text as sum from users`);
  return JSON.stringify({ eco: eco.rows, goldSum: gold.rows[0].sum });
}

function noopSend(_job: JobNotification): void {}

describe('notify scheduler', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from pending_jobs');
    await query('delete from lobby_seats');
    await query('delete from lobby_economy');
    await query('delete from lobbies');
    await query('delete from users');
  });
  after(async () => { await closePool(); });

  it('finds a ready, unclaimed job and hands its id to the sender', async () => {
    const { lobbyId, ownerId } = await makeLobby();
    await makeTeam(lobbyId, 'bosphorus', ownerId);
    const now = new Date('2026-01-01T00:00:00Z');
    const jobId = await insertJob({ lobbyId, teamKey: 'bosphorus', endsAt: new Date(now.getTime() - 1000) });

    const seen: JobNotification[] = [];
    const processed = await sweepReadyJobs({ now, send: (job) => { seen.push(job); } });

    assert.equal(processed, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].jobId, jobId);
    assert.equal(seen[0].userId, ownerId);
  });

  it('leaves the economy byte-identical across two sweeps', async () => {
    const { lobbyId, ownerId } = await makeLobby();
    await makeTeam(lobbyId, 'bosphorus', ownerId);
    await makeTeam(lobbyId, 'aurelia', null);
    const now = new Date('2026-01-01T00:00:00Z');
    await insertJob({ lobbyId, teamKey: 'bosphorus', endsAt: new Date(now.getTime() - 1000) });
    await insertJob({ lobbyId, teamKey: 'aurelia', endsAt: new Date(now.getTime() - 1000) });

    const before = await economyFingerprint();
    await sweepReadyJobs({ now, send: noopSend });
    const afterFirst = await economyFingerprint();
    await sweepReadyJobs({ now, send: noopSend });
    const afterSecond = await economyFingerprint();

    assert.equal(afterFirst, before, 'first sweep touched the economy');
    assert.equal(afterSecond, before, 'second sweep touched the economy');
  });

  it('notifies each job exactly once — a second sweep finds nothing', async () => {
    const { lobbyId, ownerId } = await makeLobby();
    await makeTeam(lobbyId, 'bosphorus', ownerId);
    const now = new Date('2026-01-01T00:00:00Z');
    await insertJob({ lobbyId, teamKey: 'bosphorus', endsAt: new Date(now.getTime() - 1000) });

    let calls = 0;
    const first = await sweepReadyJobs({ now, send: () => { calls++; } });
    const second = await sweepReadyJobs({ now, send: () => { calls++; } });

    assert.equal(first, 1);
    assert.equal(second, 0);
    assert.equal(calls, 1);
  });

  it('two racing sweeps send at most one notification for the same job', async () => {
    const { lobbyId, ownerId } = await makeLobby();
    await makeTeam(lobbyId, 'bosphorus', ownerId);
    const now = new Date('2026-01-01T00:00:00Z');
    await insertJob({ lobbyId, teamKey: 'bosphorus', endsAt: new Date(now.getTime() - 1000) });

    let calls = 0;
    const send = () => { calls++; };
    const [a, b] = await Promise.all([
      sweepReadyJobs({ now, send }),
      sweepReadyJobs({ now, send }),
    ]);

    assert.equal(calls, 1, 'more than one notification went out for the same job');
    assert.equal(a + b, 1, 'more than one sweep reported having processed the job');
  });

  it('ignores a job whose ends_at has not passed yet', async () => {
    const { lobbyId, ownerId } = await makeLobby();
    await makeTeam(lobbyId, 'bosphorus', ownerId);
    const now = new Date('2026-01-01T00:00:00Z');
    await insertJob({ lobbyId, teamKey: 'bosphorus', endsAt: new Date(now.getTime() + 60_000) });

    let calls = 0;
    const processed = await sweepReadyJobs({ now, send: () => { calls++; } });

    assert.equal(processed, 0);
    assert.equal(calls, 0);
  });

  it('ignores a job that has already been claimed', async () => {
    const { lobbyId, ownerId } = await makeLobby();
    await makeTeam(lobbyId, 'bosphorus', ownerId);
    const now = new Date('2026-01-01T00:00:00Z');
    await insertJob({
      lobbyId, teamKey: 'bosphorus',
      endsAt: new Date(now.getTime() - 1000),
      claimedAt: new Date(now.getTime() - 500),
    });

    let calls = 0;
    const processed = await sweepReadyJobs({ now, send: () => { calls++; } });

    assert.equal(processed, 0);
    assert.equal(calls, 0);
  });

  it('an AI-seat job sends nothing but is still stamped so it is not re-examined', async () => {
    const { lobbyId } = await makeLobby();
    await makeTeam(lobbyId, 'aurelia', null);
    const now = new Date('2026-01-01T00:00:00Z');
    await insertJob({ lobbyId, teamKey: 'aurelia', endsAt: new Date(now.getTime() - 1000) });

    let calls = 0;
    const first = await sweepReadyJobs({ now, send: () => { calls++; } });
    assert.equal(first, 1, 'the AI-seat job was not processed/stamped');
    assert.equal(calls, 0, 'a notification was sent for a seat with no user');

    const second = await sweepReadyJobs({ now, send: () => { calls++; } });
    assert.equal(second, 0, 'the AI-seat job was re-examined by a later sweep');
    assert.equal(calls, 0);
  });

  it('a throwing sender leaves the job unstamped, so a later sweep retries it', async () => {
    const { lobbyId, ownerId } = await makeLobby();
    await makeTeam(lobbyId, 'bosphorus', ownerId);
    const now = new Date('2026-01-01T00:00:00Z');
    const jobId = await insertJob({ lobbyId, teamKey: 'bosphorus', endsAt: new Date(now.getTime() - 1000) });

    let attempts = 0;
    const flakySend = () => {
      attempts++;
      if (attempts === 1) throw new Error('push provider unavailable');
    };

    const first = await sweepReadyJobs({ now, send: flakySend });
    assert.equal(first, 0, 'a throwing send must not count as processed');

    const row = await query<{ notified_at: Date | null }>(
      `select notified_at from pending_jobs where id = $1`, [jobId],
    );
    assert.equal(row.rows[0].notified_at, null, 'the job was stamped despite the sender throwing');

    const second = await sweepReadyJobs({ now, send: flakySend });
    assert.equal(second, 1, 'the job was not retried after the earlier failure');
    assert.equal(attempts, 2);
  });
});
