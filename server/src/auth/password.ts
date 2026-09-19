/**
 * Password hashing with scrypt from node:crypto — no third-party dependency.
 *
 * Stored form: scrypt$<N>$<r>$<p>$<saltBase64>$<keyBase64>
 * The parameters live in the string so they can be raised later without
 * invalidating existing hashes.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAXMEM = 64 * 1024 * 1024;

// Sanity bounds on parsed scrypt parameters from a stored hash. These exist
// solely to fail fast (and cheaply) on a corrupted/malicious stored value
// instead of risking a multi-second-to-hung scrypt call — see password.test.ts
// and the Step 4 write-up for why this matters even though stored values are
// expected to come only from our own database.
const MAX_N = 1 << 20; // 1,048,576 — far above any parameter we'd configure
const MAX_R = 1024;
const MAX_P = 16;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

export type PasswordValidation = 'ok' | 'too_short' | 'too_long';

export function validatePassword(password: string): PasswordValidation {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  return 'ok';
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

function isPowerOfTwoGreaterThanOne(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  // Reject out-of-range or non-power-of-two N before ever calling into
  // scrypt: a huge N can exhaust CPU/time even when maxmem stops it from
  // exhausting memory, and node's scrypt requires N to be a power of two
  // greater than 1 (otherwise it throws synchronously — but we don't want to
  // rely on that for the bound, since the throw still costs a validation
  // pass and we'd rather be explicit and cheap).
  if (!isPowerOfTwoGreaterThanOne(n) || n > MAX_N) return false;
  if (!Number.isInteger(r) || r <= 0 || r > MAX_R) return false;
  if (!Number.isInteger(p) || p <= 0 || p > MAX_P) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
