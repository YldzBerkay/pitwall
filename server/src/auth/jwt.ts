/** Our own session token. Provider tokens are verified then discarded. */
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const ISSUER = 'pit-wall';
const AUDIENCE = 'pit-wall-app';

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('SESSION_SECRET is missing or shorter than 32 characters');
  }
  return new TextEncoder().encode(raw);
}

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret());
}

/**
 * Returns the user id, or null if the token is absent, invalid or expired.
 *
 * A missing/misconfigured SESSION_SECRET is NOT swallowed into null: secret()
 * is resolved before the try block, so a configuration error throws loudly
 * instead of making every session look logged-out with no error anywhere.
 */
export async function verifySession(token: string): Promise<string | null> {
  if (!token) return null;
  const key = secret();
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
