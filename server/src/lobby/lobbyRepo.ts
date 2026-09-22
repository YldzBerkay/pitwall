/**
 * Lobbies, seats and the candidate pool behind "Hızlı oyun bul".
 *
 * Spec §3. The one rule that shapes most of this file: the SLOT IS SPENT AT
 * TEAM SELECTION, not before (§3.3). Creating a lobby, being shown a preview
 * card and pressing "Başka bul" are all free and uncommitted; `takeSeat` is
 * the single place where a slot is consumed, and it does so in the same
 * transaction that writes the seat.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.ts';
import { isRegion, type Region } from '../identity/region.ts';
import { SEAT_LADDER, isTeamKey, type AiDifficulty } from './grid.ts';
import { formatLobbyName, pickNameBase } from './names.ts';
import { nextRaceAt } from './schedule.ts';
import { claimSlot } from './slotRepo.ts';

export type Visibility = 'public' | 'private';
export type LobbyPhase = 'open' | 'checkin' | 'live' | 'result' | 'finished';

export interface LobbySettings {
  region: Region;
  visibility: Visibility;
  aiDifficulty: AiDifficulty;
  rankMin: number;
  rankMax: number;
  guestsCanInvite: boolean;
  midSeasonJoin: boolean;
}

export interface Lobby extends LobbySettings {
  id: string;
  name: string;
  creatorUserId: string;
  seasonNo: number;
  roundNo: number;
  phase: LobbyPhase;
  nextRaceAt: Date;
}

export interface Seat {
  teamKey: string;
  userId: string | null;
  managed: 'human' | 'assistant' | 'ai';
  nickname: string | null;
  countryCode: string | null;
}

interface LobbyRow {
  id: string;
  name: string;
  region: string;
  visibility: string;
  ai_difficulty: string;
  rank_min: number;
  rank_max: number;
  guests_can_invite: boolean;
  mid_season_join: boolean;
  creator_user_id: string;
  season_no: number;
  round_no: number;
  phase: string;
  next_race_at: Date;
}

const LOBBY_COLUMNS = `
  id, name, region, visibility, ai_difficulty, rank_min, rank_max,
  guests_can_invite, mid_season_join, creator_user_id, season_no, round_no,
  phase, next_race_at
`;

function mapLobby(row: LobbyRow): Lobby {
  return {
    id: row.id,
    name: row.name,
    // The CHECK constraints already restrict these columns; the guards are
    // type narrowing, not validation — a value that fails one can only mean
    // the schema and this file have drifted apart.
    region: isRegion(row.region) ? row.region : 'EU',
    visibility: row.visibility === 'private' ? 'private' : 'public',
    aiDifficulty: row.ai_difficulty as AiDifficulty,
    rankMin: row.rank_min,
    rankMax: row.rank_max,
    guestsCanInvite: row.guests_can_invite,
    midSeasonJoin: row.mid_season_join,
    creatorUserId: row.creator_user_id,
    seasonNo: row.season_no,
    roundNo: row.round_no,
    phase: row.phase as LobbyPhase,
    nextRaceAt: row.next_race_at,
  };
}

// ── Creation ───────────────────────────────────────────────────────────────

/** How many times a name collision is retried before giving up. */
const NAME_ATTEMPTS = 6;
const UNIQUE_VIOLATION = '23505';

function pgCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === UNIQUE_VIOLATION;
}

/** `22P02` — Postgres rejecting a malformed literal, e.g. a bad uuid. */
function isInvalidUuid(err: unknown): boolean {
  return pgCode(err) === '22P02';
}

/**
 * Creates a lobby with all eleven seats written as AI.
 *
 * Seats exist from the first instant so that "the calendar starts the moment
 * the lobby is created; teams nobody takes are driven by the AI" (§3.2) is a
 * property of the data, not of a later backfill — and so a seat can only ever
 * be *claimed* (an UPDATE against a row that is there), never invented.
 *
 * The lobby does NOT enter any pool until its creator has taken a team
 * (§3.2); `candidatePool` enforces that by requiring the creator's seat.
 */
