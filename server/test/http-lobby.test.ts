import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerAuthRoutes } from '../src/auth/routes.ts';
import { registerIdentityRoutes } from '../src/identity/routes.ts';
import { registerLobbyRoutes } from '../src/lobby/routes.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { SEAT_LADDER, TEAM_COUNT } from '../src/lobby/grid.ts';
import { SLOT_PRICE_GOLD } from '../src/lobby/slotRepo.ts';

let server: Server;
let base: string;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function json(
  path: string,
  init?: RequestInit & { token?: string },
): Promise<{ status: number; body: any }> {
  const { token, ...rest } = init ?? {};
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string>) };
  if (rest.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { ...rest, headers });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, body };
}

const post = (path: string, body: unknown, token?: string) =>
  json(path, { method: 'POST', body: JSON.stringify(body), token });

let seq = 0;

interface Player { token: string; id: string; nickname: string }

async function signUp(): Promise<Player> {
  seq += 1;
  const { status, body } = await post('/auth/password/register', {
    email: `player${seq}-${Date.now()}@example.test`,
    password: 'correct horse battery',
    region: 'EU',
  });
  assert.equal(status, 201, JSON.stringify(body));
  return { token: body.token, id: body.user.id, nickname: body.user.nickname };
}

/** A lobby whose creator is already seated — the only kind anyone can find. */
async function openLobby(
  settings: Record<string, unknown> = {},
  teamKey = SEAT_LADDER[0],
): Promise<{ owner: Player; lobbyId: string }> {
  const owner = await signUp();
  const created = await post('/lobby/create', settings, owner.token);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const lobbyId = created.body.lobby.id;
  const joined = await post('/lobby/join', { lobbyId, teamKey }, owner.token);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { owner, lobbyId };
}

