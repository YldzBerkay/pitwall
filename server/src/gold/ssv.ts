/**
 * AdMob rewarded-ad Server-Side Verification (SSV).
 *
 * When a player genuinely finishes a rewarded ad, AdMob's own servers call
 * a callback URL we configure, as a GET request whose query string is
 * signed with an ECDSA key that only Google holds:
 *
 *   .../callback?ad_network=...&ad_unit=...&reward_amount=10&reward_item=coins
 *     &timestamp=...&transaction_id=...&user_id=...&signature=...&key_id=...
 *
 * The client can never be trusted to say "I watched an ad" — it would be
 * trivial to replay or forge that claim — so every gold grant from ads must
 * flow through `verifySsvCallback` first. This module is the cryptography
 * and parsing only; wiring it to an HTTP route and to `grantGold` is a
 * later task.
 *
 * Protocol reference (confirmed against Google's current docs, not
 * implemented from memory):
 *   https://developers.google.com/admob/android/ssv
 *
 * Key points that shaped this implementation:
 * - The callback is a GET. Query params are sent in alphabetical order,
 *   with `signature` and `key_id` always appended last, in that order.
 * - The signed content is the exact query-string bytes BEFORE `&signature=`
 *   (not a re-serialization of parsed params — order and encoding must be
 *   byte-identical to what Google sent).
 * - The signature is ECDSA (P-256) over SHA-256, DER-encoded, then
 *   (URL-safe or standard) base64-encoded into the `signature` param.
 * - Public keys are fetched from a Google-hosted JSON endpoint shaped
 *   `{ "keys": [ { "keyId": number, "pem": string, "base64": string } ] }`
 *   and rotate on a variable schedule; Google says do not cache them for
 *   more than 24h. We additionally refetch once, immediately, whenever an
 *   incoming `key_id` isn't in our cache, since a just-rotated key would
 *   otherwise cause a false rejection until the next scheduled refresh.
 * - Google expects an HTTP 200 for the callback and retries up to 5 times
 *   at 1s intervals otherwise — meaning the eventual route handler (not
 *   this module) must treat a replay of an already-processed
 *   `transaction_id` as a success, not an error, or it will keep retrying
 *   forever. That's out of scope here; this module only decides whether a
 *   callback's signature is genuine.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

const DEFAULT_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';

/**
 * Timeout for fetching AdMob's public key list. This runs inline in the
 * request path the first time (or first time after a rotation) a given
 * key_id is seen, so it must fail fast rather than hang a reward callback
 * indefinitely if Google's endpoint is unreachable. 3s is generous enough
 * to absorb ordinary network/TLS latency but short enough that a hung
 * endpoint doesn't stall the caller noticeably.
 */
const KEY_FETCH_TIMEOUT_MS = 3000;

interface RawKeyEntry {
  keyId?: number | string;
  pem?: string;
  base64?: string;
}

interface KeysResponse {
  keys?: RawKeyEntry[];
}

export type SsvVerifyResult =
  | { ok: true; transactionId: string; userId: string; rewardAmount: number }
  | { ok: false; reason: string };

let keysUrl = DEFAULT_KEYS_URL;
let cachedKeys: Map<string, KeyObject> | null = null;

/**
 * Test seam: point the verifier at a local key server instead of Google's.
 * MUST clear the cache — otherwise a test that runs after a previous test
 * already populated `cachedKeys` would silently keep verifying against the
 * old (real or previously-stubbed) key set instead of the new one.
 */
export function __setVerifierKeysUrl(url: string): void {
  keysUrl = url;
  cachedKeys = null;
}

function logInfraFailure(reason: string, err: unknown): void {
  // Deliberately minimal: never log the query string, the signature, or a
  // user id — a signed callback is a bearer credential, and this line must
  // stay safe to ship to any log aggregator.
  const errorType = err instanceof Error ? err.name : typeof err;
  console.error('[gold/ssv] key fetch failed', { provider: 'admob', reason, errorType });
}