export async function createLobby(
  creatorUserId: string,
  settings: LobbySettings,
  now: Date = new Date(),
): Promise<Lobby> {
  const raceAt = nextRaceAt(settings.region, now);

  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
    const base = pickNameBase(settings.region);
    try {
      return await withTransaction(async (client) => {
        const seqRes = await client.query<{ seq: number }>(
          'select coalesce(max(name_seq), 0) + 1 as seq from lobbies where name_base = $1',
          [base],
        );
        const seq = seqRes.rows[0].seq;
        const inserted = await client.query<LobbyRow>(
          `
            insert into lobbies (
              name, name_base, name_seq, region, visibility, ai_difficulty,
              rank_min, rank_max, guests_can_invite, mid_season_join,
              creator_user_id, next_race_at
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            returning ${LOBBY_COLUMNS}
          `,
          [
            formatLobbyName(base, seq),
            base,
            seq,
            settings.region,
            settings.visibility,
            settings.aiDifficulty,
            settings.rankMin,
            settings.rankMax,
            settings.guestsCanInvite,
            settings.midSeasonJoin,
            creatorUserId,
            raceAt,
          ],
        );
        const lobby = mapLobby(inserted.rows[0]);
        await client.query(
          `insert into lobby_seats (lobby_id, team_key) select $1, unnest($2::text[])`,
          [lobby.id, SEAT_LADDER],
        );
        return lobby;
      });
    } catch (err) {
      // Another creation took this (base, seq) between the max() and the
      // insert. Re-roll and try again rather than serialising every lobby
      // creation behind a lock.
      if (isUniqueViolation(err) && attempt < NAME_ATTEMPTS - 1) continue;
      throw err;
    }
  }
  /* c8 ignore next 2 -- the loop either returns or throws */
  throw new Error('createLobby: exhausted name attempts');
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function loadLobby(lobbyId: string): Promise<Lobby | null> {
  try {
    const res = await query<LobbyRow>(`select ${LOBBY_COLUMNS} from lobbies where id = $1`, [lobbyId]);
    return res.rows[0] ? mapLobby(res.rows[0]) : null;
  } catch (err) {
    // A malformed uuid from an untrusted request body reads the same as
    // "no such lobby" — see loadUser in auth/userRepo.ts.
    if (isInvalidUuid(err)) return null;
    throw err;
  }
}

export async function loadSeats(lobbyId: string): Promise<Seat[]> {
  const res = await query<{
    team_key: string;
    user_id: string | null;
    managed: string;
    nickname_base: string | null;
    nickname_tag: string | null;
    country_code: string | null;
  }>(
    `
      select s.team_key, s.user_id, s.managed, u.nickname_base, u.nickname_tag, u.country_code
      from lobby_seats s
      left join users u on u.id = s.user_id
      where s.lobby_id = $1
    `,
    [lobbyId],
  );
  const bySeat = new Map(res.rows.map((r) => [r.team_key, r]));
  // Always strongest-first, so every surface (preview card, lobby screen,
  // dropdown) reads the grid in the same order.
  return SEAT_LADDER.filter((key) => bySeat.has(key)).map((key) => {
    const r = bySeat.get(key)!;
    return {
      teamKey: r.team_key,
      userId: r.user_id,
      managed: r.managed as Seat['managed'],
      nickname: r.nickname_base && r.nickname_tag ? `${r.nickname_base}#${r.nickname_tag}` : null,
      countryCode: r.country_code,
    };
  });
}

export interface PoolEntry {
  lobbyId: string;
  lobby: Lobby;
  humanTeamKeys: string[];
  freeTeamKeys: string[];
}

interface PoolRow extends LobbyRow {
  human_team_keys: string[] | null;
  free_team_keys: string[] | null;
}

/**
 * Every lobby this player could legitimately be offered right now.
 *
 * The filter is the whole of §3.4's eligibility list — region, rank gate,
 * still joinable, a genuinely free seat — plus §3.2's "a lobby whose creator
 * has not taken a team appears in no pool". Occupancy is returned as the raw
 * seat keys, so the caller (and the card) can only ever describe what is
 * really there.
 */
export async function candidatePool(
  userId: string,
  region: Region,
  rankLevel: number,
): Promise<PoolEntry[]> {
  const res = await query<PoolRow>(
    `
      select ${LOBBY_COLUMNS.split(',').map((c) => `l.${c.trim()}`).join(', ')},
             array_agg(s.team_key) filter (where s.user_id is not null) as human_team_keys,
             array_agg(s.team_key) filter (where s.user_id is null)     as free_team_keys
      from lobbies l
      join lobby_seats s on s.lobby_id = l.id
      where l.visibility = 'public'
        and l.phase <> 'finished'
        and l.region = $2
        and $3 between l.rank_min and l.rank_max
        -- Mid-season join closed: only a lobby that has not raced yet.
        and (l.mid_season_join or (l.season_no = 1 and l.round_no = 1))
        -- The creator must be seated, or the lobby is invisible (§3.2).
        and exists (
          select 1 from lobby_seats cs
          where cs.lobby_id = l.id and cs.user_id = l.creator_user_id
        )
        -- Never offer a lobby the player is already in.
        and not exists (
          select 1 from lobby_seats ms where ms.lobby_id = l.id and ms.user_id = $1
        )
      group by l.id
      -- A lobby with no free seat is not a candidate.
      having count(*) filter (where s.user_id is null) > 0
    `,
    [userId, region, rankLevel],
  );

  return res.rows.map((r) => ({
    lobbyId: r.id,
    lobby: mapLobby(r),
    humanTeamKeys: r.human_team_keys ?? [],
    freeTeamKeys: r.free_team_keys ?? [],
  }));
}

