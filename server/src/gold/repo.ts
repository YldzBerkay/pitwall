/**
 * Data-access layer for account-level Altın (gold): `gold_grants`,
 * `users.gold`, and `daily_caps`. Spec §11.
 *
 * Two design rules the code below exists to honour:
 *
 * 1. The DATABASE deduplicates gold, not the application. The same AdMob
 *    callback or store receipt must never grant gold twice, and that
 *    guarantee comes from the `gold_grants_unique` constraint on
 *    (source, external_id) — not from a "check first, then insert" in this
 *    file, which would still race under concurrent callbacks. `grantGold`
 *    always attempts the insert and turns a unique-violation (23505) into a
 *    `{ok:false, reason:'duplicate'}` result. `source` is part of the key on
 *    purpose: the ad and store identifier spaces are independent, so the
 *    same external id under a different source is a separate, legitimate
 *    grant.
 *
 * 2. Daily caps count in the SERVER's UTC day, not the caller's local day —
 *    a client that changes its device calendar must not be able to reset
 *    its cap. `capsFor`/`bumpAdsWatched`/`bumpGoldConverted` all derive the
 *    day from the passed instant via `(at at time zone 'UTC')::date`,
 *    never from `at::date` (which would use the session's timezone).
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.ts';

export type GoldSource = 'ad' | 'iap';

export interface GrantGoldInput {
  userId: string;
  source: GoldSource;
  externalId: string;
  gold: number;
}

export type GrantGoldResult =
  | { ok: true; gold: number }
  | { ok: false; reason: 'duplicate' };

export interface Caps {
  adsWatched: number;
  goldConverted: number;
}

function assertPositiveInteger(gold: number): void {
  if (!Number.isInteger(gold) || gold <= 0) {
    throw new Error(`gold must be a positive integer, got ${gold}`);
  }
}

/**
 * Inserts the ledger row and credits `users.gold` in a single transaction.
 * Relies on the database's `gold_grants_unique` constraint for dedup — see
 * the module docblock. Throws on a non-positive or fractional amount rather
 * than silently writing e.g. `gold - (-5)`, which would mint free gold.
 */
export async function grantGold(input: GrantGoldInput): Promise<GrantGoldResult> {
  const { userId, source, externalId, gold } = input;
  assertPositiveInteger(gold);

  try {
    return await withTransaction(async (client) => {
      await client.query(
        `insert into gold_grants (user_id, source, external_id, gold)
         values ($1, $2, $3, $4)`,
        [userId, source, externalId, gold],
      );
      const res = await client.query<{ gold: number }>(
        `update users set gold = gold + $2 where id = $1 returning gold`,
        [userId, gold],
      );
      return { ok: true, gold: res.rows[0].gold };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: 'duplicate' };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Conditional UPDATE (`where gold >= amount`), never read-then-write — this
 * is what makes two concurrent spends against the same balance unable to
 * both succeed. Zero is a no-op that always reports success.
 */
export async function spendGold(client: PoolClient, userId: string, amount: number): Promise<boolean> {
  if (amount === 0) return true;
  const res = await client.query(
    `update users set gold = gold - $2 where id = $1 and gold >= $2`,
    [userId, amount],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function goldOf(userId: string): Promise<number> {
  const res = await query<{ gold: number }>('select gold from users where id = $1', [userId]);
  return res.rows[0]?.gold ?? 0;
}

/** Resolves `at` to the SERVER's UTC day and reports that day's caps, zeroed when no row exists. */
export async function capsFor(userId: string, at: Date): Promise<Caps> {
  const res = await query<{ ads_watched: number; gold_converted: number }>(
    `select ads_watched, gold_converted
       from daily_caps
      where user_id = $1
        and day = ($2::timestamptz at time zone 'UTC')::date`,
    [userId, at],
  );
  const row = res.rows[0];
  return {
    adsWatched: row?.ads_watched ?? 0,
    goldConverted: row?.gold_converted ?? 0,
  };
}

export async function bumpAdsWatched(userId: string, at: Date, by = 1): Promise<void> {
  await query(
    `insert into daily_caps (user_id, day, ads_watched)
       values ($1, ($2::timestamptz at time zone 'UTC')::date, $3)
     on conflict (user_id, day)
       do update set ads_watched = daily_caps.ads_watched + excluded.ads_watched`,
    [userId, at, by],
  );
}

export async function bumpGoldConverted(userId: string, at: Date, by: number): Promise<void> {
  await query(
    `insert into daily_caps (user_id, day, gold_converted)
       values ($1, ($2::timestamptz at time zone 'UTC')::date, $3)
     on conflict (user_id, day)
       do update set gold_converted = daily_caps.gold_converted + excluded.gold_converted`,
    [userId, at, by],
  );
}
