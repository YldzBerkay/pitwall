/**
 * The other half of the anti-cheat story `server/src/economy/state.ts`
 * describes: turning a `SlotState.serverNow` reading into a remaining-time
 * countdown WITHOUT ever trusting this device's own wall clock again.
 *
 * THE EXPLOIT THIS CLOSES: the economy used to run on the client's
 * `Date.now()`. Moving the device's date/time setting forward finished a
 * 22-hour upgrade instantly, because the client computed "is this done yet"
 * from its own clock. The server closed its half by moving every job timer
 * onto Postgres, evaluated only against a server-supplied `now`
 * (`server/src/economy/jobs.ts`) — but that only protects the CLIENT if the
 * client's own displayed countdown is also immune to the same trick.
 *
 * THE FIX: a `SlotState` response carries `serverNow` — the server's own
 * clock at the moment it built the snapshot, sampled independently of
 * anything the client sent (`state.ts`'s own doc comment). `makeAnchor`
 * pairs that server reading with a MONOTONIC clock reading taken at receipt
 * (`Clock.now()`, backed by `performance.now()` by default — a reading a
 * device's date/time setting cannot move, because it counts elapsed time,
 * not wall-clock position). `jobRemainingMs` then estimates "what does the
 * server's clock read right now" by advancing the anchored `serverNow` by
 * however much the MONOTONIC clock has ticked since — never by reading the
 * wall clock again. Dragging the device's date forward changes the wall
 * clock but not the monotonic one, so it cannot move this estimate at all;
 * only real elapsed time can. See `mobile/test/device-clock.test.ts` for
 * the proof.
 *
 * Kept free of React Native/Expo imports (plain functions over plain data)
 * so it can run under `tsx --test`, same discipline as `raceSlice.ts`'s
 * `displayQualifying`/`displayRace` selectors.
 */

/** A source of monotonically increasing milliseconds — never the wall clock. */
export interface Clock {
  now(): number;
}

/**
 * The real clock: `performance.now()` where available (RN/Expo/browsers,
 * and Node — all monotonic, all unaffected by the device's date/time
 * setting), falling back to `Date.now()` only on a runtime that somehow
 * lacks it. Tests inject their own `Clock` instead of relying on this.
 */
export const defaultClock: Clock = {
  now: () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(),
};

/**
 * A `serverNow` reading anchored to a monotonic instant. Build one every
 * time a `SlotState` response arrives; `estimatedServerNowMs`/
 * `jobRemainingMs` derive everything else from it without ever reading the
 * wall clock again.
 */
export interface ServerTimeAnchor {
  /** `Date.parse(serverNow)` at the moment this anchor was made. */
  serverNowMs: number;
  /** `clock.now()` at that same moment — the monotonic reference point. */
  monotonicAtReceipt: number;
}

/** Anchors a `SlotState.serverNow` string against the given (or default) monotonic clock. */
export function makeAnchor(serverNow: string, clock: Clock = defaultClock): ServerTimeAnchor {
  return { serverNowMs: Date.parse(serverNow), monotonicAtReceipt: clock.now() };
}

/**
 * The server's clock as it must read right now, estimated from an anchor
 * and however much monotonic time has passed since. This is the ONLY place
 * "now" is reconstructed after an anchor is made, and it never consults the
 * wall clock to do it.
 */
export function estimatedServerNowMs(anchor: ServerTimeAnchor, clock: Clock = defaultClock): number {
  return anchor.serverNowMs + (clock.now() - anchor.monotonicAtReceipt);
}

/**
 * Milliseconds remaining until `job.endsAt` (an ISO instant from a
 * `SlotStateJob`), measured against the estimated server clock — never
 * against `Date.now()`. Floors at 0 rather than going negative, mirroring
 * `@pitwall/shared/economy`'s own `skipCostGold(remainingMs)` contract.
 */
export function jobRemainingMs(job: { endsAt: string }, anchor: ServerTimeAnchor, clock: Clock = defaultClock): number {
  return Math.max(0, Date.parse(job.endsAt) - estimatedServerNowMs(anchor, clock));
}
