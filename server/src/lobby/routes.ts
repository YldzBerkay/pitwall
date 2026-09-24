/**
 * Lobby, slot and invite HTTP endpoints — spec §3, §4.1, §4.2.
 *
 *   GET  /slots                 the five-row account dropdown
 *   POST /slots/unlock          buy slot 4 or 5 for 250 Gold
 *   POST /lobby/create          open a lobby (no slot spent yet)
 *   POST /lobby/quick-match     one honest preview card, or "open a fresh one"
 *   POST /lobby/join            take a team — THE committing action
 *   GET  /lobby                 ?id=… full seat list for a lobby
 *   POST /lobby/invite          invite a player by their Nickname#tag
 *   GET  /invites               invites waiting for me
 *   GET  /lobby/standings       ?id=… the lobby's current championship table
 *
 * Every route here needs a session; there is no anonymous lobby anymore.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import type { User } from '../auth/userRepo.ts';
import { loadUser } from '../auth/userRepo.ts';
import { verifySession } from '../auth/jwt.ts';
import { isRegion, type Region } from '../identity/region.ts';
import { rankFor } from '@pitwall/shared/achievements';
import { SEASON_ROUNDS } from '@pitwall/shared/season';
import {
  isAiDifficulty,
  previewSeats,
  teamName,
  type AiDifficulty,
} from './grid.ts';
import { CandidateShaper, occupancyOf } from './matchmaking.ts';
import {
  candidatePool,
  createInvite,
  createLobby,
  listInvites,
  loadLobby,
  loadSeats,
  takeSeat,
  type Lobby,
  type LobbySettings,
  type Visibility,
} from './lobbyRepo.ts';
import { ensureSlots, listSlots, unlockSlot, SLOT_PRICE_GOLD } from './slotRepo.ts';
import { standingsBeforeRound } from './runner.ts';
import { query } from '../db/pool.ts';

/**
 * One shaper per process. §3.4's percentages describe the stream of
 * candidates the SERVER hands out, so the tally is global rather than per
 * player — see the class doc for why a per-player tally would be gameable.
 */
const shaper = new CandidateShaper();

function unauthorized(): RouteResult {
  return { status: 401, body: { error: 'unauthorized' } };
}

function forbidden(): RouteResult {
  return { status: 403, body: { error: 'forbidden' } };
}

async function requireSession(ctx: RequestContext): Promise<User | null> {
  const userId = await verifySession(ctx.bearer);
  if (!userId) return null;
  return loadUser(userId);
}

/** The player's rank level, 1-10 — the value a lobby's rank gate is set in. */
function rankLevelOf(user: User): number {
  return rankFor(user.rankPoints).level;
}

function lobbyView(lobby: Lobby): Record<string, unknown> {
  return {
    id: lobby.id,
    name: lobby.name,
    region: lobby.region,
    visibility: lobby.visibility,
    aiDifficulty: lobby.aiDifficulty,
    rankMin: lobby.rankMin,
    rankMax: lobby.rankMax,
    guestsCanInvite: lobby.guestsCanInvite,
    midSeasonJoin: lobby.midSeasonJoin,
    seasonNo: lobby.seasonNo,
    roundNo: lobby.roundNo,
    totalRounds: SEASON_ROUNDS,
    phase: lobby.phase,
    nextRaceAt: lobby.nextRaceAt.toISOString(),
  };
}

// ── Slots ──────────────────────────────────────────────────────────────────

async function handleGetSlots(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();
  const slots = await listSlots(user.id, SEASON_ROUNDS);
  return {
    status: 200,
    body: {
      gold: user.gold,
      slotPrice: SLOT_PRICE_GOLD,
      slots: slots.map((s) => ({
        ...s,
        lobby: s.lobby ? { ...s.lobby, teamName: s.lobby.teamKey ? teamName(s.lobby.teamKey) : null } : null,
      })),
    },
  };
}

