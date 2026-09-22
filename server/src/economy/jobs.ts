/**
 * `pending_jobs` — car upgrades, driver training, spy missions.
 *
 * Spec: docs/superpowers/specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md §11
 *
 * The whole point of this module: `ends_at` passing writes NOTHING. It is
 * only a threshold. The only thing that mutates the economy is the
 * player's explicit CLAIM, and `claimed_at` makes that claim idempotent — a
 * repeat costs nothing and changes nothing. A separate notifier (a later
 * task) stamps `notified_at` and never touches the economy, which is
 * exactly what lets it run twice, or on two servers, without a lock.
 *
 * There is a second reason for the claim model beyond safety: the game
 * deliberately does NOT auto-apply a finished upgrade. A finished-but-
 * unclaimed upgrade still enters the next race, but the car starts from the
 * pit lane — the real Formula 1 penalty for working on a car under parc
 * fermé (Phase 3a-2's job). This module only has to make sure a finished
 * job stays unapplied until claimed, which is what makes that mechanic
 * possible.
 *
 * `now` is ALWAYS passed in by the caller. This module must never read the
 * clock itself (`Date.now()` / `new Date()`) — a test can then pass a fixed
 * instant, and the client's clock is never consulted for anything.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.ts';
import { loadTeamEconomy, spendRp, bumpCarStat, bumpUpgradesDone, type CarStats } from './repo.ts';
import { spendGold } from '../gold/repo.ts';
import { skipCostGold } from '@pitwall/shared/economy';
import { factoryEffects } from '@pitwall/shared/factory';

export type JobKind = 'upgrade' | 'training' | 'spy';

export class JobError extends Error {}

const HOUR_MS = 3_600_000;

const JOB_DURATIONS_MS: Record<JobKind, number> = {
  upgrade: 22 * HOUR_MS,
  training: 6 * HOUR_MS,
  spy: 24 * HOUR_MS,
};

const UPGRADE_BASE_RP = 750;

/** Stat label -> which `car` field it raises. Unknown labels are `bad_payload`. */
const UPGRADE_STAT_FIELD: Record<string, keyof CarStats> = {
  motor: 'motor',
  aero: 'aero',
  grip: 'grip',
};

/** Base stat gain a claimed upgrade grants, before `factoryEffects().upgradeGainBonus`. */
const UPGRADE_BASE_GAIN = 1;

function assertKnownKind(kind: JobKind): void {
  if (kind !== 'upgrade' && kind !== 'training' && kind !== 'spy') {
    throw new JobError(`startJob: unknown job kind ${JSON.stringify(kind)}`);
  }
}

/**
 * Cost/duration ladder for a repeat upgrade of the same stat label: each
 * repeat costs and takes more, so a player cannot farm one stat cheaply
 * forever. `timesDone` is how many upgrades of this label are already
 * recorded (`lobby_economy.upgrades_done`).
 */
function upgradeRpCost(timesDone: number, costScale: number): number {
  return Math.round(UPGRADE_BASE_RP * 1.25 ** timesDone * costScale);
}

function upgradeDurationMs(timesDone: number, timeScale: number): number {
  return Math.round(JOB_DURATIONS_MS.upgrade * (1 + timesDone * 0.15) * timeScale);
}

export interface StartJobInput {
  lobbyId: string;
  teamKey: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  now: Date;
}

export type StartJobResult =
  | { ok: true; jobId: string; endsAt: Date; rpCost: number }
  | { ok: false; reason: 'already_running' | 'not_enough_rp' | 'no_economy' | 'bad_payload' };

/**
 * Starts a job. The RP charge (for upgrades) and the insert live in ONE
 * transaction: if the insert loses the `pending_jobs_open_idx` partial-index
 * race (another open job of the same kind already exists), the whole
 * transaction — including the RP spend — rolls back. A player must never be
 * charged for a start that did not happen.
 */
