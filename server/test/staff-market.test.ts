/**
 * `/staff/*` — the staff market and hiring, Faz 3b-2 Stage C's first task.
 *
 * Same shape as `driver-market.test.ts`: `staffMarket` (`@pitwall/shared/
 * staff`) is a PURE function of (season, round, lobby id), so the server
 * regenerates a lobby's candidate list on demand and checks that a
 * `marketId` a hire request names is genuinely on it TODAY — never trusting
 * a fee/wage the client sends.
 *
 * PAYLAŞILAN test veritabanı: yalnızca burada yaratılan lobi/kullanıcı
 * kimlikleri izlenir ve `after`da yalnızca onlar silinir (bkz.
 * `driver-market.test.ts` ile aynı desen).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerStaffRoutes } from '../src/staff/routes.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { hireMarketStaff } from '../src/staff/market.ts';

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
    provider: 'google', providerUid: `personnel-market-${tag}-${seq}-${Date.now()}`, emailHash: null, base: `CrewTester${seq}`,
  });
  createdUserIds.push(user.id);
  const token = await signSession(user.id);
  return { id: user.id, token };
}

/** A fresh lobby, every team seeded (drivers + economy) by `createLobby` itself. */
async function makeLobby(): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'CrewLobbyOwner', provider: 'google', providerUid: `personnel-market-owner-${++seq}-${Date.now()}`, emailHash: null,
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
  registerStaffRoutes(router);
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

async function marketRows(lobbyId: string, token: string): Promise<Array<{ id: string; role: string; wage: number; contractRounds: number }>> {
  const res = await get(`/staff/market?lobbyId=${lobbyId}`, token);
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

async function staffRow(lobbyId: string, teamKey: string, role: string) {
  const res = await query<{ id: string; skill: number; wage: number; contract_rounds: number }>(
    `select id, skill, wage, contract_rounds from lobby_staff where lobby_id = $1 and team_key = $2 and role = $3`,
    [lobbyId, teamKey, role],
  );
  return res.rows[0] ?? null;
}

/** Cheapest candidate on the sheet, so hiring tests never trip over insufficient RP. */
function cheapestOf<T extends { wage: number }>(market: T[]): T {
  return [...market].sort((a, b) => a.wage - b.wage)[0];
}

/** Warm the pool: an unwarmed pool serializes connection setup and only a
 *  handful of "concurrent" callers actually reach the contended window —
 *  see the task brief's own note on this (also `driver-market.test.ts`'s
 *  identical comment). Ten throwaway queries force the pool to actually
 *  open its connections before the real race starts. */
async function warmPool(n = 10): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => query('select 1')));
}

