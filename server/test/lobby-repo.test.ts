import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import {
  candidatePool,
  createInvite,
  createLobby,
  listInvites,
  loadLobby,
  loadSeats,
  takeSeat,
  type LobbySettings,
} from '../src/lobby/lobbyRepo.ts';
import {
  FREE_SLOTS,
  SLOT_COUNT,
  SLOT_PRICE_GOLD,
  claimSlot,
  ensureSlots,
  listSlots,
  unlockSlot,
} from '../src/lobby/slotRepo.ts';
import { SEAT_LADDER, TEAM_COUNT } from '../src/lobby/grid.ts';

const SETTINGS: LobbySettings = {
  region: 'EU',
  visibility: 'public',
  aiDifficulty: 'normal',
  rankMin: 1,
  rankMax: 10,
  guestsCanInvite: true,
  midSeasonJoin: true,
};

let seq = 0;

/** A user with a unique nickname; `gold` defaults to nothing in the bank. */
async function makeUser(gold = 0): Promise<string> {
  seq += 1;
  const res = await query<{ id: string }>(
    `insert into users (nickname_base, nickname_tag, gold, region)
     values ($1, $2, $3, 'EU') returning id`,
    [`Tester${seq}`, String(1000 + (seq % 9000)).padStart(4, '0'), gold],
  );
  return res.rows[0].id;
}

/** Creates a lobby and seats its creator, the way the real flow does. */
async function lobbyWithCreator(
  settings: Partial<LobbySettings> = {},
  teamKey: string = SEAT_LADDER[0],
): Promise<{ lobbyId: string; creatorId: string }> {
  const creatorId = await makeUser();
  const lobby = await createLobby(creatorId, { ...SETTINGS, ...settings });
  const seated = await takeSeat({ userId: creatorId, lobbyId: lobby.id, teamKey, rankLevel: 1 });
  assert.equal(seated.ok, true);
  return { lobbyId: lobby.id, creatorId };
}

