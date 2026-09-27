/**
 * `lobby_drivers` repo — one row per driver per lobby, seeded from `teams.ts`'
 * fixed pairs (spec §3, §4), now carrying each row's contract (Stage B).
 *
 * Stage A seeded the two race seats and never touched them again. Stage B
 * (this file) adds:
 *   * `Contract` (`seasonsLeft`, `wage`) on every row — imported straight
 *     from `@pitwall/shared/driverMarket`, never restated (see
 *     `server/README.md`'s rule and this repo's own past espionage/winter
 *     seed incidents).
 *   * the reserve squad (`position = 'reserve'`) as real, insertable rows.
 *   * `lobby_driver_signings` — NOT a copy of the market's candidates (those
 *     are still generated on demand by `drivers/market.ts`, never stored),
 *     but the one fact that must survive: "this market id has already been
 *     signed, by this team, into this position." Its primary key
 *     `(lobby_id, market_id)` is the entire "first to sign wins" guard — an
 *     `insert ... on conflict do nothing`, exactly like `sponsorships_pk`
 *     (see `007_sponsorships.sql` and `economy/sponsorshipRepo.ts`), never a
 *     prior `select`.
 *
 * `position = 'market'` is still never written here — see 014_drivers.sql's
 * own note, restated in 016_driver_contracts.sql.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';
import { teamByKey, type Driver, type DriverStats } from '@pitwall/shared/teams';
import { initialContracts, type Contract } from '@pitwall/shared/driverMarket';
import type { Rosters } from '@pitwall/shared/raceEngine';

export type DriverPosition = 'seat_0' | 'seat_1' | 'reserve' | 'market';

export interface LobbyDriver {
  lobbyId: string;
  id: string;
  teamKey: string | null;
  position: DriverPosition;
  driver: Driver;
  contract: Contract;
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
  seasons_left: number;
  wage: number;
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
    contract: { seasonsLeft: row.seasons_left, wage: row.wage },
  };
}

/** Team-default id: stable across reseeding, unique across teams (team keys
 *  are unique), and never colliding with a market driver's `season-round-i`. */
const seatDriverId = (teamKey: string, seat: 0 | 1): string => `${teamKey}:${seat}`;

/**
 * Seeds a team's two race seats from `teams.ts` if they don't exist yet,
 * with their opening contracts from `shared`'s own `initialContracts` — the
 * same seeded 1-3 season deal every rival team in the mobile client starts
 * with, not a value invented here.
 *
 * `on conflict do nothing`, exactly like `seedTeamEconomy` (economy/repo.ts):
 * this is called every time a seat is (re-)assigned, including an AI seat
 * taken over by a human mid-season, so it must never overwrite a roster that
 * has since aged, trained, or changed in any way.
 */
