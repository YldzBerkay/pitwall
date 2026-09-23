/**
 * The server-backed economy slice.
 *
 * This is deliberately SEPARATE from `economySlice.ts` (the local,
 * `Date.now()`-driven economy — factory/testing/sponsor logic lives partly
 * there and partly in `gameStore.ts`). Deleting that local slice and
 * rewiring the economy screens onto this one is explicitly the NEXT task
 * (see this task's brief).
 *
 * ── THE REAL COLLISION, AND WHY EVERYTHING LIVES UNDER ONE KEY ────────────
 * An earlier version of this file assumed the collision was a top-level
 * `economy` object key clashing with `EconomySlice`. That assumption was
 * wrong: `EconomySlice` (`economySlice.ts`) has no `economy` key at all —
 * its fields (`gold`, `adsToday`, `convertGoldToRp`, ...) sit directly on
 * `GameState`. The REAL collision, found by reading `gameStore.ts` and
 * `driverSlice.ts` directly, is narrower and sharper: three method NAMES —
 * `startUpgrade`, `startTraining`, `convertGoldToRp` — already exist on
 * `GameState` today (`gameStore.ts`'s own `startUpgrade`,
 * `driverSlice.ts`'s `startTraining`, `economySlice.ts`'s
 * `convertGoldToRp`), each with a DIFFERENT, incompatible signature (sync,
 * no `lobbyId`) from this slice's server-calling versions (async, first arg
 * `lobbyId`). Spreading this slice's actions flat onto `GameState` — the
 * way `raceSlice.ts`'s `callPit`/`connectRace` are spread, since nothing
 * there collides — would silently shadow those three local methods, and
 * every existing screen calling them would start hitting the network with
 * the wrong argument shape and break, without a compile error to catch it
 * (both sides are plain functions).
 *
 * The fix: this whole slice's surface — state AND every action, including
 * `hydrate` — lives inside a single `economyApi` object rather than being
 * spread flat onto `GameState`. One namespace, chosen for what it names
 * (the server-backed economy client) rather than for dodging today's three
 * collisions, so it needs no rename once `economySlice.ts` is deleted next
 * task — screens will just call `useGameStore.getState().economyApi.foo()`
 * instead of the bare local `foo()`.
 *
 * Talks to the server's economy endpoints (`../../lib/api/economy.ts`,
 * `server/src/economy/routes.ts`) and otherwise follows the shape
 * `raceSlice.ts` established earlier in this stage: an `ApiResult`-returning
 * API client, `Bearer` auth via a `session()` read of `auth`, distinct
 * server error codes preserved rather than flattened, and
 * `RaceSliceDeps`-style standalone testability (`EconomyApiSliceDeps`
 * below) so this slice's own tests don't need to pull in the whole
 * `GameState`.
 *
 * EVERY COUNTDOWN COMES FROM THE SERVER'S CLOCK. `remainingMsFor` below is
 * the only sanctioned way to turn a job into a "time left" number, and it
 * is built entirely on `./economyClock.ts` — never on `Date.now()`. See
 * that module's doc comment for the exploit this closes and why a
 * monotonic anchor is what actually closes it. The anchor is (re)made on
 * EVERY server response this slice adopts — `hydrate` included — never only
 * on the first, so a long-lived session's countdown never drifts from the
 * truth (see `adopt` below).
 */
import type { ApiResult } from '@/lib/api/identity';
import {
  startUpgrade as startUpgradeApi,
  startTraining as startTrainingApi,
  startSpyMission as startSpyMissionApi,
  claimUpgrade as claimUpgradeApi,
  claimTraining as claimTrainingApi,
  claimSpyReport as claimSpyReportApi,
  skipUpgrade as skipUpgradeApi,
  skipTraining as skipTrainingApi,
  skipSpy as skipSpyApi,
  upgradeFactory as upgradeFactoryApi,
  convertGoldToRp as convertGoldToRpApi,
  getEconomyState as getEconomyStateApi,
  type SlotState,
  type SlotStateJob,
} from '@/lib/api/economy';
import { makeAnchor, jobRemainingMs, defaultClock, type Clock, type ServerTimeAnchor } from './economyClock';

export type EconomyActionOutcome =
  | { ok: true; state: SlotState }
  /** `error` is always the server's own code (or the local `not_signed_in`
   * refusal below) — never flattened into one generic failure string. A
   * player who can't afford something and a player who hit a daily cap need
   * different words (see `lib/api/economy.ts`'s doc comment). */
  | { ok: false; error: string };

