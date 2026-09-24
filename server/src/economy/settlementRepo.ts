/**
 * `race_settlement_payouts` repo — one row per team per race, the breakdown
 * behind the total `settle.ts` credits.
 *
 * Every write here happens on the CALLER's connection, inside the same
 * transaction as `markSettled` and `addRp` (see `economy/settle.ts`): a
 * client is always passed in, never opened here. A read, by contrast, has no
 * transaction to join — a player opening the app is not inside anyone's
 * settlement — so it goes through the pool directly.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';

/** One seat's earnings from one race, broken into the parts a screen shows. */
export interface SeatSettlementBreakdown {
  teamKey: string;
  /** Championship position after this race — same number `SeatPayout.position` carries. */
  position: number;
  prize: number;
  sponsorIncome: number;
  briefBonus: number;
  bonusesEarned: string[];
  streaksBroken: string[];
}

interface PayoutRow {
  team_key: string;
  position: number;
  prize: number;
  sponsor_income: number;
  brief_bonus: number;
  bonuses_earned: string[];
  streaks_broken: string[];
}

function toBreakdown(row: PayoutRow): SeatSettlementBreakdown {
  return {
    teamKey: row.team_key,
    position: row.position,
    prize: row.prize,
    sponsorIncome: row.sponsor_income,
    briefBonus: row.brief_bonus,
    bonusesEarned: row.bonuses_earned,
    streaksBroken: row.streaks_broken,
  };
}

/**
 * Writes one seat's breakdown. MUST run on the same `client` — and inside
 * the same transaction — as the `addRp` call it describes: see this file's
 * doc comment and `settle.ts`'s own "why the same commit" note.
 */
export async function insertSettlementPayout(
  client: PoolClient,
  lobbyId: string,
  seasonNo: number,
  roundNo: number,
  payout: SeatSettlementBreakdown,
): Promise<void> {
  await client.query(
    `insert into race_settlement_payouts
       (lobby_id, season_no, round_no, team_key, position, prize, sponsor_income, brief_bonus,
        bonuses_earned, streaks_broken)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      lobbyId, seasonNo, roundNo, payout.teamKey, payout.position, payout.prize,
      payout.sponsorIncome, payout.briefBonus, payout.bonusesEarned, payout.streaksBroken,
    ],
  );
}

/**
 * A single seat's breakdown for a round — `null` when that round has not
 * settled for this team yet ("nothing yet", not an error; the route this
 * feeds turns it into a 200 with an empty body, not a 404).
 */
export async function loadSettlementPayout(
  lobbyId: string,
  seasonNo: number,
  roundNo: number,
  teamKey: string,
): Promise<SeatSettlementBreakdown | null> {
  const res = await query<PayoutRow>(
    `select team_key, position, prize, sponsor_income, brief_bonus, bonuses_earned, streaks_broken
     from race_settlement_payouts
     where lobby_id = $1 and season_no = $2 and round_no = $3 and team_key = $4`,
    [lobbyId, seasonNo, roundNo, teamKey],
  );
  return res.rows[0] ? toBreakdown(res.rows[0]) : null;
}