// ── Taking a seat ──────────────────────────────────────────────────────────

export type TakeSeatError =
  | 'lobby_not_found'
  | 'unknown_team'
  | 'seat_taken'
  | 'already_in_lobby'
  | 'no_free_slot'
  | 'rank_locked'
  | 'closed'
  | 'invite_required';

export type TakeSeatResult =
  | { ok: true; lobby: Lobby; slotIndex: number }
  | { ok: false; reason: TakeSeatError };

export interface TakeSeatInput {
  userId: string;
  lobbyId: string;
  teamKey: string;
  rankLevel: number;
  /** Which slot to spend; the lowest free one when omitted. */
  slotIndex?: number;
}

/**
 * Claims a team in a lobby and spends a slot — the single committing action
 * of the whole flow (§3.3).
 *
 * Everything happens under one transaction with the lobby row locked, so two
 * players pressing "Takım seç" on the same seat at the same instant cannot
 * both get it: the seat UPDATE is conditional on `user_id is null` and the
 * loser sees `seat_taken` with their slot untouched.
 */
export async function takeSeat(input: TakeSeatInput): Promise<TakeSeatResult> {
  const { userId, lobbyId, teamKey, rankLevel, slotIndex } = input;
  if (!isTeamKey(teamKey)) return { ok: false, reason: 'unknown_team' };

  try {
    return await withTransaction(async (client): Promise<TakeSeatResult> => {
      const lobbyRow = await selectLobbyForUpdate(client, lobbyId);
      if (!lobbyRow) return { ok: false, reason: 'lobby_not_found' };
      const lobby = mapLobby(lobbyRow);
      const isCreator = lobby.creatorUserId === userId;

      if (lobby.phase === 'finished') return { ok: false, reason: 'closed' };

      // The creator is exempt from the gates they set for everyone else:
      // they are taking the seat that makes the lobby exist at all (§3.2).
      if (!isCreator) {
        if (rankLevel < lobby.rankMin || rankLevel > lobby.rankMax) {
          return { ok: false, reason: 'rank_locked' };
        }
        if (!lobby.midSeasonJoin && !(lobby.seasonNo === 1 && lobby.roundNo === 1)) {
          return { ok: false, reason: 'closed' };
        }
        if (lobby.visibility === 'private' && !(await hasOpenInvite(client, lobbyId, userId))) {
          return { ok: false, reason: 'invite_required' };
        }
      }

      const mine = await client.query('select 1 from lobby_seats where lobby_id = $1 and user_id = $2', [
        lobbyId,
        userId,
      ]);
      if (mine.rowCount) return { ok: false, reason: 'already_in_lobby' };

      const claimed = await claimSlot(client, userId, lobbyId, slotIndex);
      if (claimed === null) return { ok: false, reason: 'no_free_slot' };

      const seat = await client.query(
        `
          update lobby_seats
          set user_id = $3, managed = 'human', joined_at = now()
          where lobby_id = $1 and team_key = $2 and user_id is null
        `,
        [lobbyId, teamKey, userId],
      );
      // The seat is gone — someone won the race for it. The slot claimed a
      // moment ago must not stay spent, and `withTransaction` COMMITS what
      // the callback returns, so the only way back is to throw: SeatRollback
      // aborts the transaction (releasing the slot with it) and is converted
      // back into a plain result below.
      if (!seat.rowCount) throw new SeatRollback('seat_taken');

      await client.query(
        `update lobby_invites set accepted_at = now()
         where lobby_id = $1 and invitee_user_id = $2 and accepted_at is null`,
        [lobbyId, userId],
      );

      return { ok: true, lobby, slotIndex: claimed };
    });
  } catch (err) {
    if (err instanceof SeatRollback) return { ok: false, reason: err.reason };
    throw err;
  }
}

/** Marker that turns a post-write failure into a rollback — see takeSeat. */
class SeatRollback extends Error {
  constructor(readonly reason: TakeSeatError) {
    super(reason);
  }
}

async function selectLobbyForUpdate(client: PoolClient, lobbyId: string): Promise<LobbyRow | null> {
  try {
    const res = await client.query<LobbyRow>(
      `select ${LOBBY_COLUMNS} from lobbies where id = $1 for update`,
      [lobbyId],
    );
    return res.rows[0] ?? null;
  } catch (err) {
    // A malformed uuid reads the same as "no such lobby" (see loadLobby).
    // It must be caught here rather than left to abort the transaction.
    if (isInvalidUuid(err)) return null;
    throw err;
  }
}