export async function seedTeamDrivers(client: PoolClient, lobbyId: string, teamKey: string): Promise<void> {
  const team = teamByKey(teamKey);
  const contracts = initialContracts(teamKey, [team.drivers[0], team.drivers[1]]);
  for (const seat of [0, 1] as const) {
    const driver = team.drivers[seat];
    const contract = contracts[seat];
    await client.query(
      `insert into lobby_drivers
         (lobby_id, id, team_key, position, name, number, skill, stats, age, potential, seasons_left, wage)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
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
        contract.seasonsLeft,
        contract.wage,
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

/**
 * One driver row by (team, position) — seat_0/seat_1 (never 'market' or a
 * bare id, see `loadLobbyDrivers` for that). `null` when unseeded.
 */
export async function loadDriverRow(
  lobbyId: string, teamKey: string, position: 'seat_0' | 'seat_1' | 'reserve', driverId?: string, client?: PoolClient,
): Promise<LobbyDriver | null> {
  const sql = driverId
    ? `select * from lobby_drivers where lobby_id = $1 and team_key = $2 and position = $3 and id = $4`
    : `select * from lobby_drivers where lobby_id = $1 and team_key = $2 and position = $3`;
  const params = driverId ? [lobbyId, teamKey, position, driverId] : [lobbyId, teamKey, position];
  const res = client
    ? await client.query<DriverRow>(sql, params)
    : await query<DriverRow>(sql, params);
  return res.rows[0] ? toLobbyDriver(res.rows[0]) : null;
}

/** Every driver row in a lobby, any position. See `loadTeamDrivers` for the client rule. */
export async function loadLobbyDrivers(lobbyId: string, client?: PoolClient): Promise<LobbyDriver[]> {
  const sql = `select * from lobby_drivers where lobby_id = $1`;
  const res = client ? await client.query<DriverRow>(sql, [lobbyId]) : await query<DriverRow>(sql, [lobbyId]);
  return res.rows.map(toLobbyDriver);
}

/** A team's reserve squad — the drivers signed alongside its two race seats. */
export async function loadReserveDrivers(lobbyId: string, teamKey: string, client?: PoolClient): Promise<LobbyDriver[]> {
  const sql = `select * from lobby_drivers where lobby_id = $1 and team_key = $2 and position = 'reserve'`;
  const res = client
    ? await client.query<DriverRow>(sql, [lobbyId, teamKey])
    : await query<DriverRow>(sql, [lobbyId, teamKey]);
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

/** Every already-signed market id in this lobby — what `drivers/market.ts`
 *  subtracts from the freshly generated candidates to get "what's still on
 *  the table". */
export async function loadSignedMarketIds(lobbyId: string, client?: PoolClient): Promise<Set<string>> {
  const sql = `select market_id from lobby_driver_signings where lobby_id = $1`;
  const res = client
    ? await client.query<{ market_id: string }>(sql, [lobbyId])
    : await query<{ market_id: string }>(sql, [lobbyId]);
  return new Set(res.rows.map((r) => r.market_id));
}

/**
 * Claims a market driver id for signing. This is the ENTIRE "first to sign
 * wins" guard: an `insert` against `lobby_driver_signings_pk (lobby_id,
 * market_id)`, decided by the write's own conflict, never by a `select`
 * beforehand — same shape as `sponsorships_pk` in `sponsorshipRepo.ts`.
 * Returns `false` when someone else's claim already landed; the caller MUST
 * treat that as a hard stop (throw, to roll back anything already staged in
 * the same transaction) rather than proceeding.
 *
 * `client` MUST be the caller's own transaction client — the claim and the
 * charge-and-move that follows it must commit or roll back together (see
 * `drivers/market.ts`'s `signMarketDriver`).
 */
export async function claimMarketDriver(
  client: PoolClient, lobbyId: string, marketId: string, teamKey: string, position: 'seat_0' | 'seat_1' | 'reserve',
): Promise<boolean> {
  const res = await client.query(
    `insert into lobby_driver_signings (lobby_id, market_id, team_key, position)
     values ($1, $2, $3, $4)
     on conflict (lobby_id, market_id) do nothing`,
    [lobbyId, marketId, teamKey, position],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Frees a market id back up — used when a signing rolls back (see
 *  `claimMarketDriver`) and when a reserve driver's contract expires (his
 *  identity is no longer "already signed"). */
export async function releaseMarketSigning(client: PoolClient, lobbyId: string, marketId: string): Promise<void> {
  await client.query(`delete from lobby_driver_signings where lobby_id = $1 and market_id = $2`, [lobbyId, marketId]);
}

/**
 * Overwrites a race seat's occupant and contract. The outgoing driver is
 * discarded entirely — no roster remembers him — matching the mobile
 * client's own `signDriver` for a seat (`mobile/src/store/slices/driverSlice.ts`):
 * `drivers: seat === 0 ? [driver, state.drivers[1]] : ...` simply replaces
 * the pair, keeping no record of who left. The row's OWN id
 * (`teamKey:seat`) never changes — a seat's identity is the seat, not
 * whoever currently holds it (014_drivers.sql's own "Kimlik" note).
 */
export async function signSeatDriver(
  client: PoolClient, lobbyId: string, teamKey: string, seat: 0 | 1, driver: Driver, contract: Contract,
): Promise<void> {
  await client.query(
    `update lobby_drivers
        set name = $4, number = $5, skill = $6, stats = $7::jsonb, age = $8, potential = $9,
            seasons_left = $10, wage = $11, updated_at = now()
      where lobby_id = $1 and team_key = $2 and position = $3`,
    [
      lobbyId, teamKey, seat === 0 ? 'seat_0' : 'seat_1',
      driver.name, driver.number, driver.skill, JSON.stringify(driver.stats), driver.age, driver.potential,
      contract.seasonsLeft, contract.wage,
    ],
  );
}

/** Inserts a newly signed reserve-squad row, keyed by its own market id
 *  (`014_drivers.sql`'s "sonraki bir görev bu sürücü imzalandı diyebilir" —
 *  this is that later task). */
export async function insertReserveDriver(
  client: PoolClient, lobbyId: string, driverId: string, teamKey: string, driver: Driver, contract: Contract,
): Promise<void> {
  await client.query(
    `insert into lobby_drivers
       (lobby_id, id, team_key, position, name, number, skill, stats, age, potential, seasons_left, wage)
     values ($1, $2, $3, 'reserve', $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      lobbyId, driverId, teamKey,
      driver.name, driver.number, driver.skill, JSON.stringify(driver.stats), driver.age, driver.potential,
      contract.seasonsLeft, contract.wage,
    ],
  );
}

/** Removes a reserve-squad row (sold, or its contract expired). Returns
 *  whether a row actually existed to remove. Never touches a race seat —
 *  the `position = 'reserve'` in the `where` is load-bearing. */
export async function deleteReserveDriver(client: PoolClient, lobbyId: string, driverId: string): Promise<boolean> {
  const res = await client.query(
    `delete from lobby_drivers where lobby_id = $1 and id = $2 and position = 'reserve'`,
    [lobbyId, driverId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Overwrites a driver's contract only — a renewal, or the winter tick. */
export async function updateContract(client: PoolClient, lobbyId: string, driverId: string, contract: Contract): Promise<void> {
  await client.query(
    `update lobby_drivers set seasons_left = $3, wage = $4, updated_at = now() where lobby_id = $1 and id = $2`,
    [lobbyId, driverId, contract.seasonsLeft, contract.wage],
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
