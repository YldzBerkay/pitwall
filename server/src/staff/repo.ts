/**
 * `lobby_staff`/`lobby_staff_signings` repo — the storage side of "a staff
 * member was hired", mirroring `drivers/repo.ts`'s `lobby_drivers`/
 * `lobby_driver_signings` pair (see that file's own docblock for the shape
 * this repeats).
 *
 * Candidates are NEVER stored here — `staff/market.ts` regenerates them on
 * demand from `@pitwall/shared/staff`'s `staffMarket`. What lives in this
 * table is only the fact that a market id was hired, by which team, into
 * which role.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';
import type { StaffMember, StaffRole } from '@pitwall/shared/staff';

interface StaffRow {
  lobby_id: string;
  team_key: string;
  role: StaffRole;
  id: string;
  name: string;
  skill: number;
  wage: number;
  contract_rounds: number;
}

export interface LobbyStaffRow {
  teamKey: string;
  role: StaffRole;
  member: StaffMember;
}

function toLobbyStaffRow(row: StaffRow): LobbyStaffRow {
  return {
    teamKey: row.team_key,
    role: row.role,
    member: {
      id: row.id,
      name: row.name,
      role: row.role,
      skill: row.skill,
      wage: row.wage,
      contractRounds: row.contract_rounds,
    },
  };
}

/** Every already-hired market id in this lobby — what `staff/market.ts`
 *  subtracts from the freshly generated candidates, same rule as
 *  `drivers/repo.ts`'s `loadSignedMarketIds`. */
export async function loadHiredStaffMarketIds(lobbyId: string, client?: PoolClient): Promise<Set<string>> {
  const sql = `select market_id from lobby_staff_signings where lobby_id = $1`;
  const res = client
    ? await client.query<{ market_id: string }>(sql, [lobbyId])
    : await query<{ market_id: string }>(sql, [lobbyId]);
  return new Set(res.rows.map((r) => r.market_id));
}

/**
 * Claims a market staff id for hiring. The ENTIRE "first to hire wins"
 * guard — an `insert` against `lobby_staff_signings_pk (lobby_id,
 * market_id)`, decided by the write's own conflict, never a prior `select`
 * (same shape as `claimMarketDriver`, `drivers/repo.ts`). `false` means
 * someone else's claim already landed; the caller MUST treat that as a hard
 * stop (throw, to roll back anything already staged in the same
 * transaction).
 *
 * `client` MUST be the caller's own transaction client — the claim and the
 * charge-and-seat that follow it must commit or roll back together.
 */
export async function claimMarketStaff(
  client: PoolClient, lobbyId: string, marketId: string, teamKey: string, role: StaffRole,
): Promise<boolean> {
  const res = await client.query(
    `insert into lobby_staff_signings (lobby_id, market_id, team_key, role)
     values ($1, $2, $3, $4)
     on conflict (lobby_id, market_id) do nothing`,
    [lobbyId, marketId, teamKey, role],
  );
  return (res.rowCount ?? 0) > 0;
}

/** A team's current occupant of one role, or `null` if that seat is empty.
 *  `client` MUST be passed when called from inside a transaction — a
 *  bare-pool read while holding a checked-out connection can deadlock a
 *  full pool (same rule as `loadTeamDrivers`, `drivers/repo.ts`). */
export async function loadStaffSeat(
  lobbyId: string, teamKey: string, role: StaffRole, client?: PoolClient,
): Promise<LobbyStaffRow | null> {
  const sql = `select * from lobby_staff where lobby_id = $1 and team_key = $2 and role = $3`;
  const res = client
    ? await client.query<StaffRow>(sql, [lobbyId, teamKey, role])
    : await query<StaffRow>(sql, [lobbyId, teamKey, role]);
  return res.rows[0] ? toLobbyStaffRow(res.rows[0]) : null;
}

/** A team's whole roster, one row per filled role. */
export async function loadTeamStaff(lobbyId: string, teamKey: string, client?: PoolClient): Promise<LobbyStaffRow[]> {
  const sql = `select * from lobby_staff where lobby_id = $1 and team_key = $2`;
  const res = client
    ? await client.query<StaffRow>(sql, [lobbyId, teamKey])
    : await query<StaffRow>(sql, [lobbyId, teamKey]);
  return res.rows.map(toLobbyStaffRow);
}

/**
 * Seats a hired staff member, whether the role was empty or (with
 * `replace`) already occupied — the caller (`staff/market.ts`) has already
 * decided which case this is and refused an occupied seat when the client
 * did not ask to replace it. `on conflict ... do update` makes the write
 * itself idempotent either way; it is never reached for a genuinely-refused
 * `seatTaken` case because that throws before this is called.
 */
export async function hireStaffSeat(
  client: PoolClient, lobbyId: string, teamKey: string, member: StaffMember,
): Promise<void> {
  await client.query(
    `insert into lobby_staff (lobby_id, team_key, role, id, name, skill, wage, contract_rounds)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (lobby_id, team_key, role) do update
       set id = excluded.id, name = excluded.name, skill = excluded.skill,
           wage = excluded.wage, contract_rounds = excluded.contract_rounds,
           hired_at = now(), updated_at = now()`,
    [lobbyId, teamKey, member.role, member.id, member.name, member.skill, member.wage, member.contractRounds],
  );
}

/** Empties a role's seat — the client's `releaseStaff`: no refund, no
 *  penalty, just gone. The hired-market-id fact stays in
 *  `lobby_staff_signings` forever (a market id is round-scoped in its own
 *  seed and never recurs, so there is nothing to free — see
 *  `staff/market.ts`'s docblock). */
export async function releaseStaffSeat(client: PoolClient, lobbyId: string, teamKey: string, role: StaffRole): Promise<boolean> {
  const res = await client.query(
    `delete from lobby_staff where lobby_id = $1 and team_key = $2 and role = $3`,
    [lobbyId, teamKey, role],
  );
  return (res.rowCount ?? 0) > 0;
}
