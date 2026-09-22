/**
 * Store purchase receipt verification (Apple App Store + Google Play).
 *
 * This is the other faucet, alongside AdMob SSV (`./ssv.ts`): the client
 * says "I bought the 500-gold pack", and this module is what stands between
 * that claim and a gold grant. Two rules exist to make that claim
 * unforgeable:
 *
 * 1. The GOLD AMOUNT comes from `goldPacks` (`@pitwall/shared/economy`),
 *    never from the request or from anything the store's response says
 *    about value. A response can tell us a product id was genuinely
 *    purchased; it does not get to tell us what that product is worth.
 * 2. An SKU that isn't in `goldPacks` grants nothing, no matter how
 *    genuine the store says the purchase is. `goldPacks` is a whitelist,
 *    not a hint.
 *
 * Crediting gold (and deduplicating by transaction id) is out of scope —
 * see `./repo.ts`'s `grantGold`, source `'iap'`. This module only answers
 * "is this receipt real, and if so, for what and how much."
 *
 * ---- Apple (verifyReceipt) ----
 * Reference: https://developer.apple.com/documentation/appstorereceipts/verifyreceipt
 * (Apple now steers new integrations toward the App Store Server API, but
 * `verifyReceipt` remains documented and is what this task specifies —
 * shared secret + a single POST — so that's what's implemented here.)
 *
 * - POST a JSON body `{ "receipt-data": "<base64 receipt>", "password":
 *   "<app-specific shared secret>" }` to the production endpoint.
 * - `status: 0` in the response means the receipt is genuine. Any other
 *   status is a rejection, EXCEPT for the sandbox fallback below.
 * - Sandbox fallback: status `21007` means "this receipt is from the test
 *   environment, but it was sent to the production environment" — Apple's
 *   own documented signal to retry the exact same request against the
 *   sandbox endpoint instead. This matters in production because Apple's
 *   own review devices, and any tester who hasn't gone through
 *   TestFlight-to-App-Store promotion, generate sandbox receipts that a
 *   production server will see. Without this fallback, App Review and
 *   sandbox testers get silently rejected. (`21008` is the mirror case —
 *   a production receipt sent to sandbox — but this server only calls
 *   production first, so it isn't needed here.)
 * - Consumable products (gold packs are consumables, not subscriptions)
 *   show up under `receipt.in_app`, each entry carrying `product_id` and
 *   `transaction_id`. That's where the SKU and transaction id come from —
 *   never from the caller's `sku` argument, which is accepted only as an
 *   optional hint/log field and is not trusted for anything security
 *   relevant.
 *
 * ---- Google Play (Purchases.products.get) ----
 * Reference: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/get
 *
 * - Validating a purchase token means calling the Google Play Developer
 *   API as a service account: GET
 *   `.../applications/{packageName}/purchases/products/{productId}/tokens/{token}`
 *   with an OAuth2 bearer access token for that service account (scope
 *   `androidpublisher`), obtained via the standard JWT-bearer grant
 *   (RFC 7523) against `https://oauth2.googleapis.com/token`.
 * - The response's `purchaseState` field carries the state:
 *   `0` = Purchased, `1` = Canceled, `2` = Pending. Only `0` counts as a
 *   real, completed purchase; pending and cancelled are both rejections.
 * - `orderId` is the transaction id. `productId` is the caller-supplied
 *   `sku` here (Google's API takes it as a path parameter, so unlike
 *   Apple there's no independent product id to read back out of the
 *   response) — it's still resolved against `goldPacks` below like every
 *   other SKU, so a caller cannot claim a product id that was never sold.
 */
import { createSign } from 'node:crypto';
import { goldPacks } from '@pitwall/shared/economy';

const APPLE_VERIFY_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_VERIFY_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_RECEIPT_STATUS = 21007;

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/**
 * Timeout for every outbound call this module makes (Apple verifyReceipt,
 * Google's OAuth token exchange, Google's purchase lookup). A purchase
 * confirmation sits in the user's checkout flow — long enough to absorb
 * a slow but healthy response, short enough that a hung store endpoint
 * doesn't leave the client's "confirming your purchase" spinner running
 * for a full HTTP timeout. Matches the AdMob SSV module's reasoning in
 * spirit, sized up slightly because this module sometimes makes two
 * sequential calls (Apple's sandbox retry, Google's token-then-lookup).
 */
const FETCH_TIMEOUT_MS = 5000;

export type ReceiptPlatform = 'apple' | 'google';

