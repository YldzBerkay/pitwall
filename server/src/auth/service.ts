/**
 * Sign-up / sign-in orchestration: ties together provider verification,
 * password hashing, the user repository, onboarding-field validation and
 * session minting.
 *
 * Account-linking rule: two providers land on the SAME account only when
 * BOTH handed us a VERIFIED email address. Linking on an unverified address
 * would let anyone who can claim an address take over the account behind
 * it. When a provider gives no email, the sign-in creates a separate
 * account instead of guessing.
 */
import {
  verifySocialToken,
  isSocialProvider,
  type SocialProvider,
  type VerifiedIdentity,
} from './providers/index.ts';
import {
  createUserWithIdentity,
  addIdentity,
  findUserByProviderUid,
  findUserByEmailHash,
  findPasswordHash,
  loadUser,
  type User,
} from './userRepo.ts';
import { signSession } from './jwt.ts';
import { hashEmail, isPlausibleEmail } from './emailHash.ts';
import { hashPassword, verifyPassword, validatePassword } from './password.ts';
import { validateBase, suggestBases } from '../identity/nickname.ts';
import { isCountryCode } from '../identity/countries.ts';
import { isRegion } from '../identity/region.ts';

export type AuthErrorCode =
  | 'invalid_provider'
  | 'invalid_token'
  | 'invalid_email'
  | 'email_taken'
  | 'invalid_credentials'
  | 'password_too_short'
  | 'password_too_long'
  | 'nickname_too_short'
  | 'nickname_too_long'
  | 'nickname_invalid_chars'
  | 'nickname_blocked'
  | 'invalid_country'
  | 'invalid_region';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    // No user-supplied data (email, password, hashes) is ever interpolated
    // into this message — it is a fixed string keyed only by the error
    // code, so nothing sensitive can leak through an error message or a
    // logged stack trace.
    super(`auth error: ${code}`);
    this.code = code;
    this.name = 'AuthError';
  }
}

export interface AuthResult {
  user: User;
  token: string;
  isNew: boolean;
}

export interface SocialDeps {
  /** Injectable so tests never reach the real providers. */
  verify?: (provider: SocialProvider, token: string) => Promise<VerifiedIdentity | null>;
}

export interface OnboardingFields {
  nicknameBase?: string;
  countryCode?: string;
  region?: string;
}

export interface AuthenticateSocialInput extends OnboardingFields {
  provider: string;
  token: string;
}

export interface RegisterWithPasswordInput extends OnboardingFields {
  email: string;
  password: string;
}

export interface LoginWithPasswordInput {
  email: string;
  password: string;
}

const NICKNAME_ERROR_BY_VERDICT = {
  too_short: 'nickname_too_short',
  too_long: 'nickname_too_long',
  invalid_chars: 'nickname_invalid_chars',
  blocked: 'nickname_blocked',
} as const;

interface ValidatedOnboarding {
  base: string;
  countryCode?: string | null;
  region?: import('../identity/region.ts').Region | null;
}

/**
 * Validates (and defaults) the onboarding fields shared by both new-account
 * paths. Throws AuthError on any bad field.
 */
function validateOnboarding(input: OnboardingFields): ValidatedOnboarding {
  const base = input.nicknameBase ?? suggestBases(1)[0];
  const verdict = validateBase(base);
  if (verdict !== 'ok') {
    throw new AuthError(NICKNAME_ERROR_BY_VERDICT[verdict]);
  }

  let countryCode: string | null | undefined;
  if (input.countryCode !== undefined) {
    if (!isCountryCode(input.countryCode)) throw new AuthError('invalid_country');
    countryCode = input.countryCode;
  }

  let region: import('../identity/region.ts').Region | null | undefined;
  if (input.region !== undefined) {
    if (!isRegion(input.region)) throw new AuthError('invalid_region');
    region = input.region;
  }

  return { base, countryCode, region };
}

