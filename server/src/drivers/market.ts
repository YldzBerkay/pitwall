/**
 * The server's own copy of "what does this lobby's driver market look like
 * right now" — the piece that makes signing trustworthy, same role
 * `economy/sponsorOffers.ts` plays for sponsor offers.
 *
 * `driverMarket` (`@pitwall/shared/driverMarket`) is a PURE function of its
 * arguments (season, round, taken racing numbers, lobby id): the same inputs
 * always produce the same eight candidates. That determinism is the whole
 * point — the server never has to store a candidate to be able to check one
 * later. `marketFor` rebuilds the candidate list from the lobby's own
 * season/round, then subtracts whatever `lobby_driver_signings` says is
 * already signed (see `drivers/repo.ts`'s docblock) — "the market a lobby
 * sees is the generated candidates minus those already signed," per spec.
 *
 * ── THE TRUST BOUNDARY THIS FILE EXISTS TO ENFORCE ─────────────────────────
 * Every field `signMarketDriver` writes — the fee charged, the wage on the
 * new contract — comes from the SERVER's own regenerated candidate, matched
 * by `marketId`, never from anything a caller sent. A `fee`/`wage` in the
 * request body is read nowhere in this file. See `sponsorOffers.ts`'s own
 * docblock for the identical argument, and `driver-market.test.ts`'s
 * "ignores the client's fee" test for the proof.
 *
 * ── CONCURRENCY: "FIRST TO SIGN WINS" ──────────────────────────────────────
 * The guard is `claimMarketDriver`'s own `insert ... on conflict do
 * nothing` against `lobby_driver_signings_pk (lobby_id, market_id)` — never
 * a `select` taken first. Two concurrent callers signing the same
 * `marketId` both reach this function; exactly one of their `insert`s wins,
 * and the other's `claimMarketDriver` returns `false`, which is turned into
 * a thrown `AlreadySigned` so `withTransaction` rolls back anything that
 * transaction had already staged (nothing, at that point — the claim is
 * always the first write). See `007_sponsorships.sql`/`sponsorshipRepo.ts`
 * for the same shape used for sponsor slots.
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool.ts';
import { loadLobby } from '../lobby/lobbyRepo.ts';
import { spendRp, addRp } from '../economy/repo.ts';
import {
  driverMarket, signingCost, contractWage, renewalCost, saleValue, SQUAD_MAX,
  type MarketDriver, type Contract,
} from '@pitwall/shared/driverMarket';
import {
  loadLobbyDrivers, loadSignedMarketIds, claimMarketDriver, releaseMarketSigning,
  signSeatDriver, insertReserveDriver, loadReserveDrivers, deleteReserveDriver,
  loadDriverRow, updateContract,
} from './repo.ts';

export class DriverMarketError extends Error {
  reason: 'no_lobby';
  constructor(reason: 'no_lobby') {
    super(`drivers/market: ${reason}`);
    this.reason = reason;
  }
}

/**
 * This lobby's current free-agent pool: the season/round's generated eight
 * candidates, minus whichever of them are already signed. `client` is
 * accepted so a caller already holding a transaction's connection (the sign
 * flow below) can pass it through — a bare-pool read while holding a
 * checked-out connection can deadlock a full pool, same rule as
 * `loadTeamDrivers`/`loadLobbyEconomy`.
 */
export async function marketFor(
  lobbyId: string, client?: PoolClient,
): Promise<{ market: MarketDriver[]; season: number; round: number }> {
  // `client` MUST be forwarded here too when we're inside a transaction —
  // see `loadLobby`'s own doc comment for the pool deadlock this exact
  // call site hit before that fix (10 concurrent signings each holding a
  // transaction connection, all blocked asking the same exhausted pool for
  // a bare second one to read the lobby row).
  const lobby = await loadLobby(lobbyId, client);
  if (!lobby) throw new DriverMarketError('no_lobby');

  // Racing numbers already in use across the WHOLE grid, so a fresh
  // candidate never clashes with a car already on track — same rule
  // `NumberPool` inside `driverMarket` itself enforces for the eight
  // candidates against each other.
  const drivers = await loadLobbyDrivers(lobbyId, client);
  const takenNumbers = drivers.map((d) => d.driver.number);

  const signed = await loadSignedMarketIds(lobbyId, client);
  const candidates = driverMarket(lobby.seasonNo, lobby.roundNo, takenNumbers, lobbyId);
  const market = candidates.filter((d) => !signed.has(d.id));
  return { market, season: lobby.seasonNo, round: lobby.roundNo };
}

export type SignTarget = 'seat_0' | 'seat_1' | 'reserve';
export type SignOutcome = 'ok' | 'not_found' | 'already_signed' | 'not_enough_rp' | 'squad_full';

class AlreadySigned extends Error {}
class NotEnoughRp extends Error {}
class SquadFull extends Error {}

export interface SignResult {
  outcome: SignOutcome;
  fee?: number;
  wage?: number;
}

/**
 * Signs a market driver onto `teamKey`, into a race seat or the reserve
 * squad. The charge and the move land in ONE transaction — `withTransaction`
 * only rolls back on a throw (never on a returned failure, see
 * `db/pool.ts`), so every early exit below that must undo a write throws a
 * dedicated sentinel instead of returning; the ONE exit that returns
 * directly (`not_found`) is also the only one that has written nothing yet.
 *
 * A reserve signing costs half of a seat signing, and its wage is half too
 * — mirroring the mobile client's own `signDriver` (`driverSlice.ts`:
 * `seat === 'reserve' ? Math.round(signingCost(...) / 2) : ...`). That
 * halving rule has no `shared/` counterpart of its own to import (like
 * `sponsorRoutes.ts`'s 0.35 release-fee rate, see that file's docblock) —
 * it is applied here, server-side, to the server's OWN computed fee, never
 * to anything the client sent.
 */
