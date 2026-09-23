/**
 * Proof that the economy's device-clock exploit is closed.
 *
 * The exploit: the client used to compute "is this job done yet" from its
 * own `Date.now()`. Moving the device's wall clock forward finished a
 * 22-hour upgrade instantly. The server closed this on its side (every job
 * timer now lives in Postgres and is only ever evaluated against a
 * server-supplied `now` — see `server/src/economy/jobs.ts`'s module doc
 * comment), but the client never called the server, so on the client the
 * hole was still open. `mobile/src/store/slices/economyClock.ts` is the fix:
 * every remaining-time countdown is derived from the server's own
 * `serverNow` (`SlotState.serverNow`, from `server/src/economy/state.ts`)
 * anchored against a MONOTONIC clock reading taken at receipt — never
 * against the wall clock again after that.
 *
 * This file injects a fake clock rather than monkey-patching the global
 * `Date` — overriding `Date` globally would make every timestamp in this
 * process (including ones `node:test` itself relies on) unreliable, and the
 * test would end up fighting its own harness instead of proving anything
 * about the code under test.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeAnchor, jobRemainingMs, type Clock } from '@/store/slices/economyClock';

/**
 * A fake device clock with two INDEPENDENT readings:
 *  - `now()` — the monotonic tick `economyClock.ts` is supposed to use
 *    (stands in for `performance.now()`, which a device's date/time
 *    setting cannot move).
 *  - `wallClockMs` — a separate value representing what `Date.now()` would
 *    return on the device. Nothing in `economyClock.ts` is ever handed this
 *    value; it exists only so the test can "move the device clock forward"
 *    and then check that doing so changed nothing.
 */
class FakeDeviceClock implements Clock {
  private monotonicMs = 0;
  wallClockMs = 0;

  now(): number {
    return this.monotonicMs;
  }

  /** Real time passing — both readings advance together, as they would on
   * an unmolested device. */
  advanceReal(ms: number): void {
    this.monotonicMs += ms;
    this.wallClockMs += ms;
  }

  /** The exploit attempt: the player drags their device's date/time
   * setting forward. No real time passes, so the monotonic clock this
   * module is supposed to rely on does not move — only the wall clock
   * reading does. */
  jumpWallClockForward(ms: number): void {
    this.wallClockMs += ms;
  }
}

const HOUR_MS = 3_600_000;

test("a job's remaining time is computed from serverNow, not Date.now()", () => {
  const clock = new FakeDeviceClock();
  const serverNow = '2026-09-24T00:00:00.000Z';
  const anchor = makeAnchor(serverNow, clock);

  const job = { endsAt: '2026-09-24T05:00:00.000Z' }; // 5h upgrade, freshly started

  // No real time has passed since the anchor was taken: remaining should be
  // exactly the gap between serverNow and endsAt — a value that comes
  // entirely from the server's own strings, never from this device's clock.
  assert.equal(jobRemainingMs(job, anchor, clock), 5 * HOUR_MS);

  // 2 real hours pass (monotonic clock ticks forward with them).
  clock.advanceReal(2 * HOUR_MS);
  assert.equal(jobRemainingMs(job, anchor, clock), 3 * HOUR_MS);
});

test('moving the device clock forward finishes nothing', () => {
  const clock = new FakeDeviceClock();
  const serverNow = '2026-09-24T00:00:00.000Z';
  const anchor = makeAnchor(serverNow, clock);

  // A 22-hour upgrade, just started — the exact scenario from the exploit
  // this task exists to close.
  const job = { endsAt: '2026-09-24T22:00:00.000Z' };

  const before = jobRemainingMs(job, anchor, clock);
  assert.equal(before, 22 * HOUR_MS);
  assert.equal(before > 0, true, 'sanity: the job must not already read as finished');

  // The exploit: drag the device's date/time forward by more than the
  // job's whole remaining duration. No real time passes (the monotonic
  // clock this module relies on is untouched).
  clock.jumpWallClockForward(30 * HOUR_MS);

  const after = jobRemainingMs(job, anchor, clock);
  assert.equal(after, before, 'the device clock jump must change nothing about the computed remaining time');
  assert.equal(after > 0, true, 'the job must still read as unfinished after the device clock was moved forward');

  // Sanity check the other direction: real time actually elapsing DOES
  // count down the job, so this isn't a stuck/broken calculation — it's
  // specifically immune to the wall-clock manipulation, not to time itself.
  clock.advanceReal(1 * HOUR_MS);
  const afterRealTime = jobRemainingMs(job, anchor, clock);
  assert.equal(afterRealTime, 21 * HOUR_MS);
});
