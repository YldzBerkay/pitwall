/**
 * The server's own copy of "what does this lobby's staff market look like
 * right now" — the staff counterpart of `drivers/market.ts`'s `marketFor`/
 * `signMarketDriver` (see that file's docblock; this one repeats its shape
 * deliberately rather than reinventing it).
 *
 * `staffMarket` (`@pitwall/shared/staff`) is a PURE function of its
 * arguments (season, round, lobby id): the same inputs always produce the
 * same six candidates. The server never stores a candidate — only the fact
 * that one was hired (`lobby_staff_signings`), and this module rebuilds the
 * candidate list fresh every call and subtracts whoever's already hired.
 *
 * ── THE TRUST BOUNDARY ─────────────────────────────────────────────────────
 * Every field `hireMarketStaff` writes — the fee charged, the wage on the
 * new hire — comes from the SERVER's own regenerated candidate, matched by
 * `marketId`, never from anything a caller sent. A `fee`/`wage` in the
 * request body is read nowhere in this file (see `drivers/market.ts`'s
 * identical argument, and `staff-market.test.ts`'s "the client's fee is
 * ignored" test for the proof).
 *
 * ── CONCURRENCY: "FIRST TO HIRE WINS" ──────────────────────────────────────
 * Decision (repeated from `drivers/market.ts`): "the driver market works
 * this way and the staff market follows the same rule — two different
 * rules for two markets would be inconsistent." The guard is
 * `claimMarketStaff`'s own `insert ... on conflict do nothing` against
 * `lobby_staff_signings_pk (lobby_id, market_id)` — never a `select` taken
 * first.
 *
 * ── `contractRounds` ────────────────────────────────────────────────────
 * Nothing in this module (or anywhere else in this task) ticks
 * `contractRounds` down. Decision, reported in full in the task's session:
 * a per-round tick belongs at race settlement (`economy/settle.ts` /
 * `settlementRepo.ts`), which is exactly the "wire staff into the race and
 * economy" work the task brief reserves for the NEXT task. Ticking it here
 * would mean reaching into that pipeline a task early. `staff-market.test.ts`
 * has a test proving the field is stored as hired and does not change on
 * its own within this task's scope, so the gap is documented, not silent.
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool.ts';
import { loadLobby } from '../lobby/lobbyRepo.ts';
import { spendRp } from '../economy/repo.ts';
import { staffMarket, hiringFee, type StaffMember, type StaffRole } from '@pitwall/shared/staff';
import {
  loadHiredStaffMarketIds, claimMarketStaff, loadStaffSeat, hireStaffSeat, releaseStaffSeat, loadTeamStaff,
  type LobbyStaffRow,
} from './repo.ts';

export class StaffMarketError extends Error {
  reason: 'no_lobby';
  constructor(reason: 'no_lobby') {
    super(`staff/market: ${reason}`);
    this.reason = reason;
  }
}

/**
 * This lobby's current staff candidates: the season/round's generated six
 * candidates, minus whichever are already hired — "the market a lobby sees
 * is the generated candidates minus those already signed," the same rule
 * `drivers/market.ts`'s `marketFor` follows. `client` is accepted so a
 * caller already holding a transaction's connection (the hire flow below)
 * can pass it through — a bare-pool read while holding a checked-out
 * connection can deadlock a full pool (same rule as `marketFor`).
 */
export async function staffMarketFor(
  lobbyId: string, client?: PoolClient,
): Promise<{ market: StaffMember[]; season: number; round: number }> {
  const lobby = await loadLobby(lobbyId, client);
  if (!lobby) throw new StaffMarketError('no_lobby');

  const hired = await loadHiredStaffMarketIds(lobbyId, client);
  const candidates = staffMarket(lobby.roundNo, lobby.seasonNo, lobbyId);
  const market = candidates.filter((c) => !hired.has(c.id));
  return { market, season: lobby.seasonNo, round: lobby.roundNo };
}

export type HireOutcome = 'ok' | 'not_found' | 'already_hired' | 'not_enough_rp' | 'seat_taken';

class AlreadyHired extends Error {}
class NotEnoughRp extends Error {}
class SeatTaken extends Error {}

export interface HireResult {
  outcome: HireOutcome;
  fee?: number;
  wage?: number;
}

/**
 * Hires a market staff candidate onto `teamKey`'s roster. The charge and
 * the seat move land in ONE transaction — `withTransaction` only rolls back
 * on a throw (never on a returned failure, see `db/pool.ts`), so every
 * early exit below that must undo a write throws a dedicated sentinel
 * instead of returning; the one exit that returns directly (`not_found`) is
 * also the only one that has written nothing yet. Mirrors
 * `drivers/market.ts`'s `signMarketDriver` exactly.
 *
 * `replace` mirrors the mobile client's own `hireStaff(id, replace)`
 * (`staffSlice.ts`): hiring into an occupied role without it is refused
 * (`seat_taken`); with it, the previous occupant is simply overwritten —
 * no refund, no penalty, matching `releaseStaff`'s own rule.
 */
export async function hireMarketStaff(
  lobbyId: string, teamKey: string, marketId: string, replace: boolean,
): Promise<HireResult> {
  let fee = 0;
  let wage = 0;
  try {
    const outcome = await withTransaction(async (client): Promise<HireOutcome> => {
      const { market } = await staffMarketFor(lobbyId, client);
      const candidate = market.find((c) => c.id === marketId);
      if (!candidate) return 'not_found';

      // THE GUARD: whoever's `insert` lands first wins; the other throws
      // and rolls back having written nothing at all.
      const claimed = await claimMarketStaff(client, lobbyId, marketId, teamKey, candidate.role);
      if (!claimed) throw new AlreadyHired();

      const existing = await loadStaffSeat(lobbyId, teamKey, candidate.role, client);
      if (existing && !replace) throw new SeatTaken();

      // The candidate's OWN fee/wage — computed from the server's own
      // regenerated candidate, never from anything the caller sent.
      fee = hiringFee(candidate);
      wage = candidate.wage;

      const paid = await spendRp(client, lobbyId, teamKey, fee);
      if (!paid) throw new NotEnoughRp();

      await hireStaffSeat(client, lobbyId, teamKey, candidate);
      return 'ok';
    });
    return { outcome, fee: outcome === 'ok' ? fee : undefined, wage: outcome === 'ok' ? wage : undefined };
  } catch (err) {
    if (err instanceof AlreadyHired) return { outcome: 'already_hired' };
    if (err instanceof NotEnoughRp) return { outcome: 'not_enough_rp' };
    if (err instanceof SeatTaken) return { outcome: 'seat_taken' };
    throw err;
  }
}

export type ReleaseOutcome = 'ok' | 'not_found';

/** Releases a team's occupant of one role — no refund, no penalty, exactly
 *  the client's own `releaseStaff` rule (`staffSlice.ts`). */
export async function releaseTeamStaff(lobbyId: string, teamKey: string, role: StaffRole): Promise<{ outcome: ReleaseOutcome }> {
  return withTransaction(async (client) => {
    const released = await releaseStaffSeat(client, lobbyId, teamKey, role);
    return { outcome: released ? ('ok' as const) : ('not_found' as const) };
  });
}

/** A team's current roster, for the route layer to report. */
export async function loadRoster(lobbyId: string, teamKey: string): Promise<LobbyStaffRow[]> {
  return loadTeamStaff(lobbyId, teamKey);
}
