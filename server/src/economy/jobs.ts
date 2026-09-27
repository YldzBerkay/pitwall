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
import { loadTeamEconomy, spendRp, chargeRpFloor, bumpCarStat, bumpUpgradesDone, setPendingSpyBoost, takePendingSpyBoost, type CarStats } from './repo.ts';
import { isGarageHidden } from './espionageRepo.ts';
import { spendGold } from '../gold/repo.ts';
import { skipCostGold, goldPrices } from '@pitwall/shared/economy';
import { factoryEffects } from '@pitwall/shared/factory';
import { staffEffects } from '@pitwall/shared/staff';
import { loadStaffSeat } from '../staff/repo.ts';
import { upgradeCostFor, upgradeDurationMs as sharedUpgradeDurationMs, UPGRADE_GAIN } from '@pitwall/shared/carCustomisation';
import { trainingGain, driverStatKeys, type DriverStatKey } from '@pitwall/shared/driverMarket';
import { overallOf, type Driver } from '@pitwall/shared/teams';
import { loadDriverRow, saveDriverAfterTraining } from '../drivers/repo.ts';
import {
  resolveMission, SPY_RESOLVE_MS, SPY_COOLDOWN_MS, SPY_BOOST, BAD_INTEL_FACTOR,
  CAUGHT_FINE_SHARE, CAUGHT_FINE_MIN, FREE_AGENT_RP, RIVAL_GAIN, agentProfiles,
  type AgentKind, type SpyMission,
} from '@pitwall/shared/espionage';

/** Valid `DriverStatKey`s — `shared/driverMarket.ts`'s own enum, never
 *  restated as a literal union here. */
const TRAINING_STAT_KEYS = new Set<string>(driverStatKeys.map((k) => k.key));

export type JobKind = 'upgrade' | 'training' | 'spy';

export class JobError extends Error {}

const HOUR_MS = 3_600_000;

const JOB_DURATIONS_MS: Record<JobKind, number> = {
  upgrade: 22 * HOUR_MS,
  training: 6 * HOUR_MS,
  // `shared`'s own resolve window — never a private copy of the number, per
  // this codebase's one hard rule (see this module's docblock and
  // `shared-purity.test.ts`).
  spy: SPY_RESOLVE_MS,
};

/** Stat label -> which `car` field it raises. Unknown labels are `bad_payload`. */
const UPGRADE_STAT_FIELD: Record<string, keyof CarStats> = {
  motor: 'motor',
  aero: 'aero',
  grip: 'grip',
};

/**
 * The `ends_at` of this team's last CLAIMED spy mission, if any — the same
 * lookup `startJob`'s cooldown check uses, factored out so `buildSlotState`
 * (`state.ts`) can expose the resulting cooldown END to the client without
 * duplicating the query. `undefined` means no spy mission has ever been
 * claimed for this team, the same "nothing to report" shape the rest of
 * this module uses elsewhere.
 */
async function lastClaimedSpyEndsAt(lobbyId: string, teamKey: string): Promise<Date | undefined> {
  const last = await query<{ ends_at: Date }>(
    `select ends_at from pending_jobs
     where lobby_id = $1 and team_key = $2 and kind = 'spy' and claimed_at is not null
     order by ends_at desc limit 1`,
    [lobbyId, teamKey],
  );
  return last.rows[0]?.ends_at;
}

/**
 * The instant a new spy mission becomes startable again — the last claimed
 * mission's `ends_at` plus `SPY_COOLDOWN_MS` — or `undefined` if no mission
 * has ever been claimed. `state.ts`'s `buildSlotState` surfaces this
 * directly as `SlotState.spyCooldownUntil` (an ISO instant); the client
 * derives its own countdown from that against its monotonic anchor, never
 * against `Date.now()` — see `economyClock.ts`'s doc comment for the
 * device-clock exploit that guards against.
 */
