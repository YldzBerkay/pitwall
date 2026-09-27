/**
 * HTTP front for the driver market and contracts.
 *
 *   GET  /drivers/market?lobbyId=          this lobby's free agents — {market}
 *   POST /drivers/sign    {lobbyId, marketId, seat, seasons} -> {contract, fee}
 *   POST /drivers/renew   {lobbyId, seat, seasons}           -> {fee}
 *   POST /drivers/sell    {lobbyId, driverId}                -> {payout}
 *
 * Same house rules as `economy/sponsorRoutes.ts`:
 *  - The team acted on comes from the caller's OWN `lobby_seats` row for
 *    this lobby — never from the request body. No session -> 401; no seat
 *    in this lobby -> 403.
 *  - Every fee/wage in a response is the SERVER's own figure
 *    (`drivers/market.ts`); a `fee`/`wage` sent in the request body is read
 *    nowhere in this file.
 *  - Distinct failure reasons stay distinct strings even when they share an
 *    HTTP status — `already_signed` and `not_enough_rp` are different bugs
 *    on the client's side and different attacks from a hostile one, exactly
 *    like `economy/routes.ts`'s `STATUS_BY_CODE` mapping several reasons
 *    onto the same 409.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { verifySession } from '../auth/jwt.ts';
import { query } from '../db/pool.ts';
import {
  marketFor, signMarketDriver, renewSeatContract, sellReserveDriver,
  DriverMarketError, type SignTarget, type SignOutcome, type RenewOutcome, type SellOutcome,
} from './market.ts';

interface SeatRow {
  team_key: string;
}

/** The player's own seat for this lobby — the ONLY source of `teamKey`. */
async function findOwnTeamKey(lobbyId: string, userId: string): Promise<string | null> {
  const res = await query<SeatRow>(
    `select team_key from lobby_seats where lobby_id = $1 and user_id = $2`,
    [lobbyId, userId],
  );
  return res.rows[0]?.team_key ?? null;
}

function unauthorized(): RouteResult {
  return { status: 401, body: { error: 'unauthorized' } };
}

function forbidden(): RouteResult {
  return { status: 403, body: { error: 'forbidden' } };
}

function badRequest(): RouteResult {
  return { status: 400, body: { error: 'invalid_request' } };
}

const SIGN_TARGETS = new Set(['seat_0', 'seat_1', 'reserve']);

const SIGN_STATUS: Record<SignOutcome, number> = {
  ok: 200,
  not_found: 404,
  already_signed: 409,
  not_enough_rp: 409,
  squad_full: 409,
};

const RENEW_STATUS: Record<RenewOutcome, number> = {
  ok: 200,
  not_found: 404,
  not_due: 409,
  not_enough_rp: 409,
};

const SELL_STATUS: Record<SellOutcome, number> = {
  ok: 200,
  not_found: 404,
};

export function registerDriverMarketRoutes(router: Router): void {
  router.get('/drivers/market', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.url.searchParams.get('lobbyId');
    if (!lobbyId) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    try {
      // Read-only: `marketFor` regenerates the candidate list fresh every
      // call from the lobby's own season/round and subtracts whoever is
      // already signed — nothing here writes.
      const { market } = await marketFor(lobbyId);
      return { status: 200, body: { market } };
    } catch (err) {
      if (err instanceof DriverMarketError) return { status: 404, body: { error: err.reason } };
      throw err;
    }
  });

  router.post('/drivers/sign', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.body['lobbyId'];
    if (typeof lobbyId !== 'string' || lobbyId.length === 0) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    const marketId = ctx.body['marketId'];
    if (typeof marketId !== 'string' || marketId.length === 0) return badRequest();

    const seat = ctx.body['seat'];
    if (typeof seat !== 'string' || !SIGN_TARGETS.has(seat)) return badRequest();

    const seasonsRaw = ctx.body['seasons'];
    const seasons = typeof seasonsRaw === 'number' && Number.isInteger(seasonsRaw) ? seasonsRaw : 2;
    if (seasons < 1 || seasons > 3) return badRequest();

    // ── THE CHECK THAT MATTERS ─────────────────────────────────────────
    // `marketId`/`seat`/`seasons` only say WHICH driver and WHERE; the fee
    // and wage that actually get charged and stored come from the SERVER's
    // own regenerated market inside `signMarketDriver`, never from
    // `ctx.body['fee']`/`ctx.body['wage']` — those are read nowhere in this
    // handler. See the module docblock.
    let result;
    try {
      result = await signMarketDriver(lobbyId, teamKey, marketId, seat as SignTarget, seasons);
    } catch (err) {
      if (err instanceof DriverMarketError) return { status: 404, body: { error: err.reason } };
      throw err;
    }

    if (result.outcome !== 'ok') return { status: SIGN_STATUS[result.outcome], body: { error: result.outcome } };
    return { status: 200, body: { fee: result.fee, wage: result.wage } };
  });

  router.post('/drivers/renew', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.body['lobbyId'];
    if (typeof lobbyId !== 'string' || lobbyId.length === 0) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    const seat = ctx.body['seat'];
    if (seat !== 0 && seat !== 1) return badRequest();

    const seasonsRaw = ctx.body['seasons'];
    const seasons = typeof seasonsRaw === 'number' && Number.isInteger(seasonsRaw) ? seasonsRaw : 2;
    if (seasons < 1 || seasons > 3) return badRequest();

    const result = await renewSeatContract(lobbyId, teamKey, seat, seasons);
    if (result.outcome !== 'ok') return { status: RENEW_STATUS[result.outcome], body: { error: result.outcome } };
    return { status: 200, body: { fee: result.fee } };
  });

  router.post('/drivers/sell', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.body['lobbyId'];
    if (typeof lobbyId !== 'string' || lobbyId.length === 0) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    const driverId = ctx.body['driverId'];
    if (typeof driverId !== 'string' || driverId.length === 0) return badRequest();

    const result = await sellReserveDriver(lobbyId, teamKey, driverId);
    if (result.outcome !== 'ok') return { status: SELL_STATUS[result.outcome], body: { error: result.outcome } };
    return { status: 200, body: { payout: result.payout } };
  });
}