async function fetchKeys(): Promise<Map<string, KeyObject> | null> {
  try {
    const res = await fetch(keysUrl, { signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      logInfraFailure('non_200', new Error(String(res.status)));
      return null;
    }
    const body = (await res.json()) as KeysResponse;
    if (!Array.isArray(body.keys)) {
      logInfraFailure('malformed_response', new Error('missing keys array'));
      return null;
    }
    const map = new Map<string, KeyObject>();
    for (const entry of body.keys) {
      if (entry.keyId === undefined || entry.keyId === null) continue;
      const pemOrDer = entry.pem ?? (entry.base64 ? derToPem(entry.base64) : undefined);
      if (!pemOrDer) continue;
      try {
        map.set(String(entry.keyId), createPublicKey(pemOrDer));
      } catch {
        // Skip a single unparsable key rather than failing the whole batch.
        continue;
      }
    }
    return map;
  } catch (err) {
    logInfraFailure('fetch_error', err);
    return null;
  }
}

function derToPem(base64Der: string): string {
  const lines = base64Der.match(/.{1,64}/g) ?? [base64Der];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

async function getKey(keyId: string, allowRefetch: boolean): Promise<KeyObject | null> {
  if (!cachedKeys) {
    cachedKeys = await fetchKeys();
  }
  const found = cachedKeys?.get(keyId);
  if (found) return found;
  if (!allowRefetch) return null;
  // Google rotates keys; an unknown key_id might just mean our cache is
  // stale, so refetch exactly once before giving up.
  cachedKeys = await fetchKeys();
  return cachedKeys?.get(keyId) ?? null;
}

function decodeSignature(raw: string): Buffer | null {
  try {
    const normalized = decodeURIComponent(raw).replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(normalized, 'base64');
    if (buf.length === 0) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Verifies a raw AdMob SSV callback query string and, on success, returns
 * the fields the gold ledger needs. Never throws: every failure path
 * (malformed input, unknown key, bad signature, missing fields) is
 * reported as `{ok: false, reason}` so a flood of garbage requests can
 * never crash or spam the process — and, per the log-hygiene requirement,
 * a rejection is never logged at all, since it carries no more information
 * than "someone sent us a request".
 */
export async function verifySsvCallback(rawQueryString: string): Promise<SsvVerifyResult> {
  try {
    if (typeof rawQueryString !== 'string' || rawQueryString.length === 0) {
      return { ok: false, reason: 'empty_input' };
    }
    const queryString = rawQueryString.startsWith('?') ? rawQueryString.slice(1) : rawQueryString;
    const parts = queryString.split('&').filter((p) => p.length > 0);
    if (parts.length < 3) {
      return { ok: false, reason: 'malformed' };
    }

    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    if (!last.startsWith('key_id=')) {
      return { ok: false, reason: 'missing_key_id' };
    }
    if (!secondLast.startsWith('signature=')) {
      return { ok: false, reason: 'missing_signature' };
    }

    const keyId = decodeURIComponent(last.slice('key_id='.length));
    const signatureRaw = secondLast.slice('signature='.length);
    if (!keyId) {
      return { ok: false, reason: 'missing_key_id' };
    }
    if (!signatureRaw) {
      return { ok: false, reason: 'missing_signature' };
    }

    // Exact byte-for-byte content Google signed: everything before
    // "&signature=...&key_id=...". Reconstructed by rejoining the
    // untouched leading parts, never by re-serializing parsed values.
    const contentParts = parts.slice(0, parts.length - 2);
    const contentToVerify = contentParts.join('&');

    const fields = new Map<string, string>();
    for (const part of contentParts) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      try {
        fields.set(key, decodeURIComponent(value));
      } catch {
        return { ok: false, reason: 'malformed' };
      }
    }

    const transactionId = fields.get('transaction_id');
    if (!transactionId) {
      // Without this there is no deduplication key, so it must never be
      // trusted even if the signature otherwise checks out.
      return { ok: false, reason: 'missing_transaction_id' };
    }
    const userId = fields.get('user_id');
    if (!userId) {
      return { ok: false, reason: 'missing_user_id' };
    }
    const rewardAmountRaw = fields.get('reward_amount');
    const rewardAmount = rewardAmountRaw === undefined ? NaN : Number(rewardAmountRaw);
    if (!Number.isFinite(rewardAmount) || !Number.isInteger(rewardAmount) || rewardAmount <= 0) {
      return { ok: false, reason: 'invalid_reward_amount' };
    }

    const signature = decodeSignature(signatureRaw);
    if (!signature) {
      return { ok: false, reason: 'invalid_signature_encoding' };
    }

    const publicKey = await getKey(keyId, true);
    if (!publicKey) {
      return { ok: false, reason: 'unknown_key_id' };
    }

    let signatureValid: boolean;
    try {
      signatureValid = cryptoVerify(
        'sha256',
        Buffer.from(contentToVerify, 'utf8'),
        publicKey,
        signature,
      );
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      return { ok: false, reason: 'invalid_signature' };
    }

    return { ok: true, transactionId, userId, rewardAmount };
  } catch {
    // Belt and suspenders: this function must never throw, no matter what
    // garbage is thrown at it.
    return { ok: false, reason: 'unexpected_error' };
  }
}
