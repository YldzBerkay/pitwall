/**
 * HTTP front for the staff market and hiring.
 *
 *   GET  /staff/market  ?lobbyId=                        -> {market}
 *   GET  /staff/roster  ?lobbyId=                         -> {roster}
 *   POST /staff/hire    {lobbyId, marketId, replace?}     -> {fee, wage, role}
 *   POST /staff/release {lobbyId, role}                   -> {}
 *
 * Same house rules as `drivers/routes.ts`:
 *  - The team acted on comes from the caller's OWN `lobby_seats` row for
 *    this lobby — never from the request body. No session -> 401; no seat
 *    in this lobby -> 403.
 *  - Every fee/wage in a response is the SERVER's own figure
 *    (`staff/market.ts`); a `fee`/`wage` sent in the request body is read
 *    nowhere in this file.
 *  - Distinct failure reasons stay distinct strings even when they share an
 *    HTTP status.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { verifySession } from '../auth/jwt.ts';
import { query } from '../db/pool.ts';
import { staffRoles, type StaffRole } from '@pitwall/shared/staff';
import {
  staffMarketFor, hireMarketStaff, releaseTeamStaff, loadRoster,
  StaffMarketError, type HireOutcome, type ReleaseOutcome,
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

const STAFF_ROLES: ReadonlySet<string> = new Set(staffRoles.map((r) => r.key));

const HIRE_STATUS: Record<HireOutcome, number> = {
  ok: 200,
  not_found: 404,
  already_hired: 409,
  not_enough_rp: 409,
  seat_taken: 409,
};

const RELEASE_STATUS: Record<ReleaseOutcome, number> = {
  ok: 200,
  not_found: 404,
};

export function registerStaffRoutes(router: Router): void {
  router.get('/staff/market', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.url.searchParams.get('lobbyId');
    if (!lobbyId) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    try {
      // Read-only: `staffMarketFor` regenerates the candidate list fresh
      // every call from the lobby's own season/round and subtracts whoever
      // is already hired — nothing here writes.
      const { market } = await staffMarketFor(lobbyId);
      return { status: 200, body: { market } };
    } catch (err) {
      if (err instanceof StaffMarketError) return { status: 404, body: { error: err.reason } };
      throw err;
    }
  });

  router.get('/staff/roster', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.url.searchParams.get('lobbyId');
    if (!lobbyId) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    const roster = await loadRoster(lobbyId, teamKey);
    return { status: 200, body: { roster: roster.map((r) => ({ role: r.role, member: r.member })) } };
  });

  router.post('/staff/hire', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.body['lobbyId'];
    if (typeof lobbyId !== 'string' || lobbyId.length === 0) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    const marketId = ctx.body['marketId'];
    if (typeof marketId !== 'string' || marketId.length === 0) return badRequest();

    const replace = ctx.body['replace'] === true;

    // ── THE CHECK THAT MATTERS ─────────────────────────────────────────
    // `marketId`/`replace` only say WHICH candidate and WHETHER to
    // overwrite an occupied seat; the fee and wage that actually get
    // charged and stored come from the SERVER's own regenerated market
    // inside `hireMarketStaff`, never from `ctx.body['fee']`/
    // `ctx.body['wage']` — those are read nowhere in this handler.
    let result;
    try {
      result = await hireMarketStaff(lobbyId, teamKey, marketId, replace);
    } catch (err) {
      if (err instanceof StaffMarketError) return { status: 404, body: { error: err.reason } };
      throw err;
    }

    if (result.outcome !== 'ok') return { status: HIRE_STATUS[result.outcome], body: { error: result.outcome } };
    return { status: 200, body: { fee: result.fee, wage: result.wage } };
  });

  router.post('/staff/release', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.body['lobbyId'];
    if (typeof lobbyId !== 'string' || lobbyId.length === 0) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    const role = ctx.body['role'];
    if (typeof role !== 'string' || !STAFF_ROLES.has(role)) return badRequest();

    const result = await releaseTeamStaff(lobbyId, teamKey, role as StaffRole);
    if (result.outcome !== 'ok') return { status: RELEASE_STATUS[result.outcome], body: { error: result.outcome } };
    return { status: 200, body: {} };
  });
}
