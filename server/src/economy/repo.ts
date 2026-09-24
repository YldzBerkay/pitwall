/**
 * `lobby_economy` repo — one row per team per lobby (AI seats included; the
 * race engine reads one source for "what car is this team driving").
 *
 * Every write here that can race (spending RP) or that can be re-run
 * harmlessly (seeding) is written so the DATABASE enforces the invariant,
 * not the caller: a conditional UPDATE for spends, `on conflict do nothing`
 * for seeding. See the comments on `spendRp` and `seedTeamEconomy`.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';
import { teamByKey } from '@pitwall/shared/teams';
import { ECONOMY_SCALE } from '@pitwall/shared/economy';

export interface CarStats {
  motor: number;
  aero: number;
  grip: number;
}

export interface TeamEconomy {
  lobbyId: string;
  teamKey: string;
  rp: number;
  factoryLevels: Record<string, number>;
  car: CarStats;
  spyState: Record<string, unknown>;
  upgradesDone: Record<string, number>;
  updatedAt: Date;
}

/**
 * Starting RP.
 *
 * A mid-grid team earns roughly 1,100 RP per race (see `ECONOMY_SCALE`'s doc
 * comment in `@pitwall/shared/economy`). We seed about two races' worth,
 * scaled by the same knob everything else in the economy reads from, so a
 * team can start exactly one upgrade before its first race — enough to feel
 * the system move — without being able to buy its way through a season
 * before ever racing.
 */
export const STARTING_RP = Math.round(1_100 * 2 * ECONOMY_SCALE);

interface EconomyRow {
  lobby_id: string;
  team_key: string;
  rp: number;
  factory_levels: Record<string, number>;
  car: CarStats;
  spy_state: Record<string, unknown>;
  upgrades_done: Record<string, number>;
  updated_at: Date;
}

function toTeamEconomy(row: EconomyRow): TeamEconomy {
  return {
    lobbyId: row.lobby_id,
    teamKey: row.team_key,
    rp: row.rp,
    factoryLevels: row.factory_levels,
    car: row.car,
    spyState: row.spy_state,
    upgradesDone: row.upgrades_done,
    updatedAt: row.updated_at,
  };
}

/**
 * A team's starting car.
 *
 * `teams.ts` carries no per-team motor/aero/grip split — only a single
 * `baseStrength` (0-100, the pre-season pace) — so every stat starts equal,
 * compressed into the same rough band the server's own placeholder car uses
 * (`defaultSetup` in `server/src/league.ts`, ~58-72). A backmarker still
 * starts with a usable car; the grid's real spread comes from upgrades
 * bought over the season, not from this seed.
 */
function startingCar(teamKey: string): CarStats {
  const team = teamByKey(teamKey);
  const stat = Math.round(30 + team.baseStrength * 0.5);
  return { motor: stat, aero: stat, grip: stat };
}

/**
 * Seeds a team's economy row if it doesn't have one yet.
 *
 * MUST be `on conflict do nothing`, never an upsert that overwrites `rp`,
 * `car`, etc.: this is called every time a seat is (re-)assigned, including
 * when an AI seat is taken over by a human mid-season. Overwriting on
 * conflict would silently wipe a live team's whole season.
 */
export async function seedTeamEconomy(client: PoolClient, lobbyId: string, teamKey: string): Promise<void> {
  await client.query(
    `insert into lobby_economy (lobby_id, team_key, rp, car)
     values ($1, $2, $3, $4::jsonb)
     on conflict (lobby_id, team_key) do nothing`,
    [lobbyId, teamKey, STARTING_RP, JSON.stringify(startingCar(teamKey))],
  );
}