describe('staff market and hiring', () => {
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
    const { status } = await get(`/staff/market?lobbyId=${lobbyId}`, null);
    assert.equal(status, 401);
  });

  it('a valid session with no seat in that lobby gets 403', async () => {
    const lobbyId = await makeLobby();
    const outsider = await makeUser('outsider');
    const { status } = await get(`/staff/market?lobbyId=${lobbyId}`, outsider.token);
    assert.equal(status, 403);
  });

  // ── 1. Same lobby, same round: two seated players see the same market ──
  it('1. a seated player sees the lobby staff market; two players in the same lobby see the same candidates', async () => {
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
  it('2. two different lobbies see different staff markets in the same round', async () => {
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
    assert.notDeepEqual(marketOne, marketTwo, 'two lobbies produced the exact same staff market for the same round');
  });

  // ── 3. Hiring charges the server fee, assigns the staff member, leaves market ─
  it('3. hiring charges the server fee, assigns the staff member, and leaves the market', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('hire-basic');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 100_000);

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    const rpBefore = await rpOf(lobbyId, TEAM_A);

    const { status, body } = await post('/staff/hire', owner.token, { lobbyId, marketId: candidate.id });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.fee, candidate.wage * 2, 'reported fee did not match the server\'s own 2x-wage fee');

    const rpAfter = await rpOf(lobbyId, TEAM_A);
    assert.equal(rpAfter, rpBefore - body.fee, 'RP was not charged by exactly the reported fee');

    const row = await staffRow(lobbyId, TEAM_A, candidate.role);
    assert.ok(row, 'hired staff member was not seated');
    assert.equal(row!.id, candidate.id);
    assert.equal(row!.wage, body.wage);
    assert.equal(row!.contract_rounds, candidate.contractRounds);

    const marketAfter = await marketRows(lobbyId, owner.token);
    assert.ok(!marketAfter.some((c) => c.id === candidate.id), 'hired candidate is still listed on the market');
  });

  // ── 4. First to hire wins — concurrency, pool warmed ────────────────────
  it('4. first to hire wins: exactly one of many concurrent hires succeeds', async () => {
    const lobbyId = await makeLobby();
    const a = await makeUser('race-a');
    const b = await makeUser('race-b');
    await seatHuman(lobbyId, TEAM_A, a.id);
    await seatHuman(lobbyId, TEAM_B, b.id);
    await setRp(lobbyId, TEAM_A, 100_000);
    await setRp(lobbyId, TEAM_B, 100_000);

    const market = await marketRows(lobbyId, a.token);
    const candidate = cheapestOf(market);

    await warmPool();

    // Split across TWO DIFFERENT TEAMS so `lobby_staff_pk (lobby_id,
    // team_key, role)` can never incidentally block the double-hire on its
    // own — the only thing stopping the same candidate from being hired
    // twice must be `claimMarketStaff`'s guard (see proof (a) in the task
    // report).
    const CONCURRENCY = 30;
    let reached = 0;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_unused, i) => {
        reached += 1;
        const teamKey = i % 2 === 0 ? TEAM_A : TEAM_B;
        return hireMarketStaff(lobbyId, teamKey, candidate.id, false).then((r) => r.outcome);
      }),
    );

    const wins = results.filter((r) => r === 'ok').length;
    const tally: Record<string, number> = {};
    for (const r of results) tally[r] = (tally[r] ?? 0) + 1;
    console.log(`[concurrency] ${CONCURRENCY} callers dispatched, ${reached} reached hireMarketStaff, ${wins} won the claim, tally=${JSON.stringify(tally)}`);
    assert.equal(wins, 1, `expected exactly one caller to hire the staff member, got ${wins} of ${CONCURRENCY}`);

    const losers = results.filter((r) => r === 'already_hired' || r === 'not_found').length;
    assert.equal(losers, CONCURRENCY - 1, 'every loser must see an honest rejection (already_hired or not_found)');
  });

  // ── 5. The client's fee is ignored ──────────────────────────────────────
  it('5. the client\'s fee is ignored — an inflated/deflated fee in the request never lands', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('hire-ignores-fee');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 100_000);

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    const rpBefore = await rpOf(lobbyId, TEAM_A);

    const { status, body } = await post('/staff/hire', owner.token, {
      lobbyId, marketId: candidate.id,
      // An attacker's whole point: try to hire staff for free, or write
      // itself a bigger wage.
      fee: 1, wage: 999_999,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.notEqual(body.fee, 1, 'the client-supplied fee of 1 was honoured');
    assert.equal(body.fee, candidate.wage * 2);

    const rpAfter = await rpOf(lobbyId, TEAM_A);
    assert.equal(rpBefore - rpAfter, candidate.wage * 2, 'the amount actually charged did not match the server\'s fee');

    const row = await staffRow(lobbyId, TEAM_A, candidate.role);
    assert.notEqual(row!.wage, 999_999, 'the client-supplied wage of 999999 was honoured');
  });

  // ── 6. Insufficient funds refuses, charges nothing, hires nothing ──────
  it('6. insufficient funds refuses the hire, charges nothing, hires nothing', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('hire-no-rp');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 0);

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);

    const { status, body } = await post('/staff/hire', owner.token, { lobbyId, marketId: candidate.id });
    assert.equal(status, 409);
    assert.equal(body.error, 'not_enough_rp');

    assert.equal(await rpOf(lobbyId, TEAM_A), 0, 'RP moved despite the refusal');
    assert.equal(await staffRow(lobbyId, TEAM_A, candidate.role), null, 'a seat was filled despite the refusal');

    // And the candidate is genuinely still on the market — the failed claim
    // rolled back too.
    const marketAfter = await marketRows(lobbyId, owner.token);
    assert.ok(marketAfter.some((c) => c.id === candidate.id), 'a candidate whose hire failed on funds was removed from the market anyway');
  });

  // ── 7. Releasing follows the client's rule: no refund, no penalty ──────
  it('7. releasing empties the seat with no refund and no penalty', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('release');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 100_000);

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    const hired = await post('/staff/hire', owner.token, { lobbyId, marketId: candidate.id });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));

    const rpBefore = await rpOf(lobbyId, TEAM_A);
    const { status, body } = await post('/staff/release', owner.token, { lobbyId, role: candidate.role });
    assert.equal(status, 200, JSON.stringify(body));

    assert.equal(await rpOf(lobbyId, TEAM_A), rpBefore, 'releasing changed the RP balance — client rule is no refund, no penalty');
    assert.equal(await staffRow(lobbyId, TEAM_A, candidate.role), null, 'the seat was not actually emptied');
  });

  // ── 8. Capacity per role is enforced ────────────────────────────────────
  it('8. capacity per role is enforced: a second hire into an occupied role is refused without replace, honoured with it', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('capacity');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 100_000);

    const market = await marketRows(lobbyId, owner.token);
    const first = cheapestOf(market);
    const firstHire = await post('/staff/hire', owner.token, { lobbyId, marketId: first.id });
    assert.equal(firstHire.status, 200, JSON.stringify(firstHire.body));

    const second = market.find((c) => c.role === first.role && c.id !== first.id);
    assert.ok(second, 'expected a second candidate in the same role to test capacity against');

    const refused = await post('/staff/hire', owner.token, { lobbyId, marketId: second!.id });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'seat_taken');

    // Nothing changed: the occupied seat still holds the first hire.
    const rowAfterRefusal = await staffRow(lobbyId, TEAM_A, first.role);
    assert.equal(rowAfterRefusal!.id, first.id);

    // With `replace`, the seat IS overwritten.
    const rpBeforeReplace = await rpOf(lobbyId, TEAM_A);
    const replaced = await post('/staff/hire', owner.token, { lobbyId, marketId: second!.id, replace: true });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(await rpOf(lobbyId, TEAM_A), rpBeforeReplace - replaced.body.fee);

    const rowAfterReplace = await staffRow(lobbyId, TEAM_A, first.role);
    assert.equal(rowAfterReplace!.id, second!.id);
  });

  // ── 9. contractRounds: stored as hired, and does not tick on its own ────
  it('9. contractRounds is stored exactly as the market generated it, and nothing in this task ticks it', async () => {
    const lobbyId = await makeLobby();
    const owner = await makeUser('contract-rounds');
    await seatHuman(lobbyId, TEAM_A, owner.id);
    await setRp(lobbyId, TEAM_A, 100_000);

    const market = await marketRows(lobbyId, owner.token);
    const candidate = cheapestOf(market);
    assert.ok(candidate.contractRounds >= 6 && candidate.contractRounds <= 15, 'candidate contractRounds out of the shared seed\'s expected range');

    const hired = await post('/staff/hire', owner.token, { lobbyId, marketId: candidate.id });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));

    const rowRightAfter = await staffRow(lobbyId, TEAM_A, candidate.role);
    assert.equal(rowRightAfter!.contract_rounds, candidate.contractRounds);

    // Decision: nothing in THIS task ticks `contractRounds` down — a
    // per-round tick belongs at race settlement, which is next task's "wire
    // staff into the race and economy" work. Reading the roster again
    // (no race, no settlement, no season rollover happened in between)
    // must show the exact same value — proving the field is stored, not
    // silently mutated by anything this task added.
    const rosterRes = await get(`/staff/roster?lobbyId=${lobbyId}`, owner.token);
    assert.equal(rosterRes.status, 200, JSON.stringify(rosterRes.body));
    const seat = rosterRes.body.roster.find((r: any) => r.role === candidate.role);
    assert.ok(seat, 'hired staff member missing from roster read');
    assert.equal(seat.member.contractRounds, candidate.contractRounds, 'contractRounds changed without any tick mechanism existing yet');
  });
});