async function handleUnlockSlot(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();
  const slotIndex = Number(ctx.body.slotIndex);
  const result = await unlockSlot(user.id, slotIndex);
  if (!result.ok) {
    return { status: result.reason === 'insufficient_gold' ? 402 : 400, body: { error: result.reason } };
  }
  const slots = await listSlots(user.id, SEASON_ROUNDS);
  return { status: 200, body: { gold: result.gold, slots } };
}

// ── Creating a lobby ───────────────────────────────────────────────────────

type SettingsError = 'invalid_region' | 'invalid_visibility' | 'invalid_difficulty' | 'invalid_rank_gate';

function readSettings(body: Record<string, unknown>, fallbackRegion: Region | null): LobbySettings | SettingsError {
  const region = body.region ?? fallbackRegion;
  if (!isRegion(region)) return 'invalid_region';

  const visibility = body.visibility ?? 'public';
  if (visibility !== 'public' && visibility !== 'private') return 'invalid_visibility';

  const aiDifficulty = body.aiDifficulty ?? 'normal';
  if (!isAiDifficulty(aiDifficulty)) return 'invalid_difficulty';

  const rankMin = body.rankMin === undefined ? 1 : Number(body.rankMin);
  const rankMax = body.rankMax === undefined ? 10 : Number(body.rankMax);
  if (
    !Number.isInteger(rankMin) || !Number.isInteger(rankMax) ||
    rankMin < 1 || rankMax > 10 || rankMin > rankMax
  ) {
    return 'invalid_rank_gate';
  }

  return {
    region,
    visibility: visibility as Visibility,
    aiDifficulty: aiDifficulty as AiDifficulty,
    rankMin,
    rankMax,
    // Both default to open — the restrictive settings are the deliberate
    // choice, so they have to be asked for.
    guestsCanInvite: body.guestsCanInvite !== false,
    midSeasonJoin: body.midSeasonJoin !== false,
  };
}

async function freeSlotCount(userId: string): Promise<number> {
  // The five rows are written lazily, on first use — an account that has
  // never opened this screen has none yet, and would otherwise read as
  // "no free slot".
  await ensureSlots(userId);
  const res = await query<{ count: string }>(
    'select count(*) from account_slots where user_id = $1 and unlocked and lobby_id is null',
    [userId],
  );
  return Number(res.rows[0]?.count ?? 0);
}

async function handleCreateLobby(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();

  const settings = readSettings(ctx.body, user.region);
  if (typeof settings === 'string') return { status: 400, body: { error: settings } };

  // Creating a lobby costs no gold (§3.1) but does need somewhere to put the
  // team that comes next — refusing here is kinder than letting the player
  // configure a lobby they could not sit in.
  if ((await freeSlotCount(user.id)) === 0) return { status: 409, body: { error: 'no_free_slot' } };

  const lobby = await createLobby(user.id, settings);
  const seats = await loadSeats(lobby.id);
  return {
    status: 201,
    body: {
      lobby: lobbyView(lobby),
      // The creator picks from all eleven (§3.2) — that is what the slot
      // bought them.
      seats: previewSeats(seats.map((s) => s.teamKey), lobby.aiDifficulty),
    },
  };
}

// ── Quick match ────────────────────────────────────────────────────────────

/**
 * Returns ONE candidate preview card, or `{ candidate: null }` when the pool
 * has nothing for this player — which the client turns into "open a fresh
 * lobby" (§3.4), where every seat is still free.
 *
 * `exclude` carries the lobby ids already shown in this sitting, so "Başka
 * bul" moves on instead of re-offering the same lobby. It is free and
 * unlimited by design; nothing is committed until a team is chosen.
 */
