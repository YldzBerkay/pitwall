/**
 * `sponsorships` repo — one row per team per lobby per slot: a signed
 * sponsorship position.
 *
 * `generateOffers` (shared/src/sponsors.ts) is a pure function of its inputs
 * (round, championship position, running deals, taken slots) — its
 * randomness is seeded from those inputs alone, so the offer sheet is
 * regenerated on demand rather than stored. Only the player's decision to
 * SIGN one of those offers needs persistence, which is what this module
 * writes.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';
import type { Sponsorship, SlotKey } from '@pitwall/shared/sponsors';

interface SponsorshipRow {
  lobby_id: string;
  team_key: string;
  deal_id: string;
  brand_key: string;
  slot: SlotKey;
  per_race: number;
  target_position: number;
  bonus: number;
  signed_round: number;
  expires_round: number;
  streak_target: number;
  streak: number;
}

function toSponsorship(row: SponsorshipRow): Sponsorship {
  return {
    dealId: row.deal_id,
    brandKey: row.brand_key,
    slot: row.slot,
    perRace: row.per_race,
    targetPosition: row.target_position,
    bonus: row.bonus,
    signedRound: row.signed_round,
    expiresRound: row.expires_round,
    streakTarget: row.streak_target,
    streak: row.streak,
  };
}

/**
 * Inserts one signed slot of a deal.
 *
 * A deal that spans several slots (a title sponsor buying the sidepod AND
 * the engine cover) is written as one call per slot, sharing `dealId` — the
 * same one-record-per-position layout `Sponsorship` itself uses. The
 * primary key on `(lobby_id, team_key, slot)` is the guard against a team
 * holding two sponsorships in the same slot: it lives in this write's own
 * constraint, not in a check the caller does first, so two concurrent signs
 * for the same slot cannot both land.
 */
export async function insertSponsorship(
  client: PoolClient, lobbyId: string, teamKey: string, sponsorship: Sponsorship,
): Promise<void> {
  await client.query(
    `insert into sponsorships
       (lobby_id, team_key, deal_id, brand_key, slot, per_race, target_position,
        bonus, signed_round, expires_round, streak_target, streak)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      lobbyId, teamKey, sponsorship.dealId, sponsorship.brandKey, sponsorship.slot,
      sponsorship.perRace, sponsorship.targetPosition, sponsorship.bonus,
      sponsorship.signedRound, sponsorship.expiresRound, sponsorship.streakTarget,
      sponsorship.streak,
    ],
  );
}

/**
 * Releases every slot held by one deal — a package is all-or-nothing, so
 * releasing (or replacing, for a renewal) always removes the whole group by
 * `dealId` rather than one slot at a time.
 */
export async function deleteDeal(
  client: PoolClient, lobbyId: string, teamKey: string, dealId: string,
): Promise<void> {
  await client.query(
    `delete from sponsorships where lobby_id = $1 and team_key = $2 and deal_id = $3`,
    [lobbyId, teamKey, dealId],
  );
}

/**
 * Advances (or resets) the consecutive-target-hit streak on one slot's deal.
 *
 * The new value is computed by the caller from `shared`'s `settleRace`, same
 * as every other economy write in this tree — `now` for jobs, formulas for
 * rp — never recomputed here.
 */
export async function setStreak(
  client: PoolClient, lobbyId: string, teamKey: string, slot: SlotKey, streak: number,
): Promise<void> {
  await client.query(
    `update sponsorships set streak = $4
     where lobby_id = $1 and team_key = $2 and slot = $3`,
    [lobbyId, teamKey, slot, streak],
  );
}

/**
 * A team's signed sponsorships, in a stable order (by slot key) so a
 * re-render of the car never reshuffles which decal is drawn first.
 *
 * `client` is accepted (not required) for the same reason as
 * `loadLobbyEconomy`: a read taken while the caller already holds a
 * transaction's connection must use THAT connection, or it asks the pool for
 * a second one and can deadlock against itself once the pool is full.
 */
export async function loadTeamSponsorships(
  lobbyId: string, teamKey: string, client?: PoolClient,
): Promise<Sponsorship[]> {
  const sql = `select * from sponsorships where lobby_id = $1 and team_key = $2 order by slot`;
  const res = client
    ? await client.query<SponsorshipRow>(sql, [lobbyId, teamKey])
    : await query<SponsorshipRow>(sql, [lobbyId, teamKey]);
  return res.rows.map(toSponsorship);
}

/** Every signed sponsorship in a lobby, across every team. */
export async function loadLobbySponsorships(
  lobbyId: string, client?: PoolClient,
): Promise<Sponsorship[]> {
  const sql = `select * from sponsorships where lobby_id = $1 order by team_key, slot`;
  const res = client
    ? await client.query<SponsorshipRow>(sql, [lobbyId])
    : await query<SponsorshipRow>(sql, [lobbyId]);
  return res.rows.map(toSponsorship);
}
