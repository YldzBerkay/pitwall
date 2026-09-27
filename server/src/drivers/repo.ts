/**
 * `lobby_drivers` repo — one row per driver per lobby, seeded from `teams.ts`'
 * fixed pairs (spec §3, §4).
 *
 * Stage A only: every team's two race seats, filled once and never
 * overwritten. Contracts, the reserve squad and the market are Stage B; this
 * file seeds and reads, nothing else. It imports `teams.ts`'s defaults rather
 * than restating them, same rule `economy/repo.ts` follows for car stats.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';
import { teamByKey, type Driver, type DriverStats } from '@pitwall/shared/teams';
import type { Rosters } from '@pitwall/shared/raceEngine';

export type DriverPosition = 'seat_0' | 'seat_1' | 'reserve' | 'market';

export interface LobbyDriver {
  lobbyId: string;
  id: string;
  teamKey: string | null;
  position: DriverPosition;
  driver: Driver;
}

interface DriverRow {
  lobby_id: string;
  id: string;
  team_key: string | null;
  position: string;
  name: string;
  number: number;
  skill: number;
  stats: DriverStats;
  age: number;
  potential: number;
}

function toLobbyDriver(row: DriverRow): LobbyDriver {
  return {
    lobbyId: row.lobby_id,
    id: row.id,
    teamKey: row.team_key,
    position: row.position as DriverPosition,
    driver: {
      name: row.name,
      number: row.number,
      skill: row.skill,
      stats: row.stats,
      age: row.age,
      potential: row.potential,
    },
  };
}

/** Team-default id: stable across reseeding, unique across teams (team keys
 *  are unique), and never colliding with a market driver's `season-round-i`. */
const seatDriverId = (teamKey: string, seat: 0 | 1): string => `${teamKey}:${seat}`;

/**
 * Seeds a team's two race seats from `teams.ts` if they don't exist yet.
 *
 * `on conflict do nothing`, exactly like `seedTeamEconomy` (economy/repo.ts):
 * this is called every time a seat is (re-)assigned, including an AI seat
 * taken over by a human mid-season, so it must never overwrite a roster that
 * has since aged, trained, or changed in any way.
 */
export async function seedTeamDrivers(client: PoolClient, lobbyId: string, teamKey: string): Promise<void> {
  const team = teamByKey(teamKey);
  for (const seat of [0, 1] as const) {
    const driver = team.drivers[seat];
    await client.query(
      `insert into lobby_drivers (lobby_id, id, team_key, position, name, number, skill, stats, age, potential)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       on conflict (lobby_id, id) do nothing`,
      [
        lobbyId,
        seatDriverId(teamKey, seat),
        teamKey,
        seat === 0 ? 'seat_0' : 'seat_1',
        driver.name,
        driver.number,
        driver.skill,
        JSON.stringify(driver.stats),
        driver.age,
        driver.potential,
      ],
    );
  }
}

/**
 * A team's two race-seat drivers, seat 0 first. `null` if either seat is
 * unseeded (should not happen once `seedTeamDrivers` has run for this team).
 *
 * `client` MUST be passed when called from inside a transaction — a bare-pool
 * read while holding a connection deadlocks a full pool (see
 * `loadLobbyEconomy`'s doc comment in `economy/repo.ts`).
 */
export async function loadTeamDrivers(lobbyId: string, teamKey: string, client?: PoolClient): Promise<[Driver, Driver] | null> {
  const sql = `select * from lobby_drivers where lobby_id = $1 and team_key = $2 and position in ('seat_0','seat_1')`;
  const res = client
    ? await client.query<DriverRow>(sql, [lobbyId, teamKey])
    : await query<DriverRow>(sql, [lobbyId, teamKey]);
  const bySeat = new Map(res.rows.map((r) => [r.position, toLobbyDriver(r).driver]));
  const seat0 = bySeat.get('seat_0');
  const seat1 = bySeat.get('seat_1');
  if (!seat0 || !seat1) return null;
  return [seat0, seat1];
}

/** Every driver row in a lobby, any position. See `loadTeamDrivers` for the client rule. */
export async function loadLobbyDrivers(lobbyId: string, client?: PoolClient): Promise<LobbyDriver[]> {
  const sql = `select * from lobby_drivers where lobby_id = $1`;
  const res = client ? await client.query<DriverRow>(sql, [lobbyId]) : await query<DriverRow>(sql, [lobbyId]);
  return res.rows.map(toLobbyDriver);
}

/**
 * Overwrites a driver's age/stats/skill after a season rollover ages or
 * develops him. `name`, `number` and `potential` are set once at seeding
 * (`seedTeamDrivers`) and never revised here — a rollover moves a driver
 * along the rules he was given, it does not reissue him.
 *
 * `client` MUST be the rollover's own transaction client (see
 * `loadTeamDrivers`'s doc comment for the deadlock a bare-pool write would
 * risk) — the whole point of Faz 3b-2's ageing pass is that it lands in the
 * same commit as the season number it belongs to.
 */
export async function saveDriverAfterSeason(client: PoolClient, lobbyId: string, driverId: string, driver: Driver): Promise<void> {
  await client.query(
    `update lobby_drivers
        set age = $3, stats = $4::jsonb, skill = $5, updated_at = now()
      where lobby_id = $1 and id = $2`,
    [lobbyId, driverId, driver.age, JSON.stringify(driver.stats), driver.skill],
  );
}

/**
 * Every team's race-seat pair, as the race engine's `Rosters` shape — the
 * live counterpart of `teams.ts`' fixed defaults. `driverOf` (raceEngine.ts)
 * falls back to `rosters[teamKey]` for EVERY team, human-managed or AI, so
 * this covers the whole grid, not just occupied seats. See `loadTeamDrivers`
 * for the client rule.
 *
 * A team missing either race seat (should not happen once `seedTeamDrivers`
 * has run for it) is left out entirely rather than half-filled — a half
 * pair would let `driverOf` read `rosters[teamKey][1]` as `undefined` for
 * one seat while the other reads live data, which is a worse failure than
 * falling back to the team's default pair for both seats.
 */
export async function loadLobbyRosters(lobbyId: string, client?: PoolClient): Promise<Rosters> {
  const drivers = await loadLobbyDrivers(lobbyId, client);
  const byTeam = new Map<string, [Driver | undefined, Driver | undefined]>();
  for (const d of drivers) {
    if (!d.teamKey) continue; // market driver, unseated
    if (d.position !== 'seat_0' && d.position !== 'seat_1') continue;
    const idx = d.position === 'seat_0' ? 0 : 1;
    const pair = byTeam.get(d.teamKey) ?? [undefined, undefined];
    pair[idx] = d.driver;
    byTeam.set(d.teamKey, pair);
  }
  const rosters: Rosters = {};
  for (const [teamKey, pair] of byTeam) {
    if (pair[0] && pair[1]) rosters[teamKey] = [pair[0], pair[1]];
  }
  return rosters;
}
