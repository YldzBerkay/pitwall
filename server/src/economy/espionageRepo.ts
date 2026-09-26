/**
 * `garage_hides` — the defensive half of espionage: a team hiding its garage
 * for a stretch of rounds, blocking every spy attempt against it (own
 * missions targeting it, and rival attempts at settlement) for that window.
 *
 * See migration `010_garage_hide.sql` for why this is its own table rather
 * than a reused key in `lobby_economy.spy_state`.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';

/**
 * Extends (or starts) a team's hide through `currentRound + days - 1`,
 * never shortening an existing hide that already reaches further.
 *
 * A single upsert, not a read-then-write: the `on conflict` branch computes
 * the new `until_round` from the ROW BEING WRITTEN (`garage_hides.until_round`),
 * so two concurrent purchases serialise on the row the same way `spendRp`'s
 * conditional UPDATE does, rather than one clobbering the other's read.
 * Returns the resulting `until_round`, for the caller to hand back (or not)
 * to the player — mirrors `chargeRpFloor`'s "report what actually happened"
 * rule.
 */
export async function bumpGarageHide(
  client: PoolClient, lobbyId: string, teamKey: string, currentRound: number, days: number,
): Promise<number> {
  const res = await client.query<{ until_round: number }>(
    `insert into garage_hides (lobby_id, team_key, until_round)
     values ($1, $2, $3::int + $4::int - 1)
     on conflict (lobby_id, team_key) do update
       set until_round = greatest($3::int, garage_hides.until_round) + $4::int - 1,
           updated_at = now()
     returning until_round`,
    [lobbyId, teamKey, currentRound, days],
  );
  return res.rows[0].until_round;
}

/**
 * Whether `teamKey`'s garage is hidden THROUGH `round` (inclusive) — the same
 * "still hidden" test the client's `isHidden()` uses (`hide.untilRound >=
 * round`), just backed by a table instead of local state.
 *
 * `client` MUST be passed when called from inside a transaction — see
 * `loadTeamEconomy`'s doc comment in `repo.ts` for why a bare-pool read while
 * holding a connection can deadlock the pool.
 */
export async function isGarageHidden(
  lobbyId: string, teamKey: string, round: number, client?: PoolClient,
): Promise<boolean> {
  const sql = `select 1 from garage_hides where lobby_id = $1 and team_key = $2 and until_round >= $3`;
  const res = client
    ? await client.query(sql, [lobbyId, teamKey, round])
    : await query(sql, [lobbyId, teamKey, round]);
  return (res.rowCount ?? 0) > 0;
}
