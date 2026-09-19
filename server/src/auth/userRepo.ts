/**
 * Data-access layer for accounts: the SQL behind `users` and
 * `auth_identities`. Spec §2, §6.
 *
 * Four sign-in methods exist (Google, Apple, Facebook, email+password). A
 * single person may use more than one; they are linked into ONE account by
 * a peppered hash of their verified email. Raw email addresses and
 * plaintext passwords are NEVER handled here — only hashes come in, and
 * only hashes go out.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.ts';
import { allocateNickname } from '../identity/nicknameRepo.ts';
import { isRegion, type Region } from '../identity/region.ts';

export type Provider = 'google' | 'apple' | 'facebook' | 'password';

export interface User {
  id: string;
  createdAt: Date;
  gold: number;
  rankPoints: number;
  countryCode: string | null;
  region: Region | null;
  nicknameBase: string;
  nicknameTag: string;
}

export interface IdentityInput {
  provider: Provider;
  providerUid: string;
  /** Peppered hash of the verified email, or null when the provider gave none. */
  emailHash: string | null;
  /** Only set (and only allowed) for provider === 'password'. */
  passwordHash?: string | null;
}

export interface CreateUserInput extends IdentityInput {
  /** Nickname base to allocate a tag under — see nicknameRepo. */
  base: string;
  countryCode?: string | null;
  region?: Region | null;
}

interface UserRow {
  id: string;
  created_at: Date;
  gold: number;
  rank_points: number;
  country_code: string | null;
  region: string | null;
  nickname_base: string;
  nickname_tag: string;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    createdAt: row.created_at,
    gold: row.gold,
    rankPoints: row.rank_points,
    countryCode: row.country_code,
    // The DB CHECK constraint already limits this column to the known
    // buckets or null, so `isRegion` here is just a type-narrowing guard,
    // not a runtime gate — a value that fails it can only mean the schema
    // and this code have drifted apart.
    region: row.region !== null && isRegion(row.region) ? row.region : null,
    nicknameBase: row.nickname_base,
    nicknameTag: row.nickname_tag,
  };
}

const SELECT_USER_SQL = `
  select id, created_at, gold, rank_points, country_code, region, nickname_base, nickname_tag
  from users
  where id = $1
`;

async function selectUser(userId: string, client?: PoolClient): Promise<User | null> {
  const res = client
    ? await client.query<UserRow>(SELECT_USER_SQL, [userId])
    : await query<UserRow>(SELECT_USER_SQL, [userId]);
  return res.rows[0] ? mapUser(res.rows[0]) : null;
}

const INSERT_IDENTITY_SQL = `
  insert into auth_identities (user_id, provider, provider_uid, email_hash, password_hash)
  values ($1, $2, $3, $4, $5)
`;

async function insertIdentity(
  userId: string,
  identity: IdentityInput,
  client: PoolClient,
): Promise<void> {
  await client.query(INSERT_IDENTITY_SQL, [
    userId,
    identity.provider,
    identity.providerUid,
    identity.emailHash,
    identity.passwordHash ?? null,
  ]);
}

/**
 * Creates a brand-new user together with its first auth identity, as ONE
 * atomic transaction.
 *
 * ⚠️ This is the only correct way to create an account. `allocateNickname`
 * commits the `users` row on its own the instant it returns UNLESS it is
 * given this transaction's client — so the nickname allocation and the
 * `auth_identities` insert MUST share one `withTransaction` client. If the
 * identity insert then fails (e.g. a duplicate `(provider, provider_uid)`),
 * the whole transaction — nickname allocation included — rolls back, and no
 * stranded `users` row is left behind. Do not "simplify" this by calling
 * `allocateNickname` outside the transaction.
 */
export async function createUserWithIdentity(input: CreateUserInput): Promise<User> {
  return withTransaction(async (client) => {
    const { userId } = await allocateNickname(input.base, { client });

    await insertIdentity(userId, input, client);

    if (input.countryCode !== undefined || input.region !== undefined) {
      await applyProfileUpdate(client, userId, {
        countryCode: input.countryCode,
        region: input.region,
      });
    }

    const user = await selectUser(userId, client);
    /* c8 ignore next 3 -- the row we just inserted in this same transaction */
    if (!user) {
      throw new Error(`createUserWithIdentity: freshly created user ${userId} vanished`);
    }
    return user;
  });
}

/** Links an additional sign-in method to an existing user. */
export async function addIdentity(userId: string, identity: IdentityInput): Promise<void> {
  await query(INSERT_IDENTITY_SQL, [
    userId,
    identity.provider,
    identity.providerUid,
    identity.emailHash,
    identity.passwordHash ?? null,
  ]);
}