export async function startJob(input: StartJobInput): Promise<StartJobResult> {
  const { lobbyId, teamKey, kind, payload, now } = input;
  assertKnownKind(kind);

  const economy = await loadTeamEconomy(lobbyId, teamKey);
  if (!economy) return { ok: false, reason: 'no_economy' };

  const effects = factoryEffects(economy.factoryLevels);

  let rpCost = 0;
  let durationMs = JOB_DURATIONS_MS[kind];
  let storedPayload: Record<string, unknown> = payload;

  if (kind === 'upgrade') {
    const stat = payload?.['stat'];
    if (typeof stat !== 'string' || !(stat in UPGRADE_STAT_FIELD)) {
      return { ok: false, reason: 'bad_payload' };
    }
    const timesDone = economy.upgradesDone[stat] ?? 0;
    rpCost = upgradeRpCost(timesDone, effects.upgradeCostScale);
    durationMs = upgradeDurationMs(timesDone, effects.upgradeTimeScale);
    storedPayload = { stat };
  }

  const endsAt = new Date(now.getTime() + durationMs);

  try {
    return await withTransaction(async (client) => {
      if (rpCost > 0) {
        const spent = await spendRp(client, lobbyId, teamKey, rpCost);
        if (!spent) return { ok: false as const, reason: 'not_enough_rp' as const };
      }

      const res = await client.query<{ id: string }>(
        `insert into pending_jobs (lobby_id, team_key, kind, payload, started_at, ends_at)
         values ($1, $2, $3, $4::jsonb, $5, $6)
         returning id`,
        [lobbyId, teamKey, kind, JSON.stringify(storedPayload), now, endsAt],
      );
      return { ok: true as const, jobId: res.rows[0].id, endsAt, rpCost };
    });
  } catch (err) {
    if (isOpenJobConflict(err)) {
      return { ok: false, reason: 'already_running' };
    }
    throw err;
  }
}

function isOpenJobConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: string }).code === '23505'
    && (err as { constraint?: string }).constraint === 'pending_jobs_open_idx';
}

interface PendingJobRow {
  id: string;
  lobby_id: string;
  team_key: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  started_at: Date;
  ends_at: Date;
  claimed_at: Date | null;
  notified_at: Date | null;
}

export interface ClaimJobInput {
  lobbyId: string;
  teamKey: string;
  jobId: string;
  now: Date;
}

export type ClaimJobResult =
  | { ok: true; kind: JobKind; applied: Record<string, unknown> }
  | { ok: false; reason: 'not_found' | 'not_ready' | 'already_claimed' };

/**
 * Claims a job, applying its effect exactly once.
 *
 * The UPDATE's `where` carries BOTH `claimed_at is null` AND
 * `ends_at <= $now` at once. Read-then-write would let two concurrent
 * claims both read "unclaimed and ready" before either writes, and both
 * apply — the double-apply hole. A single conditional UPDATE lets Postgres's
 * row lock serialise the two: the second writer blocks until the first
 * commits, then re-evaluates the `where` against the now-claimed row, so at
 * most one of them can match.
 *
 * When the UPDATE matches nothing, a follow-up read distinguishes *why*
 * (missing / early / already claimed) so callers get a useful reason
 * instead of one generic failure.
 */
export async function claimJob(input: ClaimJobInput): Promise<ClaimJobResult> {
  const { lobbyId, teamKey, jobId, now } = input;

  return withTransaction(async (client) => {
    const res = await client.query<PendingJobRow>(
      `update pending_jobs
       set claimed_at = $4
       where id = $1 and lobby_id = $2 and team_key = $3
         and claimed_at is null and ends_at <= $4
       returning *`,
      [jobId, lobbyId, teamKey, now],
    );

    const claimed = res.rows[0];
    if (!claimed) {
      return diagnoseClaimFailure(client, lobbyId, teamKey, jobId, now);
    }

    const applied = await applyJobEffect(client, lobbyId, teamKey, claimed);
    return { ok: true as const, kind: claimed.kind, applied };
  });
}

async function diagnoseClaimFailure(
  client: PoolClient, lobbyId: string, teamKey: string, jobId: string, now: Date,
): Promise<ClaimJobResult> {
  const res = await client.query<PendingJobRow>(
    `select * from pending_jobs where id = $1 and lobby_id = $2 and team_key = $3`,
    [jobId, lobbyId, teamKey],
  );
  const row = res.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.claimed_at !== null) return { ok: false, reason: 'already_claimed' };
  if (row.ends_at.getTime() > now.getTime()) return { ok: false, reason: 'not_ready' };
  // Shouldn't happen — unclaimed and ready but the UPDATE still missed it —
  // but treat it as "not ready" rather than throwing a confusing error.
  return { ok: false, reason: 'not_ready' };
}