async function handleQuickMatch(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();
  if (!user.region) return { status: 400, body: { error: 'region_required' } };

  const exclude = new Set(
    Array.isArray(ctx.body.exclude) ? ctx.body.exclude.filter((v): v is string => typeof v === 'string') : [],
  );

  const pool = (await candidatePool(user.id, user.region, rankLevelOf(user)))
    .filter((entry) => !exclude.has(entry.lobbyId));

  const chosen = shaper.pick(pool);
  if (!chosen) return { status: 200, body: { candidate: null } };

  const occupancy = occupancyOf(chosen.humanTeamKeys);
  return {
    status: 200,
    body: {
      candidate: {
        lobby: lobbyView(chosen.lobby),
        // Real counts, straight off the seat rows. Nothing here is padded or
        // withheld — see the honesty note in matchmaking.ts.
        humans: chosen.humanTeamKeys.length,
        ai: chosen.freeTeamKeys.length,
        occupancy,
        seats: previewSeats(chosen.freeTeamKeys, chosen.lobby.aiDifficulty),
      },
    },
  };
}

// ── Joining ────────────────────────────────────────────────────────────────

const JOIN_STATUS: Record<string, number> = {
  lobby_not_found: 404,
  unknown_team: 400,
  seat_taken: 409,
  already_in_lobby: 409,
  no_free_slot: 409,
  rank_locked: 403,
  closed: 403,
  invite_required: 403,
};

async function handleJoin(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();

  const lobbyId = typeof ctx.body.lobbyId === 'string' ? ctx.body.lobbyId : '';
  const teamKey = typeof ctx.body.teamKey === 'string' ? ctx.body.teamKey : '';
  const slotIndex = ctx.body.slotIndex === undefined ? undefined : Number(ctx.body.slotIndex);
  if (!lobbyId || !teamKey) return { status: 400, body: { error: 'lobby_and_team_required' } };

  const result = await takeSeat({
    userId: user.id,
    lobbyId,
    teamKey,
    rankLevel: rankLevelOf(user),
    slotIndex: Number.isInteger(slotIndex) ? slotIndex : undefined,
  });
  if (!result.ok) return { status: JOIN_STATUS[result.reason] ?? 400, body: { error: result.reason } };

  const seats = await loadSeats(result.lobby.id);
  return {
    status: 200,
    body: {
      lobby: lobbyView(result.lobby),
      slotIndex: result.slotIndex,
      teamKey,
      seats,
    },
  };
}

async function handleGetLobby(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();
  const lobbyId = ctx.url.searchParams.get('id') ?? '';
  const lobby = await loadLobby(lobbyId);
  if (!lobby) return { status: 404, body: { error: 'lobby_not_found' } };

  const seats = await loadSeats(lobby.id);
  // A private lobby is only readable from the inside: it is reachable by
  // invitation alone (§3.6), so its seat list must not be a public lookup.
  const inside = seats.some((s) => s.userId === user.id);
  if (lobby.visibility === 'private' && !inside) return { status: 404, body: { error: 'lobby_not_found' } };

  return { status: 200, body: { lobby: lobbyView(lobby), seats } };
}

// ── Invites ────────────────────────────────────────────────────────────────

const INVITE_STATUS: Record<string, number> = {
  lobby_not_found: 404,
  not_in_lobby: 403,
  not_allowed: 403,
  already_in_lobby: 409,
  lobby_full: 409,
};

/**
 * Looks a player up by their FULL `Nickname#1234` tag.
 *
 * Exact match only, and deliberately so: partial search would let anyone
 * enumerate accounts by prefix (§5, the same privacy rule the friend system
 * is built on). A miss returns the same shape as a hit's failure — nothing
 * here confirms whether a given base name exists.
 */
async function findUserByTag(tag: string): Promise<string | null> {
  const at = tag.lastIndexOf('#');
  if (at <= 0) return null;
  const base = tag.slice(0, at);
  const digits = tag.slice(at + 1);
  if (!/^[0-9]+$/.test(digits)) return null;
  const res = await query<{ id: string }>(
    'select id from users where nickname_base = $1 and nickname_tag = $2',
    [base, digits],
  );
  return res.rows[0]?.id ?? null;
}