/** Postgres error code for a malformed literal of the target type (e.g. `uuid`). */
const INVALID_TEXT_REPRESENTATION = '22P02';

function isInvalidUuidError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === INVALID_TEXT_REPRESENTATION
  );
}

export async function findUserByProviderUid(
  provider: Provider,
  providerUid: string,
): Promise<User | null> {
  const res = await query<UserRow>(
    `
      select u.id, u.created_at, u.gold, u.rank_points, u.country_code, u.region,
             u.nickname_base, u.nickname_tag
      from auth_identities a
      join users u on u.id = a.user_id
      where a.provider = $1 and a.provider_uid = $2
    `,
    [provider, providerUid],
  );
  return res.rows[0] ? mapUser(res.rows[0]) : null;
}

/**
 * Finds the user linked to a verified-email hash, for cross-provider
 * account linking. Two identities can legitimately share an `email_hash`
 * (the same person signing in with Google and later with Facebook using the
 * same address) — when that happens we want the account that existed
 * FIRST, so a later sign-in links onto the original account rather than
 * whichever row Postgres happens to return first.
 *
 * Ordering by `created_at` alone is not deterministic when two identities
 * are inserted in the very same transaction (they can share an identical
 * `now()` timestamp): `addIdentity`/`createUserWithIdentity` never insert
 * two DIFFERENT users' identities in one transaction, so in practice a tie
 * only happens between a user's own identities, all pointing at the same
 * `user_id` — the ORDER BY tie is broken by `user_id` only to make the
 * query itself deterministic; it never changes which user is returned.
 */
export async function findUserByEmailHash(emailHash: string): Promise<User | null> {
  const res = await query<UserRow>(
    `
      select u.id, u.created_at, u.gold, u.rank_points, u.country_code, u.region,
             u.nickname_base, u.nickname_tag
      from auth_identities a
      join users u on u.id = a.user_id
      where a.email_hash = $1
      order by a.created_at asc, a.user_id asc
      limit 1
    `,
    [emailHash],
  );
  return res.rows[0] ? mapUser(res.rows[0]) : null;
}

/** Looks up the password hash for the `password` provider by email hash. */
export async function findPasswordHash(
  emailHash: string,
): Promise<{ userId: string; hash: string } | null> {
  const res = await query<{ user_id: string; password_hash: string }>(
    `
      select user_id, password_hash
      from auth_identities
      where provider = 'password' and email_hash = $1
    `,
    [emailHash],
  );
  const row = res.rows[0];
  return row ? { userId: row.user_id, hash: row.password_hash } : null;
}

/**
 * Loads a user by id.
 *
 * A route handler typically calls this with an id taken straight from a
 * JWT — untrusted input that could be malformed (truncated, tampered,
 * stale format). A malformed `uuid` literal makes Postgres raise `22P02
 * invalid input syntax for type uuid`, which we deliberately treat the same
 * as "no such user" (return null) rather than letting a raw database error
 * escape: to the caller, "the id doesn't parse" and "the id parses but
 * doesn't exist" both mean the same thing — reject the request as
 * unauthenticated/not-found. Any OTHER database error still propagates.
 */
export async function loadUser(userId: string): Promise<User | null> {
  try {
    return await selectUser(userId);
  } catch (err) {
    if (isInvalidUuidError(err)) return null;
    throw err;
  }
}

export interface ProfileUpdate {
  countryCode?: string | null;
  region?: Region | null;
}

async function applyProfileUpdate(
  client: PoolClient,
  userId: string,
  update: ProfileUpdate,
): Promise<void> {
  // `coalesce($n, column)` treats an explicit `null` as "leave alone", not
  // "clear the field" — a field can only be SET here, never CLEARED, once a
  // caller has given it a value. That is a deliberate limitation of this
  // partial-update shape (distinguishing "omitted" from "clear to null"
  // would need a sentinel or a separate per-field flag); if a future
  // feature needs to let a player clear their country or region, this
  // function needs a real "unset" signal, not `undefined`/`null` alone. No
  // caller in this codebase currently needs to clear either field, so it is
  // left as-is rather than adding a mechanism nothing yet uses.
  await client.query(
    `
      update users
      set country_code = coalesce($2, country_code),
          region        = coalesce($3, region)
      where id = $1
    `,
    [userId, update.countryCode ?? null, update.region ?? null],
  );
}

/**
 * Partially updates the profile fields that were actually supplied —
 * omitting a key leaves that column untouched. See `applyProfileUpdate`'s
 * doc comment for why an explicit `null` cannot be used to CLEAR a field.
 */
export async function updateProfile(
  userId: string,
  update: ProfileUpdate,
): Promise<User | null> {
  await withTransaction(async (client) => {
    await applyProfileUpdate(client, userId, update);
  });
  return selectUser(userId);
}
