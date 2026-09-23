/**
 * Koltuk başına hafta sonu tercihleri: veritabanı kısıtları, uç nokta ve
 * `startRaceFor`in bu seçimleri tarife donması.
 *
 * PAYLAŞILAN test veritabanı: tablo geneli `delete` YOK — yalnızca burada
 * yaratılan kimlikler izlenir ve yalnızca onlar silinir (bkz. race-checkin.test.ts).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerWeekendChoiceRoutes } from '../src/lobby/weekendChoices.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { setFactoryLevel } from '../src/economy/repo.ts';
import { startRaceFor, openRace } from '../src/lobby/runner.ts';
import { loadRun, loadDecisions } from '../src/lobby/raceRepo.ts';
import { replayRace } from '../src/lobby/replay.ts';
import { statScore } from '@pitwall/shared/raceEngine';
import { trackForRound } from '@pitwall/shared/tracks';

const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const TEAM_A = SEAT_LADDER[0];
const TEAM_B = SEAT_LADDER[1];

let server: Server;
let base: string;

interface Res { status: number; body: any }

async function post(path: string, token: string | null, payload: Record<string, unknown>): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* bırak null */ }
  return { status: res.status, body };
}

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `wc-${tag}-${seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(user.id);
  return { id: user.id, token: await signSession(user.id) };
}

/** Testin ihtiyaç duyduğu en küçük lobi: 11 koltuk + 11 ekonomi satırı. */
async function makeLobby(tag: string): Promise<string> {
  const owner = await makeUser(`own-${tag}`);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbies.push(lobby.id);
  return lobby.id;
}

async function seat(lobbyId: string, teamKey: string, managed: 'human' | 'assistant', tag: string) {
  const user = await makeUser(tag);
  await query(
    `update lobby_seats set user_id = $3, managed = $4, joined_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, user.id, managed],
  );
  return user;
}

async function setPhase(lobbyId: string, phase: string) {
  await query('update lobbies set phase = $2 where id = $1', [lobbyId, phase]);
}

async function seatChoices(lobbyId: string, teamKey: string) {
  const res = await query<{ compound: string | null; bias: string | null; tactics: string | null; quali_risk: string | null }>(
    'select compound, bias, tactics, quali_risk from lobby_seats where lobby_id = $1 and team_key = $2',
    [lobbyId, teamKey],
  );
  return res.rows[0];
}

