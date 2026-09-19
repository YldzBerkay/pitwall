/** Verifies Google ID tokens (JWTs) against Google's published JWKS. */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { VerifiedIdentity } from './index.ts';
import { isJwtTokenRejection, logProviderInfraFailure } from './index.ts';

const DEFAULT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

// This sits on the interactive sign-in path (a human is waiting on the
// screen), so 3-5s is the usual budget: long enough to ride out ordinary
// network jitter, short enough that a dead endpoint fails fast instead of
// making the login hang.
const JWKS_TIMEOUT_MS = 4000;

let jwksUrl = DEFAULT_JWKS_URL;
let jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: JWKS_TIMEOUT_MS });

/** Test seam: repoint the JWKS endpoint and clear the cached key set. */
export function __setGoogleJwksUrl(url: string): void {
  jwksUrl = url;
  jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: JWKS_TIMEOUT_MS });
}

function configuredAudiences(): string[] {
  const raw = process.env.GOOGLE_CLIENT_IDS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function verifyGoogleToken(token: string): Promise<VerifiedIdentity | null> {
  const audience = configuredAudiences();
  if (audience.length === 0) return null;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience,
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;

    const email =
      payload.email_verified === true && typeof payload.email === 'string' ? payload.email : null;

    return { providerUid: payload.sub, email };
  } catch (err) {
    if (!isJwtTokenRejection(err)) logProviderInfraFailure('google', err);
    return null;
  }
}
