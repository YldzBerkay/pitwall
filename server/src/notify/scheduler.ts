/**
 * `pending_jobs` notification sweep — push a "your job finished" alert once
 * a job's `ends_at` has passed.
 *
 * Spec: docs/superpowers/specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md §11
 *
 * THE RULE THIS MODULE EXISTS TO KEEP: the only column this module ever
 * writes is `pending_jobs.notified_at`. It never touches `lobby_economy`,
 * `users.gold`, or `claimed_at` — those are the claim model's business
 * (`economy/jobs.ts`), and a finished-but-unclaimed job is deliberately left
 * unapplied until the player claims it. Because this sweep has nothing to
 * apply, running it twice, or on two servers at once, cannot corrupt
 * anything the economy cares about. The worst it can do is send a duplicate
 * push — and `for update skip locked` (below) prevents even that.
 *
 * `now` is ALWAYS passed in by the caller, exactly like `economy/jobs.ts`:
 * this module must never read the clock itself, so a test can pass a fixed
 * instant and two servers agree on what "ready" means only via the value
 * they were each given.
 *
 * This module is NOT wired to a timer or to `src/index.ts` — scheduling it
 * (a `setInterval`, a cron worker, whatever) is a later decision. This file
 * only builds the sweep and it is safe to call from anywhere, any number of
 * times, concurrently.
 */
import { query, withTransaction } from '../db/pool.ts';
import type { JobKind } from '../economy/jobs.ts';

export interface JobNotification {
  jobId: string;
  lobbyId: string;
  teamKey: string;
  kind: JobKind;
  /** The human owner of the seat. AI seats never reach `send` — see below. */
  userId: string;
}

export interface SweepReadyJobsInput {
  now: Date;
  /**
   * Delivers one notification. May be sync or async, and MAY THROW (e.g. the
   * push provider is down). A throw is exactly how a caller tells this sweep
   * "this one didn't go out" — see the retry contract below.
   */
  send: (job: JobNotification) => void | Promise<void>;
  /** Caps how many candidate jobs one call inspects. Defaults to 50. */
  limit?: number;
}

const DEFAULT_LIMIT = 50;

interface CandidateRow {
  id: string;
}

interface LockedJobRow {
  id: string;
  lobby_id: string;
  team_key: string;
  kind: JobKind;
  user_id: string | null;
}

/**
 * Sweeps for jobs whose `ends_at` has passed, unclaimed and not yet
 * notified, and calls `send` once per job. Returns how many jobs were
 * successfully notified and stamped.
 *
 * Two-phase, so the expensive/unbounded part never holds a lock:
 *
 *  1. An un-locking `select` gets a candidate id list (bounded by `limit`).
 *     Two concurrent sweeps may both see the same candidate here — that's
 *     fine, phase 2 is what actually serialises them.
 *  2. Each candidate is handled in its OWN transaction that re-selects that
 *     one row `for update skip locked`. If another sweep already holds the
 *     row's lock (or already notified/claimed it since phase 1), this
 *     returns nothing and we move on without sending anything — this is the
 *     mechanism that caps duplicate pushes at (at most) one per job even
 *     under two sweeps racing on two servers.
 *
 * `send` runs INSIDE that per-job transaction, before the `update ...
 * notified_at` statement, and the whole thing rolls back on any throw. That
 * ordering is what the retry contract depends on: if `send` throws, the
 * transaction (row lock included) rolls back, `notified_at` is never
 * written, and the row is exactly as eligible for a later sweep as it was
 * before this one ran. Stamping `notified_at` before calling `send` would
 * break this — a failed push would still "count" as delivered and never
 * retry. Do not reorder those two statements.
 *
 * One job's `send` throwing does not abort the rest of the sweep: the error
 * is caught per-job so a single flaky push does not stop other ready jobs
 * in the same batch from being notified.
 */
export async function sweepReadyJobs(input: SweepReadyJobsInput): Promise<number> {
  const { now, send, limit = DEFAULT_LIMIT } = input;

  const candidates = await query<CandidateRow>(
    `select id from pending_jobs
     where claimed_at is null and notified_at is null and ends_at <= $1
     order by ends_at asc
     limit $2`,
    [now, limit],
  );

  let processed = 0;
  for (const { id } of candidates.rows) {
    if (await processOneJob(id, now, send)) processed++;
  }
  return processed;
}

async function processOneJob(
  jobId: string, now: Date, send: SweepReadyJobsInput['send'],
): Promise<boolean> {
  try {
    return await withTransaction(async (client) => {
      // `for update of pj skip locked`: if another sweep already has this
      // row locked (racing sweep, or a concurrent claim), we get back no
      // rows instead of blocking — that is what stops two sweeps from both
      // sending for the same job. The `where` re-checks readiness/claimed/
      // notified against the CURRENT row, not the phase-1 snapshot, in case
      // something changed between the two selects.
      const res = await client.query<LockedJobRow>(
        `select pj.id, pj.lobby_id, pj.team_key, pj.kind, ls.user_id
         from pending_jobs pj
         join lobby_seats ls on ls.lobby_id = pj.lobby_id and ls.team_key = pj.team_key
         where pj.id = $1
           and pj.claimed_at is null and pj.notified_at is null and pj.ends_at <= $2
         for update of pj skip locked`,
        [jobId, now],
      );
      const job = res.rows[0];
      if (!job) return false;

      // AI seats (no user_id) have no one to push to. We still stamp below
      // so the job is not re-examined by every future sweep forever.
      if (job.user_id) {
        await send({
          jobId: job.id, lobbyId: job.lobby_id, teamKey: job.team_key,
          kind: job.kind, userId: job.user_id,
        });
      }

      // Only ever this column. Never `lobby_economy`, `users.gold`, or
      // `claimed_at` — see the module docblock.
      await client.query(`update pending_jobs set notified_at = $2 where id = $1`, [job.id, now]);
      return true;
    });
  } catch (err) {
    // `send` threw (or the transaction otherwise failed): the transaction
    // rolled back, so `notified_at` was never written — this job is exactly
    // as eligible for a later sweep as before. Swallow here so one bad push
    // doesn't stop the rest of this batch from being notified.
    console.error(`notify scheduler: job ${jobId} failed, will retry on a later sweep:`, err);
    return false;
  }
}
