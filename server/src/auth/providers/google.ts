/** Verifies Google ID tokens (JWTs) against Google's published JWKS. */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { VerifiedIdentity } from './index.ts';

const DEFAULT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let jwksUrl = DEFAULT_JWKS_URL;
let jwks = createRemoteJWKSet(new URL(jwksUrl));

/** Test seam: repoint the JWKS endpoint and clear the cached key set. */
export function __setGoogleJwksUrl(url: string): void {
  jwksUrl = url;
  jwks = createRemoteJWKSet(new URL(jwksUrl));
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
  } catch {
    return null;
  }
}
