/**
 * `user_careers` repo — the user's career, folded one weekend at a time by
 * `economy/settle.ts`, in the SAME transaction as the rp it pays out (see
 * that file's own docblock and `013_career.sql`).
 *
 * The career belongs to the USER, not a lobby or a seat: a player races in
 * 3-5 lobbies at once, and every one of them folds into this same row.
 * `loadCareerForUpdate` locks that row (`for update`, after an `insert ...
 * on conflict do nothing` that guarantees it exists) so two settlements for
 * the same user — in two different lobbies — can never both read the same
 * stale total and stomp each other; the second waits for the first's commit,
 * exactly the "read inside a transaction takes the transaction's client"
 * discipline this codebase already leans on elsewhere.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';
import { emptyCareer, type Career } from '@pitwall/shared/achievements';

interface CareerRow {
  score: number;
  races: number;
  wins: number;
  podiums: number;
  poles: number;
  fastest_laps: number;
  dnfs: number;
  best_championship: number;
  seasons_completed: number;
  count_podium: number;
  count_pole: number;
  count_fastest_lap: number;
  count_win: number;
  count_double: number;
  count_hat_trick: number;
  count_grand_slam: number;
  count_clean_sweep: number;
}

function toCareer(row: CareerRow): Career {
  return {
    score: row.score,
    counts: {
      podium: row.count_podium,
      pole: row.count_pole,
      fastestLap: row.count_fastest_lap,
      win: row.count_win,
      double: row.count_double,
      hatTrick: row.count_hat_trick,
      grandSlam: row.count_grand_slam,
      cleanSweep: row.count_clean_sweep,
    },
    races: row.races,
    wins: row.wins,
    podiums: row.podiums,
    poles: row.poles,
    fastestLaps: row.fastest_laps,
    dnfs: row.dnfs,
    bestChampionship: row.best_championship,
    seasonsCompleted: row.seasons_completed,
  };
}

/**
 * A user's career, read for display — no lock, since the caller is not
 * about to write it back (a settlement uses `loadCareerForUpdate` instead).
 * `null` user (never happens for a real seat) or a user with no row yet both
 * read as `emptyCareer()` — "hasn't raced" is not an error.
 */
export async function loadCareer(userId: string, client?: PoolClient): Promise<Career> {
  const sql = `select score, races, wins, podiums, poles, fastest_laps, dnfs, best_championship,
                      seasons_completed, count_podium, count_pole, count_fastest_lap, count_win,
                      count_double, count_hat_trick, count_grand_slam, count_clean_sweep
                 from user_careers where user_id = $1`;
  const res = client
    ? await client.query<CareerRow>(sql, [userId])
    : await query<CareerRow>(sql, [userId]);
  return res.rows[0] ? toCareer(res.rows[0]) : emptyCareer();
}

/**
 * Loads a user's career FOR UPDATE, inside the caller's transaction —
 * `client` is mandatory here, never optional, because this is always the
 * read half of a read-modify-write settlement does with `saveCareer` in the
 * very same transaction. `insert ... on conflict do nothing` first so a
 * user's first-ever race has a row to lock (`for update` on a row that does
 * not exist locks nothing and races with a second first-time insert).
 */
export async function loadCareerForUpdate(client: PoolClient, userId: string): Promise<Career> {
  await client.query(
    `insert into user_careers (user_id) values ($1) on conflict (user_id) do nothing`,
    [userId],
  );
  const res = await client.query<CareerRow>(
    `select score, races, wins, podiums, poles, fastest_laps, dnfs, best_championship,
            seasons_completed, count_podium, count_pole, count_fastest_lap, count_win,
            count_double, count_hat_trick, count_grand_slam, count_clean_sweep
       from user_careers where user_id = $1 for update`,
    [userId],
  );
  return res.rows[0] ? toCareer(res.rows[0]) : emptyCareer();
}

/**
 * Writes a career back — MUST run on the same `client`, inside the same
 * transaction, as the `loadCareerForUpdate` that produced the value being
 * folded into it (see that function's own note on the row lock).
 */
export async function saveCareer(client: PoolClient, userId: string, career: Career): Promise<void> {
  await client.query(
    `update user_careers set
       score = $2, races = $3, wins = $4, podiums = $5, poles = $6, fastest_laps = $7, dnfs = $8,
       best_championship = $9, seasons_completed = $10,
       count_podium = $11, count_pole = $12, count_fastest_lap = $13, count_win = $14,
       count_double = $15, count_hat_trick = $16, count_grand_slam = $17, count_clean_sweep = $18,
       updated_at = now()
     where user_id = $1`,
    [
      userId, career.score, career.races, career.wins, career.podiums, career.poles,
      career.fastestLaps, career.dnfs, career.bestChampionship, career.seasonsCompleted,
      career.counts.podium, career.counts.pole, career.counts.fastestLap, career.counts.win,
      career.counts.double, career.counts.hatTrick, career.counts.grandSlam, career.counts.cleanSweep,
    ],
  );
}
