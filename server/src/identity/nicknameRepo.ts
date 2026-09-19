/**
 * Race-free nickname allocation. Spec §2.2.
 *
 * Strategy, in order:
 *   1. Up to RANDOM_ATTEMPTS optimistic inserts with a random tag. The unique
 *      index on (nickname_base, nickname_tag) is the arbiter — ON CONFLICT DO
 *      NOTHING means a lost race costs one retry, never a duplicate.
 *   2. If those all collide AND the tag width is small enough to scan safely
 *      (see SCAN_MAX_WIDTH below), scan the base's taken tags and pick a free
 *      one at random from what remains (still via ON CONFLICT, so a
 *      concurrent writer taking it mid-scan just costs another loop).
 *   3. If the whole width is taken (or too wide to scan), widen the tag by
 *      one digit and start over.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.ts';
import { DEFAULT_TAG_WIDTH, randomTag, tagCeiling, validateBase } from './nickname.ts';

const RANDOM_ATTEMPTS = 8;
const DEFAULT_MAX_WIDTH = 8;

/**
 * The exhaustive "scan every taken tag, compute the complement" fallback is
 * O(10^width) in both time and memory (it materialises every possible tag at
 * that width to diff against the taken set). Measured on this machine:
 *
 *   width 5 (10^5 candidates):   ~3.3ms,  ~4.5MB heap
 *   width 6 (10^6 candidates): ~46-58ms,   ~46MB heap
 *   width 7 (10^7 candidates):   ~526ms,  ~421MB heap
 *   width 8 (10^8 candidates): extrapolates to multi-second, multi-GB —
 *     enough to blow past default Node heap limits and stall the event loop
 *     for seconds, unacceptable on a server holding live race WebSockets.
 *
 * width 6 is already 10-20x slower and 10x heavier than width 5 for a step
 * that is synchronous and event-loop-blocking, and it fires precisely when
 * contention is highest — the worst possible moment to hold up every other
 * connection. So the scan is only safe up to width 5. Above that we skip
 * straight to widening if the random attempts don't find a free slot. That's
 * fine in practice: a base has to be nearly full at width 5 — on the order
 * of 100,000 accounts sharing one base name — before the scan would even run,
 * which is already an implausible amount of contention for a single base;
 * beyond that, the random attempts plus widening to a wider tag are enough.
 */
const SCAN_MAX_WIDTH = 5;

export class NicknameSpaceExhaustedError extends Error {
  constructor(base: string, maxWidth: number) {
    super(`nickname space exhausted for base "${base}" at width ${maxWidth}`);
    this.name = 'NicknameSpaceExhaustedError';
  }
}

export interface AllocatedNickname {
  userId: string;
  base: string;
  tag: string;
}

export interface AllocateOptions {
  /** Starting tag width. Defaults to 4. */
  width?: number;
  /** Widening stops here. Defaults to 8. */
  maxWidth?: number;
  /** Reuse an open transaction instead of the pool. */
  client?: PoolClient;
}

const INSERT_SQL = `
  insert into users (nickname_base, nickname_tag)
  values ($1, $2)
  on conflict (nickname_base, nickname_tag) do nothing
  returning id
`;

/**
 * ⚠️ ORPHAN-ROW HAZARD — read before calling this without `options.client`.
 *
 * Called without `options.client` (the default), this function commits the
 * `users` row to the pool immediately and independently of anything the
 * caller does next. If you are wiring up real account creation, the
 * following `auth_identities` insert is a SEPARATE statement — and if it
 * fails (crash, validation error, network fault) after this one has already
 * committed, the `users` row it created is stranded: no auth identity, and
 * nothing links it back to report or clean up. `auth_identities` cascades
 * from `users`, not the other way round, so nothing deletes it for you.
 *
 * The `client` escape hatch exists exactly for this: pass an open
 * `PoolClient` (e.g. from `withTransaction`) that is ALSO used for the
 * `auth_identities` insert, so both succeed or both roll back together.
 *
 * Any caller creating a real account MUST pass `options.client` from a
 * transaction shared with the `auth_identities` insert. Only skip it when a
 * stranded `users` row with no identity attached would be harmless (e.g.
 * throwaway/test data, or a flow with no `auth_identities` insert at all).
 */
export async function allocateNickname(
  base: string,
  options: AllocateOptions = {},
): Promise<AllocatedNickname> {
  const verdict = validateBase(base);
  if (verdict !== 'ok') throw new Error(`invalid nickname base: ${verdict}`);

  const executor = options.client ?? getPool();
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  let width = options.width ?? DEFAULT_TAG_WIDTH;

  const tryInsert = async (tag: string): Promise<string | null> => {
    const res = await executor.query<{ id: string }>(INSERT_SQL, [base, tag]);
    return res.rows[0]?.id ?? null;
  };

  while (width <= maxWidth) {
    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
      const tag = randomTag(width);
      const id = await tryInsert(tag);
      if (id) return { userId: id, base, tag };
    }

    // Yoğun taban: kalan boş haneleri tara — ama yalnızca bu taramanın
    // ucuz kaldığı genişliklerde (bkz. SCAN_MAX_WIDTH yorumu).
    if (width <= SCAN_MAX_WIDTH) {
      const taken = new Set(
        (await executor.query<{ nickname_tag: string }>(
          'select nickname_tag from users where nickname_base = $1 and length(nickname_tag) = $2',
          [base, width],
        )).rows.map((r) => r.nickname_tag),
      );

      const free: string[] = [];
      for (let n = 1; n <= tagCeiling(width); n += 1) {
        const tag = String(n).padStart(width, '0');
        if (!taken.has(tag)) free.push(tag);
      }

      // Boşları karıştırıp sırayla dene — eşzamanlı yazıcı birini kapsa sıradakine geçer.
      for (let i = free.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [free[i], free[j]] = [free[j], free[i]];
      }
      for (const tag of free) {
        const id = await tryInsert(tag);
        if (id) return { userId: id, base, tag };
      }
    }

    width += 1;
  }

  throw new NicknameSpaceExhaustedError(base, maxWidth);
}