function startServer(): Promise<void> {
  const router = new Router();
  registerWeekendChoiceRoutes(router);
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

describe('weekend choices', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();
    await startServer();
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  // ── 1. Round-trip ──────────────────────────────────────────────────────

  it('a seat\'s choices round-trip through the database', async () => {
    const lobbyId = await makeLobby('roundtrip');
    await query(
      `update lobby_seats set compound = 'SOFT', bias = 0.5, tactics = 'aggressive', quali_risk = 'aggressive'
       where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    );
    const row = await seatChoices(lobbyId, TEAM_A);
    assert.equal(row.compound, 'SOFT');
    assert.equal(Number(row.bias), 0.5);
    assert.equal(row.tactics, 'aggressive');
    assert.equal(row.quali_risk, 'aggressive');
  });

  // ── 2. Invalid values rejected by the database ─────────────────────────

  it('rejects a lowercase compound', async () => {
    const lobbyId = await makeLobby('bad-compound');
    await assert.rejects(() => query(
      `update lobby_seats set compound = 'soft' where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    ));
  });

  it('rejects an unknown tactic', async () => {
    const lobbyId = await makeLobby('bad-tactic');
    await assert.rejects(() => query(
      `update lobby_seats set tactics = 'yolo' where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    ));
  });

  it('rejects an out-of-range bias', async () => {
    const lobbyId = await makeLobby('bad-bias');
    await assert.rejects(() => query(
      `update lobby_seats set bias = 1.5 where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    ));
  });

  it('rejects an unknown quali risk', async () => {
    const lobbyId = await makeLobby('bad-risk');
    await assert.rejects(() => query(
      `update lobby_seats set quali_risk = 'yolo' where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    ));
  });

  // ── 3. The route stores choices for the caller's own seat only ─────────

  it('stores choices for the session\'s own seat, ignoring a different teamKey in the body', async () => {
    const lobbyId = await makeLobby('own-seat');
    const userA = await seat(lobbyId, TEAM_A, 'human', 'own-seat-a');
    await seat(lobbyId, TEAM_B, 'human', 'own-seat-b');
    await setPhase(lobbyId, 'open');

    const res = await post('/race/weekend-choices', userA.token, {
      lobbyId, teamKey: TEAM_B, compound: 'HARD', tactics: 'conservative', qualiRisk: 'safe', bias: -0.4,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.teamKey, TEAM_A, 'a teamKey in the body must be ignored');

    const rowA = await seatChoices(lobbyId, TEAM_A);
    assert.equal(rowA.compound, 'HARD');
    const rowB = await seatChoices(lobbyId, TEAM_B);
    assert.equal(rowB.compound, null, 'the other team must be untouched');
  });

  // ── 4. Phase gate ────────────────────────────────────────────────────────

  it('is accepted in the open phase', async () => {
    const lobbyId = await makeLobby('phase-open');
    const user = await seat(lobbyId, TEAM_A, 'human', 'phase-open-a');
    await setPhase(lobbyId, 'open');
    const res = await post('/race/weekend-choices', user.token, { lobbyId, tactics: 'aggressive' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('is accepted in the checkin phase', async () => {
    const lobbyId = await makeLobby('phase-checkin');
    const user = await seat(lobbyId, TEAM_A, 'human', 'phase-checkin-a');
    await setPhase(lobbyId, 'checkin');
    const res = await post('/race/weekend-choices', user.token, { lobbyId, tactics: 'aggressive' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('is rejected once the lobby is live', async () => {
    const lobbyId = await makeLobby('phase-live');
    const user = await seat(lobbyId, TEAM_A, 'human', 'phase-live-a');
    await setPhase(lobbyId, 'live');
    const res = await post('/race/weekend-choices', user.token, { lobbyId, tactics: 'aggressive' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'wrong_phase');
  });

  // ── 5. startRaceFor uses the stored choices ─────────────────────────────

  it('startRaceFor freezes the stored tactics into the snapshot, not the default', async () => {
    const lobbyId = await makeLobby('runner-tactics');
    await seat(lobbyId, TEAM_A, 'human', 'runner-tactics-a');
    await query(
      `update lobby_seats set tactics = 'aggressive', compound = 'SOFT', bias = 0.8, quali_risk = 'aggressive'
       where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    );

    const { snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const entry = snapshot.entries[TEAM_A];
    assert.ok(entry, 'team must be in entries');
    assert.equal(entry.tactics, 'aggressive');
    assert.equal(entry.setup.compound, 'SOFT');
    assert.equal(entry.setup.bias, 0.8);
    assert.equal(snapshot.risks?.[TEAM_A], 'aggressive');
  });

  // ── 6. A seat with no choices still races, on the defaults ─────────────

  it('a seat with no choices still races, on today\'s defaults', async () => {
    const lobbyId = await makeLobby('runner-defaults');
    await seat(lobbyId, TEAM_A, 'human', 'runner-defaults-a');

    const { snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const entry = snapshot.entries[TEAM_A];
    assert.ok(entry, 'team must be in entries');
    assert.equal(entry.tactics, 'balanced');
    assert.equal(entry.setup.compound, 'MEDIUM');
    assert.equal(entry.setup.bias, 0);
    assert.equal(snapshot.risks?.[TEAM_A], 'safe');
  });

  // ── 7. Changing a choice after lights-out does not change the running race ─

  it('a choice changed after lights-out does not affect the already-started race', async () => {
    const lobbyId = await makeLobby('post-lights-out');
    await seat(lobbyId, TEAM_A, 'human', 'post-lights-out-a');
    await query(
      `update lobby_seats set tactics = 'conservative' where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    );
    await setPhase(lobbyId, 'live');

    const started = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    assert.equal(started.snapshot.entries[TEAM_A].tactics, 'conservative');

    // Doğrudan SQL ile, ışıklar söndükten SONRA değiştir.
    await query(
      `update lobby_seats set tactics = 'aggressive' where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    );

    // Donmuş tarif satırın kendisinde hâlâ 'conservative' — DB'nin
    // `race_runs_immutable` tetikleyicisi zaten bunu garanti eder.
    const run = await loadRun(lobbyId, 1, 1);
    assert.ok(run, 'run must exist');
    assert.equal(run!.snapshot.entries[TEAM_A].tactics, 'conservative');

    // Asıl kanıt: PRODÜKSİYONUN yarışı devraldığı/oynattığı gerçek yol —
    // `openRace` — de hâlâ donmuş tarifi kullanmalı, `lobby_seats`teki
    // GÜNCEL satırı değil.
    const opened = await openRace({ lobbyId, seasonNo: 1, roundNo: 1, ownerId: 'wc-test-owner', now: new Date() });
    assert.ok(opened, 'race must be open');
    assert.equal(opened!.state.entries[TEAM_A].tactics, 'conservative',
      'openRace must replay the FROZEN choice, not the one just written to lobby_seats');
  });

  // ── 8. Different choices produce genuinely different qualifying results ─

  it('two teams with different choices produce different qualifying results', async () => {
    const lobbyId = await makeLobby('quali-diff');
    await seat(lobbyId, TEAM_A, 'human', 'quali-diff-a');
    await seat(lobbyId, TEAM_B, 'human', 'quali-diff-b');
    await query(
      `update lobby_seats set bias = 1, compound = 'SOFT' where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_A],
    );
    await query(
      `update lobby_seats set bias = -1, compound = 'HARD' where lobby_id = $1 and team_key = $2`,
      [lobbyId, TEAM_B],
    );

    const { snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const track = trackForRound(1);
    const scoreA = statScore(snapshot.entries[TEAM_A].setup, track);
    const scoreB = statScore(snapshot.entries[TEAM_B].setup, track);
    // Zıt bias (+1 / -1) ve farklı bileşimin (SOFT/HARD) motorun kendi
    // formülüyle (statScore, effectiveStats) GERÇEKTEN farklı bir sıralama
    // pace'i ürettiğini kanıtlar — bu, özelliğin kozmetik olmadığının
    // doğrudan kanıtıdır, bir yarış çalıştırıp sonucu tahmin etmeye çalışmak
    // (gürültülü ve gevrek) yerine.
    assert.notEqual(scoreA, scoreB, 'opposite bias must move the stat score');
    assert.notEqual(snapshot.entries[TEAM_A].setup.compound, snapshot.entries[TEAM_B].setup.compound);
  });
});