// ── Invites (§3.6) ─────────────────────────────────────────────────────────

async function hasOpenInvite(client: PoolClient, lobbyId: string, userId: string): Promise<boolean> {
  const res = await client.query(
    `select 1 from lobby_invites
     where lobby_id = $1 and invitee_user_id = $2 and accepted_at is null and expires_at > now()`,
    [lobbyId, userId],
  );
  return Boolean(res.rowCount);
}

export const INVITE_TTL_HOURS = 72;

export type InviteError = 'lobby_not_found' | 'not_in_lobby' | 'not_allowed' | 'already_in_lobby' | 'lobby_full';

export type InviteResult = { ok: true; inviteId: string; expiresAt: Date } | { ok: false; reason: InviteError };

/**
 * Invites a player to a lobby the inviter is seated in.
 *
 * An invite RESERVES NOTHING (§3.6): it is permission to join, and the
 * invitee picks from whatever is still free when they arrive. That is why
 * there is no team_key here and why `lobby_full` is checked at accept time as
 * well as now.
 */
export async function createInvite(
  inviterUserId: string,
  lobbyId: string,
  inviteeUserId: string,
): Promise<InviteResult> {
  return withTransaction(async (client): Promise<InviteResult> => {
    const lobbyRes = await client.query<LobbyRow>(`select ${LOBBY_COLUMNS} from lobbies where id = $1`, [lobbyId]);
    if (!lobbyRes.rows[0]) return { ok: false, reason: 'lobby_not_found' };
    const lobby = mapLobby(lobbyRes.rows[0]);

    const seated = await client.query('select 1 from lobby_seats where lobby_id = $1 and user_id = $2', [
      lobbyId,
      inviterUserId,
    ]);
    if (!seated.rowCount) return { ok: false, reason: 'not_in_lobby' };

    // "Davetli davet edebilir" off: the creator is the only one who can
    // extend the chain (§3.6).
    if (!lobby.guestsCanInvite && lobby.creatorUserId !== inviterUserId) {
      return { ok: false, reason: 'not_allowed' };
    }

    const already = await client.query('select 1 from lobby_seats where lobby_id = $1 and user_id = $2', [
      lobbyId,
      inviteeUserId,
    ]);
    if (already.rowCount) return { ok: false, reason: 'already_in_lobby' };

    const free = await client.query(
      'select 1 from lobby_seats where lobby_id = $1 and user_id is null limit 1',
      [lobbyId],
    );
    if (!free.rowCount) return { ok: false, reason: 'lobby_full' };

    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
    const res = await client.query<{ id: string; expires_at: Date }>(
      `
        insert into lobby_invites (lobby_id, inviter_user_id, invitee_user_id, expires_at)
        values ($1, $2, $3, $4)
        on conflict (lobby_id, invitee_user_id) where invitee_user_id is not null and accepted_at is null
        do update set inviter_user_id = excluded.inviter_user_id, expires_at = excluded.expires_at
        returning id, expires_at
      `,
      [lobbyId, inviterUserId, inviteeUserId, expiresAt],
    );
    return { ok: true, inviteId: res.rows[0].id, expiresAt: res.rows[0].expires_at };
  });
}

export interface PendingInvite {
  id: string;
  lobby: Lobby;
  inviterNickname: string | null;
  expiresAt: Date;
  freeTeamKeys: string[];
}

export async function listInvites(userId: string): Promise<PendingInvite[]> {
  const res = await query<
    LobbyRow & {
      invite_id: string;
      expires_at: Date;
      inviter_base: string | null;
      inviter_tag: string | null;
      free_team_keys: string[] | null;
    }
  >(
    `
      select i.id as invite_id, i.expires_at,
             inviter.nickname_base as inviter_base, inviter.nickname_tag as inviter_tag,
             ${LOBBY_COLUMNS.split(',').map((c) => `l.${c.trim()}`).join(', ')},
             (
               select array_agg(s.team_key)
               from lobby_seats s
               where s.lobby_id = l.id and s.user_id is null
             ) as free_team_keys
      from lobby_invites i
      join lobbies l on l.id = i.lobby_id
      left join users inviter on inviter.id = i.inviter_user_id
      where i.invitee_user_id = $1
        and i.accepted_at is null
        and i.expires_at > now()
        and l.phase <> 'finished'
      order by i.created_at desc
    `,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.invite_id,
    lobby: mapLobby(r),
    inviterNickname: r.inviter_base && r.inviter_tag ? `${r.inviter_base}#${r.inviter_tag}` : null,
    expiresAt: r.expires_at,
    freeTeamKeys: r.free_team_keys ?? [],
  }));
}
