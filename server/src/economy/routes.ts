/**
 * HTTP front for the economy command endpoint.
 *
 * ONE route, POST-only, and the router (`http/router.ts`) does exact path
 * matching with no path parameters — so `lobbyId` travels in the request
 * BODY alongside `type` and whatever the action needs, not in the URL.
 *
 * Two things this file exists to enforce (see the task's warnings):
 *  1. A session is required, and the team acted on comes from the player's
 *     OWN `lobby_seats` row for that lobby — never from the request body.
 *     A `teamKey` sent in the body is read nowhere in this file.
 *  2. Nothing thrown by `runAction` for an unrecognised reason is ever
 *     swallowed into a misleading 400 — it is re-thrown so the router turns
 *     it into a 500 with no detail leaked (see `http/router.ts`).
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { verifySession } from '../auth/jwt.ts';
import { query } from '../db/pool.ts';
import { runAction, type ActionFailureCode } from './actions.ts';

const STATUS_BY_CODE: Record<ActionFailureCode, number> = {
  unknown_action: 400,
  bad_payload: 400,
  not_ready: 409,
  already_claimed: 409,
  already_running: 409,
  not_enough_rp: 409,
  not_enough_gold: 409,
  no_user: 400,
  not_found: 404,
  cap_reached: 409,
  no_economy: 404,
};

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

export function registerEconomyRoutes(router: Router): void {
  router.post('/economy/action', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.body['lobbyId'];
    if (typeof lobbyId !== 'string' || lobbyId.length === 0) {
      return { status: 400, body: { error: 'invalid_request' } };
    }

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    // `now` is sampled HERE, from this machine's own clock, and nowhere
    // else. `jobs.ts` deliberately never reads the clock itself — every one
    // of its entry points takes `now` from its caller so a test can pin it
    // — which means the anti-cheat property of the whole job system (a
    // claim only succeeds once `ends_at` has really passed; a skip's gold
    // cost is computed from real remaining time) rests entirely on this
    // call site handing it a trustworthy value. `runAction` takes `now` as
    // a parameter only so tests can fix it; a request body's `now` /
    // `serverNow` / `timestamp` (if a client ever sends one) is NEVER read
    // here or in `actions.ts` — a caller-supplied instant far in the future
    // would make `skipCostGold` return 0 (a free skip) and make an unready
    // job's `ends_at <= now` compare true (an instant claim). Do not add a
    // fallback or override that lets any part of the request influence this
    // value.
    const now = new Date();
    const result = await runAction({ lobbyId, userId, teamKey, body: ctx.body, now });
    if (result.ok) return { status: 200, body: result.state };

    const status = STATUS_BY_CODE[result.code];
    if (status === undefined) {
      // A code `runAction` can return but this map doesn't know about is a
      // programming error in this file, not a client mistake — surface it
      // as a 500 via the router rather than guessing a status.
      throw new Error('registerEconomyRoutes: unmapped action failure code');
    }
    return { status, body: { error: result.code } };
  });
}
