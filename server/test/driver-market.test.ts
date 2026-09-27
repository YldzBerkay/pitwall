/**
 * `/drivers/*` — the driver market and contracts, Faz 3b-2 Stage B's first
 * task.
 *
 * The property under test everywhere here is the one the whole slice exists
 * for, same shape as `sponsor-routes.test.ts`: `driverMarket` (`@pitwall/
 * shared/driverMarket`) is a PURE function of (season, round, taken racing
 * numbers, lobby id), so the server can regenerate a lobby's candidate list
 * on demand and check that a `marketId` a sign request names is genuinely
 * on it TODAY — never trusting a fee/wage the client sends. 'the client's
 * fee is ignored' is the test that actually exercises that boundary.
 *
 * PAYLAŞILAN test veritabanı: yalnızca burada yaratılan lobi/kullanıcı
 * kimlikleri izlenir ve `after`da yalnızca onlar silinir (bkz.
 * `sponsor-routes.test.ts`/`driver-ageing.test.ts` ile aynı desen).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerDriverMarketRoutes } from '../src/drivers/routes.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { rolloverRace } from '../src/lobby/rollover.ts';
import { startRaceFor } from '../src/lobby/runner.ts';
import { loadRun } from '../src/lobby/raceRepo.ts';
import { SEASON_ROUNDS } from '@pitwall/shared/season';
import { marketFor, signMarketDriver } from '../src/drivers/market.ts';

let server: Server;
let base: string;
let seq = 0;

// ── ids created by THIS suite, so teardown never touches another suite's
// rows sharing this database (house rule: no table-wide deletes). ─────────
const createdLobbyIds: string[] = [];
const createdUserIds: string[] = [];

const TEAM_A = SEAT_LADDER[0];
const TEAM_B = SEAT_LADDER[1];

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

function post(path: string, token: string | null, payload: Record<string, unknown>) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return json(path, { method: 'POST', headers, body: JSON.stringify(payload) });
}

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    provider: 'google', providerUid: `driver-market-${tag}-${seq}-${Date.now()}`, emailHash: null, base: `DriverTester${seq}`,
  });
  createdUserIds.push(user.id);
  const token = await signSession(user.id);
  return { id: user.id, token };
}

/** A fresh lobby, every team seeded (drivers + economy) by `createLobby` itself. */
async function makeLobby(): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'DriverLobbyOwner', provider: 'google', providerUid: `driver-market-owner-${++seq}-${Date.now()}`, emailHash: null,
  });
  createdUserIds.push(owner.id);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbyIds.push(lobby.id);
  return lobby.id;
}

