/**
 * Third-party sign-in token verification.
 *
 * The mobile app obtains a token from Google / Apple / Facebook and sends it
 * to us. We must prove it is genuine AND issued for our app before trusting
 * the identity inside it, then mint our own session JWT (see ../jwt.ts) and
 * discard the provider token.
 */
import { errors as joseErrors } from 'jose';
import { verifyGoogleToken } from './google.ts';
import { verifyAppleToken } from './apple.ts';
import { verifyFacebookToken } from './facebook.ts';

/**
 * True when `error` is an ordinary, expected JWT rejection (bad signature,
 * wrong audience/issuer, expired, malformed, unknown key id) rather than an
 * infrastructure problem. These are routine — anyone can trigger one at will
 * just by sending garbage — so they must stay quiet: an attacker must not be
 * able to flood the logs by hammering us with invalid tokens.
 *
 * Also included: `JOSENotSupported`. jose throws this the moment it sees a
 * JWT header `alg` it won't map to a JWKS key type (e.g. `"none"`, or
 * `"HS256"` in a classic alg-confusion attempt) — that check runs purely
 * against attacker-controlled input, before any network call, so anyone can
 * trigger it at will just by setting a strange `alg`. It is exactly as
 * routine as a bad signature and must stay quiet for the same reason.
 *
 * Deliberately NOT included: jose's generic `JOSEError` (e.g. a non-200 JWKS
 * response, or a JWKS body that fails to parse) and `JWKSTimeout` — both mean
 * the identity provider's infrastructure misbehaved, not that the token was
 * bad, and those must be logged (see `logProviderInfraFailure`).
 *
 * Also deliberately NOT included: `JWKSInvalid` and `JWKInvalid`. Read against
 * jose 5.10.0's source (`src/jwks/local.ts` / dist `jwks/local.js`):
 *   - `JWKSInvalid('JSON Web Key Set malformed')` is thrown by the
 *     `LocalJWKSet` constructor when the fetched JWKS body itself is not
 *     `{ keys: [...] }` — a property of the document the provider served,
 *     never of the token.
 *   - `JWKSInvalid('JSON Web Key Set members must be public keys')` is thrown
 *     from `importWithAlgCache` while importing a *candidate* JWK that the
 *     token's `alg`/`kid` merely selected from the provider's own key set —
 *     the failure is that the provider published a private/malformed key,
 *     not anything about the token. No attacker-controlled field of the
 *     token can force this branch; at most a token's `alg`/`kid` pick which
 *     already-fetched key gets imported.
 *   - `JWKInvalid` is thrown only from `jwk/thumbprint.js` (computing a JWK
 *     thumbprint), which the verify path used here (`createRemoteJWKSet` →
 *     `jwtVerify` → `jwks/local.js`) never calls — `local.js` doesn't even
 *     import `JWKInvalid`. It cannot fire from token or provider data on
 *     this path today; the closest live analogue is `JWKSInvalid` above, so
 *     it is grouped with it rather than left routine by omission.
 * Both are therefore infrastructure-caused (a provider serving a broken or
 * malformed key set), not attacker-caused, and must be logged.
 */
export function isJwtTokenRejection(error: unknown): boolean {
  return (
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWTExpired ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JOSEAlgNotAllowed ||
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys ||
    error instanceof joseErrors.JOSENotSupported
  );
}

/**
 * Logs an infrastructure failure (JWKS/Graph endpoint unreachable, timed
 * out, returned a non-2xx status, or sent a body we could not parse) so an
 * operator can tell "the provider is down" apart from "someone is sending
 * forged tokens" — both otherwise collapse to the same `null` return.
 *
 * Never pass the token or an email address into `error` — only short,
 * fixed messages (a status code, a timeout, a network error name) belong
 * here. This is deliberately `console.error` (loud): infrastructure
 * failures are rare and actionable, unlike token rejections.
 */
export function logProviderInfraFailure(provider: SocialProvider, error: unknown): void {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[auth] ${provider} token verification hit an infrastructure problem: ${reason}`);
}

export interface VerifiedIdentity {
  providerUid: string;
  /** Verified address, or null when the provider gave none we can trust. */
  email: string | null;
}

export type SocialProvider = 'google' | 'apple' | 'facebook';

const SOCIAL_PROVIDERS: readonly SocialProvider[] = ['google', 'apple', 'facebook'];

export function isSocialProvider(value: unknown): value is SocialProvider {
  return typeof value === 'string' && (SOCIAL_PROVIDERS as readonly string[]).includes(value);
}

export async function verifySocialToken(
  provider: SocialProvider,
  token: string,
): Promise<VerifiedIdentity | null> {
  switch (provider) {
    case 'google':
      return verifyGoogleToken(token);
    case 'apple':
      return verifyAppleToken(token);
    case 'facebook':
      return verifyFacebookToken(token);
    default:
      return null;
  }
}