export async function spyCooldownEnd(lobbyId: string, teamKey: string): Promise<Date | undefined> {
  const lastEndsAt = await lastClaimedSpyEndsAt(lobbyId, teamKey);
  return lastEndsAt ? new Date(lastEndsAt.getTime() + SPY_COOLDOWN_MS) : undefined;
}

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
 *
 * The base formulas (`upgradeCostFor`/`upgradeDurationMs`) come from
 * `@pitwall/shared/carCustomisation` — the single definition `mobile`'s
 * `npm run econ` gate validates — so the server can never again quietly
 * diverge from the numbers the client shows. Factory department effects
 * (`upgradeCostScale`/`upgradeTimeScale`) still apply on top, exactly as
 * `mobile/src/store/gameStore.ts`'s `buildCostFor`/`buildTimeFor` compose
 * them: `Math.round(shared(...) * scale)`.
 */
function upgradeRpCost(timesDone: number, costScale: number): number {
  return Math.round(upgradeCostFor(timesDone) * costScale);
}

function upgradeDurationMs(timesDone: number, timeScale: number): number {
  return Math.round(sharedUpgradeDurationMs(timesDone) * timeScale);
}

export interface StartJobInput {
  lobbyId: string;
  teamKey: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  now: Date;
  /**
   * The account issuing the command — needed ONLY when a premium spy agent
   * (gold, per-user) might be charged. Every other job kind ignores it, the
   * same way `skipJob`'s optional `userId` does for its own gold path.
   */
  userId?: string;
}

export type StartJobResult =
  | { ok: true; jobId: string; endsAt: Date; rpCost: number; goldCost: number }
  | { ok: false; reason: 'already_running' | 'not_enough_rp' | 'not_enough_gold' | 'no_economy' | 'bad_payload' | 'cooldown' | 'no_user' };

/**
 * Starts a job. The RP charge (for upgrades) and the insert live in ONE
 * transaction: if the insert loses the `pending_jobs_open_idx` partial-index
 * race (another open job of the same kind already exists), the whole
 * transaction — including the RP spend — rolls back. A player must never be
 * charged for a start that did not happen.
 */