describe('lobby http', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'b'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();

    const router = new Router();
    registerAuthRoutes(router);
    registerIdentityRoutes(router);
    registerLobbyRoutes(router);

    server = createServer(async (req, res) => {
      if (await router.handle(req, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  beforeEach(async () => { await query('delete from users'); });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await closePool();
  });

  it('refuses every lobby endpoint without a session', async () => {
    const calls: [string, () => Promise<{ status: number }>][] = [
      ['GET /slots', () => json('/slots')],
      ['POST /slots/unlock', () => post('/slots/unlock', { slotIndex: 4 })],
      ['POST /lobby/create', () => post('/lobby/create', {})],
      ['POST /lobby/quick-match', () => post('/lobby/quick-match', {})],
      ['POST /lobby/join', () => post('/lobby/join', { lobbyId: 'x', teamKey: 'y' })],
      ['GET /lobby', () => json('/lobby?id=x')],
      ['POST /lobby/invite', () => post('/lobby/invite', { lobbyId: 'x', nickname: 'y#1' })],
      ['GET /invites', () => json('/invites')],
    ];
    for (const [label, call] of calls) {
      assert.equal((await call()).status, 401, label);
    }
  });

  describe('GET /slots', () => {
    it('returns five rows, three of them unlocked and empty', async () => {
      const player = await signUp();
      const { status, body } = await json('/slots', { token: player.token });
      assert.equal(status, 200);
      assert.equal(body.slotPrice, SLOT_PRICE_GOLD);
      assert.equal(body.slots.length, 5);
      assert.deepEqual(body.slots.map((s: any) => s.unlocked), [true, true, true, false, false]);
      assert.ok(body.slots.every((s: any) => s.lobby === null));
    });

    it('shows the team, season, round and lobby name of an occupied slot', async () => {
      const { owner } = await openLobby();
      const { body } = await json('/slots', { token: owner.token });
      const slot = body.slots[0];
      assert.equal(slot.lobby.teamKey, SEAT_LADDER[0]);
      assert.ok(slot.lobby.teamName.length > 0);
      assert.equal(slot.lobby.seasonNo, 1);
      assert.equal(slot.lobby.roundNo, 1);
      assert.ok(slot.lobby.totalRounds > 1);
      assert.match(slot.lobby.name, /#\d+$/);
    });
  });

  describe('POST /slots/unlock', () => {
    it('sells slot 4 for 250 Gold', async () => {
      const player = await signUp();
      await query('update users set gold = $2 where id = $1', [player.id, SLOT_PRICE_GOLD]);
      const { status, body } = await post('/slots/unlock', { slotIndex: 4 }, player.token);
      assert.equal(status, 200);
      assert.equal(body.gold, 0);
      assert.equal(body.slots[3].unlocked, true);
    });

    it('answers 402 when the gold is not there', async () => {
      const player = await signUp();
      const { status, body } = await post('/slots/unlock', { slotIndex: 4 }, player.token);
      assert.equal(status, 402);
      assert.equal(body.error, 'insufficient_gold');
    });

    it('refuses a slot that is free anyway', async () => {
      const player = await signUp();
      const { status, body } = await post('/slots/unlock', { slotIndex: 2 }, player.token);
      assert.equal(status, 400);
      assert.equal(body.error, 'not_purchasable');
    });
  });

  describe('POST /lobby/create', () => {
    it('opens a lobby offering all eleven teams to its creator', async () => {
      const player = await signUp();
      const { status, body } = await post('/lobby/create', { aiDifficulty: 'hard' }, player.token);
      assert.equal(status, 201);
      assert.equal(body.lobby.aiDifficulty, 'hard');
      assert.equal(body.lobby.region, 'EU');
      assert.equal(body.seats.length, TEAM_COUNT);
      // Every row carries what the player is signing up for (§3.3).
      for (const seat of body.seats) {
        assert.ok(seat.objective >= 1);
        assert.ok(seat.rankPoints > 0);
        assert.ok(seat.carRating > 0);
      }
      // Hard is worth 1.4x normal.
      const normal = await post('/lobby/create', { aiDifficulty: 'normal' }, player.token);
      assert.ok(body.seats[0].rankPoints > normal.body.seats[0].rankPoints);
    });

    it('rejects a nonsense setting rather than quietly defaulting it', async () => {
      const player = await signUp();
      for (const [patch, error] of [
        [{ region: 'MARS' }, 'invalid_region'],
        [{ visibility: 'secret' }, 'invalid_visibility'],
        [{ aiDifficulty: 'brutal' }, 'invalid_difficulty'],
        [{ rankMin: 8, rankMax: 3 }, 'invalid_rank_gate'],
        [{ rankMin: 0 }, 'invalid_rank_gate'],
      ] as const) {
        const { status, body } = await post('/lobby/create', patch, player.token);
        assert.equal(status, 400, JSON.stringify(patch));
        assert.equal(body.error, error);
      }
    });

    it('refuses once every slot already holds a lobby', async () => {
      const player = await signUp();
      for (let i = 0; i < 3; i += 1) {
        const created = await post('/lobby/create', {}, player.token);
        assert.equal(created.status, 201);
        const joined = await post(
          '/lobby/join',
          { lobbyId: created.body.lobby.id, teamKey: SEAT_LADDER[0] },
          player.token,
        );
        assert.equal(joined.status, 200);
      }
      const { status, body } = await post('/lobby/create', {}, player.token);
      assert.equal(status, 409);
      assert.equal(body.error, 'no_free_slot');
    });
  });

  describe('POST /lobby/quick-match', () => {
    it('offers nothing when no lobby is joinable', async () => {
      const player = await signUp();
      const { status, body } = await post('/lobby/quick-match', {}, player.token);
      assert.equal(status, 200);
      assert.equal(body.candidate, null);
    });

    it('returns one card whose counts match the real seats', async () => {
      const { lobbyId } = await openLobby();
      const player = await signUp();
      const { body } = await post('/lobby/quick-match', {}, player.token);
      assert.equal(body.candidate.lobby.id, lobbyId);
      assert.equal(body.candidate.humans, 1);
      assert.equal(body.candidate.ai, TEAM_COUNT - 1);
      // The card's free list IS the free list — one row per genuinely open
      // seat, nothing withheld and nothing invented (§3.4).
      assert.equal(body.candidate.seats.length, TEAM_COUNT - 1);
      assert.ok(!body.candidate.seats.some((s: any) => s.teamKey === SEAT_LADDER[0]));
      assert.equal(body.candidate.occupancy.topPair, true);
    });

    it('moves on when the player says "başka bul"', async () => {
      const first = await openLobby();
      const second = await openLobby();
      const player = await signUp();
      const a = await post('/lobby/quick-match', {}, player.token);
      const b = await post('/lobby/quick-match', { exclude: [a.body.candidate.lobby.id] }, player.token);
      assert.notEqual(b.body.candidate.lobby.id, a.body.candidate.lobby.id);
      assert.deepEqual(
        [a.body.candidate.lobby.id, b.body.candidate.lobby.id].sort(),
        [first.lobbyId, second.lobbyId].sort(),
      );

      // Neither offer committed anything: the slots are all still free.
      const slots = await json('/slots', { token: player.token });
      assert.ok(slots.body.slots.every((s: any) => s.lobby === null));
    });
  });

  describe('POST /lobby/join', () => {
    it('seats the player and returns the grid', async () => {
      const { lobbyId } = await openLobby();
      const player = await signUp();
      const { status, body } = await post('/lobby/join', { lobbyId, teamKey: SEAT_LADDER[3] }, player.token);
      assert.equal(status, 200);
      assert.equal(body.slotIndex, 1);
      const mine = body.seats.find((s: any) => s.userId === player.id);
      assert.equal(mine.teamKey, SEAT_LADDER[3]);
      assert.equal(mine.managed, 'human');
      assert.equal(mine.nickname, player.nickname);
    });

    it('answers 409 for a seat that is already gone', async () => {
      const { lobbyId } = await openLobby();
      const player = await signUp();
      const { status, body } = await post('/lobby/join', { lobbyId, teamKey: SEAT_LADDER[0] }, player.token);
      assert.equal(status, 409);
      assert.equal(body.error, 'seat_taken');
    });

    it('validates its input', async () => {
      const player = await signUp();
      assert.equal((await post('/lobby/join', { lobbyId: 'x' }, player.token)).status, 400);
      assert.equal((await post('/lobby/join', { lobbyId: 'x', teamKey: 'nope' }, player.token)).status, 400);
      const real = await openLobby();
      const { status, body } = await post(
        '/lobby/join',
        { lobbyId: '11111111-1111-1111-1111-111111111111', teamKey: SEAT_LADDER[1] },
        player.token,
      );
      assert.equal(status, 404);
      assert.equal(body.error, 'lobby_not_found');
      assert.ok(real.lobbyId);
    });
  });

  describe('GET /lobby', () => {
    it('shows a public lobby to anyone and hides a private one', async () => {
      const open = await openLobby();
      const secret = await openLobby({ visibility: 'private' });
      const stranger = await signUp();

      const visible = await json(`/lobby?id=${open.lobbyId}`, { token: stranger.token });
      assert.equal(visible.status, 200);
      assert.equal(visible.body.seats.length, TEAM_COUNT);

      const hidden = await json(`/lobby?id=${secret.lobbyId}`, { token: stranger.token });
      assert.equal(hidden.status, 404);
      // Its own members still see it.
      const inside = await json(`/lobby?id=${secret.lobbyId}`, { token: secret.owner.token });
      assert.equal(inside.status, 200);
    });
  });

  describe('invites', () => {
    it('invites by full tag and lets the invitee in', async () => {
      const { owner, lobbyId } = await openLobby({ visibility: 'private' });
      const friend = await signUp();

      const invited = await post('/lobby/invite', { lobbyId, nickname: friend.nickname }, owner.token);
      assert.equal(invited.status, 201, JSON.stringify(invited.body));

      const inbox = await json('/invites', { token: friend.token });
      assert.equal(inbox.body.invites.length, 1);
      assert.equal(inbox.body.invites[0].inviter, owner.nickname);
      assert.equal(inbox.body.invites[0].lobby.id, lobbyId);
      assert.equal(inbox.body.invites[0].seats.length, TEAM_COUNT - 1);

      const joined = await post('/lobby/join', { lobbyId, teamKey: SEAT_LADDER[2] }, friend.token);
      assert.equal(joined.status, 200);
      assert.equal((await json('/invites', { token: friend.token })).body.invites.length, 0);
    });

    it('does not confirm whether a partial nickname exists', async () => {
      // Exact-tag lookup only — §5's privacy rule, enforced from the first
      // feature that searches for a player.
      const { owner, lobbyId } = await openLobby();
      const friend = await signUp();
      const base = friend.nickname.split('#')[0];
      for (const attempt of [base, `${base}#`, `${base}#12`, 'Nobody#0001']) {
        const { status, body } = await post('/lobby/invite', { lobbyId, nickname: attempt }, owner.token);
        assert.equal(status, 404, attempt);
        assert.equal(body.error, 'player_not_found');
      }
    });

    it('refuses an inviter with no seat in the lobby', async () => {
      const { lobbyId } = await openLobby();
      const stranger = await signUp();
      const friend = await signUp();
      const { status, body } = await post('/lobby/invite', { lobbyId, nickname: friend.nickname }, stranger.token);
      assert.equal(status, 403);
      assert.equal(body.error, 'not_in_lobby');
    });
  });
});
