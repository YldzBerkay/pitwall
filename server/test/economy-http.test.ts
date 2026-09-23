import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerEconomyRoutes } from '../src/economy/routes.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { seedTeamEconomy } from '../src/economy/repo.ts';
import { GOLD_TO_RP, GOLD_TO_RP_DAILY_CAP } from '@pitwall/shared/economy';
import { DEPARTMENT_MAX_LEVEL } from '@pitwall/shared/factory';

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

async function makeUser(): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    provider: 'google',
    providerUid: `econ-http-${seq}-${Date.now()}`,
    emailHash: null,
    base: `EconTester${seq}`,
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
    [`EconLobby #${seq}`, 'EconLobby', seq, creatorUserId],
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

async function seatAi(lobbyId: string, teamKey: string): Promise<void> {
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, teamKey));
  await query(
    `insert into lobby_seats (lobby_id, team_key, user_id, managed)
     values ($1, $2, null, 'ai')`,
    [lobbyId, teamKey],
  );
}

async function rpOf(lobbyId: string, teamKey: string): Promise<number> {
  const res = await query<{ rp: number }>(
    `select rp from lobby_economy where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey],
  );
  return res.rows[0].rp;
}

function startServer(): Promise<void> {
  const router = new Router();
  registerEconomyRoutes(router);
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

function post(path: string, token: string | null, payload: Record<string, unknown>) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return json(path, { method: 'POST', headers, body: JSON.stringify(payload) });
}

function get(path: string, token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return json(path, { method: 'GET', headers });
}

/** A full snapshot of everything a read must leave untouched. */
async function snapshotEconomy(lobbyId: string, teamKey: string, userId: string) {
  const economy = (await query(
    `select rp, factory_levels, car, spy_state, upgrades_done, updated_at
     from lobby_economy where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey],
  )).rows[0];
  const jobs = (await query(
    `select id, kind, payload, started_at, ends_at, claimed_at, notified_at
     from pending_jobs where lobby_id = $1 and team_key = $2 order by id`,
    [lobbyId, teamKey],
  )).rows;
  const caps = (await query(
    `select day, ads_watched, gold_converted from daily_caps where user_id = $1 order by day`,
    [userId],
  )).rows;
  const gold = (await query<{ gold: number }>('select gold from users where id = $1', [userId])).rows[0].gold;
  return { economy, jobs, caps, gold };
}

