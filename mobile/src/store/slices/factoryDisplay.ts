/**
 * What the factory/car-upgrade screen (`DevelopmentScreen.tsx`) should show,
 * derived from the server-backed `economyApi` slice
 * (`economyApiSlice.ts`) rather than the local `economySlice.ts` /
 * `gameStore.ts` upgrade logic.
 *
 * Follows the exact shape `raceSlice.ts` established for
 * `displayRace`/`displayQualifying`: a plain function over data, no
 * rendering, so it can run under `tsx --test` (`DevelopmentScreen.tsx`
 * itself imports React Native and cannot).
 *
 * ── NO LOCAL FALLBACK ──────────────────────────────────────────────────────
 * Exactly like `displayRace`: once there is no lobby, this NEVER reaches for
 * the local economy's numbers (`gameStore.ts`'s `carStats`/`rp`/`departments`
 * from `economySlice.ts`/the local upgrade logic still on `GameState`). A
 * lobby-less player seeing local numbers next to a lobby-seated player
 * seeing server numbers is the same second-reality bug this migration phase
 * exists to close (see this task's brief and `raceSlice.ts`'s own doc
 * comment on `displayRace`). `{ kind: 'no-lobby' }` is a distinct shape from
 * `{ kind: 'ready', ... }` for exactly that reason — a screen must be able
 * to say "you're not in a lobby" rather than silently render *something*.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT COMPUTE ───────────────────────────────
 * The local screen today previews an upgrade's RP cost and build time
 * BEFORE it is started (`buildCostFor`/`buildTimeFor` in `gameStore.ts`,
 * built on `@pitwall/shared/carCustomisation`'s `upgradeCostFor`/
 * `upgradeDurationMs`). The server's own formula
 * (`server/src/economy/jobs.ts`'s `upgradeRpCost`/`upgradeDurationMs`) now
 * imports that exact same `upgradeCostFor`/`upgradeDurationMs` and only
 * layers factory scales on top — the base numbers can no longer drift.
 * (They used to: server-side was once its own 750 RP × 1.25^done over
 * 22h × (1 + 0.15·done), privately reimplemented instead of imported. That
 * has been fixed.) Even so, this module still exposes no
 * `nextUpgradeCost` / `nextUpgradeDurationMs` field, because the server
 * does not expose a preview endpoint and factory scale composition
 * (`upgradeCostScale`/`upgradeTimeScale`) is server round-trip state this
 * module doesn't have — the true cost/duration only becomes known once the
 * server actually returns the started job. A `skipCostGold` for a job
 * ALREADY running is fine and included below, because that number comes
 * straight from `SlotStateJob.skipCostGold` — the server's own figure, not
 * a client re-derivation.
 *
 * Factory-department upgrade cost is different: `departmentCost` lives in
 * `@pitwall/shared/factory` and BOTH `server/src/economy/actions.ts` and
 * this client import that exact same function — there is only one
 * implementation, so previewing it here is not a re-derivation that can
 * drift. The screen may keep using it directly, fed by this module's
 * `factoryLevels`.
 */
import type { SlotStateJob } from '@/lib/api/economy';
import type { EconomyApiSliceState } from './economyApiSlice';
import { jobRemainingMs, defaultClock, type Clock, type ServerTimeAnchor } from './economyClock';

/** The UI's car-stat labels (`gameStore.ts`'s `carStats`) are uppercase;
 * the server's job payload and `SlotState.car` keys are lowercase
 * (`UPGRADE_STAT_FIELD` in `server/src/economy/jobs.ts`). Translate at the
 * boundary rather than changing either side. */
export const STAT_LABEL_TO_SERVER: Record<string, string> = { MOTOR: 'motor', AERO: 'aero', GRIP: 'grip' };
export const SERVER_STAT_TO_LABEL: Record<string, string> = { motor: 'MOTOR', aero: 'AERO', grip: 'GRIP' };

