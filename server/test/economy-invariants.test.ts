/**
 * Economy invariants — Phase 3a-1's closing argument.
 *
 * Spec: docs/superpowers/specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md
 *
 * This file does not aim for coverage — the other economy/gold/notify test
 * files already have that. It states seven properties a future change
 * could silently break, and pins each one AT THE SEAM: through the HTTP
 * routes players actually call, not the repo functions underneath. Where
 * an existing unit test already pins the same guarantee exactly (usually
 * at the repo level, with hand-picked `now` values that can't be
 * reproduced through a route that samples its own clock), a comment says
 * so and points at it — this file's version is the integration-level
 * restatement, not a duplicate for its own sake.
 *
 * Every property below was broken in the source, confirmed to fail here,
 * then restored — see the task report for the seven before/after results.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerEconomyRoutes } from '../src/economy/routes.ts';
import { registerGoldRoutes, type GoldRoutesDeps } from '../src/gold/routes.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { seedTeamEconomy } from '../src/economy/repo.ts';
import { sweepReadyJobs } from '../src/notify/scheduler.ts';
import { startJob, claimJob, skipJob } from '../src/economy/jobs.ts';
import { GOLD_TO_RP, GOLD_TO_RP_DAILY_CAP, ADS_PER_DAY } from '@pitwall/shared/economy';

let server: Server;
let base: string;
let seq = 0;

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, body, text };
}

function post(path: string, token: string | null, payload: Record<string, unknown>) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return json(path, { method: 'POST', headers, body: JSON.stringify(payload) });
}

async function makeUser(): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    provider: 'google',
    providerUid: `econ-inv-${seq}-${Date.now()}`,
    emailHash: null,
    base: `InvTester${seq}`,
  });
  const token = await signSession(user.id);
  return { id: user.id, token };
}

async function makeLobby(creatorUserId: string): Promise<string> {
  seq += 1;
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`InvLobby #${seq}`, 'InvLobby', seq, creatorUserId],
  );
  return res.rows[0].id;
}

async function seatHuman(lobbyId: string, teamKey: string, userId: string): Promise<void> {
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, teamKey));
  await query(
    `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
     values ($1, $2, $3, 'human', now())`,
    [lobbyId, teamKey, userId],
  );
}

function fakeSsvSeq(userId: string, rewardAmount = 1): (raw: string) => Promise<any> {
  return async (raw: string) => {
    const params = new URLSearchParams(raw);
    const tx = params.get('tx') ?? 'default';
    return { ok: true, transactionId: tx, userId, rewardAmount };
  };
}

/** Registers both economy and gold routes so any single test can hit either seam. */
function startServer(goldDeps: GoldRoutesDeps = {}): Promise<void> {
  const router = new Router();
  registerEconomyRoutes(router);
  registerGoldRoutes(router, goldDeps);
  server = createServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('economy invariants (seam level)', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();
  });

  beforeEach(async () => {
    await query('delete from pending_jobs');
    await query('delete from lobby_seats');
    await query('delete from lobby_economy');
    await query('delete from daily_caps');
    await query('delete from gold_grants');
    await query('delete from lobbies');
    await query('delete from users');
  });

  after(async () => {
    await closePool();
  });

  // ---------------------------------------------------------------------
  // 1. A client cannot finish a job early.
  // ---------------------------------------------------------------------
  it('1. a request-supplied now/serverNow/timestamp cannot fast-forward a claim', async () => {
    // economy-http.test.ts already pins this exact scenario at the same
    // (route) level — restated here so the seven properties read as one set.
    await startServer();
    try {
      const owner = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      await seatHuman(lobbyId, 'aurelia', owner.id);

      const start = await post('/economy/action', owner.token, { lobbyId, type: 'startUpgrade', label: 'motor' });
      const jobId = start.body.jobs[0].jobId;

      const farFuture = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
      const { status, body } = await post('/economy/action', owner.token, {
        lobbyId, type: 'claimUpgrade', jobId,
        now: farFuture, serverNow: farFuture, timestamp: farFuture,
      });
      assert.equal(status, 409, 'a body-supplied clock must not make an unready job claimable');
      assert.equal(body.error, 'not_ready');
    } finally {
      await stopServer();
    }
  });

  // ---------------------------------------------------------------------
  // 2. A claim is idempotent.
  // ---------------------------------------------------------------------
  it('2. the same claim sent twice applies its effect exactly once', async () => {
    // economy-jobs.test.ts pins the repo-level version of this (claimJob
    // called twice with a hand-picked `now`). The route samples its own
    // `now()`, so this version forces readiness by moving `ends_at` into
    // the past directly in the database, then drives both claims through
    // the actual HTTP route.
    await startServer();
    try {
      const owner = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      await seatHuman(lobbyId, 'aurelia', owner.id);

      const start = await post('/economy/action', owner.token, { lobbyId, type: 'startUpgrade', label: 'motor' });
      const jobId = start.body.jobs[0].jobId;
      await query(`update pending_jobs set ends_at = now() - interval '1 second' where id = $1`, [jobId]);

      const first = await post('/economy/action', owner.token, { lobbyId, type: 'claimUpgrade', jobId });
      assert.equal(first.status, 200, 'the first claim on a ready job must succeed');
      const motorAfterFirst = first.body.car.motor;

      const second = await post('/economy/action', owner.token, { lobbyId, type: 'claimUpgrade', jobId });
      assert.equal(second.status, 409, 'a repeat claim must not succeed again');
      assert.equal(second.body.error, 'already_claimed');

      const row = await query<{ car: { motor: number } }>(
        `select car from lobby_economy where lobby_id = $1 and team_key = $2`,
        [lobbyId, 'aurelia'],
      );
      assert.equal(row.rows[0].car.motor, motorAfterFirst, 'a repeat claim must not apply the upgrade a second time');
    } finally {
      await stopServer();
    }
  });

  // ---------------------------------------------------------------------
  // 3. A gold faucet cannot be replayed — ad path and purchase path.
  // ---------------------------------------------------------------------
  it('3a. the ad-watch faucet credits the same transaction_id once', async () => {
    // gold-http.test.ts already pins this exactly, at this same level.
    const user = await makeUser();
    await startServer({ verifySsvCallback: fakeSsvSeq(user.id, 25) });
    try {
      const first = await json('/gold/admob-ssv?tx=tx-replay-check');
      assert.equal(first.status, 200);
      assert.equal(first.body.gold, 25);

      const second = await json('/gold/admob-ssv?tx=tx-replay-check');
      assert.equal(second.status, 200);
      assert.equal(second.body.gold, 25, 'a replayed ad callback must not credit gold twice');
    } finally {
      await stopServer();
    }
  });

  it('3b. the store-purchase faucet credits the same transaction_id once', async () => {
    // gold-http.test.ts already pins this exactly, at this same level.
    const user = await makeUser();
    await startServer({
      verifyReceipt: async () => ({ ok: true, sku: 'gold_500', transactionId: 'tx-iap-replay-check', gold: 500 }),
    });
    try {
      const purchase = () => post('/gold/purchase', user.token, { platform: 'apple', receipt: 'r' });
      const first = await purchase();
      assert.equal(first.status, 200);
      assert.equal(first.body.gold, 500);

      const second = await purchase();
      assert.equal(second.status, 200);
      assert.equal(second.body.gold, 500, 'a replayed receipt must not credit gold twice');
    } finally {
      await stopServer();
    }
  });

  // ---------------------------------------------------------------------
  // 4. The daily ad cap holds under concurrency.
  // ---------------------------------------------------------------------
  it('4. more than ADS_PER_DAY concurrent valid callbacks credit exactly ADS_PER_DAY', async () => {
    // gold-repo.test.ts already races grantGoldForAd directly; this is the
    // same race through the actual HTTP route, with distinct transaction
    // ids (as real concurrent AdMob deliveries would carry) so dedup is
    // not what's under test — only the cap.
    const user = await makeUser();
    await startServer({ verifySsvCallback: fakeSsvSeq(user.id, 1) });
    try {
      const attempts = ADS_PER_DAY + 4;
      const results = await Promise.all(
        Array.from({ length: attempts }, (_, i) => json(`/gold/admob-ssv?tx=race-${i}`)),
      );
      assert.ok(results.every((r) => r.status === 200), 'every callback must still answer 200');

      const finalGold = (await query<{ gold: number }>('select gold from users where id = $1', [user.id])).rows[0].gold;
      assert.equal(finalGold, ADS_PER_DAY, 'concurrent callbacks overshot the daily ad cap');
    } finally {
      await stopServer();
    }
  });

  // ---------------------------------------------------------------------
  // 5. Gold and RP never drift apart.
  // ---------------------------------------------------------------------
  it('5. a gold->RP conversion moves gold, rp and the cap together, or none of them', async () => {
    // economy-http.test.ts's "gold spent, rp credited and the cap counter
    // are mutually consistent" test pins the single-request version of
    // this exactly; this restates the invariant as the closing set expects.
    await startServer();
    try {
      const owner = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      await seatHuman(lobbyId, 'aurelia', owner.id);
      await query(`update users set gold = 1000 where id = $1`, [owner.id]);

      const rpBefore = (await query<{ rp: number }>(
        `select rp from lobby_economy where lobby_id = $1 and team_key = $2`, [lobbyId, 'aurelia'],
      )).rows[0].rp;

      const amount = 5;
      const { status } = await post('/economy/action', owner.token, { lobbyId, type: 'convertGoldToRp', gold: amount });
      assert.equal(status, 200);

      const goldAfter = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;
      const rpAfter = (await query<{ rp: number }>(
        `select rp from lobby_economy where lobby_id = $1 and team_key = $2`, [lobbyId, 'aurelia'],
      )).rows[0].rp;
      const capsAfter = (await query<{ gold_converted: number }>(
        `select gold_converted from daily_caps where user_id = $1`, [owner.id],
      )).rows[0];

      assert.equal(goldAfter, 1000 - amount, 'gold must be spent by exactly the converted amount');
      assert.equal(rpAfter, rpBefore + amount * GOLD_TO_RP, 'rp must be credited for exactly the converted amount');
      assert.equal(capsAfter.gold_converted, amount, 'the cap counter must move with gold and rp, not separately');

      // Now push past the daily cap: this branch (`CapReached`) is where the
      // three writes actually risk drifting — the gold spend has already
      // happened by the time the cap check runs, so a not-actually-atomic
      // implementation credits rp anyway once the cap is exceeded.
      const overCapAmount = GOLD_TO_RP_DAILY_CAP; // caps.gold_converted is already `amount`, so this alone tips it over
      const refused = await post('/economy/action', owner.token, { lobbyId, type: 'convertGoldToRp', gold: overCapAmount });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, 'cap_reached');

      const goldAfterRefusal = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;
      const rpAfterRefusal = (await query<{ rp: number }>(
        `select rp from lobby_economy where lobby_id = $1 and team_key = $2`, [lobbyId, 'aurelia'],
      )).rows[0].rp;
      assert.equal(goldAfterRefusal, goldAfter, 'a cap-refused conversion must not have spent gold');
      assert.equal(rpAfterRefusal, rpAfter, 'a cap-refused conversion must not have credited rp');
    } finally {
      await stopServer();
    }
  });

  // ---------------------------------------------------------------------
  // 6. A successful spend always buys something.
  // ---------------------------------------------------------------------
  it('6. a skip on a job already claimed by a race must not debit gold', async () => {
    // economy-jobs.test.ts's "a claim racing a skip" test pins the true
    // concurrent race (two independently-stamped `now`s) at the repo
    // level — that precision isn't reproducible through a route that
    // samples its own wall clock. This version drives the resolved
    // outcome (claim wins) through the actual route: force the job ready,
    // claim it via the route, then attempt to skip the now-claimed job and
    // confirm gold does not move — the same "a spend that buys nothing"
    // failure mode `skipJob`'s docblock names by history.
    await startServer();
    try {
      const owner = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      await seatHuman(lobbyId, 'aurelia', owner.id);
      await query(`update users set gold = 1000 where id = $1`, [owner.id]);

      const start = await post('/economy/action', owner.token, { lobbyId, type: 'startTraining', driverIdx: 0 });
      const jobId = start.body.jobs[0].jobId;
      await query(`update pending_jobs set ends_at = now() - interval '1 second' where id = $1`, [jobId]);

      const claim = await post('/economy/action', owner.token, { lobbyId, type: 'claimTraining', jobId });
      assert.equal(claim.status, 200, 'the claim must win — the job is ready and unclaimed');

      const goldBefore = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;
      const skip = await post('/economy/action', owner.token, { lobbyId, type: 'skipTraining', jobId });
      assert.equal(skip.status, 409);
      assert.equal(skip.body.error, 'already_claimed');

      const goldAfter = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;
      assert.equal(goldAfter, goldBefore, 'a skip on an already-claimed job must not debit gold');
    } finally {
      await stopServer();
    }
  });

  it('6b. a GENUINE claim/skip race never debits gold for the loser — pins the UPDATE guard itself', async () => {
    // The HTTP route deliberately hides `now` from the caller (property 1),
    // which makes it impossible to stage a real concurrent claim-vs-skip
    // race through the route itself: both handlers would sample the same
    // wall clock a few microseconds apart, so the sequential case above
    // (6) can't tell the difference between "the UPDATE's own WHERE
    // clause caught it" and "the prior SELECT already caught it" — both
    // guards independently suffice against an ALREADY-claimed job. This
    // test drives `jobs.ts` directly — the one seam that exposes `now`,
    // by design (see the module docblock) — to reproduce the exact race
    // economy-jobs.test.ts already pins, so the specific guard skipJob's
    // own docblock calls out (the WHERE clause, not the initial read) is
    // provably what's carrying the guarantee, not a redundant check.
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    await query(`update users set gold = 1000 where id = $1`, [owner.id]);

    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'aurelia', kind: 'training', payload: {}, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const claimNow = new Date(started.endsAt.getTime() + 1000);
    const skipNow = new Date(started.endsAt.getTime() - 1000);
    const goldBefore = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;

    const [claimRes, skipRes] = await Promise.all([
      claimJob({ lobbyId, teamKey: 'aurelia', jobId: started.jobId, now: claimNow }),
      skipJob({ lobbyId, teamKey: 'aurelia', jobId: started.jobId, userId: owner.id, now: skipNow }),
    ]);

    const goldAfter = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;
    assert.ok(!(claimRes.ok && skipRes.ok), 'both a claim and a skip succeeded on the same job');
    if (!skipRes.ok) {
      assert.equal(skipRes.reason, 'already_claimed');
      assert.equal(goldAfter, goldBefore, 'the skip lost the race but still debited gold');
    }
  });

  // ---------------------------------------------------------------------
  // 7. The notifier writes nothing to the economy.
  // ---------------------------------------------------------------------
  it('7. two sweeps leave every economy value byte-identical', async () => {
    // notify-scheduler.test.ts already pins this exactly, at this same
    // (module) level — there is no HTTP route for the notifier to go
    // through, so this IS the seam. Restated briefly for the closing set.
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    const now = new Date('2026-01-01T00:00:00Z');
    await query(
      `insert into pending_jobs (lobby_id, team_key, kind, payload, started_at, ends_at)
       values ($1, 'aurelia', 'training', '{}'::jsonb, now(), $2)`,
      [lobbyId, new Date(now.getTime() - 1000)],
    );

    async function economyFingerprint(): Promise<string> {
      const eco = await query(
        `select lobby_id, team_key, rp, factory_levels, car, upgrades_done
         from lobby_economy order by lobby_id, team_key`,
      );
      const gold = await query<{ sum: string }>(`select coalesce(sum(gold), 0)::text as sum from users`);
      return JSON.stringify({ eco: eco.rows, goldSum: gold.rows[0].sum });
    }

    const before = await economyFingerprint();
    await sweepReadyJobs({ now, send: () => {} });
    const afterFirst = await economyFingerprint();
    await sweepReadyJobs({ now, send: () => {} });
    const afterSecond = await economyFingerprint();

    assert.equal(afterFirst, before, 'the first sweep touched the economy');
    assert.equal(afterSecond, before, 'the second sweep touched the economy');
  });
});