export interface EconomyApiSliceState {
  /** The lobby this slot belongs to, or undefined before any action has
   * been sent. */
  lobbyId?: string;
  /** The last full slot snapshot the server returned. `null` before the
   * first successful call — never fabricated locally. */
  slot: SlotState | null;
  /** `slot.serverNow` anchored to a monotonic clock reading taken the
   * moment that response arrived. `undefined` until `slot` is set.
   * `remainingMsFor` reads this, never `slot.serverNow` directly against
   * `Date.now()`. Refreshed on every adopted response — see the module doc
   * comment. */
  anchor?: ServerTimeAnchor;
  /** The most recent action's (or `hydrate`'s) result, kept distinct from
   * `slot` so a rejection (e.g. `not_enough_rp`) can be shown without being
   * swallowed into the slot state — mirrors `raceSlice.ts`'s
   * `lastPitOutcome`. */
  lastActionOutcome?: EconomyActionOutcome;
}

export interface EconomyApiSliceActions {
  /**
   * Reads the current slot from the server without mutating anything
   * (`GET /economy/state`). This is how a screen opened cold learns the
   * player's state — it must not have to fire a mutating action just to
   * read one back. Same refusal/outcome shape as every action below.
   */
  hydrate: (lobbyId: string) => Promise<EconomyActionOutcome>;
  startUpgrade: (lobbyId: string, label: string) => Promise<EconomyActionOutcome>;
  startTraining: (lobbyId: string, driverIdx: number) => Promise<EconomyActionOutcome>;
  startSpyMission: (lobbyId: string, payload?: Record<string, unknown>) => Promise<EconomyActionOutcome>;
  claimUpgrade: (lobbyId: string, jobId: string) => Promise<EconomyActionOutcome>;
  claimTraining: (lobbyId: string, jobId: string) => Promise<EconomyActionOutcome>;
  claimSpyReport: (lobbyId: string, jobId: string) => Promise<EconomyActionOutcome>;
  skipUpgrade: (lobbyId: string, jobId: string) => Promise<EconomyActionOutcome>;
  skipTraining: (lobbyId: string, jobId: string) => Promise<EconomyActionOutcome>;
  skipSpy: (lobbyId: string, jobId: string) => Promise<EconomyActionOutcome>;
  upgradeFactory: (lobbyId: string, code: string) => Promise<EconomyActionOutcome>;
  convertGoldToRp: (lobbyId: string, gold: number) => Promise<EconomyActionOutcome>;
}

/**
 * Everything this slice contributes to `GameState` sits under this one key —
 * see the module doc comment for why (`startUpgrade`/`startTraining`/
 * `convertGoldToRp` all already exist elsewhere on `GameState` with
 * incompatible signatures).
 */
export interface EconomyApiSlice {
  economyApi: EconomyApiSliceState & EconomyApiSliceActions;
}

/** Mirrors `RaceSliceDeps` in `raceSlice.ts`: the one thing this slice reads
 * from the rest of the store, kept minimal so tests can build a standalone
 * store without the whole `GameState`. */
export interface EconomyApiSliceDeps {
  auth: { baseUrl: string; token?: string };
}

type ActionApi<TInput> = (baseUrl: string, token: string, input: TInput) => Promise<ApiResult<SlotState>>;

/** Injectable collaborators, defaulting to the real client and clock —
 * mirrors `RaceSliceInjected` in `raceSlice.ts`. */
export interface EconomyApiSliceInjected {
  getEconomyStateApi?: ActionApi<{ lobbyId: string }>;
  startUpgradeApi?: ActionApi<{ lobbyId: string; label: string }>;
  startTrainingApi?: ActionApi<{ lobbyId: string; driverIdx: number }>;
  startSpyMissionApi?: ActionApi<{ lobbyId: string } & Record<string, unknown>>;
  claimUpgradeApi?: ActionApi<{ lobbyId: string; jobId: string }>;
  claimTrainingApi?: ActionApi<{ lobbyId: string; jobId: string }>;
  claimSpyReportApi?: ActionApi<{ lobbyId: string; jobId: string }>;
  skipUpgradeApi?: ActionApi<{ lobbyId: string; jobId: string }>;
  skipTrainingApi?: ActionApi<{ lobbyId: string; jobId: string }>;
  skipSpyApi?: ActionApi<{ lobbyId: string; jobId: string }>;
  upgradeFactoryApi?: ActionApi<{ lobbyId: string; code: string }>;
  convertGoldToRpApi?: ActionApi<{ lobbyId: string; gold: number }>;
  clock?: Clock;
}

type Set = (partial: Partial<EconomyApiSlice> | ((state: EconomyApiSlice) => Partial<EconomyApiSlice>)) => void;
type Get = () => EconomyApiSlice & EconomyApiSliceDeps;

/**
 * Typed loosely (not against the real `GameState`) so this slice can be
 * dropped into either a standalone test store or the real one later,
 * mirroring how `raceSlice.ts`'s tests build their own minimal store.
 */