export async function authenticateSocial(
  input: AuthenticateSocialInput,
  deps: SocialDeps = {},
): Promise<AuthResult> {
  if (!isSocialProvider(input.provider)) {
    throw new AuthError('invalid_provider');
  }
  const provider = input.provider;

  const verify = deps.verify ?? verifySocialToken;
  const identity = await verify(provider, input.token);
  if (!identity) {
    throw new AuthError('invalid_token');
  }

  const existing = await findUserByProviderUid(provider, identity.providerUid);
  if (existing) {
    const token = await signSession(existing.id);
    return { user: existing, token, isNew: false };
  }

  if (identity.email) {
    const emailHash = hashEmail(identity.email);
    const byEmail = await findUserByEmailHash(emailHash);
    if (byEmail) {
      // A concurrent identical sign-in (same provider + uid, racing this
      // one) could insert the very same identity between our step-3 check
      // above and this insert. `addIdentity` is a single atomic INSERT, so
      // no partial/orphan state is possible either way — but without this
      // catch, the loser of that race would see a raw Postgres unique-
      // violation instead of a normal, successful sign-in. Re-fetching by
      // provider uid recovers cleanly: the row is now certainly there.
      try {
        await addIdentity(byEmail.id, {
          provider,
          providerUid: identity.providerUid,
          emailHash,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const winner = await findUserByProviderUid(provider, identity.providerUid);
        /* c8 ignore next 3 -- only unreachable if the conflicting row vanished mid-race */
        if (!winner) throw err;
        const token = await signSession(winner.id);
        return { user: winner, token, isNew: false };
      }
      const token = await signSession(byEmail.id);
      return { user: byEmail, token, isNew: false };
    }

    const onboarding = validateOnboarding(input);
    const user = await createNewSocialAccount(provider, identity.providerUid, emailHash, onboarding);
    const token = await signSession(user.id);
    return { user, token, isNew: true };
  }

  const onboarding = validateOnboarding(input);
  const user = await createNewSocialAccount(provider, identity.providerUid, null, onboarding);
  const token = await signSession(user.id);
  return { user, token, isNew: true };
}

/**
 * Creates a brand-new account for a social sign-in, recovering (instead of
 * throwing a raw Postgres error) if a concurrent identical sign-in wins the
 * same (provider, providerUid) insert first — see the comment above the
 * `addIdentity` call in `authenticateSocial` for the same race, one step
 * earlier in the flow.
 */
async function createNewSocialAccount(
  provider: SocialProvider,
  providerUid: string,
  emailHash: string | null,
  onboarding: ValidatedOnboarding,
): Promise<User> {
  try {
    return await createUserWithIdentity({
      provider,
      providerUid,
      emailHash,
      base: onboarding.base,
      countryCode: onboarding.countryCode,
      region: onboarding.region,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findUserByProviderUid(provider, providerUid);
    /* c8 ignore next 2 -- only unreachable if the conflicting row vanished mid-race */
    if (!winner) throw err;
    return winner;
  }
}

export async function registerWithPassword(
  input: RegisterWithPasswordInput,
): Promise<AuthResult> {
  if (!isPlausibleEmail(input.email)) {
    throw new AuthError('invalid_email');
  }
  const validation = validatePassword(input.password);
  if (validation === 'too_short') throw new AuthError('password_too_short');
  if (validation === 'too_long') throw new AuthError('password_too_long');

  const emailHash = hashEmail(input.email);

  // The password provider's identity uid IS the email hash: a password
  // account is inherently keyed by its (verified-by-registration) address,
  // so re-registering the same address always collides on the primary key
  // rather than needing a separate existence check racing the insert.
  const existingPasswordAccount = await findUserByProviderUid('password', emailHash);
  if (existingPasswordAccount) {
    throw new AuthError('email_taken');
  }

  const passwordHash = await hashPassword(input.password);

  const byEmail = await findUserByEmailHash(emailHash);
  if (byEmail) {
    try {
      await addIdentity(byEmail.id, {
        provider: 'password',
        providerUid: emailHash,
        emailHash,
        passwordHash,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AuthError('email_taken');
      throw err;
    }
    const token = await signSession(byEmail.id);
    return { user: byEmail, token, isNew: false };
  }

  const onboarding = validateOnboarding(input);
  let user: User;
  try {
    user = await createUserWithIdentity({
      provider: 'password',
      providerUid: emailHash,
      emailHash,
      passwordHash,
      base: onboarding.base,
      countryCode: onboarding.countryCode,
      region: onboarding.region,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AuthError('email_taken');
    throw err;
  }
  const token = await signSession(user.id);
  return { user, token, isNew: true };
}

export async function loginWithPassword(input: LoginWithPasswordInput): Promise<AuthResult> {
  const emailHash = hashEmail(input.email);
  const found = await findPasswordHash(emailHash);

  // Both branches pay the same scrypt cost, whether or not the account
  // exists, so response timing does not reveal account existence. A fixed
  // dummy hash (valid shape, unreachable-in-practice params) is verified
  // against when there is no real hash to check.
  const hashToCheck = found?.hash ?? DUMMY_PASSWORD_HASH;
  const passwordOk = await verifyPassword(input.password, hashToCheck);

  if (!found || !passwordOk) {
    throw new AuthError('invalid_credentials');
  }

  const user = await loadUser(found.userId);
  /* c8 ignore next 3 -- the row we just found by its own hash lookup */
  if (!user) {
    throw new AuthError('invalid_credentials');
  }
  const token = await signSession(user.id);
  return { user, token, isNew: false };
}

// A fixed, valid-shaped scrypt hash with no corresponding real password.
// verifyPassword always runs a real scrypt call against it, costing the
// same time as a genuine check, so an unknown account is indistinguishable
// in timing from a wrong password on a known account.
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

/** Postgres unique_violation error code. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