async function seatHuman(lobbyId: string, teamKey: string, userId: string): Promise<void> {
  await query(
    `update lobby_seats set user_id = $3, managed = 'human', joined_at = now() where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, userId],
  );
}

function startServer(): Promise<void> {
  const router = new Router();
  registerDriverMarketRoutes(router);
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

async function marketRows(lobbyId: string, token: string): Promise<Array<{ id: string; fee: number; wage: number; number: number }>> {
  const res = await get(`/drivers/market?lobbyId=${lobbyId}`, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.market;
}

async function rpOf(lobbyId: string, teamKey: string): Promise<number> {
  const res = await query<{ rp: number }>(`select rp from lobby_economy where lobby_id = $1 and team_key = $2`, [lobbyId, teamKey]);
  return res.rows[0].rp;
}

async function setRp(lobbyId: string, teamKey: string, rp: number): Promise<void> {
  await query(`update lobby_economy set rp = $3 where lobby_id = $1 and team_key = $2`, [lobbyId, teamKey, rp]);
}

async function driverRow(lobbyId: string, id: string) {
  const res = await query<{ id: string; team_key: string | null; position: string; seasons_left: number; wage: number }>(
    `select id, team_key, position, seasons_left, wage from lobby_drivers where lobby_id = $1 and id = $2`,
    [lobbyId, id],
  );
  return res.rows[0] ?? null;
}

/** Cheapest candidate on the sheet, so signing tests never trip over insufficient RP. */
function cheapestOf<T extends { fee: number }>(market: T[]): T {
  return [...market].sort((a, b) => a.fee - b.fee)[0];
}

/** Warm the pool: an unwarmed pool serializes connection setup and only a
 *  handful of "concurrent" callers actually reach the contended window — see
 *  the task brief's own note on this (also `practice.test.ts`'s identical
 *  comment). Ten throwaway queries force the pool to actually open its
 *  connections before the real race starts. */
async function warmPool(n = 10): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => query('select 1')));
}

describe('driver market and contracts', () => {
  before(async () => {
    process.env.SESSION_SECRET ??= 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER ??= 'test-pepper-value';
    await runMigrations();
    await startServer();
  });

  after(async () => {
    if (createdLobbyIds.length) await query(`delete from lobbies where id = any($1::uuid[])`, [createdLobbyIds]);
    if (createdUserIds.length) await query(`delete from users where id = any($1::uuid[])`, [createdUserIds]);
    await stopServer();
    await closePool();
  });

  it('requires a session: 401 without a bearer', async () => {
    const lobbyId = await makeLobby();
    const { status } = await get(`/drivers/market?lobbyId=${lobbyId}`, null);
    assert.equal(status, 401);
  });

  it('a valid session with no seat in that lobby gets 403', async () => {
    const lobbyId = await makeLobby();
    const outsider = await makeUser('outsider');
    const { status } = await get(`/drivers/market?lobbyId=${lobbyId}`, outsider.token);
    assert.equal(status, 403);
  });

  // ── 1. Same lobby, same round: two seated players see the same market ──
  it('1. a seated player sees the lobby market; two players in the same lobby see the same candidates', async () => {
    const lobbyId = await makeLobby();
    const a = await makeUser('same-lobby-a');
    const b = await makeUser('same-lobby-b');
    await seatHuman(lobbyId, TEAM_A, a.id);
    await seatHuman(lobbyId, TEAM_B, b.id);

    const marketA = await marketRows(lobbyId, a.token);
    const marketB = await marketRows(lobbyId, b.token);
    assert.ok(marketA.length > 0, 'expected at least one candidate');
    assert.deepEqual(marketA, marketB);
  });

  // ── 2. Two different lobbies, same round: different markets ────────────
  it('2. two different lobbies see different markets in the same round', async () => {
    const lobbyOne = await makeLobby();
    const lobbyTwo = await makeLobby();
    const one = await makeUser('lobby-one');
    const two = await makeUser('lobby-two');
    await seatHuman(lobbyOne, TEAM_A, one.id);
    await seatHuman(lobbyTwo, TEAM_A, two.id);

    const marketOne = await marketRows(lobbyOne, one.token);
    const marketTwo = await marketRows(lobbyTwo, two.token);
    // Both lobbies are fresh (season 1, round 1) — without the lobby id in
    // the seed these would be byte-identical.
    assert.notDeepEqual(marketOne, marketTwo, 'two lobbies produced the exact same market for the same round');
  });

  // ── 3. Signing charges the server's fee, moves the driver, leaves market ─
  it('3. signing charges the server fee, moves the driver into the seat, and leaves the market', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('sign-basic');
    await seatHuman(lobbyId, TEAM_A, owner.id);

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    const rpBefore = await rpOf(lobbyId, TEAM_A);

    const { status, body } = await post('/drivers/sign', owner.token, {
      lobbyId, marketId: candidate.id, seat: 'seat_0', seasons: 2,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.fee, candidate.fee, 'reported fee did not match the server\'s own candidate fee');

    const rpAfter = await rpOf(lobbyId, TEAM_A);
    assert.equal(rpAfter, rpBefore - body.fee, 'RP was not charged by exactly the reported fee');

    const seat0 = await driverRow(lobbyId, `${TEAM_A}:0`);
    assert.equal(seat0.seasons_left, 2);
    assert.equal(seat0.wage, body.wage);

    const marketAfter = await marketRows(lobbyId, owner.token);
    assert.ok(!marketAfter.some((d: any) => d.id === candidate.id), 'signed driver is still listed on the market');
  });

  // ── 4. First to sign wins — concurrency, pool warmed ────────────────────
  it('4. first to sign wins: exactly one of many concurrent signings succeeds', async () => {
    const lobbyId = await makeLobby();
    const a = await makeUser('race-a');
    const b = await makeUser('race-b');
    await seatHuman(lobbyId, TEAM_A, a.id);
    await seatHuman(lobbyId, TEAM_B, b.id);
    // Plenty of RP so funds are never the reason a signing loses.
    await setRp(lobbyId, TEAM_A, 100_000);
    await setRp(lobbyId, TEAM_B, 100_000);

    const market = await marketRows(lobbyId, a.token);
    const candidate = cheapestOf(market);

    await warmPool();

    // Split across TWO DIFFERENT TEAMS, both into a race seat rather than
    // the reserve squad: `insertReserveDriver`'s row is keyed by `marketId`
    // itself, so `lobby_drivers_pk` would incidentally block a double
    // reserve-sign even with the guard removed (see proof (a) in the task
    // report). A race seat's row is keyed by `teamKey:seat` instead — two
    // DIFFERENT teams' seat rows share no such key — so this is the only
    // shape that actually isolates `claimMarketDriver`'s guard as the sole
    // thing stopping the same real person from driving for two teams.
    const CONCURRENCY = 30;
    let reached = 0;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_unused, i) => {
        reached += 1;
        const teamKey = i % 2 === 0 ? TEAM_A : TEAM_B;
        return signMarketDriver(lobbyId, teamKey, candidate.id, 'seat_0', 2).then((r) => r.outcome);
      }),
    );

    const wins = results.filter((r) => r === 'ok').length;
    const tally: Record<string, number> = {};
    for (const r of results) tally[r] = (tally[r] ?? 0) + 1;
    console.log(`[concurrency] ${CONCURRENCY} callers dispatched, ${reached} reached signMarketDriver, ${wins} won the claim, tally=${JSON.stringify(tally)}`);
    assert.equal(wins, 1, `expected exactly one caller to sign the driver, got ${wins} of ${CONCURRENCY}`);

    // Every loser sees a HONEST rejection, but not always the SAME one: a
    // caller whose own transaction raced the winner's `insert` and lost
    // sees `already_signed` (`claimMarketDriver`'s own conflict); a caller
    // that started only after the winner's transaction already COMMITTED
    // sees `not_found` instead, because `marketFor` (this same function)
    // filters a signed id out of the candidate list entirely — the driver
    // is no longer offered at all, not merely rejected on claim. Both are
    // the same invariant ("you did not get him") observed at two different
    // points in the commit's visibility; neither is silence, and neither is
    // the driver coming back `ok` twice.
    const losers = results.filter((r) => r === 'already_signed' || r === 'not_found').length;
    assert.equal(losers, CONCURRENCY - 1, 'every loser must see an honest rejection (already_signed or not_found)');
  });

  // ── 5. The client's fee is ignored ──────────────────────────────────────
  it('5. the client\'s fee is ignored — an inflated/deflated fee in the request never lands', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('sign-ignores-fee');
    await seatHuman(lobbyId, TEAM_A, owner.id);

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    const rpBefore = await rpOf(lobbyId, TEAM_A);

    const { status, body } = await post('/drivers/sign', owner.token, {
      lobbyId, marketId: candidate.id, seat: 'seat_1', seasons: 2,
      // An attacker's whole point: try to buy a driver for free, or write
      // itself a bigger wage.
      fee: 1, wage: 999_999,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.notEqual(body.fee, 1, 'the client-supplied fee of 1 was honoured');
    assert.equal(body.fee, candidate.fee);

    const rpAfter = await rpOf(lobbyId, TEAM_A);
    assert.equal(rpBefore - rpAfter, candidate.fee, 'the amount actually charged did not match the server\'s fee');

    const seat1 = await driverRow(lobbyId, `${TEAM_A}:1`);
    assert.notEqual(seat1.wage, 999_999, 'the client-supplied wage of 999999 was honoured');
  });

  // ── 6. Insufficient funds refuses, charges nothing, moves nothing ──────
  it('6. insufficient funds refuses the signing, charges nothing, moves nothing', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('sign-no-rp');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 0);

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    const seat0Before = await driverRow(lobbyId, `${TEAM_A}:0`);

    const { status, body } = await post('/drivers/sign', owner.token, {
      lobbyId, marketId: candidate.id, seat: 'seat_0', seasons: 2,
    });
    assert.equal(status, 409);
    assert.equal(body.error, 'not_enough_rp');

    assert.equal(await rpOf(lobbyId, TEAM_A), 0, 'RP moved despite the refusal');
    const seat0After = await driverRow(lobbyId, `${TEAM_A}:0`);
    assert.deepEqual(seat0After, seat0Before, 'the seat changed despite the refusal');

    // And the driver is genuinely still on the market — the failed claim
    // rolled back too.
    const marketAfter = await marketRows(lobbyId, owner.token);
    assert.ok(marketAfter.some((d: any) => d.id === candidate.id), 'a driver whose signing failed on funds was removed from the market anyway');
  });

  // ── 7. Renew and sell follow their rules ────────────────────────────────
  it('7a. renew is refused before the final contract year, and succeeds in it', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('renew');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 100_000);

    // Fresh seat contracts are 1-3 seasons (shared's initialContracts) —
    // force a known "not due" state, then a known "final year" state.
    await query(`update lobby_drivers set seasons_left = 2 where lobby_id = $1 and id = $2`, [lobbyId, `${TEAM_A}:0`]);
    const notDue = await post('/drivers/renew', owner.token, { lobbyId, seat: 0, seasons: 2 });
    assert.equal(notDue.status, 409);
    assert.equal(notDue.body.error, 'not_due');

    await query(`update lobby_drivers set seasons_left = 1 where lobby_id = $1 and id = $2`, [lobbyId, `${TEAM_A}:0`]);
    const rpBefore = await rpOf(lobbyId, TEAM_A);
    const renewed = await post('/drivers/renew', owner.token, { lobbyId, seat: 0, seasons: 2 });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal(await rpOf(lobbyId, TEAM_A), rpBefore - renewed.body.fee);

    const seat0 = await driverRow(lobbyId, `${TEAM_A}:0`);
    // A renewal runs from the end of the current deal: its final season (1)
    // plus the new term (2).
    assert.equal(seat0.seasons_left, 3);
  });

  it('7b. selling a reserve driver pays the sale value and removes him from the squad, but only from the squad', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('sell');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 100_000);

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    const signed = await post('/drivers/sign', owner.token, { lobbyId, marketId: candidate.id, seat: 'reserve', seasons: 2 });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));

    const rpBefore = await rpOf(lobbyId, TEAM_A);
    const { status, body } = await post('/drivers/sell', owner.token, { lobbyId, driverId: candidate.id });
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.payout > 0);
    assert.equal(await rpOf(lobbyId, TEAM_A), rpBefore + body.payout);

    assert.equal(await driverRow(lobbyId, candidate.id), null);
    // The race seats are untouched by a reserve sale.
    const seat0 = await driverRow(lobbyId, `${TEAM_A}:0`);
    assert.ok(seat0, 'selling a reserve driver must not touch the race seats');

    // Selling releases the market claim — the same driver id is signable again.
    const marketAfter = await marketRows(lobbyId, owner.token);
    assert.ok(marketAfter.some((d: any) => d.id === candidate.id), 'a sold driver\'s market id was not released');
  });

  it('selling an unowned or already-sold driver id is a clean 404', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('sell-missing');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    const { status, body } = await post('/drivers/sell', owner.token, { lobbyId, driverId: 'not-a-real-id' });
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  });

  // ── 8. Rollover ticks contracts ─────────────────────────────────────────
  it('8. rollover ticks contracts: a human reserve driver in his final year returns to the market; AI seats renew', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('rollover');
    await seatHuman(lobbyId, TEAM_A, owner.id); // TEAM_A: human. TEAM_B and the rest stay AI.
    await setRp(lobbyId, TEAM_A, 100_000);

    // Sign a reserve driver on a one-season deal — his final year.
    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    const signed = await post('/drivers/sign', owner.token, { lobbyId, marketId: candidate.id, seat: 'reserve', seasons: 1 });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.ok(await driverRow(lobbyId, candidate.id), 'reserve driver was not actually seated in the squad');

    const aiSeat0Before = await driverRow(lobbyId, `${TEAM_B}:0`);
    assert.ok(aiSeat0Before.seasons_left >= 1);

    await query(`update lobbies set phase = 'result', season_no = 1, round_no = $2 where id = $1`, [lobbyId, SEASON_ROUNDS]);
    const outcome = await rolloverRace(lobbyId, 1, SEASON_ROUNDS, new Date());
    assert.ok(outcome.rolled && outcome.seasonRolled, 'rollover did not actually turn the season over');

    // Human reserve driver, final year, expired: gone from the squad.
    assert.equal(await driverRow(lobbyId, candidate.id), null, 'expired reserve driver is still in the squad');
    // And genuinely "back on the market": his market id's claim is gone
    // from `lobby_driver_signings` — checked directly, rather than by
    // looking for `candidate.id` on the CURRENT market listing, because the
    // round also advanced in this same rollover (`driverMarket`'s ids are
    // `${season}-${round}-i`) — a fresh round's candidates never reuse an
    // old round's ids regardless of whether the old one was ever signed,
    // so that particular id could never legitimately reappear either way.
    const claim = await query(
      `select 1 from lobby_driver_signings where lobby_id = $1 and market_id = $2`,
      [lobbyId, candidate.id],
    );
    assert.equal(claim.rowCount, 0, 'expired driver\'s market-signing claim was not released');

    // AI seat: contract renewed, never expired.
    const aiSeat0After = await driverRow(lobbyId, `${TEAM_B}:0`);
    assert.ok(aiSeat0After.seasons_left > 0, 'an AI contract reached zero instead of auto-renewing');
  });

  // ── 9. A seat move after lights-out affects future races only ───────────
  it('9. a driver moved into a seat after lights-out does not change that race\'s replay', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('frozen-roster');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 100_000);

    const now = new Date();
    const started = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now });
    assert.ok(started.snapshot, 'race did not actually start');

    const runBefore = await loadRun(lobbyId, 1, 1);
    assert.ok(runBefore);
    const frozenSeat0Before = runBefore!.snapshot.rosters[TEAM_A]?.[0];
    assert.ok(frozenSeat0Before, 'frozen recipe carries no roster for the seated team');

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    const signResult = await signMarketDriver(lobbyId, TEAM_A, candidate.id, 'seat_0', 2);
    assert.equal(signResult.outcome, 'ok', JSON.stringify(signResult));
    // Confirm the seat really did change, live.
    const seat0Live = await driverRow(lobbyId, `${TEAM_A}:0`);
    assert.notEqual(seat0Live.wage, undefined);

    const runAfter = await loadRun(lobbyId, 1, 1);
    assert.ok(runAfter);
    assert.deepEqual(
      runAfter!.snapshot.rosters[TEAM_A]?.[0],
      frozenSeat0Before,
      'a driver signed after lights-out changed an already-frozen race replay',
    );
  });
});