export interface VerifyReceiptInput {
  platform: ReceiptPlatform;
  /** Apple: base64 receipt data. Google: the purchase token. */
  receipt: string;
  /**
   * Optional hint, required in practice for Google (the API needs a
   * product id in the URL). Never trusted on its own — always resolved
   * against `goldPacks` before anything is granted.
   */
  sku?: string;
}

export type VerifyReceiptResult =
  | { ok: true; sku: string; transactionId: string; gold: number }
  | { ok: false; reason: string };

function logInfraFailure(platform: ReceiptPlatform, reason: string, err?: unknown): void {
  // Deliberately minimal, and deliberately ONLY for infrastructure
  // failures (network errors, malformed responses, missing credentials) —
  // never for an ordinary rejected receipt. A replayed or forged receipt
  // is an expected, uninteresting event that must not be able to flood
  // the logs; a receipt or shared secret must never appear in a log line
  // since both are bearer credentials.
  const errorType = err instanceof Error ? err.name : err === undefined ? undefined : typeof err;
  console.error('[gold/receipts] infra failure', { platform, reason, errorType });
}

/** Resolves an SKU against the catalogue. Unknown SKU => no result, no gold. */
function resolveGold(sku: string | undefined): number | null {
  if (!sku) return null;
  const pack = goldPacks.find((p) => p.sku === sku);
  return pack ? pack.gold : null;
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Apple
// ---------------------------------------------------------------------------

interface AppleInAppEntry {
  product_id?: string;
  transaction_id?: string;
}

interface AppleVerifyResponse {
  status?: number;
  receipt?: { in_app?: AppleInAppEntry[] };
}

async function callAppleVerify(
  url: string,
  receiptData: string,
  sharedSecret: string,
): Promise<{ ok: true; body: AppleVerifyResponse } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'receipt-data': receiptData, password: sharedSecret }),
      signal: timeoutSignal(),
    });
  } catch (err) {
    logInfraFailure('apple', 'fetch_error', err);
    return { ok: false, reason: 'network_error' };
  }

  if (!res.ok) {
    logInfraFailure('apple', 'non_200', new Error(String(res.status)));
    return { ok: false, reason: 'store_http_error' };
  }

  let body: AppleVerifyResponse;
  try {
    body = (await res.json()) as AppleVerifyResponse;
  } catch (err) {
    logInfraFailure('apple', 'malformed_response', err);
    return { ok: false, reason: 'malformed_response' };
  }

  return { ok: true, body };
}

async function verifyAppleReceipt(receipt: string): Promise<VerifyReceiptResult> {
  const sharedSecret = process.env.APPLE_SHARED_SECRET;
  if (!sharedSecret) {
    // Fail closed: with no shared secret configured, nothing can be
    // verified, so nothing is accepted. Never falls back to "trust it".
    logInfraFailure('apple', 'missing_shared_secret');
    return { ok: false, reason: 'not_configured' };
  }

  let attempt = await callAppleVerify(APPLE_VERIFY_URL, receipt, sharedSecret);
  if (!attempt.ok) {
    return { ok: false, reason: attempt.reason };
  }

  if (attempt.body.status === APPLE_SANDBOX_RECEIPT_STATUS) {
    // Documented sandbox fallback: a sandbox receipt was sent to
    // production. Retry once against the sandbox endpoint rather than
    // rejecting outright, or App Review and every non-promoted tester
    // build would fail every purchase.
    attempt = await callAppleVerify(APPLE_SANDBOX_VERIFY_URL, receipt, sharedSecret);
    if (!attempt.ok) {
      return { ok: false, reason: attempt.reason };
    }
  }

  if (attempt.body.status !== 0) {
    // Quiet: an ordinary invalid/replayed/forged receipt is not worth a
    // log line, and logging the status alongside receipt content risks
    // trouble later if anyone extends this branch carelessly.
    return { ok: false, reason: 'invalid_receipt' };
  }

  const entries = attempt.body.receipt?.in_app ?? [];
  const entry = entries[0];
  const sku = entry?.product_id;
  const transactionId = entry?.transaction_id;
  if (!sku || !transactionId) {
    return { ok: false, reason: 'missing_purchase_info' };
  }

  const gold = resolveGold(sku);
  if (gold === null) {
    // Rule 2: an SKU we never sold grants nothing, even with a genuine,
    // successfully verified receipt behind it.
    return { ok: false, reason: 'unknown_sku' };
  }

  // Rule 1: the gold amount is ALWAYS read from the catalogue lookup
  // above, never from any field on `entry` or `attempt.body`.
  return { ok: true, sku, transactionId, gold };
}

