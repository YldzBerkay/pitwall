/**
 * `GET /lobby/practice` — the read path for a lobby's completed practice
 * sessions (`src/lobby/practice.ts`'s frozen `practice_runs`, derived on
 * demand with `derivePracticeResult`).
 *
 * Follows the house pattern (`routes.ts`'s own doc comment): exact path, no
 * path parameters, `?id=` matching `GET /lobby`/`GET /lobby/standings`'s own
 * precedent. A session is required; the caller's seat comes from
 * `lobby_seats` via the session, never the request. The read mutates
 * nothing — no test here writes through the route, only through direct repo
 * calls used to set up fixtures.
 *
 * PAYLAŞILAN test veritabanı: yalnızca burada yaratılan kimlikler izlenir ve
 * yalnızca onlar silinir (diğer testlerle aynı desen).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerLobbyRoutes } from '../src/lobby/routes.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { seedTeamEconomy } from '../src/economy/repo.ts';
import { FP1_OFFSET_MS, freezeDuePracticeSessions } from '../src/lobby/practice.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';

const TEAM_A = SEAT_LADDER[0];
const TEAM_B = SEAT_LADDER[1];

let server: Server;
let base: string;
let seq = 0;

const createdLobbies: string[] = [];
const createdUsers: string[] = [];

/** A non-sprint round (matches `practice.test.ts`'s own choice). */
const ROUND = 1;

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, body };
}

function get(path: string, token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return json(path, { headers });
}

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `practice-http-${tag}-${seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(user.id);
  return { id: user.id, token: await signSession(user.id) };
}

async function makeLobby(raceAt: Date): Promise<string> {
  seq += 1;
  const owner = await makeUser(`own-${seq}`);
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at, round_no)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4, $5, $6)
     returning id`,
    [`PracticeHttp #${seq}`, 'PracticeHttp', seq, owner.id, raceAt, ROUND],
  );
  createdLobbies.push(res.rows[0].id);
  return res.rows[0].id;
}

async function seatHuman(lobbyId: string, teamKey: string, tag: string): Promise<{ id: string; token: string }> {
  const user = await makeUser(tag);
  await query(
    `insert into lobby_seats (lobby_id, team_key, user_id, managed) values ($1, $2, $3, 'human')`,
    [lobbyId, teamKey, user.id],
  );
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, teamKey));
  return user;
}

function startServer(): Promise<void> {
  const router = new Router();
  registerLobbyRoutes(router);
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

describe('GET /lobby/practice', () => {
  before(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = process.env.EMAIL_HASH_PEPPER ?? 'test-pepper-value';
    await runMigrations();
    await startServer();
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('a seated player reads the lobby completed sessions', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby(raceAt);
    const driver = await seatHuman(lobbyId, TEAM_A, 'read');

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    await freezeDuePracticeSessions(fp1At);

    const res = await get(`/lobby/practice?id=${lobbyId}`, driver.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions.length, 1, 'the frozen FP1 session did not come back');
    assert.equal(res.body.sessions[0].sessionNo, 1);
    assert.ok(Array.isArray(res.body.sessions[0].result.order), 'no timesheet order in the response');
    assert.ok(res.body.sessions[0].result.order.length > 0, 'the timesheet is empty');
  });

  it('two different seated players get identical timesheets for the same session', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby(raceAt);
    const driverA = await seatHuman(lobbyId, TEAM_A, 'a');
    const driverB = await seatHuman(lobbyId, TEAM_B, 'b');

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    await freezeDuePracticeSessions(fp1At);

    const resA = await get(`/lobby/practice?id=${lobbyId}`, driverA.token);
    const resB = await get(`/lobby/practice?id=${lobbyId}`, driverB.token);
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.deepEqual(resA.body, resB.body, 'two seated players saw different timesheets for the same session');
  });

  it('the read mutates nothing', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby(raceAt);
    const driver = await seatHuman(lobbyId, TEAM_A, 'ro');

    const fp1At = new Date(raceAt.getTime() - FP1_OFFSET_MS);
    await freezeDuePracticeSessions(fp1At);

    const before = await query('select count(*) from practice_runs where lobby_id = $1', [lobbyId]);
    await get(`/lobby/practice?id=${lobbyId}`, driver.token);
    await get(`/lobby/practice?id=${lobbyId}`, driver.token);
    const after = await query('select count(*) from practice_runs where lobby_id = $1', [lobbyId]);
    assert.deepEqual(before.rows, after.rows, 'reading the timesheet changed practice_runs');
  });

  it('no session means 401', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby(raceAt);
    const res = await get(`/lobby/practice?id=${lobbyId}`, null);
    assert.equal(res.status, 401);
  });

  it('no seat means 403', async () => {
    const raceAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const lobbyId = await makeLobby(raceAt);
    await seatHuman(lobbyId, TEAM_A, 'seated');
    const outsider = await makeUser('outsider');

    const res = await get(`/lobby/practice?id=${lobbyId}`, outsider.token);
    assert.equal(res.status, 403);
  });
});
