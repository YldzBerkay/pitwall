/**
 * `GET /economy/career` — reading the signed-in USER's career.
 *
 * Follows `GET /economy/settlement`'s own precedent (see that route's test
 * file and `economy/routes.ts`'s docblock): the router does exact path
 * matching with no path parameters, a session is mandatory, and the value
 * read comes from the caller's OWN row — never anything the request
 * supplies. Unlike every other read in this file's siblings, a career has NO
 * lobby to scope it: it belongs to the user (`user_careers`, keyed by
 * `user_id`), because a player races in 3-5 lobbies and all of them fold
 * into the same row (`013_career.sql`, `careerRepo.ts`).
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
import { loadCareerForUpdate, saveCareer } from '../src/economy/careerRepo.ts';

let server: Server;
let base: string;
let seq = 0;

// ── ids created by THIS suite, so teardown never touches another suite's
// rows sharing this database (house rule: no table-wide deletes). ─────────
const createdUserIds: string[] = [];

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
    provider: 'google', providerUid: `career-http-${seq}-${Date.now()}`, emailHash: null, base: `CareerTester${seq}`,
  });
  createdUserIds.push(user.id);
  const token = await signSession(user.id);
  return { id: user.id, token };
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

describe('GET /economy/career', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();
    await startServer();
  });

  after(async () => {
    if (createdUserIds.length) {
      await query(`delete from users where id = any($1::uuid[])`, [createdUserIds]);
    }
    await stopServer();
    await closePool();
  });

  it("reads the signed-in user's own career", async () => {
    const user = await makeUser();
    await withTransaction(async (client) => {
      const career = await loadCareerForUpdate(client, user.id);
      await saveCareer(client, user.id, {
        ...career,
        score: 245,
        races: 3,
        wins: 1,
        podiums: 2,
        counts: { ...career.counts, win: 1, podium: 2 },
      });
    });

    const { status, body } = await get('/economy/career', user.token);
    assert.equal(status, 200);
    assert.equal(body.career.score, 245);
    assert.equal(body.career.races, 3);
    assert.equal(body.career.wins, 1);
    assert.equal(body.career.podiums, 2);
    assert.equal(body.career.counts.win, 1);
    assert.equal(body.career.counts.podium, 2);
  });

  it('a user with no career row yet reads an empty career, not an error', async () => {
    const user = await makeUser();
    const { status, body } = await get('/economy/career', user.token);
    assert.equal(status, 200);
    assert.equal(body.career.score, 0);
    assert.equal(body.career.races, 0);
  });

  it('mutates nothing: no row is created by the read itself', async () => {
    const user = await makeUser();
    await get('/economy/career', user.token);
    const rows = await query('select 1 from user_careers where user_id = $1', [user.id]);
    assert.equal(rows.rows.length, 0, 'a plain read must never insert the on-conflict row `loadCareerForUpdate` would');
  });

  it('requires a session: 401 without a bearer', async () => {
    const { status } = await get('/economy/career', null);
    assert.equal(status, 401);
  });
});