// ---------------------------------------------------------------------------
// Google Play
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mints a short-lived OAuth2 access token for the Play Developer API using
 * the standard JWT-bearer grant (RFC 7523) with the configured service
 * account. Returns null (never throws) on any credential or network
 * problem, so the caller can fail closed uniformly.
 */
async function getGooglePlayAccessToken(): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !privateKey) {
    logInfraFailure('google', 'missing_service_account_credentials');
    return { ok: false, reason: 'not_configured' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: email,
      scope: GOOGLE_PLAY_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;

  let signature: string;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    signature = base64url(signer.sign(privateKey));
  } catch (err) {
    // A malformed/unparsable private key is a configuration problem, not
    // an ordinary rejection — worth logging (type only, never the key).
    logInfraFailure('google', 'jwt_sign_error', err);
    return { ok: false, reason: 'not_configured' };
  }

  const assertion = `${unsigned}.${signature}`;

  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: timeoutSignal(),
    });
  } catch (err) {
    logInfraFailure('google', 'fetch_error', err);
    return { ok: false, reason: 'network_error' };
  }

  if (!res.ok) {
    logInfraFailure('google', 'non_200', new Error(String(res.status)));
    return { ok: false, reason: 'store_http_error' };
  }

  try {
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
      logInfraFailure('google', 'malformed_token_response');
      return { ok: false, reason: 'malformed_response' };
    }
    return { ok: true, token: body.access_token };
  } catch (err) {
    logInfraFailure('google', 'malformed_response', err);
    return { ok: false, reason: 'malformed_response' };
  }
}

interface GooglePurchaseResponse {
  purchaseState?: number;
  orderId?: string;
}

const GOOGLE_PURCHASED_STATE = 0;

async function verifyGooglePurchase(purchaseToken: string, sku: string | undefined): Promise<VerifyReceiptResult> {
  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  if (!packageName) {
    logInfraFailure('google', 'missing_package_name');
    return { ok: false, reason: 'not_configured' };
  }

  // Rule 2 applies before we even call the store: an SKU we never sold is
  // rejected outright, so a bad/unknown product id never needs a network
  // round trip (and never leaks whether it "looks" like a real purchase).
  const gold = resolveGold(sku);
  if (gold === null || !sku) {
    return { ok: false, reason: 'unknown_sku' };
  }

  const tokenResult = await getGooglePlayAccessToken();
  if (!tokenResult.ok) {
    return { ok: false, reason: tokenResult.reason };
  }

  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    packageName,
  )}/purchases/products/${encodeURIComponent(sku)}/tokens/${encodeURIComponent(purchaseToken)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${tokenResult.token}` },
      signal: timeoutSignal(),
    });
  } catch (err) {
    logInfraFailure('google', 'fetch_error', err);
    return { ok: false, reason: 'network_error' };
  }

  if (!res.ok) {
    // A 4xx here (e.g. unknown token) is an ordinary rejection, not an
    // infra failure worth logging — stay quiet per the log-hygiene rule.
    return { ok: false, reason: 'store_http_error' };
  }

  let body: GooglePurchaseResponse;
  try {
    body = (await res.json()) as GooglePurchaseResponse;
  } catch (err) {
    logInfraFailure('google', 'malformed_response', err);
    return { ok: false, reason: 'malformed_response' };
  }

  if (body.purchaseState !== GOOGLE_PURCHASED_STATE) {
    return { ok: false, reason: 'not_purchased' };
  }

  const transactionId = body.orderId;
  if (!transactionId) {
    return { ok: false, reason: 'missing_order_id' };
  }

  // Rule 1: `gold` was already resolved from the catalogue above, before
  // the store was even called — nothing from `body` overrides it.
  return { ok: true, sku, transactionId, gold };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Verifies a store purchase receipt/token and, on success, returns the
 * catalogue SKU, the store's transaction id, and the gold amount as
 * defined by `goldPacks` — never as claimed by the request or the store
 * response. Never throws. Crediting gold is the caller's job (see
 * `./repo.ts`); this function only decides whether, and for what, that's
 * warranted.
 */
export async function verifyReceipt(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
  try {
    if (!input || typeof input.receipt !== 'string' || input.receipt.length === 0) {
      return { ok: false, reason: 'empty_receipt' };
    }
    if (input.platform === 'apple') {
      return await verifyAppleReceipt(input.receipt);
    }
    if (input.platform === 'google') {
      return await verifyGooglePurchase(input.receipt, input.sku);
    }
    return { ok: false, reason: 'unknown_platform' };
  } catch {
    // Belt and suspenders: must never throw, no matter what.
    return { ok: false, reason: 'unexpected_error' };
  }
}