export async function startJob(input: StartJobInput): Promise<StartJobResult> {
  const { lobbyId, teamKey, kind, payload, now, userId } = input;
  assertKnownKind(kind);

  const economy = await loadTeamEconomy(lobbyId, teamKey);
  if (!economy) return { ok: false, reason: 'no_economy' };

  if (kind === 'spy') {
    // The 48h cooldown is measured from the last mission's `ends_at` — the
    // moment it "finished" — not from whenever the player got around to
    // claiming it, so a slow claim can never be used to shorten the wait.
    // `pending_jobs_open_idx` already stops a SECOND open spy job; this is
    // the separate temporal gap after a CLAIMED one.
    const lastEndsAt = await lastClaimedSpyEndsAt(lobbyId, teamKey);
    if (lastEndsAt && now.getTime() < lastEndsAt.getTime() + SPY_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown' };
    }
  }

  const effects = factoryEffects(economy.factoryLevels);

  let rpCost = 0;
  let goldCost = 0;
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

  if (kind === 'spy') {
    // A free agent costs RP, a premium agent costs gold — restated from
    // nowhere: `FREE_AGENT_RP` and `goldPrices.premiumAgent` are `shared/`'s
    // own numbers (see espionage.ts / economy.ts), never re-typed here.
    // Before this, the server started a mission for free; the client's own
    // local charge hid the gap until the client stopped being the one
    // deciding what happened, at which point espionage became free.
    const agent = payload?.['agent'];
    if (agent !== 'free' && agent !== 'premium') {
      return { ok: false, reason: 'bad_payload' };
    }
    if (agent === 'premium') {
      goldCost = goldPrices.premiumAgent;
    } else {
      rpCost = FREE_AGENT_RP;
    }
  }

  const endsAt = new Date(now.getTime() + durationMs);

  try {
    return await withTransaction(async (client) => {
      // The spend and the insert live in ONE transaction: a lost
      // `pending_jobs_open_idx` race below rolls the spend back with it (the
      // `catch` re-throws anything but that conflict, so `withTransaction`
      // never has a reason to swallow a real error here).
      if (goldCost > 0) {
        if (!userId) return { ok: false as const, reason: 'no_user' as const };
        const spent = await spendGold(client, userId, goldCost);
        if (!spent) return { ok: false as const, reason: 'not_enough_gold' as const };
      } else if (rpCost > 0) {
        const spent = await spendRp(client, lobbyId, teamKey, rpCost);
        if (!spent) return { ok: false as const, reason: 'not_enough_rp' as const };
      }

      const res = await client.query<{ id: string }>(
        `insert into pending_jobs (lobby_id, team_key, kind, payload, started_at, ends_at)
         values ($1, $2, $3, $4::jsonb, $5, $6)
         returning id`,
        [lobbyId, teamKey, kind, JSON.stringify(storedPayload), now, endsAt],
      );
      return { ok: true as const, jobId: res.rows[0].id, endsAt, rpCost, goldCost };
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
 * Training still has nowhere to write its result — driver state moves to
 * the server in a later Phase 3b task. We stamp the claim (above) and hand
 * the payload back so the work is not lost, but there is no further write to
 * make here yet.
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
    // MUST take `client` — this runs inside claimJob's transaction, and a
    // bare-pool read while holding a connection can deadlock a full pool
    // (see loadTeamEconomy's doc comment).
    const economy = await loadTeamEconomy(lobbyId, teamKey, client);
    const effects = factoryEffects(economy?.factoryLevels ?? {});
    // The chief mechanic's own bonus — `staffEffects`'s own docblock is
    // clear that everything else in the game reads its effects rather than
    // a skill number directly. At skill 40 (an empty seat) `upgradeBonus`
    // is exactly 0, so an unstaffed team's upgrade gain is byte-identical
    // to before this task — no gate needed the way the pit crew/brief
    // fields need one in `runner.ts`'s `buildFrozenEntries` (see that
    // function's own doc comment for why those two DO need one).
    // MUST take `client` — same reason as the read two lines up.
    const mechanic = await loadStaffSeat(lobbyId, teamKey, 'mechanic', client);
    const mechanicBonus = staffEffects({ mechanic: mechanic?.member }).upgradeBonus;
    // A pending espionage boost on this exact stat (SPY_BOOST for a
    // successful mission, BAD_INTEL_FACTOR for a wrong one) multiplies this
    // one upgrade and is consumed here — `takePendingSpyBoost` clears it in
    // the same statement it reads it, so it can never apply twice.
    const boost = await takePendingSpyBoost(client, lobbyId, teamKey, stat as string);
    const gain = (UPGRADE_GAIN + effects.upgradeGainBonus + mechanicBonus) * boost;
    await bumpCarStat(client, lobbyId, teamKey, field, gain);
    await bumpUpgradesDone(client, lobbyId, teamKey, stat as string);
    return { stat, gain };
  }

  if (job.kind === 'spy') {
    return applySpyEffect(client, lobbyId, teamKey, job);
  }

  if (job.kind === 'training') {
    return applyTrainingEffect(client, lobbyId, teamKey, job);
  }

  return job.payload;
}

/**
 * Applies a claimed training job to the targeted race seat.
 *
 * `driverIdx`/`stat` are validated leniently, not with a `JobError` throw
 * the way the upgrade branch does for a corrupted stat: unlike upgrades,
 * training jobs existed (and are exercised by `economy-jobs.test.ts`'s own
 * fixtures) BEFORE this feature ever stored a target, with a bare `{}` or
 * `{ driverIdx }` payload — a job like that must keep claiming cleanly, it
 * just has nothing to apply. Only 0/1 (a race seat) are resolved today; a
 * reserve-squad index (2+) has no stable server-side identity yet (see
 * `drivers/repo.ts`'s reserve rows, keyed by market id, not by position) and
 * is out of scope here — it falls through to the same no-op.
 */
async function applyTrainingEffect(
  client: PoolClient, lobbyId: string, teamKey: string, job: PendingJobRow,
): Promise<Record<string, unknown>> {
  const { driverIdx, stat } = job.payload as { driverIdx?: unknown; stat?: unknown };
  const seat = driverIdx === 0 ? 'seat_0' as const : driverIdx === 1 ? 'seat_1' as const : undefined;
  if (!seat || typeof stat !== 'string' || !TRAINING_STAT_KEYS.has(stat)) {
    return job.payload;
  }

  // MUST take `client` — this runs inside claimJob's own transaction, and a
  // bare-pool read while holding a connection can deadlock a full pool (see
  // the upgrade branch's identical comment above, and `loadTeamDrivers`'s
  // doc comment in `drivers/repo.ts`).
  const row = await loadDriverRow(lobbyId, teamKey, seat, undefined, client);
  if (!row || row.isStopgap) {
    // Unseeded seat (older fixtures), or a stopgap filler — a temporary
    // driver with no contract is not a signed driver to improve.
    return { driverIdx, stat, gain: 0 };
  }

  const economy = await loadTeamEconomy(lobbyId, teamKey, client);
  const effects = factoryEffects(economy?.factoryLevels ?? {});
  const statKey = stat as DriverStatKey;
  // shared's own rule (`trainingGain`), scaled by the driver academy's
  // `trainingScale` — the SAME composition the mobile client already uses
  // (`driverSlice.ts`'s `collectTraining`), never a private copy.
  const gain = Math.round(trainingGain(row.driver, statKey) * effects.trainingScale * 100) / 100;
  const stats = {
    ...row.driver.stats,
    [statKey]: Math.min(99, Math.round((row.driver.stats[statKey] + gain) * 100) / 100),
  };
  const updated: Driver = { ...row.driver, stats, skill: overallOf(stats) };
  await saveDriverAfterTraining(client, lobbyId, row.id, updated);
  return { driverIdx, stat, gain };
}

/**
 * Resolves a claimed spy mission and applies its effect.
 *
 * The outcome is rolled HERE, from values the server itself holds — the
 * mission's own stored `startedRound`/`season`/`targetTeam`/`agent`, the
 * spying team's own key, the TARGET's current garage-hide state, and the two
 * teams' actual `car` stats, all read fresh from the database — never from
 * anything in the client's request. `shared/src/espionage.ts`'s
 * `resolveMission` is the one place that decides the roll; this function
 * only feeds it and applies what it returns.
 *
 * `targetHidden` is read at CLAIM time (the current round, from `lobbies`),
 * not from anything captured at start — the same "current data, not stale
 * data" rule the two teams' car stats already followed here. A garage
 * un-hidden between start and claim must not retroactively un-block a
 * mission that would have hit a live hide; the target's CURRENT state is
 * what the intel would actually have found.
 */
async function applySpyEffect(
  client: PoolClient, lobbyId: string, teamKey: string, job: PendingJobRow,
): Promise<Record<string, unknown>> {
  const { targetTeam, stat, agent, startedRound, season } = job.payload as {
    targetTeam?: unknown; stat?: unknown; agent?: unknown; startedRound?: unknown; season?: unknown;
  };
  if (
    typeof targetTeam !== 'string' || typeof stat !== 'string'
    || typeof agent !== 'string' || !(agent in agentProfiles)
    || typeof startedRound !== 'number' || typeof season !== 'number'
  ) {
    // Stored at start time by `actions.ts`'s `startSpyMission`, which
    // validates every field before ever calling `startJob`. Reaching claim
    // with one missing/malformed means stored data drifted from the code —
    // fail loudly, the same way the upgrade branch above does for an unknown
    // stat.
    throw new JobError(`claimJob: stored spy payload is malformed ${JSON.stringify(job.payload)}`);
  }

  const [ownEconomy, targetEconomy, lobbyRow] = await Promise.all([
    loadTeamEconomy(lobbyId, teamKey, client),
    loadTeamEconomy(lobbyId, targetTeam, client),
    client.query<{ round_no: number }>('select round_no from lobbies where id = $1', [lobbyId]),
  ]);
  if (!ownEconomy || !targetEconomy) {
    throw new JobError(`claimJob: spy mission references a team with no economy row (own=${teamKey}, target=${targetTeam})`);
  }
  const currentRound = lobbyRow.rows[0]?.round_no ?? startedRound;

  const statField = stat as keyof CarStats;
  const targetStronger = (targetEconomy.car[statField] ?? 0) > (ownEconomy.car[statField] ?? 0);
  const targetHidden = await isGarageHidden(lobbyId, targetTeam, currentRound, client);

  const mission: SpyMission = {
    id: job.id,
    targetTeam,
    stat: statField,
    agent: agent as AgentKind,
    startedRound,
    startedAt: job.started_at.getTime(),
    endsAt: job.ends_at.getTime(),
    lobbyId,
    season,
    ownTeam: teamKey,
  };
  const outcome = resolveMission(mission, targetHidden, targetStronger);

  if (outcome === 'success') {
    await setPendingSpyBoost(client, lobbyId, teamKey, stat, SPY_BOOST);
    return { outcome, targetTeam, stat };
  }
  if (outcome === 'badIntel') {
    await setPendingSpyBoost(client, lobbyId, teamKey, stat, BAD_INTEL_FACTOR);
    return { outcome, targetTeam, stat };
  }
  if (outcome === 'caught') {
    const nominalFine = Math.max(CAUGHT_FINE_MIN, Math.round(ownEconomy.rp * CAUGHT_FINE_SHARE));
    // `chargeRpFloor` floors at zero AND returns what it actually deducted —
    // that returned value, never `nominalFine`, is what gets reported back.
    const fine = await chargeRpFloor(client, lobbyId, teamKey, nominalFine);
    // The target wins the affair, the way the 2007 spygate fine also handed
    // the wronged team an edge: it gets a real bump on the very stat that
    // was being spied on (the intel it had to defend became a lead of its
    // own). `RIVAL_GAIN` is the SAME constant the client already used for
    // this (`aiBonus[target] += RIVAL_GAIN`); the server has no `aiBonus`,
    // so this lands on the target's actual `car` row instead.
    await bumpCarStat(client, lobbyId, targetTeam, statField, RIVAL_GAIN);
    return { outcome, targetTeam, stat, fine };
  }
  // 'nothing' / 'blocked': no further effect.
  return { outcome, targetTeam, stat };
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
 * left.
 *
 * The gold spend and the UPDATE that brings `ends_at` forward live in ONE
 * transaction, and the UPDATE's `where` carries `claimed_at is null` alongside
 * `id`/`lobby_id`/`team_key` — exactly the discipline `claimJob` already uses
 * for its own conditional UPDATE. That guard is what makes the two directions
 * of the guarantee hold together: a failed spend can never move `ends_at`,
 * AND a spend that succeeds but hits a job some concurrent `claimJob` already
 * claimed moves nothing either — the zero-row UPDATE fails the transaction
 * (`already_claimed`) instead of returning `ok: true`, so the gold spend rolls
 * back with it. The two either both land or both don't; there is no state
 * where gold moves but the skip did not take effect.
 *
 * The initial SELECT is no longer what correctness depends on — a job read
 * as unclaimed here could still be claimed by the time the UPDATE runs. It is
 * kept only to produce a precise `not_found` / `already_claimed` result code
 * on the common (non-racing) path before any gold is spent; the conditional
 * UPDATE below is the actual guard.
 *
 * `withTransaction` only rolls back on a THROW — a function that merely
 * `return`s still commits. So the zero-row case below cannot just return
 * `{ ok: false }`; it throws a private sentinel to force the rollback (which
 * undoes the gold spend), and the catch below turns that sentinel back into
 * the ordinary `already_claimed` result.
 */
class SkipLostRace extends Error {}

export async function skipJob(input: SkipJobInput): Promise<SkipJobResult> {
  const { lobbyId, teamKey, jobId, userId, now } = input;

  try {
    return await withTransaction(async (client) => {
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

      const updateRes = await client.query(
        `update pending_jobs set ends_at = $2
         where id = $1 and claimed_at is null`,
        [jobId, now],
      );
      if (updateRes.rowCount === 0) {
        // Someone claimed this job after our SELECT but before this UPDATE.
        // Throw to force the rollback — otherwise the gold spend above would
        // commit for a skip that moved nothing.
        throw new SkipLostRace();
      }
      return { ok: true, goldCost };
    });
  } catch (err) {
    if (err instanceof SkipLostRace) {
      return { ok: false, reason: 'already_claimed' };
    }
    throw err;
  }
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
