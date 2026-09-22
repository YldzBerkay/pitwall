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
import { grantGold, goldOf, capsFor, bumpAdsWatched } from './repo.ts';
import { verifySsvCallback as realVerifySsvCallback, type SsvVerifyResult } from './ssv.ts';
import { verifyReceipt as realVerifyReceipt, type VerifyReceiptInput, type VerifyReceiptResult } from './receipts.ts';
import { ADS_PER_DAY } from '@pitwall/shared/economy';

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

    // Enforce the daily ad cap (shared/src/economy.ts: GOLD_PER_AD /
    // ADS_PER_DAY) before crediting anything. `capsFor` resolves against
    // the SERVER's UTC day, so a capped user gets a plain 200 with no
    // credit — the same shape as a duplicate-transaction reply, and for
    // the same reason: Google retries a non-200 up to 5 times, and "you
    // are at your daily limit" is not a delivery failure, it is the
    // expected steady state for an active player.
    //
    // This check-then-credit is not perfectly race-free: two distinct,
    // genuine callbacks for the same user arriving at the same instant
    // could both read a cap of ADS_PER_DAY-1 and both credit, landing the
    // counter one over. That requires two concurrent ad-watch deliveries
    // for one account, which is not how a single client watches ads (one
    // rewarded ad at a time) — the overshoot is bounded by the number of
    // truly concurrent requests in flight, not attacker-controlled at any
    // scale that matters here, so it is accepted rather than solved.
    const now = new Date();
    const caps = await capsFor(user.id, now);
    if (caps.adsWatched >= ADS_PER_DAY) {
      return { status: 200, body: { gold: await goldOf(user.id) } };
    }

    const grant = await grantGold({
      userId: user.id,
      source: 'ad',
      externalId: result.transactionId,
      // Taken from the VERIFIED callback result, never from a fresh,
      // unverified parse of the query string.
      gold: result.rewardAmount,
    });

    // The counter is bumped only when `grantGold` actually inserted a new
    // ledger row (`grant.ok`), and only AFTER it succeeds. On a duplicate
    // `transaction_id` (a Google retry of an ad already credited),
    // `grant.ok` is false and the counter is left untouched — a retry
    // must not cost the player a second slot in their daily allowance.
    //
    // `grantGold` and `bumpAdsWatched` are two separate statements/
    // transactions (`grantGold` opens and commits its own transaction in
    // repo.ts), so this pair is not atomic: a crash between them would
    // leave gold credited without the counter bumped, letting the cap
    // silently drift upward over time. Closing that gap for real needs a
    // single transaction that does the insert-into-gold_grants, the
    // users.gold update, AND the daily_caps upsert together — i.e. a
    // change to repo.ts (e.g. a `grantGoldForAd` that takes the same
    // client used for the grant and bumps the counter before committing),
    // which is out of scope for this change. This code minimizes the
    // window (the bump happens immediately after the grant resolves, with
    // no other awaits in between) but does not eliminate it.
    if (grant.ok) {
      await bumpAdsWatched(user.id, now);
    }

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
