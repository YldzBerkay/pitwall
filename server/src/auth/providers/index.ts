/**
 * Third-party sign-in token verification.
 *
 * The mobile app obtains a token from Google / Apple / Facebook and sends it
 * to us. We must prove it is genuine AND issued for our app before trusting
 * the identity inside it, then mint our own session JWT (see ../jwt.ts) and
 * discard the provider token.
 */
import { verifyGoogleToken } from './google.ts';
import { verifyAppleToken } from './apple.ts';
import { verifyFacebookToken } from './facebook.ts';

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
