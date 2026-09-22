/**
 * Account slots — spec §4.1 and §1.
 *
 * A slot is the account-level right to manage ONE team in ONE lobby. Three
 * come free, the 4th and 5th cost 250 Gold each, permanently. Gold is the
 * only currency that can buy one: RP belongs to a lobby and can never leave
 * it (§1.2), so there is no exchange rate to price a slot in — this is the
 * documented exception to "nothing is gold-only" (§1.3).
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.ts';

export const SLOT_COUNT = 5;
export const FREE_SLOTS = 3;
export const SLOT_PRICE_GOLD = 250;

export interface SlotRow {
  slotIndex: number;
  unlocked: boolean;
  lobbyId: string | null;
}

/** A slot as the 5-row dropdown (§4.2) needs it. */
export interface SlotView extends SlotRow {
  lobby: {
    id: string;
    name: string;
    region: string;
    aiDifficulty: string;
    seasonNo: number;
    roundNo: number;
    totalRounds: number;
    phase: string;
    nextRaceAt: string;
    teamKey: string | null;
    teamName: string | null;
  } | null;
}

/**
 * Writes the five slot rows for an account if they are not there yet.
 *
 * Idempotent and safe to call on every read — `on conflict do nothing` means
 * two concurrent calls cannot double-insert, and an already-unlocked 4th slot
 * is never reset by a later call (the insert simply does not fire).
 */
export async function ensureSlots(userId: string, client?: PoolClient): Promise<void> {
  const sql = `
    insert into account_slots (user_id, slot_index, unlocked)
    select $1, i, i <= $2
    from generate_series(1, $3) as i
    on conflict (user_id, slot_index) do nothing
  `;
  const params = [userId, FREE_SLOTS, SLOT_COUNT];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

interface SlotViewRow {
  slot_index: number;
  unlocked: boolean;
  lobby_id: string | null;
  name: string | null;
  region: string | null;
  ai_difficulty: string | null;
  season_no: number | null;
  round_no: number | null;
  phase: string | null;
  next_race_at: Date | null;
  team_key: string | null;
}

export async function listSlots(userId: string, totalRounds: number): Promise<SlotView[]> {
  await ensureSlots(userId);
  const res = await query<SlotViewRow>(
    `
      select s.slot_index, s.unlocked, s.lobby_id,
             l.name, l.region, l.ai_difficulty, l.season_no, l.round_no, l.phase, l.next_race_at,
             seat.team_key
      from account_slots s
      left join lobbies l on l.id = s.lobby_id
      left join lobby_seats seat on seat.lobby_id = s.lobby_id and seat.user_id = s.user_id
      where s.user_id = $1
      order by s.slot_index
    `,
    [userId],
  );
  return res.rows.map((r) => ({
    slotIndex: r.slot_index,
    unlocked: r.unlocked,
    lobbyId: r.lobby_id,
    lobby:
      r.lobby_id && r.name && r.next_race_at
        ? {
            id: r.lobby_id,
            name: r.name,
            region: r.region ?? '',
            aiDifficulty: r.ai_difficulty ?? 'normal',
            seasonNo: r.season_no ?? 1,
            roundNo: r.round_no ?? 1,
            totalRounds,
            phase: r.phase ?? 'open',
            nextRaceAt: r.next_race_at.toISOString(),
            teamKey: r.team_key,
            teamName: null, // filled by the route, which owns the team catalogue
          }
        : null,
  }));
}

export type UnlockResult =
  | { ok: true; gold: number }
  | { ok: false; reason: 'already_unlocked' | 'not_purchasable' | 'insufficient_gold' };

/**
 * Buys slot 4 or 5 for 250 Gold.
 *
 * The user row is locked FOR UPDATE before the balance is read, so two
 * requests racing on the same account cannot both see enough gold and both
 * spend it — the second one blocks, re-reads the debited balance and fails
 * with `insufficient_gold`.
 */
export async function unlockSlot(userId: string, slotIndex: number): Promise<UnlockResult> {
  if (!Number.isInteger(slotIndex) || slotIndex <= FREE_SLOTS || slotIndex > SLOT_COUNT) {
    return { ok: false, reason: 'not_purchasable' };
  }
  return withTransaction(async (client) => {
    await ensureSlots(userId, client);
    const balance = await client.query<{ gold: number }>(
      'select gold from users where id = $1 for update',
      [userId],
    );
    /* c8 ignore next -- the caller already loaded this user from its session */
    if (!balance.rows[0]) return { ok: false, reason: 'not_purchasable' } as const;

    const slot = await client.query<{ unlocked: boolean }>(
      'select unlocked from account_slots where user_id = $1 and slot_index = $2',
      [userId, slotIndex],
    );
    if (slot.rows[0]?.unlocked) return { ok: false, reason: 'already_unlocked' } as const;

    const gold = balance.rows[0].gold;
    if (gold < SLOT_PRICE_GOLD) return { ok: false, reason: 'insufficient_gold' } as const;

    await client.query('update users set gold = gold - $2 where id = $1', [userId, SLOT_PRICE_GOLD]);
    await client.query(
      'update account_slots set unlocked = true where user_id = $1 and slot_index = $2',
      [userId, slotIndex],
    );
    return { ok: true, gold: gold - SLOT_PRICE_GOLD } as const;
  });
}

/**
 * Takes the lowest unlocked, empty slot for `lobbyId`.
 *
 * `for update` on the candidate row is what makes "the slot is spent exactly
 * once" true: §3.3 binds the slot to the moment a TEAM IS CHOSEN, and this is
 * that moment — it runs inside the same transaction as the seat insert, so a
 * player who loses the race for a seat also keeps their slot.
 *
 * Returns null when the account has no free unlocked slot left.
 */
export async function claimSlot(
  client: PoolClient,
  userId: string,
  lobbyId: string,
  preferredIndex?: number,
): Promise<number | null> {
  await ensureSlots(userId, client);
  const res = await client.query<{ slot_index: number }>(
    `
      select slot_index from account_slots
      where user_id = $1 and unlocked and lobby_id is null
        and ($2::int is null or slot_index = $2::int)
      order by slot_index
      limit 1
      for update
    `,
    [userId, preferredIndex ?? null],
  );
  const slotIndex = res.rows[0]?.slot_index;
  if (slotIndex === undefined) return null;
  await client.query(
    'update account_slots set lobby_id = $3 where user_id = $1 and slot_index = $2',
    [userId, slotIndex, lobbyId],
  );
  return slotIndex;
}

/** Frees whichever slot points at `lobbyId`. */
export async function releaseSlot(client: PoolClient, userId: string, lobbyId: string): Promise<void> {
  await client.query(
    'update account_slots set lobby_id = null where user_id = $1 and lobby_id = $2',
    [userId, lobbyId],
  );
}