/**
 * Applies a claimed job's effect and returns what was applied.
 *
 * Training and spy currently have nowhere to write their result — driver
 * and intel state move to the server in Phase 3b. We stamp the claim (above)
 * and hand the payload back so the work is not lost, but there is no
 * further write to make here yet.
 */
async function applyJobEffect(
  client: PoolClient, lobbyId: string, teamKey: string, job: PendingJobRow,
): Promise<Record<string, unknown>> {
  if (job.kind === 'upgrade') {
    const stat = job.payload['stat'];
    const field = typeof stat === 'string' ? UPGRADE_STAT_FIELD[stat] : undefined;
    if (!field) {
      // The job was validated at start time; a missing/renamed field here
      // would mean stored data drifted from the code. Fail loudly instead
      // of silently doing nothing.
      throw new JobError(`claimJob: stored upgrade payload has no known stat ${JSON.stringify(stat)}`);
    }
    const economy = await loadTeamEconomy(lobbyId, teamKey);
    const effects = factoryEffects(economy?.factoryLevels ?? {});
    const gain = UPGRADE_BASE_GAIN + effects.upgradeGainBonus;
    await bumpCarStat(client, lobbyId, teamKey, field, gain);
    await bumpUpgradesDone(client, lobbyId, teamKey, stat as string);
    return { stat, gain };
  }
  // training / spy: nothing to write yet (Phase 3b) — return the payload.
  return job.payload;
}

export interface SkipJobInput {
  lobbyId: string;
  teamKey: string;
  jobId: string;
  userId?: string;
  now: Date;
}

export type SkipJobResult =
  | { ok: true; goldCost: number }
  | { ok: false; reason: 'not_found' | 'already_claimed' | 'not_enough_gold' | 'no_user' };

/**
 * Skips the remaining time on a job, charging gold proportional to what is
 * left. The UPDATE that brings `ends_at` forward only runs AFTER the gold
 * spend succeeds, and both live in the same transaction, so a failed spend
 * can never move `ends_at`.
 */
export async function skipJob(input: SkipJobInput): Promise<SkipJobResult> {
  const { lobbyId, teamKey, jobId, userId, now } = input;

  return withTransaction(async (client) => {
    const res = await client.query<PendingJobRow>(
      `select * from pending_jobs where id = $1 and lobby_id = $2 and team_key = $3`,
      [jobId, lobbyId, teamKey],
    );
    const job = res.rows[0];
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.claimed_at !== null) return { ok: false, reason: 'already_claimed' };

    const remainingMs = job.ends_at.getTime() - now.getTime();
    const goldCost = skipCostGold(remainingMs);

    if (goldCost > 0) {
      if (!userId) return { ok: false, reason: 'no_user' };
      const spent = await spendGold(client, userId, goldCost);
      if (!spent) return { ok: false, reason: 'not_enough_gold' };
    }

    await client.query(
      `update pending_jobs set ends_at = $2 where id = $1`,
      [jobId, now],
    );
    return { ok: true, goldCost };
  });
}

export interface OpenJob {
  jobId: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  startedAt: Date;
  endsAt: Date;
  ready: boolean;
  skipCostGold: number;
}

/** Every unclaimed job for a team. `ready` is computed from `now`, never stored. */
export async function openJobs(lobbyId: string, teamKey: string, now: Date): Promise<OpenJob[]> {
  const res = await query<PendingJobRow>(
    `select * from pending_jobs where lobby_id = $1 and team_key = $2 and claimed_at is null
     order by started_at asc`,
    [lobbyId, teamKey],
  );
  return res.rows.map((row) => {
    const remainingMs = row.ends_at.getTime() - now.getTime();
    return {
      jobId: row.id,
      kind: row.kind,
      payload: row.payload,
      startedAt: row.started_at,
      endsAt: row.ends_at,
      ready: remainingMs <= 0,
      skipCostGold: skipCostGold(remainingMs),
    };
  });
}
