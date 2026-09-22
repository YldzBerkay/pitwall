/**
 * Slot state — the single response shape for a team's economy slot.
 *
 * Spec: docs/superpowers/specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md
 *
 * THE SHAPE, AND WHY: the economy used to run on the client's `Date.now()`.
 * Moving the device clock forward finished a 22-hour upgrade instantly,
 * because the client computed "is this done yet" itself. The fix moves
 * every timer, and every write, onto the server — but that only closes the
 * hole if the client can never reconstruct authoritative state out of
 * fragments.
 *
 * That is why this module returns the WHOLE state of a slot — rp, gold,
 * car, factory, upgrade counters, every open job, team value, daily caps —
 * as one object, rather than exposing narrower endpoints that each return a
 * slice. With fragments, the client has to stitch several responses
 * together into "what does my slot look like now", and a single missed or
 * out-of-order partial update silently desynchronises the two sides — the
 * bug is invisible until a player notices their screen disagrees with the
 * server. With one full snapshot per response, there is nothing to stitch,
 * so that class of bug cannot exist. The command dispatcher that runs an
 * action and then calls `buildSlotState` to answer it is the next task;
 * this module only has to build the snapshot correctly.
 *
 * `serverNow` IS THE OTHER HALF OF THE ANTI-CHEAT STORY. Every response
 * carries the server's own clock reading (never the caller's), and the
 * client is expected to compute every countdown from the difference between
 * `serverNow` and its own clock at receipt time, re-deriving that offset on
 * every response. Moving the device clock then changes nothing: the visible
 * countdown is anchored to the server's notion of time, and `ready`/
 * `endsAt` on each job are themselves computed against the server-supplied
 * `now` that reached this function, never against anything the client sent.
 * See `buildSlotState`'s own doc comment for how `now` reaches here.
 */
import { loadTeamEconomy } from './repo.ts';
import { openJobs, type OpenJob } from './jobs.ts';
import { teamValue } from './value.ts';
import { goldOf, capsFor } from '../gold/repo.ts';
import { ADS_PER_DAY, GOLD_TO_RP_DAILY_CAP } from '@pitwall/shared/economy';

export class SlotStateError extends Error {
  reason: 'no_economy';
  constructor(reason: 'no_economy') {
    super(`buildSlotState: ${reason}`);
    this.reason = reason;
  }
}

export interface SlotStateJob {
  jobId: string;
  kind: OpenJob['kind'];
  payload: Record<string, unknown>;
  endsAt: string;
  ready: boolean;
  skipCostGold: number;
}

export interface SlotStateCaps {
  /** Rewarded ads the account may still watch before the server's UTC day rolls over. */
  adsLeft: number;
  /** Gold the account may still convert to RP before the server's UTC day rolls over. */
  convertibleLeft: number;
}

export interface SlotState {
  /** The server's own clock at the moment this snapshot was built — see the module docblock. */
  serverNow: string;
  lobbyId: string;
  teamKey: string;
  rp: number;
  gold: number;
  car: { motor: number; aero: number; grip: number };
  factory: Record<string, number>;
  upgradesDone: Record<string, number>;
  jobs: SlotStateJob[];
  teamValue: number;
  caps: SlotStateCaps;
}

export interface BuildSlotStateInput {
  lobbyId: string;
  teamKey: string;
  /** Account whose gold and daily caps apply to this slot. */
  userId: string;
  /**
   * The instant to evaluate job readiness and daily caps against. In
   * production the dispatcher passes its own fresh server-side reading, but
   * a test may pin any instant here to make `ready`/caps deterministic —
   * exactly like `jobs.ts`, this function must never read `Date.now()`
   * itself FOR THOSE COMPUTATIONS, so a test can control them precisely.
   *
   * This is deliberately NOT where `serverNow` on the response comes from.
   * See `serverNow`'s own doc comment below for why.
   */
  now: Date;
}

/**
 * Builds the full state of one team's economy slot.
 *
 * The four independent reads (economy row, open jobs, gold balance, daily
 * caps) are fetched CONCURRENTLY with `Promise.all`, not one after another —
 * this function runs on every command a player issues, so four sequential
 * round-trips would multiply the latency of every action by four for no
 * benefit; none of the four depends on another's result.
 *
 * A slot with no economy row (an unseeded team) is not a partially-built
 * response — it throws `SlotStateError('no_economy')` so the caller (the
 * command dispatcher) can turn it into a clean error response instead of
 * serialising a half-built object with nulls in place of rp/car/etc.
 *
 * `serverNow` is read from THIS function's own `new Date()`, never from the
 * `now` parameter. This is the one deliberate exception to "never read the
 * clock yourself": `now` is an input the caller controls (a test pins it; a
 * compromised or buggy dispatcher could in principle be tricked into
 * forwarding something caller-influenced), so echoing it back as
 * `serverNow` would make the field only as trustworthy as whatever produced
 * `now`. The whole anti-cheat story — the client re-deriving its countdowns
 * from the gap between `serverNow` and its own clock — only holds if
 * `serverNow` is the actual instant this machine believes it is, sampled
 * independently of anything passed in. `now` still governs `ready` and the
 * caps math, so tests stay deterministic for those.
 */
export async function buildSlotState(input: BuildSlotStateInput): Promise<SlotState> {
  const { lobbyId, teamKey, userId, now } = input;
  const serverNow = new Date();

  const [economy, jobs, gold, caps] = await Promise.all([
    loadTeamEconomy(lobbyId, teamKey),
    openJobs(lobbyId, teamKey, now),
    goldOf(userId),
    capsFor(userId, now),
  ]);

  if (!economy) {
    throw new SlotStateError('no_economy');
  }

  return {
    serverNow: serverNow.toISOString(),
    lobbyId,
    teamKey,
    rp: economy.rp,
    gold,
    car: economy.car,
    factory: economy.factoryLevels,
    upgradesDone: economy.upgradesDone,
    jobs: jobs.map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      payload: job.payload,
      endsAt: job.endsAt.toISOString(),
      ready: job.ready,
      skipCostGold: job.skipCostGold,
    })),
    teamValue: teamValue({ rp: economy.rp, car: economy.car, factoryLevels: economy.factoryLevels }),
    caps: {
      adsLeft: Math.max(0, ADS_PER_DAY - caps.adsWatched),
      convertibleLeft: Math.max(0, GOLD_TO_RP_DAILY_CAP - caps.goldConverted),
    },
  };
}