export interface FactoryCarStat {
  label: string;
  value: number;
  /**
   * The server's own pending espionage multiplier for this stat's NEXT
   * upgrade (`SlotState.spyBoosts`, keyed by the server's lowercase stat
   * label and translated back here) — `undefined` when nothing is
   * pending, never a fabricated `1`. A value above 1 is a bonus (a
   * successful mission's `SPY_BOOST`); a value below 1 is a warning, not a
   * bonus (bad intel's `BAD_INTEL_FACTOR`) — the screen must render the two
   * distinctly, never with the same "good news" styling. The number itself
   * is never recomputed here — it is the server's figure, verbatim, and it
   * disappears from a later snapshot the instant the upgrade that consumes
   * it (`server/src/economy/jobs.ts`'s `applyJobEffect` ->
   * `takePendingSpyBoost`) is claimed.
   */
  pendingBoost?: number;
}

export interface FactoryUpgradeJob {
  jobId: string;
  /** Translated back to the UI's uppercase label (`MOTOR`/`AERO`/`GRIP`). */
  label: string;
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

export type FactoryDisplay =
  | { kind: 'no-lobby' }
  /** In a lobby, but `hydrate`/an action response has not landed yet. */
  | { kind: 'loading' }
  | {
      kind: 'ready';
      rp: number;
      gold: number;
      carStats: FactoryCarStat[];
      /** Department code -> level, straight from `SlotState.factory`. */
      factoryLevels: Record<string, number>;
      /** The one upgrade job the factory bench can hold, if any — undefined
       * means the bench is free to start a new one. */
      currentUpgrade?: FactoryUpgradeJob;
    };

/**
 * Builds one `FactoryCarStat`, omitting `pendingBoost` entirely (rather than
 * setting it to `undefined`) when nothing is pending — this keeps a
 * fixture built before this field existed (`assert.deepEqual` against a
 * plain `{ label, value }` object) equal to what this function returns, and
 * matches the rest of `SlotState`'s own "absent key means nothing", not a
 * fabricated placeholder.
 */
function carStat(label: string, value: number, pendingBoost: number | undefined): FactoryCarStat {
  return pendingBoost === undefined ? { label, value } : { label, value, pendingBoost };
}

function toFactoryUpgradeJob(job: SlotStateJob, anchor: ServerTimeAnchor, clock: Clock): FactoryUpgradeJob {
  const stat = String(job.payload['stat'] ?? '');
  return {
    jobId: job.jobId,
    label: SERVER_STAT_TO_LABEL[stat] ?? stat,
    ready: job.ready,
    skipCostGold: job.skipCostGold,
    remainingMs: jobRemainingMs(job, anchor, clock),
  };
}

/**
 * `lobbyId` is the app's own "are we seated in a lobby" signal — the same
 * one `raceSlice.ts`'s `displayRace`/`displayQualifying` key off
 * (`race.lobbyId`), not `economyApi.lobbyId` (which is only set once the
 * first economy call succeeds, so it lags behind and would show `no-lobby`
 * for a beat after joining even though the player is already seated).
 */
export function displayFactory(
  lobbyId: string | undefined,
  economyApi: Pick<EconomyApiSliceState, 'slot' | 'anchor'>,
  clock: Clock = defaultClock,
): FactoryDisplay {
  if (!lobbyId) return { kind: 'no-lobby' };

  const { slot, anchor } = economyApi;
  if (!slot) return { kind: 'loading' };

  const upgradeJob = slot.jobs.find((j) => j.kind === 'upgrade');
  const currentUpgrade = upgradeJob && anchor ? toFactoryUpgradeJob(upgradeJob, anchor, clock) : undefined;

  return {
    kind: 'ready',
    rp: slot.rp,
    gold: slot.gold,
    carStats: [
      carStat('MOTOR', slot.car.motor, slot.spyBoosts?.['motor']),
      carStat('AERO', slot.car.aero, slot.spyBoosts?.['aero']),
      carStat('GRIP', slot.car.grip, slot.spyBoosts?.['grip']),
    ],
    factoryLevels: slot.factory,
    currentUpgrade,
  };
}