describe('economy http', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();
    await startServer();
  });

  beforeEach(async () => {
    await query('delete from pending_jobs');
    await query('delete from lobby_seats');
    await query('delete from lobby_economy');
    await query('delete from daily_caps');
    await query('delete from lobbies');
    await query('delete from users');
  });

  after(async () => {
    await stopServer();
    await closePool();
  });

  it('requires a session: 401 without a bearer', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);

    const { status } = await post('/economy/action', null, { lobbyId, type: 'startUpgrade', label: 'motor' });
    assert.equal(status, 401);
  });

  it('a valid session with no seat in that lobby gets 403', async () => {
    const owner = await makeUser();
    const outsider = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);

    const { status } = await post('/economy/action', outsider.token, {
      lobbyId, type: 'startUpgrade', label: 'motor',
    });
    assert.equal(status, 403);
  });

  it('startUpgrade returns 200 with the whole slot state: serverNow parses, one job, rp dropped', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    const before = await rpOf(lobbyId, 'aurelia');

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'startUpgrade', label: 'motor',
    });

    assert.equal(status, 200);
    assert.ok(!Number.isNaN(Date.parse(body.serverNow)), 'serverNow must parse as a date');
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].kind, 'upgrade');
    assert.ok(body.rp < before, 'rp must have dropped');
  });

  it('an unknown action type is 400 unknown_action, never a 500', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'doSomethingWeird',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'unknown_action');
  });

  it('claiming a job before it is ready returns 409 not_ready', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);

    const start = await post('/economy/action', owner.token, { lobbyId, type: 'startUpgrade', label: 'motor' });
    const jobId = start.body.jobs[0].jobId;

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'claimUpgrade', jobId,
    });
    assert.equal(status, 409);
    assert.equal(body.error, 'not_ready');
  });

  it('a second open upgrade is 409 already_running and leaves rp unchanged', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);

    await post('/economy/action', owner.token, { lobbyId, type: 'startUpgrade', label: 'motor' });
    const rpAfterFirst = await rpOf(lobbyId, 'aurelia');

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'startUpgrade', label: 'aero',
    });
    assert.equal(status, 409);
    assert.equal(body.error, 'already_running');

    const rpAfterSecond = await rpOf(lobbyId, 'aurelia');
    assert.equal(rpAfterSecond, rpAfterFirst, 'a rejected second start must not touch rp');
  });

  it('upgradeFactory raises a department level and charges rp, and refuses past the max level', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    // Give the team plenty of RP so the department-cap boundary is what's
    // under test, not the RP cost ladder.
    await query(`update lobby_economy set rp = 10000000 where lobby_id = $1 and team_key = $2`, [lobbyId, 'aurelia']);

    const rpBefore = await rpOf(lobbyId, 'aurelia');
    const first = await post('/economy/action', owner.token, {
      lobbyId, type: 'upgradeFactory', code: 'wind_tunnel',
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.factory.wind_tunnel, 1);
    assert.ok((await rpOf(lobbyId, 'aurelia')) < rpBefore, 'rp must have been charged');

    // Drive the department straight to its max level, then confirm the
    // next attempt is refused rather than exercising the whole cost ladder.
    await query(
      `update lobby_economy set factory_levels = jsonb_set(factory_levels, '{wind_tunnel}', to_jsonb($3::int), true)
       where lobby_id = $1 and team_key = $2`,
      [lobbyId, 'aurelia', DEPARTMENT_MAX_LEVEL],
    );
    const atCap = await post('/economy/action', owner.token, { lobbyId, type: 'upgradeFactory', code: 'wind_tunnel' });
    assert.equal(atCap.status, 409);
    assert.equal(atCap.body.error, 'cap_reached');
  });

  it('an unknown department code is 400 bad_payload', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'upgradeFactory', code: 'not_a_real_department',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_payload');
  });

  it('convertGoldToRp converts within the daily cap and is refused once it is spent', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    await query(`update users set gold = 1000 where id = $1`, [owner.id]);

    const rpBefore = await rpOf(lobbyId, 'aurelia');
    const first = await post('/economy/action', owner.token, {
      lobbyId, type: 'convertGoldToRp', gold: GOLD_TO_RP_DAILY_CAP,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.rp, rpBefore + GOLD_TO_RP_DAILY_CAP * GOLD_TO_RP);
    assert.equal(first.body.gold, 1000 - GOLD_TO_RP_DAILY_CAP);

    const second = await post('/economy/action', owner.token, { lobbyId, type: 'convertGoldToRp', gold: 1 });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'cap_reached');
  });

  it('convertGoldToRp refuses when the account does not have enough gold', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    await query(`update users set gold = 0 where id = $1`, [owner.id]);

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'convertGoldToRp', gold: 1,
    });
    assert.equal(status, 409);
    assert.equal(body.error, 'not_enough_gold');
  });

  it('convertGoldToRp: gold spent, rp credited and the cap counter are mutually consistent — never one without the others', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    await query(`update users set gold = 1000 where id = $1`, [owner.id]);

    const goldBefore = 1000;
    const rpBefore = await rpOf(lobbyId, 'aurelia');
    const amount = 5;

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'convertGoldToRp', gold: amount,
    });
    assert.equal(status, 200);

    const goldAfter = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;
    const rpAfter = await rpOf(lobbyId, 'aurelia');
    const capsAfter = (await query<{ gold_converted: number }>(
      `select gold_converted from daily_caps where user_id = $1`,
      [owner.id],
    )).rows[0];

    assert.equal(goldAfter, goldBefore - amount, 'gold must be spent by exactly the converted amount');
    assert.equal(rpAfter, rpBefore + amount * GOLD_TO_RP, 'rp must be credited for exactly the converted amount');
    assert.equal(capsAfter.gold_converted, amount, 'the cap counter must record exactly the converted amount');
    assert.equal(body.gold, goldAfter);
    assert.equal(body.rp, rpAfter);
  });

  it('convertGoldToRp past the daily cap is refused and spends nothing', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    await query(`update users set gold = 1000 where id = $1`, [owner.id]);

    // Use up the whole day's cap first.
    const first = await post('/economy/action', owner.token, {
      lobbyId, type: 'convertGoldToRp', gold: GOLD_TO_RP_DAILY_CAP,
    });
    assert.equal(first.status, 200);
    const goldAfterFirst = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;
    const rpAfterFirst = await rpOf(lobbyId, 'aurelia');

    // Any further conversion this UTC day must be refused, and refused
    // ATOMICALLY — no gold taken even though the account can afford it.
    const second = await post('/economy/action', owner.token, { lobbyId, type: 'convertGoldToRp', gold: 1 });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'cap_reached');

    const goldAfterSecond = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;
    const rpAfterSecond = await rpOf(lobbyId, 'aurelia');
    assert.equal(goldAfterSecond, goldAfterFirst, 'a cap-refused conversion must not have spent gold');
    assert.equal(rpAfterSecond, rpAfterFirst, 'a cap-refused conversion must not have credited rp');
  });

  it('RACE: conversions racing for the same user never exceed the daily cap', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    // Plenty of gold, so the daily cap — not the balance — is what's tested.
    await query(`update users set gold = 1000000 where id = $1`, [owner.id]);

    const rpBefore = await rpOf(lobbyId, 'aurelia');
    const chunk = Math.max(1, Math.floor(GOLD_TO_RP_DAILY_CAP / 4));
    const attempts = 8;

    const results = await Promise.all(
      Array.from({ length: attempts }, () => post('/economy/action', owner.token, {
        lobbyId, type: 'convertGoldToRp', gold: chunk,
      })),
    );

    const succeeded = results.filter((r) => r.status === 200).length;
    const totalConverted = succeeded * chunk;
    assert.ok(
      totalConverted <= GOLD_TO_RP_DAILY_CAP,
      `concurrent conversions overshot the daily cap: converted ${totalConverted} > cap ${GOLD_TO_RP_DAILY_CAP}`,
    );

    const capsAfter = (await query<{ gold_converted: number }>(
      `select gold_converted from daily_caps where user_id = $1`,
      [owner.id],
    )).rows[0];
    assert.equal(capsAfter.gold_converted, totalConverted, 'the cap counter must match exactly what was actually converted');

    const goldAfter = (await query<{ gold: number }>('select gold from users where id = $1', [owner.id])).rows[0].gold;
    assert.equal(goldAfter, 1000000 - totalConverted, 'gold spent must match exactly what was converted');

    const rpAfter = await rpOf(lobbyId, 'aurelia');
    assert.equal(rpAfter, rpBefore + totalConverted * GOLD_TO_RP, 'rp credited must match exactly what was converted');
  });

  it('the team key in the request body is ignored — the seat, not the body, decides', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);
    await seatAi(lobbyId, 'silberpfad');

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'startUpgrade', label: 'motor', teamKey: 'silberpfad',
    });
    assert.equal(status, 200);
    assert.equal(body.teamKey, 'aurelia', 'the response must reflect the seat team, not the body team');

    const silberpfadJobs = await query('select 1 from pending_jobs where lobby_id = $1 and team_key = $2', [lobbyId, 'silberpfad']);
    assert.equal(silberpfadJobs.rowCount, 0, 'the other team named in the body must not have been touched');
  });

  it('never echoes the request body back in the response', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);

    const distinctive = 'canary-value-should-never-appear-9182';
    const { text } = await post('/economy/action', owner.token, {
      lobbyId, type: 'startUpgrade', label: 'motor', extraneous: distinctive,
    });
    assert.ok(!text.includes(distinctive));
  });

  it('a malformed body (non-string label) is 400 bad_payload, not a crash', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'startUpgrade', label: 12345,
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_payload');
  });

  it('a request-supplied clock is ignored: a future now/serverNow/timestamp in the body cannot fast-forward a claim', async () => {
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
  });

  it('a malformed body (missing jobId) is 400 bad_payload, not a crash', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await seatHuman(lobbyId, 'aurelia', owner.id);

    const { status, body } = await post('/economy/action', owner.token, {
      lobbyId, type: 'claimUpgrade',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_payload');
  });

  // ── GET /economy/state — read-only, no mutation ─────────────────────────

  describe('GET /economy/state', () => {
    it('a seated player reads their slot state, serverNow included', async () => {
      const owner = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      await seatHuman(lobbyId, 'aurelia', owner.id);

      const { status, body } = await get(`/economy/state?lobbyId=${lobbyId}`, owner.token);
      assert.equal(status, 200);
      assert.equal(body.lobbyId, lobbyId);
      assert.equal(body.teamKey, 'aurelia');
      assert.ok(!Number.isNaN(Date.parse(body.serverNow)), 'serverNow must parse as a date');
      assert.equal(typeof body.rp, 'number');
    });

    it('reading mutates nothing: economy row, open jobs and daily caps are byte-for-byte unchanged', async () => {
      const owner = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      await seatHuman(lobbyId, 'aurelia', owner.id);
      // Give the slot some state worth checking for corruption: an open job
      // and some daily-cap usage, not just the freshly-seeded defaults.
      await post('/economy/action', owner.token, { lobbyId, type: 'startUpgrade', label: 'motor' });
      await query(`update users set gold = 500 where id = $1`, [owner.id]);
      await post('/economy/action', owner.token, { lobbyId, type: 'convertGoldToRp', gold: 3 });

      const before = await snapshotEconomy(lobbyId, 'aurelia', owner.id);

      const { status } = await get(`/economy/state?lobbyId=${lobbyId}`, owner.token);
      assert.equal(status, 200);

      const after = await snapshotEconomy(lobbyId, 'aurelia', owner.id);
      assert.deepEqual(after, before, 'GET /economy/state must not write anything, anywhere');
    });

    it('requires a session: 401 without a bearer', async () => {
      const owner = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      await seatHuman(lobbyId, 'aurelia', owner.id);

      const { status } = await get(`/economy/state?lobbyId=${lobbyId}`, null);
      assert.equal(status, 401);
    });

    it('a valid session with no seat in that lobby gets 403', async () => {
      const owner = await makeUser();
      const outsider = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      await seatHuman(lobbyId, 'aurelia', owner.id);

      const { status } = await get(`/economy/state?lobbyId=${lobbyId}`, outsider.token);
      assert.equal(status, 403);
    });

    it('the team key comes from the seat — a teamKey supplied by the caller is ignored', async () => {
      const owner = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      await seatHuman(lobbyId, 'aurelia', owner.id);
      await seatAi(lobbyId, 'silberpfad');

      const { status, body } = await get(`/economy/state?lobbyId=${lobbyId}&teamKey=silberpfad`, owner.token);
      assert.equal(status, 200);
      assert.equal(body.teamKey, 'aurelia', 'the response must reflect the seat team, not the query team');
    });

    it('a lobby with no economy row for the seated team yields the distinct no_economy reason', async () => {
      const owner = await makeUser();
      const lobbyId = await makeLobby(owner.id);
      // Seat the player WITHOUT seeding lobby_economy for their team, unlike
      // seatHuman — this is the "unseeded team" case buildSlotState guards.
      await query(
        `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
         values ($1, $2, $3, 'human', now())`,
        [lobbyId, 'aurelia', owner.id],
      );

      const { status, body } = await get(`/economy/state?lobbyId=${lobbyId}`, owner.token);
      assert.equal(status, 404);
      assert.equal(body.error, 'no_economy');
    });

    it('a missing lobbyId query param is 400 invalid_request, not a crash', async () => {
      const owner = await makeUser();
      const { status } = await get('/economy/state', owner.token);
      assert.equal(status, 400);
    });
  });
});