export function createEconomyApiSlice(
  set: Set,
  get: Get,
  injected: EconomyApiSliceInjected = {},
): EconomyApiSlice {
  const clock = injected.clock ?? defaultClock;
  const apis = {
    getEconomyState: injected.getEconomyStateApi ?? getEconomyStateApi,
    startUpgrade: injected.startUpgradeApi ?? startUpgradeApi,
    startTraining: injected.startTrainingApi ?? startTrainingApi,
    startSpyMission: injected.startSpyMissionApi ?? startSpyMissionApi,
    claimUpgrade: injected.claimUpgradeApi ?? claimUpgradeApi,
    claimTraining: injected.claimTrainingApi ?? claimTrainingApi,
    claimSpyReport: injected.claimSpyReportApi ?? claimSpyReportApi,
    skipUpgrade: injected.skipUpgradeApi ?? skipUpgradeApi,
    skipTraining: injected.skipTrainingApi ?? skipTrainingApi,
    skipSpy: injected.skipSpyApi ?? skipSpyApi,
    upgradeFactory: injected.upgradeFactoryApi ?? upgradeFactoryApi,
    convertGoldToRp: injected.convertGoldToRpApi ?? convertGoldToRpApi,
  };

  /** Mirrors `raceSlice.ts`'s own `session()` helper. */
  const session = (): { baseUrl: string; token: string } | undefined => {
    const { baseUrl, token } = get().auth;
    return token ? { baseUrl, token } : undefined;
  };

  /**
   * Adopts a fresh `SlotState` — from any action, or from `hydrate` — into
   * the store. Spreads the PREVIOUS `economyApi` first so the action
   * functions living alongside the state (this object owns both, per the
   * module doc comment) are never dropped, then re-anchors the monotonic
   * clock against this response's `serverNow`. Called on every successful
   * response, not only the first, which is what keeps the countdown from
   * drifting on a long-lived session.
   */
  const adopt = (lobbyId: string, state: SlotState): EconomyActionOutcome => {
    const outcome: EconomyActionOutcome = { ok: true, state };
    set((s) => ({
      economyApi: {
        ...s.economyApi,
        lobbyId,
        slot: state,
        anchor: makeAnchor(state.serverNow, clock),
        lastActionOutcome: outcome,
      },
    }));
    return outcome;
  };

  const fail = (error: string): EconomyActionOutcome => {
    const outcome: EconomyActionOutcome = { ok: false, error };
    set((s) => ({ economyApi: { ...s.economyApi, lastActionOutcome: outcome } }));
    return outcome;
  };

  /** Every action call (and `hydrate`) follows this exact shape: no session
   * -> local `not_signed_in` refusal with nothing sent; otherwise call the
   * given API function and adopt or report its result. */
  const run = async <TInput extends { lobbyId: string }>(
    lobbyId: string,
    call: (baseUrl: string, token: string, input: TInput) => Promise<ApiResult<SlotState>>,
    input: TInput,
  ): Promise<EconomyActionOutcome> => {
    const auth = session();
    if (!auth) return fail('not_signed_in');
    const res = await call(auth.baseUrl, auth.token, input);
    return res.ok ? adopt(lobbyId, res.data) : fail(res.error);
  };

  return {
    economyApi: {
      slot: null,

      hydrate: (lobbyId) => run(lobbyId, apis.getEconomyState, { lobbyId }),
      startUpgrade: (lobbyId, label) => run(lobbyId, apis.startUpgrade, { lobbyId, label }),
      startTraining: (lobbyId, driverIdx) => run(lobbyId, apis.startTraining, { lobbyId, driverIdx }),
      startSpyMission: (lobbyId, payload = {}) => run(lobbyId, apis.startSpyMission, { lobbyId, ...payload }),
      claimUpgrade: (lobbyId, jobId) => run(lobbyId, apis.claimUpgrade, { lobbyId, jobId }),
      claimTraining: (lobbyId, jobId) => run(lobbyId, apis.claimTraining, { lobbyId, jobId }),
      claimSpyReport: (lobbyId, jobId) => run(lobbyId, apis.claimSpyReport, { lobbyId, jobId }),
      skipUpgrade: (lobbyId, jobId) => run(lobbyId, apis.skipUpgrade, { lobbyId, jobId }),
      skipTraining: (lobbyId, jobId) => run(lobbyId, apis.skipTraining, { lobbyId, jobId }),
      skipSpy: (lobbyId, jobId) => run(lobbyId, apis.skipSpy, { lobbyId, jobId }),
      upgradeFactory: (lobbyId, code) => run(lobbyId, apis.upgradeFactory, { lobbyId, code }),
      convertGoldToRp: (lobbyId, gold) => run(lobbyId, apis.convertGoldToRp, { lobbyId, gold }),
    },
  };
}

/**
 * Milliseconds remaining on a job from the current slot, derived from the
 * slice's own `anchor` — never from `Date.now()`. Returns `undefined` when
 * there is no slot/anchor yet (nothing received from the server) so a
 * screen can tell "unknown" apart from "zero".
 */
export function remainingMsFor(
  economyApi: Pick<EconomyApiSliceState, 'anchor'>,
  job: SlotStateJob,
  clock: Clock = defaultClock,
): number | undefined {
  if (!economyApi.anchor) return undefined;
  return jobRemainingMs(job, economyApi.anchor, clock);
}