export async function signMarketDriver(
  lobbyId: string, teamKey: string, marketId: string, target: SignTarget, seasons: number,
): Promise<SignResult> {
  let fee = 0;
  let wage = 0;
  try {
    const outcome = await withTransaction(async (client): Promise<SignOutcome> => {
      const { market } = await marketFor(lobbyId, client);
      const candidate = market.find((d) => d.id === marketId);
      if (!candidate) return 'not_found';

      const { id: _id, fee: _candidateFee, wage: _candidateWage, ...driver } = candidate;
      const isReserve = target === 'reserve';
      fee = isReserve ? Math.round(signingCost(driver, seasons) / 2) : signingCost(driver, seasons);
      wage = isReserve ? Math.round(contractWage(driver, seasons) / 2) : contractWage(driver, seasons);
      const contract: Contract = { seasonsLeft: seasons, wage };

      // THE GUARD: whoever's `insert` lands first wins; the other throws
      // and rolls back having written nothing at all.
      const claimed = await claimMarketDriver(client, lobbyId, marketId, teamKey, target);
      if (!claimed) throw new AlreadySigned();

      if (isReserve) {
        const squad = await loadReserveDrivers(lobbyId, teamKey, client);
        if (squad.length >= SQUAD_MAX) throw new SquadFull();
      }

      // The charge and the move are both staged in this same transaction;
      // if the charge fails, the claim above is rolled back too, so the
      // driver is genuinely available again — not silently reserved for a
      // buyer who never paid.
      const paid = await spendRp(client, lobbyId, teamKey, fee);
      if (!paid) throw new NotEnoughRp();

      if (isReserve) await insertReserveDriver(client, lobbyId, marketId, teamKey, driver, contract);
      else await signSeatDriver(client, lobbyId, teamKey, target === 'seat_0' ? 0 : 1, driver, contract);

      return 'ok';
    });
    return { outcome, fee: outcome === 'ok' ? fee : undefined, wage: outcome === 'ok' ? wage : undefined };
  } catch (err) {
    if (err instanceof AlreadySigned) return { outcome: 'already_signed' };
    if (err instanceof NotEnoughRp) return { outcome: 'not_enough_rp' };
    if (err instanceof SquadFull) return { outcome: 'squad_full' };
    throw err;
  }
}

export type RenewOutcome = 'ok' | 'not_found' | 'not_due' | 'not_enough_rp';

/**
 * Extends a driver already in a race seat — only in his final contract
 * year, at the CURRENT price (`renewalCost`, imported from `shared`, same
 * rule as the mobile client's `renewDriver`: no transfer fee, only a
 * signing bonus, but on today's value — a driver who improved is dearer to
 * keep than he was to sign).
 */
export async function renewSeatContract(
  lobbyId: string, teamKey: string, seat: 0 | 1, seasons: number,
): Promise<{ outcome: RenewOutcome; fee?: number }> {
  return withTransaction(async (client) => {
    const row = await loadDriverRow(lobbyId, teamKey, seat === 0 ? 'seat_0' : 'seat_1', undefined, client);
    if (!row) return { outcome: 'not_found' as const };
    if (row.contract.seasonsLeft > 1) return { outcome: 'not_due' as const };

    const cost = renewalCost(row.driver, seasons);
    const paid = await spendRp(client, lobbyId, teamKey, cost);
    if (!paid) return { outcome: 'not_enough_rp' as const };

    // A renewal runs from the end of the current deal: its final season
    // plus the new term (mirrors `driverSlice.ts`'s `renewDriver`).
    const renewed: Contract = { seasonsLeft: row.contract.seasonsLeft + seasons, wage: contractWage(row.driver, seasons) };
    await updateContract(client, lobbyId, row.id, renewed);
    return { outcome: 'ok' as const, fee: cost };
  });
}

export type SellOutcome = 'ok' | 'not_found';

/**
 * Sells a reserve-squad driver — never a race seat, `deleteReserveDriver`'s
 * own `where` enforces that. The payout is `saleValue` (80% of the fee
 * after the 20% manager's commission), imported from `shared`, same as the
 * mobile client's `sellDriver`. Releasing the market-signing claim means
 * his identity is no longer "already signed" — the part of "returns to the
 * market" that is actually meaningful once he's gone (see
 * `drivers/ageing.ts`'s docblock for the winter-expiry version of the same
 * release).
 */
export async function sellReserveDriver(
  lobbyId: string, teamKey: string, driverId: string,
): Promise<{ outcome: SellOutcome; payout?: number }> {
  return withTransaction(async (client) => {
    const rows = await loadReserveDrivers(lobbyId, teamKey, client);
    const row = rows.find((r) => r.id === driverId);
    if (!row) return { outcome: 'not_found' as const };

    const payout = saleValue(row.driver);
    const deleted = await deleteReserveDriver(client, lobbyId, driverId);
    if (!deleted) return { outcome: 'not_found' as const };
    await releaseMarketSigning(client, lobbyId, driverId);
    await addRp(client, lobbyId, teamKey, payout);
    return { outcome: 'ok' as const, payout };
  });
}