describe('lobby repository', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    // account_slots, lobbies, lobby_seats and lobby_invites all cascade from
    // users, so one delete clears the whole fixture.
    await query('delete from users');
  });
  after(async () => { await closePool(); });

  describe('account slots (§4.1)', () => {
    it('gives three unlocked slots and two locked ones', async () => {
      const userId = await makeUser();
      const slots = await listSlots(userId, 24);
      assert.equal(slots.length, SLOT_COUNT);
      assert.deepEqual(
        slots.map((s) => s.unlocked),
        [true, true, true, false, false],
      );
      assert.ok(slots.every((s) => s.lobby === null));
    });

    it('is idempotent — a second ensureSlots never resets an unlock', async () => {
      const userId = await makeUser(SLOT_PRICE_GOLD);
      assert.deepEqual(await unlockSlot(userId, 4), { ok: true, gold: 0 });
      await ensureSlots(userId);
      const slots = await listSlots(userId, 24);
      assert.equal(slots[3].unlocked, true);
    });

    it('charges 250 Gold for slot 4 and refuses without it', async () => {
      const poor = await makeUser(SLOT_PRICE_GOLD - 1);
      assert.deepEqual(await unlockSlot(poor, 4), { ok: false, reason: 'insufficient_gold' });
      const gold = await query<{ gold: number }>('select gold from users where id = $1', [poor]);
      assert.equal(gold.rows[0].gold, SLOT_PRICE_GOLD - 1, 'a refused purchase must not debit');
    });

    it('refuses to sell a free slot or a slot past the cap', async () => {
      const userId = await makeUser(10_000);
      for (const index of [1, FREE_SLOTS, SLOT_COUNT + 1, 0, 2.5]) {
        assert.deepEqual(await unlockSlot(userId, index), { ok: false, reason: 'not_purchasable' }, `slot ${index}`);
      }
      const gold = await query<{ gold: number }>('select gold from users where id = $1', [userId]);
      assert.equal(gold.rows[0].gold, 10_000);
    });

    it('will not sell the same slot twice', async () => {
      const userId = await makeUser(SLOT_PRICE_GOLD * 2);
      assert.equal((await unlockSlot(userId, 5)).ok, true);
      assert.deepEqual(await unlockSlot(userId, 5), { ok: false, reason: 'already_unlocked' });
      const gold = await query<{ gold: number }>('select gold from users where id = $1', [userId]);
      assert.equal(gold.rows[0].gold, SLOT_PRICE_GOLD, 'the second attempt must not debit again');
    });

    it('charges exactly once when two purchases race for the same gold', async () => {
      const userId = await makeUser(SLOT_PRICE_GOLD);
      const [a, b] = await Promise.all([unlockSlot(userId, 4), unlockSlot(userId, 5)]);
      const succeeded = [a, b].filter((r) => r.ok);
      assert.equal(succeeded.length, 1, `expected one winner, got ${JSON.stringify([a, b])}`);
      const gold = await query<{ gold: number }>('select gold from users where id = $1', [userId]);
      assert.equal(gold.rows[0].gold, 0);
    });
  });

  describe('createLobby (§3.1, §3.2)', () => {
    it('names itself from the region pool and numbers it', async () => {
      const userId = await makeUser();
      const lobby = await createLobby(userId, SETTINGS);
      assert.match(lobby.name, /^[A-Za-z ]+ #\d+$/);
      assert.equal(lobby.seasonNo, 1);
      assert.equal(lobby.roundNo, 1);
      assert.equal(lobby.phase, 'open');
      assert.ok(lobby.nextRaceAt.getTime() > Date.now());
    });

    it('writes all eleven seats as AI up front', async () => {
      const userId = await makeUser();
      const lobby = await createLobby(userId, SETTINGS);
      const seats = await loadSeats(lobby.id);
      assert.equal(seats.length, TEAM_COUNT);
      assert.ok(seats.every((s) => s.managed === 'ai' && s.userId === null));
      assert.deepEqual(seats.map((s) => s.teamKey), [...SEAT_LADDER]);
    });

    it('gives concurrent creations distinct names', async () => {
      const users = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
      const lobbies = await Promise.all(users.map((u) => createLobby(u, SETTINGS)));
      assert.equal(new Set(lobbies.map((l) => l.name)).size, lobbies.length);
    });

    it('treats an unknown lobby id — including a malformed one — as not found', async () => {
      assert.equal(await loadLobby('not-a-uuid'), null);
      assert.equal(await loadLobby('11111111-1111-1111-1111-111111111111'), null);
    });
  });

  describe('takeSeat (§3.3)', () => {
    it('claims the team and spends the lowest free slot', async () => {
      const { lobbyId, creatorId } = await lobbyWithCreator();
      const slots = await listSlots(creatorId, 24);
      assert.equal(slots[0].lobbyId, lobbyId);
      assert.ok(slots.slice(1).every((s) => s.lobbyId === null), 'only one slot may be spent');

      const seats = await loadSeats(lobbyId);
      const mine = seats.find((s) => s.userId === creatorId);
      assert.equal(mine?.teamKey, SEAT_LADDER[0]);
      assert.equal(mine?.managed, 'human');
    });

    it('hands the seat to exactly one of two players racing for it', async () => {
      const { lobbyId } = await lobbyWithCreator();
      const a = await makeUser();
      const b = await makeUser();
      const team = SEAT_LADDER[1];
      const results = await Promise.all([
        takeSeat({ userId: a, lobbyId, teamKey: team, rankLevel: 1 }),
        takeSeat({ userId: b, lobbyId, teamKey: team, rankLevel: 1 }),
      ]);
      const winners = results.filter((r) => r.ok);
      assert.equal(winners.length, 1, JSON.stringify(results));

      // The loser's slot must be untouched — the slot is only spent on a
      // seat that was actually won (§3.3).
      const loser = results[0].ok ? b : a;
      const slots = await listSlots(loser, 24);
      assert.ok(slots.every((s) => s.lobbyId === null), 'a lost race must not spend a slot');
    });

    it('refuses a second team in the same lobby', async () => {
      const { lobbyId, creatorId } = await lobbyWithCreator();
      const again = await takeSeat({ userId: creatorId, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 1 });
      assert.deepEqual(again, { ok: false, reason: 'already_in_lobby' });
    });

    it('refuses an unknown team key without touching a slot', async () => {
      const { lobbyId } = await lobbyWithCreator();
      const userId = await makeUser();
      assert.deepEqual(
        await takeSeat({ userId, lobbyId, teamKey: 'ferrari', rankLevel: 1 }),
        { ok: false, reason: 'unknown_team' },
      );
      const slots = await listSlots(userId, 24);
      assert.ok(slots.every((s) => s.lobbyId === null));
    });

    it('refuses when every unlocked slot is already in use', async () => {
      const userId = await makeUser();
      for (let i = 0; i < FREE_SLOTS; i += 1) {
        const { lobbyId } = await lobbyWithCreator();
        const r = await takeSeat({ userId, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 1 });
        assert.equal(r.ok, true, `slot ${i + 1}`);
      }
      const { lobbyId } = await lobbyWithCreator();
      assert.deepEqual(
        await takeSeat({ userId, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 1 }),
        { ok: false, reason: 'no_free_slot' },
      );
    });

    it('enforces the rank gate on joiners but not on the creator', async () => {
      // The creator sets the gate and is taking the seat that makes the
      // lobby exist at all, so their own rank never locks them out.
      const { lobbyId } = await lobbyWithCreator({ rankMin: 5, rankMax: 8 });
      const userId = await makeUser();
      assert.deepEqual(
        await takeSeat({ userId, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 2 }),
        { ok: false, reason: 'rank_locked' },
      );
      assert.equal((await takeSeat({ userId, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 6 })).ok, true);
    });

    it('closes a mid-season-join-off lobby once it has raced', async () => {
      const { lobbyId } = await lobbyWithCreator({ midSeasonJoin: false });
      await query('update lobbies set round_no = 4 where id = $1', [lobbyId]);
      const userId = await makeUser();
      assert.deepEqual(
        await takeSeat({ userId, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 1 }),
        { ok: false, reason: 'closed' },
      );
    });

    it('lets nobody but an invitee into a private lobby', async () => {
      const { lobbyId, creatorId } = await lobbyWithCreator({ visibility: 'private' });
      const stranger = await makeUser();
      assert.deepEqual(
        await takeSeat({ userId: stranger, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 1 }),
        { ok: false, reason: 'invite_required' },
      );

      assert.equal((await createInvite(creatorId, lobbyId, stranger)).ok, true);
      assert.equal((await takeSeat({ userId: stranger, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 1 })).ok, true);

      // Accepting consumes the invite, so it no longer shows as pending.
      assert.equal((await listInvites(stranger)).length, 0);
    });
  });

  describe('claimSlot', () => {
    it('honours a specific slot index and refuses a locked one', async () => {
      const userId = await makeUser();
      const other = await makeUser();
      const lobby = await createLobby(other, SETTINGS);
      await withTransaction(async (client) => {
        assert.equal(await claimSlot(client, userId, lobby.id, 3), 3);
      });
      const second = await createLobby(other, SETTINGS);
      await withTransaction(async (client) => {
        // Slot 4 was never bought.
        assert.equal(await claimSlot(client, userId, second.id, 4), null);
      });
    });
  });

  describe('candidatePool (§3.4)', () => {
    it('hides a lobby whose creator has not taken a team yet (§3.2)', async () => {
      const creatorId = await makeUser();
      await createLobby(creatorId, SETTINGS);
      const seeker = await makeUser();
      assert.equal((await candidatePool(seeker, 'EU', 1)).length, 0);

      const { lobbyId } = await lobbyWithCreator();
      const pool = await candidatePool(seeker, 'EU', 1);
      assert.deepEqual(pool.map((p) => p.lobbyId), [lobbyId]);
    });

    it('reports the real seat split', async () => {
      const { lobbyId, creatorId } = await lobbyWithCreator();
      const seeker = await makeUser();
      const [entry] = await candidatePool(seeker, 'EU', 1);
      assert.deepEqual(entry.humanTeamKeys, [SEAT_LADDER[0]]);
      assert.equal(entry.freeTeamKeys.length, TEAM_COUNT - 1);
      assert.ok(!entry.freeTeamKeys.includes(SEAT_LADDER[0]));
      assert.ok(creatorId);
    });

    it('excludes private lobbies, other regions, closed rank gates and lobbies you are in', async () => {
      const seeker = await makeUser();
      await lobbyWithCreator({ visibility: 'private' });
      await lobbyWithCreator({ region: 'APAC' });
      await lobbyWithCreator({ rankMin: 7, rankMax: 10 });
      const { lobbyId: mine } = await lobbyWithCreator();
      assert.equal((await takeSeat({ userId: seeker, lobbyId: mine, teamKey: SEAT_LADDER[1], rankLevel: 1 })).ok, true);

      assert.equal((await candidatePool(seeker, 'EU', 1)).length, 0);
    });

    it('drops a lobby once every seat is taken', async () => {
      const { lobbyId } = await lobbyWithCreator();
      for (const teamKey of SEAT_LADDER.slice(1)) {
        const userId = await makeUser();
        assert.equal((await takeSeat({ userId, lobbyId, teamKey, rankLevel: 1 })).ok, true, teamKey);
      }
      const seeker = await makeUser();
      assert.equal((await candidatePool(seeker, 'EU', 1)).length, 0);
    });
  });

  describe('invites (§3.6)', () => {
    it('lets a seated guest invite when the lobby allows it', async () => {
      const { lobbyId, creatorId } = await lobbyWithCreator({ visibility: 'private' });
      const guest = await makeUser();
      assert.equal((await createInvite(creatorId, lobbyId, guest)).ok, true);
      assert.equal((await takeSeat({ userId: guest, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 1 })).ok, true);

      const friend = await makeUser();
      assert.equal((await createInvite(guest, lobbyId, friend)).ok, true);
      const pending = await listInvites(friend);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].lobby.id, lobbyId);
      // The invite reserves nothing — it lists what is free right now.
      assert.equal(pending[0].freeTeamKeys.length, TEAM_COUNT - 2);
    });

    it('lets only the creator invite when guest invites are off', async () => {
      const { lobbyId, creatorId } = await lobbyWithCreator({ guestsCanInvite: false });
      const guest = await makeUser();
      assert.equal((await createInvite(creatorId, lobbyId, guest)).ok, true);
      assert.equal((await takeSeat({ userId: guest, lobbyId, teamKey: SEAT_LADDER[1], rankLevel: 1 })).ok, true);

      const friend = await makeUser();
      assert.deepEqual(await createInvite(guest, lobbyId, friend), { ok: false, reason: 'not_allowed' });
    });

    it('refuses an inviter who holds no seat', async () => {
      const { lobbyId } = await lobbyWithCreator();
      const outsider = await makeUser();
      const friend = await makeUser();
      assert.deepEqual(await createInvite(outsider, lobbyId, friend), { ok: false, reason: 'not_in_lobby' });
    });

    it('collapses a repeated invite into the one pending row', async () => {
      const { lobbyId, creatorId } = await lobbyWithCreator();
      const friend = await makeUser();
      const first = await createInvite(creatorId, lobbyId, friend);
      const second = await createInvite(creatorId, lobbyId, friend);
      assert.equal(first.ok && second.ok, true);
      assert.equal((await listInvites(friend)).length, 1);
    });

    it('hides an expired invite', async () => {
      const { lobbyId, creatorId } = await lobbyWithCreator();
      const friend = await makeUser();
      assert.equal((await createInvite(creatorId, lobbyId, friend)).ok, true);
      await query(`update lobby_invites set expires_at = now() - interval '1 hour'`);
      assert.equal((await listInvites(friend)).length, 0);
    });
  });
});
