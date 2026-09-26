/**
 * What the espionage screen (`PaddockScreen.tsx`'s `IntelSection`) should
 * show, derived from the server-backed `economyApi` slice
 * (`economyApiSlice.ts`) rather than the local `espionageSlice.ts` — which
 * this task deletes outright, not merely stops calling. See that file's own
 * former docblock for why it never resolved anything: `resolveMission`'s
 * only caller was `skipMission` (pay gold to force a result), and an
 * unresolved mission returned `'pending'` from `startMission` forever,
 * blocking every new one. Both are gone: the server resolves missions on
 * CLAIM (`claimSpyReport`), and a claimed mission simply stops being an open
 * job — nothing left in `SlotState.jobs` to block a new one, only the
 * server's real 48h cooldown (`SlotState.spyCooldownUntil`) can.
 *
 * Follows the EXACT shape `factoryDisplay.ts`'s `displayFactory` established
 * — a plain function over data, no rendering, so it runs under `tsx --test`
 * (`PaddockScreen.tsx` itself imports React Native and cannot). See that
 * module's own doc comment for the `{ kind: 'no-lobby' }` rule this mirrors:
 * once there is no lobby, this never reaches for local numbers — there are
 * none left to reach for.
 */
import type { SlotStateHide, SpyClaimResult } from '@/lib/api/economy';
import type { EconomyApiSliceState } from './economyApiSlice';
import { jobRemainingMs, defaultClock, type Clock, type ServerTimeAnchor } from './economyClock';

export interface SpyMissionJob {
  jobId: string;
  targetTeam: string;
  stat: string;
  agent: string;
  /** Whether the job is claimable right now, per the server's own clock —
   * taken as-is from `SlotStateJob.ready`, never recomputed from `endsAt`. */
  ready: boolean;
  /** The server's own figure for skipping the rest of this job — never
   * recomputed client-side. */
  skipCostGold: number;
  /** Milliseconds left, derived from the slice's monotonic anchor — never
   * from `Date.now()`. See `economyClock.ts`'s module doc for the exploit
   * this closes. */
  remainingMs: number;
}

export type EspionageDisplay =
  | { kind: 'no-lobby' }
  /** In a lobby, but `hydrate`/an action response has not landed yet. */
  | { kind: 'loading' }
  | {
      kind: 'ready';
      /** The one spy job the bench can hold, if any — undefined means a new
       * mission can be started (subject to `cooldownRemainingMs` below). */
      currentMission?: SpyMissionJob;
      /** Milliseconds until the 48h cooldown lifts, or `undefined` when
       * there is none (no mission ever claimed, or it already lifted).
       * Derived from `SlotState.spyCooldownUntil` against the slice's own
       * monotonic anchor — never `Date.now()`. */
      cooldownRemainingMs?: number;
      /** `null` when this garage has never been hidden. */
      hide: SlotStateHide | null;
    };

function toSpyMissionJob(job: { jobId: string; payload: Record<string, unknown>; ready: boolean; skipCostGold: number; endsAt: string }, anchor: ServerTimeAnchor, clock: Clock): SpyMissionJob {
  return {
    jobId: job.jobId,
    targetTeam: String(job.payload['targetTeam'] ?? ''),
    stat: String(job.payload['stat'] ?? ''),
    agent: String(job.payload['agent'] ?? ''),
    ready: job.ready,
    skipCostGold: job.skipCostGold,
    remainingMs: jobRemainingMs(job, anchor, clock),
  };
}

/**
 * `lobbyId` is the app's own "are we seated in a lobby" signal, same as
 * `displayFactory` — not `economyApi.lobbyId`, which lags a beat behind the
 * first successful economy call.
 */
export function displayEspionage(
  lobbyId: string | undefined,
  economyApi: Pick<EconomyApiSliceState, 'slot' | 'anchor'>,
  clock: Clock = defaultClock,
): EspionageDisplay {
  if (!lobbyId) return { kind: 'no-lobby' };

  const { slot, anchor } = economyApi;
  if (!slot) return { kind: 'loading' };

  const spyJob = slot.jobs.find((j) => j.kind === 'spy');
  const currentMission = spyJob && anchor ? toSpyMissionJob(spyJob, anchor, clock) : undefined;

  let cooldownRemainingMs: number | undefined;
  if (slot.spyCooldownUntil && anchor) {
    const remaining = jobRemainingMs({ endsAt: slot.spyCooldownUntil }, anchor, clock);
    if (remaining > 0) cooldownRemainingMs = remaining;
  }

  return {
    kind: 'ready',
    currentMission,
    cooldownRemainingMs,
    hide: slot.hide,
  };
}

/** Re-exported purely so a screen can type a just-claimed report's outcome
 * without importing `@/lib/api/economy` directly for it. */
export type { SpyClaimResult };