export async function loadTeamEconomy(lobbyId: string, teamKey: string): Promise<TeamEconomy | null> {
  const res = await query<EconomyRow>(
    `select * from lobby_economy where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey],
  );
  return res.rows[0] ? toTeamEconomy(res.rows[0]) : null;
}

/**
 * Bir lobinin tüm takım ekonomileri.
 *
 * `client` VERİLMELİDİR eğer çağrı bir transaction'ın içindeyse. Aksi hâlde
 * çağıran bir havuz bağlantısını tutarken çıplak havuzdan ikincisini ister;
 * havuz dolduğunda tutan da isteyen de birbirini bekler ve süreç kilitlenir.
 * Bu, Faz 3a-2'de sezon dönüşü yük testinde gerçekten gözlendi.
 */
export async function loadLobbyEconomy(
  lobbyId: string,
  client?: PoolClient,
): Promise<TeamEconomy[]> {
  const sql = `select * from lobby_economy where lobby_id = $1`;
  const res = client
    ? await client.query<EconomyRow>(sql, [lobbyId])
    : await query<EconomyRow>(sql, [lobbyId]);
  return res.rows.map(toTeamEconomy);
}

function assertNonNegativeInteger(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`${label}: amount must be a non-negative integer, got ${amount}`);
  }
}

/**
 * Spends `amount` RP if the team can afford it.
 *
 * This is a single conditional UPDATE (`where ... and rp >= $amount`), not a
 * read-then-write: two concurrent spends racing against the same balance
 * must not both succeed. Postgres's row-level locking on the UPDATE makes
 * the second writer block until the first commits, then re-evaluate the
 * `where` against the now-updated row — so at most one of them matches.
 * Returns whether the spend went through.
 */
export async function spendRp(client: PoolClient, lobbyId: string, teamKey: string, amount: number): Promise<boolean> {
  assertNonNegativeInteger(amount, 'spendRp');
  const res = await client.query(
    `update lobby_economy
     set rp = rp - $3, updated_at = now()
     where lobby_id = $1 and team_key = $2 and rp >= $3`,
    [lobbyId, teamKey, amount],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Credits `amount` RP. */
export async function addRp(client: PoolClient, lobbyId: string, teamKey: string, amount: number): Promise<void> {
  assertNonNegativeInteger(amount, 'addRp');
  await client.query(
    `update lobby_economy
     set rp = rp + $3, updated_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, amount],
  );
}

/**
 * Charges a penalty, floored at zero rather than refused below the balance.
 *
 * Unlike `spendRp`, this is never a player-chosen spend that should fail
 * outright when the team can't afford it — it's a break fee on a contract
 * the player is walking away from (see `sponsorRoutes.ts` `releaseSponsor`),
 * and the team must still get the slot back even if the penalty exceeds
 * their balance. The floor lives in the `greatest()` of the write itself,
 * not in a read-then-clamp the caller does first.
 */
export async function chargeRpFloor(client: PoolClient, lobbyId: string, teamKey: string, amount: number): Promise<void> {
  assertNonNegativeInteger(amount, 'chargeRpFloor');
  await client.query(
    `update lobby_economy
     set rp = greatest(0, rp - $3), updated_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, amount],
  );
}

/** Records a factory building's level. */
export async function setFactoryLevel(
  client: PoolClient, lobbyId: string, teamKey: string, code: string, level: number,
): Promise<void> {
  await client.query(
    `update lobby_economy
     set factory_levels = jsonb_set(factory_levels, $3::text[], to_jsonb($4::int), true),
         updated_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, [code], level],
  );
}

/** Adds `delta` to a numeric field (`motor`/`aero`/`grip`) inside `car`. */
export async function bumpCarStat(
  client: PoolClient, lobbyId: string, teamKey: string, field: keyof CarStats, delta: number,
): Promise<void> {
  await client.query(
    `update lobby_economy
     set car = jsonb_set(car, $3::text[], to_jsonb((car->>$4)::numeric + $5::numeric), true),
         updated_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, [field], field, delta],
  );
}

/** Increments an upgrade-done counter, starting from 0 when absent. */
export async function bumpUpgradesDone(
  client: PoolClient, lobbyId: string, teamKey: string, label: string,
): Promise<void> {
  await client.query(
    `update lobby_economy
     set upgrades_done = jsonb_set(
           upgrades_done, $3::text[],
           to_jsonb(coalesce((upgrades_done->>$4)::int, 0) + 1), true),
         updated_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, [label], label],
  );
}