async function handleInvite(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();

  const lobbyId = typeof ctx.body.lobbyId === 'string' ? ctx.body.lobbyId : '';
  const nickname = typeof ctx.body.nickname === 'string' ? ctx.body.nickname.trim() : '';
  if (!lobbyId || !nickname) return { status: 400, body: { error: 'lobby_and_nickname_required' } };

  const inviteeId = await findUserByTag(nickname);
  if (!inviteeId) return { status: 404, body: { error: 'player_not_found' } };
  if (inviteeId === user.id) return { status: 400, body: { error: 'already_in_lobby' } };

  const result = await createInvite(user.id, lobbyId, inviteeId);
  if (!result.ok) return { status: INVITE_STATUS[result.reason] ?? 400, body: { error: result.reason } };
  return { status: 201, body: { inviteId: result.inviteId, expiresAt: result.expiresAt.toISOString() } };
}

async function handleGetInvites(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();
  const invites = await listInvites(user.id);
  return {
    status: 200,
    body: {
      invites: invites.map((i) => ({
        id: i.id,
        lobby: lobbyView(i.lobby),
        inviter: i.inviterNickname,
        expiresAt: i.expiresAt.toISOString(),
        // An invite reserves nothing (§3.6) — this is what is free RIGHT NOW,
        // and it may well be a shorter list by the time it is accepted.
        seats: previewSeats(i.freeTeamKeys, i.lobby.aiDifficulty),
      })),
    },
  };
}

// ── Standings ──────────────────────────────────────────────────────────────

/**
 * The lobby's current constructors' table.
 *
 * There is deliberately no stored table to read (`runner.ts`'s
 * `standingsBeforeRound` docblock): it is re-derived here by replaying
 * every round of the CURRENT season that has actually been run. Asking one
 * past the last possible round of the season (`SEASON_ROUNDS + 1`) rather
 * than `lobby.roundNo` sidesteps a subtler question this route has no
 * business answering — whether `round_no` has already rolled over past a
 * just-settled race (`rollover.ts` only advances it once `sweep.ts` pushes
 * a `result` lobby forward, which can lag a settled race by a beat). A
 * round with no recorded run is silently skipped by `standingsBeforeRound`
 * itself, so replaying "through the end of the season" and replaying
 * "through whatever has really been raced so far" are the same call.
 *
 * No `teamKey` is read or returned: the table belongs to the whole lobby,
 * not to one seat, so unlike `/economy/state` there is nothing here for a
 * `findOwnTeamKey` lookup to narrow — only membership (403 below) is
 * checked. Read-only: nothing below writes anything.
 */
async function handleGetStandings(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();

  const lobbyId = ctx.url.searchParams.get('id') ?? '';
  if (!lobbyId) return { status: 400, body: { error: 'invalid_request' } };

  const lobby = await loadLobby(lobbyId);
  if (!lobby) return { status: 404, body: { error: 'lobby_not_found' } };

  const seats = await loadSeats(lobby.id);
  const seated = seats.some((s) => s.userId === user.id);
  if (!seated) return forbidden();

  const standings = await standingsBeforeRound(lobby.id, lobby.seasonNo, SEASON_ROUNDS + 1);
  return { status: 200, body: { standings } };
}

export function registerLobbyRoutes(router: Router): void {
  router.get('/slots', handleGetSlots);
  router.post('/slots/unlock', handleUnlockSlot);
  router.post('/lobby/create', handleCreateLobby);
  router.post('/lobby/quick-match', handleQuickMatch);
  router.post('/lobby/join', handleJoin);
  router.get('/lobby', handleGetLobby);
  router.post('/lobby/invite', handleInvite);
  router.get('/invites', handleGetInvites);
  router.get('/lobby/standings', handleGetStandings);
}
