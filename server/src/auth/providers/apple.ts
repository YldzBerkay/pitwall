/** Verifies "Sign in with Apple" identity tokens (JWTs) against Apple's published JWKS. */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { VerifiedIdentity } from './index.ts';
import { isJwtTokenRejection, logProviderInfraFailure } from './index.ts';

const DEFAULT_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const ISSUER = 'https://appleid.apple.com';

// Same interactive-sign-in budget as the Google provider: 3-5s is the usual
// range, so 4s absorbs normal jitter without making a dead endpoint hang the
// login (see google.ts for the fuller rationale).
const JWKS_TIMEOUT_MS = 4000;

let jwksUrl = DEFAULT_JWKS_URL;
let jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: JWKS_TIMEOUT_MS });

/** Test seam: repoint the JWKS endpoint and clear the cached key set. */
export function __setAppleJwksUrl(url: string): void {
  jwksUrl = url;
  jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: JWKS_TIMEOUT_MS });
}

function configuredAudiences(): string[] {
  const raw = process.env.APPLE_BUNDLE_IDS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function verifyAppleToken(token: string): Promise<VerifiedIdentity | null> {
  const audience = configuredAudiences();
  if (audience.length === 0) return null;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience,
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;

    // Apple sends email only on first authorisation, and email_verified as
    // either the boolean true or the string "true" — accept both. Absence of
    // an email (subsequent logins, or a private relay address) is normal.
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    const email = verified && typeof payload.email === 'string' ? payload.email : null;

    return { providerUid: payload.sub, email };
  } catch (err) {
    if (!isJwtTokenRejection(err)) logProviderInfraFailure('apple', err);
    return null;
  }
}
