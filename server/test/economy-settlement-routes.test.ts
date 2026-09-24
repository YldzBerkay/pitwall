/**
 * `GET /economy/settlement` — reading one seat's race-settlement breakdown.
 *
 * Follows `GET /economy/state`'s own precedent exactly (see
 * `economy/routes.ts`'s docblock and `economy-http.test.ts`): the router
 * does exact path matching with no path parameters but does expose the
 * query string, a session is mandatory, and the team read is the caller's
 * OWN `lobby_seats` row — never a `teamKey` the request supplies. This
 * suite proves that boundary plus the two properties specific to a
 * settlement read: it mutates nothing, and a round that has not settled yet
 * comes back as "nothing yet" (`settlement: null`, 200), not an error.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerEconomyRoutes } from '../src/economy/routes.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER, TEAM_COUNT } from '../src/lobby/grid.ts';
import { startRaceFor } from '../src/lobby/runner.ts';
import { settleRace } from '../src/economy/settle.ts';
import { insertSponsorship } from '../src/economy/sponsorshipRepo.ts';

let server: Server;
let base: string;
let seq = 0;

// ── ids created by THIS suite, so teardown never touches another suite's
// rows sharing this database (house rule: no table-wide deletes). ─────────
const createdLobbyIds: string[] = [];
const createdUserIds: string[] = [];

const HUMAN = SEAT_LADDER[0];

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
  return json(path, { method: 'GET', headers });
}

async function makeUser(): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    provider: 'google', providerUid: `settlement-http-${seq}-${Date.now()}`, emailHash: null, base: `SettleTester${seq}`,
  });
  createdUserIds.push(user.id);
  const token = await signSession(user.id);
  return { id: user.id, token };
}

/** A full lobby (all 11 seats, all economy rows) with the human seat handed to `userId`. */
async function makeLobby(userId: string): Promise<string> {
  const lobby = await createLobby(userId, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbyIds.push(lobby.id);
  await query(
    `update lobby_seats set user_id = $3, managed = 'human', joined_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobby.id, HUMAN, userId],
  );
  return lobby.id;
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

/** Everything a read must leave untouched: every seat's economy row and sponsorship row in the lobby. */
async function snapshotLobby(lobbyId: string) {
  const economy = (await query(
    `select team_key, rp, factory_levels, car, spy_state, upgrades_done, updated_at
     from lobby_economy where lobby_id = $1 order by team_key`,
    [lobbyId],
  )).rows;
  const sponsorships = (await query(
    `select team_key, deal_id, brand_key, slot, per_race, target_position, bonus, streak
     from sponsorships where lobby_id = $1 order by team_key, slot`,
    [lobbyId],
  )).rows;
  return { economy, sponsorships };
}

describe('GET /economy/settlement', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();
    await startServer();
  });

  after(async () => {
    if (createdLobbyIds.length) {
      await query(`delete from lobbies where id = any($1::uuid[])`, [createdLobbyIds]);
    }
    if (createdUserIds.length) {
      await query(`delete from users where id = any($1::uuid[])`, [createdUserIds]);
    }
    await stopServer();
    await closePool();
  });

  it('reads the seated player\'s own breakdown for a round that has settled', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await withTransaction((client) => insertSponsorship(client, lobbyId, HUMAN, {
      dealId: 'route-deal', brandKey: 'axion', slot: 'sidepod', perRace: 70, bonus: 200,
      signedRound: 1, expiresRound: 99, streakTarget: 5, streak: 0, targetPosition: TEAM_COUNT,
    }));
    await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const expected = settlement.payouts.find((p) => p.teamKey === HUMAN)!;

    const { status, body } = await get(`/economy/settlement?lobbyId=${lobbyId}&round=1`, owner.token);
    assert.equal(status, 200);
    assert.ok(body.settlement, 'settled round must not read as empty');
    assert.equal(body.settlement.round, 1);
    assert.equal(body.settlement.position, expected.position);
    assert.equal(body.settlement.prize, expected.prize);
    assert.equal(body.settlement.sponsorIncome, expected.sponsorIncome);
    assert.equal(body.settlement.briefBonus, expected.briefBonus);
    assert.deepEqual(body.settlement.bonusesEarned, expected.bonusesEarned);
    assert.deepEqual(body.settlement.streaksBroken, expected.streaksBroken);
    // A deal running to round 99 has NOT lapsed at the end of round 1.
    assert.deepEqual(body.settlement.expired, []);
  });

  it('reports the slots whose contract lapsed this round — the same ones it deleted', async () => {
    // The player learns a sponsorship ended ONLY from this field: settlement
    // deletes the lapsed deal outright, so after the fact there is nothing
    // left to ask. A deal expiring at round 2 is gone at the end of round 1
    // (the client's own `expiresRound <= nextRound` rule, mirrored in
    // `settle.ts`), so it must be named here — and its slot must really be
    // empty afterwards, or this field would be describing a deletion that
    // did not happen.
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await withTransaction(async (client) => {
      await insertSponsorship(client, lobbyId, HUMAN, {
        dealId: 'lapsing-deal', brandKey: 'axion', slot: 'sidepod', perRace: 70, bonus: 200,
        signedRound: 1, expiresRound: 2, streakTarget: 5, streak: 0, targetPosition: TEAM_COUNT,
      });
      await insertSponsorship(client, lobbyId, HUMAN, {
        dealId: 'running-deal', brandKey: 'velox', slot: 'noseFront', perRace: 40, bonus: 100,
        signedRound: 1, expiresRound: 99, streakTarget: 5, streak: 0, targetPosition: TEAM_COUNT,
      });
    });
    await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    const { status, body } = await get(`/economy/settlement?lobbyId=${lobbyId}&round=1`, owner.token);
    assert.equal(status, 200);
    assert.deepEqual(body.settlement.expired, ['sidepod']);

    const left = await query<{ slot: string }>(
      `select slot from sponsorships where lobby_id = $1 and team_key = $2 order by slot`,
      [lobbyId, HUMAN],
    );
    assert.deepEqual(left.rows.map((r) => r.slot), ['noseFront'], 'the reported slot must be the one actually freed');
  });

  it('never uses a teamKey the caller supplies — the seat decides', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    // A `teamKey` query param, even naming a real team in this lobby, is not
    // read anywhere in this route — the response must still reflect HUMAN.
    const { status, body } = await get(`/economy/settlement?lobbyId=${lobbyId}&round=1&teamKey=${SEAT_LADDER[2]}`, owner.token);
    assert.equal(status, 200);
    assert.equal(body.settlement.position >= 1, true);
  });

  it('a round that has not settled yet reads as "nothing yet", not an error', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    // No race started at all for round 1 — nothing to settle.
    const { status, body } = await get(`/economy/settlement?lobbyId=${lobbyId}&round=1`, owner.token);
    assert.equal(status, 200);
    assert.equal(body.settlement, null);
  });

  it('mutates nothing: economy and sponsorship rows are identical before and after the read', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);
    await withTransaction((client) => insertSponsorship(client, lobbyId, HUMAN, {
      dealId: 'mutate-check-deal', brandKey: 'axion', slot: 'sidepod', perRace: 55, bonus: 150,
      signedRound: 1, expiresRound: 99, streakTarget: 5, streak: 0, targetPosition: 1,
    }));
    await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    const before = await snapshotLobby(lobbyId);
    const { status } = await get(`/economy/settlement?lobbyId=${lobbyId}&round=1`, owner.token);
    assert.equal(status, 200);
    const after = await snapshotLobby(lobbyId);
    assert.deepEqual(after, before, 'GET /economy/settlement must not write anything, anywhere');
  });

  it('requires a session: 401 without a bearer', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);

    const { status } = await get(`/economy/settlement?lobbyId=${lobbyId}&round=1`, null);
    assert.equal(status, 401);
  });

  it('a valid session with no seat in that lobby gets 403', async () => {
    const owner = await makeUser();
    const outsider = await makeUser();
    const lobbyId = await makeLobby(owner.id);

    const { status } = await get(`/economy/settlement?lobbyId=${lobbyId}&round=1`, outsider.token);
    assert.equal(status, 403);
  });

  it('a missing lobbyId or round query param is 400 invalid_request, not a crash', async () => {
    const owner = await makeUser();
    const lobbyId = await makeLobby(owner.id);

    const missingRound = await get(`/economy/settlement?lobbyId=${lobbyId}`, owner.token);
    assert.equal(missingRound.status, 400);

    const missingLobby = await get(`/economy/settlement?round=1`, owner.token);
    assert.equal(missingLobby.status, 400);

    const badRound = await get(`/economy/settlement?lobbyId=${lobbyId}&round=abc`, owner.token);
    assert.equal(badRound.status, 400);
  });
});
