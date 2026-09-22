/**
 * HTTP front for the two gold faucets: AdMob's server-side verification
 * (SSV) callback and store purchase receipts. See `./ssv.ts`, `./receipts.ts`
 * and `./repo.ts` for the actual verification and ledger logic — this
 * module only wires them to routes.
 *
 * Retry rule (see task/plan notes): Google's SSV callback retries up to 5
 * times at 1s intervals and expects HTTP 200. A replayed `transaction_id`
 * — which happens routinely, since Google retries whenever it isn't sure
 * the first call landed — must answer 200 and grant nothing, or every
 * successful-but-unacknowledged delivery turns into five more deliveries.
 * Store receipts get the same treatment for the same reason: clients retry
 * purchase confirmation on their own.
 *
 * A bad signature is NOT a retry candidate — it's a forgery or a
 * misconfiguration — and must not be answered 200.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { verifySession } from '../auth/jwt.ts';
import { loadUser } from '../auth/userRepo.ts';
import { grantGold, goldOf } from './repo.ts';
import { verifySsvCallback as realVerifySsvCallback, type SsvVerifyResult } from './ssv.ts';
import { verifyReceipt as realVerifyReceipt, type VerifyReceiptInput, type VerifyReceiptResult } from './receipts.ts';

export interface GoldRoutesDeps {
  verifySsvCallback?: (rawQueryString: string) => Promise<SsvVerifyResult>;
  verifyReceipt?: (input: VerifyReceiptInput) => Promise<VerifyReceiptResult>;
}

function unauthorized(): RouteResult {
  return { status: 401, body: { error: 'unauthorized' } };
}

export function registerGoldRoutes(router: Router, deps: GoldRoutesDeps = {}): void {
  const verifySsvCallback = deps.verifySsvCallback ?? realVerifySsvCallback;
  const verifyReceipt = deps.verifyReceipt ?? realVerifyReceipt;

  router.get('/gold/admob-ssv', async (ctx: RequestContext): Promise<RouteResult> => {
    // `url.search` is the exact query-string bytes the router already
    // parsed the request with (no field is re-serialized), which is what
    // the byte-identical signature check inside verifySsvCallback needs.
    const rawQueryString = ctx.url.search;

    const result = await verifySsvCallback(rawQueryString);
    if (!result.ok) {
      // Not a retry candidate: an invalid signature is a forgery or a
      // misconfiguration, not a delivery Google should keep re-sending.
      // Any non-200 works; 400 is chosen and carries no detail about why.
      return { status: 400, body: { error: 'rejected' } };
    }

    // The `user_id` in the callback is whatever the client passed to the
    // AdMob SDK — it was never signed as "this is a real account", only
    // the ad-watch event was. It must be checked against a real account
    // before crediting anything.
    const user = await loadUser(result.userId);
    if (!user) {
      // This is not a duplicate-transaction case, but it is just as
      // pointless to have Google retry: the user id came from the
      // client's own session state and will not change on redelivery, so
      // retrying buys nothing. Answering 200 here credits no one (there is
      // no account to credit) while avoiding five useless retries of a
      // request that can never succeed — the same spirit as the duplicate
      // case below, just for a different reason.
      return { status: 200, body: {} };
    }

    const grant = await grantGold({
      userId: user.id,
      source: 'ad',
      externalId: result.transactionId,
      // Taken from the VERIFIED callback result, never from a fresh,
      // unverified parse of the query string.
      gold: result.rewardAmount,
    });

    const gold = grant.ok ? grant.gold : await goldOf(user.id);
    // Duplicate transaction_id => 200, nothing credited. This is the
    // retry rule: Google will call this up to 5 times for one genuine ad
    // watch, and every one of those calls must look like success.
    return { status: 200, body: { gold } };
  });

  router.post('/gold/purchase', async (ctx: RequestContext): Promise<RouteResult> => {
    const sessionUserId = await verifySession(ctx.bearer);
    if (!sessionUserId) return unauthorized();
    const user = await loadUser(sessionUserId);
    if (!user) return unauthorized();

    const platform = ctx.body.platform;
    const receipt = ctx.body.receipt;
    const sku = ctx.body.sku;
    if ((platform !== 'apple' && platform !== 'google') || typeof receipt !== 'string') {
      return { status: 400, body: { error: 'invalid_request' } };
    }

    const result = await verifyReceipt({
      platform,
      receipt,
      sku: typeof sku === 'string' ? sku : undefined,
    });
    if (!result.ok) {
      // An invalid/unknown-SKU/forged receipt is an ordinary rejection,
      // not a retry candidate to acknowledge with 200.
      return { status: 400, body: { error: 'rejected' } };
    }

    // The session's own user id is the ONLY source of truth for who gets
    // credited — never anything the client put in the request body (a
    // `userId` field there, if sent, is silently ignored).
    const grant = await grantGold({
      userId: user.id,
      source: 'iap',
      externalId: result.transactionId,
      gold: result.gold,
    });

    const gold = grant.ok ? grant.gold : await goldOf(user.id);
    // Duplicate transaction_id => 200, nothing credited. Store clients
    // retry purchase confirmation on their own, for the same reasons
    // Google's SSV callback does.
    return { status: 200, body: { gold } };
  });
}
