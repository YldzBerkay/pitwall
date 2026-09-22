/**
 * "Hızlı oyun bul" candidate selection — spec §3.3 and §3.4.
 *
 * ── The honesty rule ───────────────────────────────────────────────────────
 * Nothing in this file invents occupancy. A candidate's flags are read from
 * the seats that are REALLY held by humans, and the preview card the player
 * sees is rendered from the same rows. The distribution targets below shape
 * WHICH real lobby gets offered; they never change what the card says about
 * it. Fake scarcity is out of scope by explicit design decision (§3.4:
 * consumer-law and store-review risk), so if you ever find yourself wanting
 * a "displayHumans" field that differs from the row count, stop.
 *
 * ── What the targets mean ──────────────────────────────────────────────────
 * §3.4 asks that, ACROSS THE CANDIDATES SERVED, the strongest 3rd seat is
 * really taken in 85% of them and the strongest 4th seat in 75%. That is a
 * property of the stream of offers, not of any single offer, so this module
 * keeps a running tally and steers each pick toward whichever side of the
 * target it is currently short on — including steering DOWN, by preferring an
 * emptier lobby once the quota is already met. Steering down is not a
 * concession: an emptier lobby still needs players, and a stream that is 100%
 * top-heavy would starve every lobby that is one seat short of taking off.
 *
 * When the pool cannot satisfy the wanted shape, the wants are relaxed rather
 * than forced — §3.4: "Hedef oranı tutturacak aday yoksa sunucu sıralamayı
 * olduğu gibi kullanır."
 */
import { teamOfCar } from './grid.ts';

export interface Candidate {
  lobbyId: string;
  /** Team keys whose seat is held by a human, exactly as stored. */
  humanTeamKeys: readonly string[];
}

/**
 * Which of the grid's strongest CARS are really being driven by a human —
 * §3.4's three rows, in order. A car counts as filled when the team fielding
 * it has a human in its seat (one manager runs both of a team's cars).
 *
 * `topPair` is the first row (strongest 1st AND 2nd car), `car3` and `car4`
 * the two that carry the 85% and 75% targets. On the real grid those three
 * rows name three different teams — see CAR_LADDER in grid.ts — which is
 * exactly why they can hold different targets.
 */
export interface Occupancy {
  topPair: boolean;
  car3: boolean;
  car4: boolean;
}

export function occupancyOf(humanTeamKeys: readonly string[]): Occupancy {
  const held = new Set(humanTeamKeys);
  const car = (n: number) => held.has(teamOfCar(n));
  return { topPair: car(1) && car(2), car3: car(3), car4: car(4) };
}

export interface DistributionTargets {
  /** Share of served candidates whose strongest 3rd car is really taken. */
  car3: number;
  /** Share of served candidates whose strongest 4th car is really taken. */
  car4: number;
}

export const DEFAULT_TARGETS: DistributionTargets = { car3: 0.85, car4: 0.75 };

/**
 * How much more likely a lobby whose top two seats are taken is to be picked,
 * among the candidates that already match the wanted shape. §3.4 gives that
 * row "high weight — priority candidate", not "always", so this is a weight
 * and not a hard sort: a fresh lobby with an empty front row still gets
 * offered sometimes, which is how it ever fills up.
 */
const TOP_PAIR_WEIGHT = 4;

interface Tally {
  served: number;
  car3: number;
  car4: number;
}

function weightedPick<T extends Candidate>(pool: readonly T[], random: () => number): T {
  const weights = pool.map((c) => (occupancyOf(c.humanTeamKeys).topPair ? TOP_PAIR_WEIGHT : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let ticket = random() * total;
  for (let i = 0; i < pool.length; i += 1) {
    ticket -= weights[i];
    if (ticket < 0) return pool[i];
  }
  /* c8 ignore next -- only reachable on float drift at the very end */
  return pool[pool.length - 1];
}

/**
 * Stateful shaper over a stream of "Hızlı oyun bul" requests.
 *
 * One instance per server process. The tally is deliberately in-memory and
 * not persisted: it shapes a distribution, and a restart re-converging from
 * zero costs nothing but a handful of offers. It is NOT per player — the
 * targets in §3.4 are about the candidate stream as a whole, and a per-player
 * tally would let a player who keeps pressing "Başka bul" walk their own
 * quota down.
 */
export class CandidateShaper {
  private tally: Tally = { served: 0, car3: 0, car4: 0 };

  constructor(private readonly targets: DistributionTargets = DEFAULT_TARGETS) {}

  /** Running share of served candidates for each target — for the sim/tests. */
  get ratios(): { served: number; car3: number; car4: number } {
    const { served, car3, car4 } = this.tally;
    return served === 0
      ? { served: 0, car3: 0, car4: 0 }
      : { served, car3: car3 / served, car4: car4 / served };
  }

  /**
   * Picks one candidate out of an already-eligible pool (region, rank gate,
   * joinability and free seats are the caller's filter), or null when the
   * pool is empty — the caller then opens a fresh lobby (§3.4).
   */
  pick<T extends Candidate>(pool: readonly T[], random: () => number = Math.random): T | null {
    if (pool.length === 0) return null;

    const next = this.tally.served + 1;
    // How far each target is from where it should be by now. Positive means
    // behind (serve one WITH that car), negative means ahead (serve one
    // WITHOUT it, so the ratio comes back down to the target).
    const deficit = {
      car3: this.targets.car3 * next - this.tally.car3,
      car4: this.targets.car4 * next - this.tally.car4,
    };
    const want = { car3: deficit.car3 > 0, car4: deficit.car4 > 0 };

    const matching = (wantCar3: boolean | null, wantCar4: boolean | null) =>
      pool.filter((c) => {
        const o = occupancyOf(c.humanTeamKeys);
        return (wantCar3 === null || o.car3 === wantCar3) && (wantCar4 === null || o.car4 === wantCar4);
      });

    // Ideally satisfy both wants at once. When the pool holds nothing of that
    // shape, give way on the target that is CLOSER to where it should be — a
    // fixed "car3 always wins" order would, in a thin pool, let the 4th-car
    // ratio drift while the 3rd-car ratio sat comfortably on target.
    const car3First = Math.abs(deficit.car3) >= Math.abs(deficit.car4);
    const subset =
      firstNonEmpty([
        matching(want.car3, want.car4),
        car3First ? matching(want.car3, null) : matching(null, want.car4),
        car3First ? matching(null, want.car4) : matching(want.car3, null),
        pool,
      ]) ?? pool;

    const chosen = weightedPick(subset, random);

    // Count what was ACTUALLY served, not what was wanted — when the pool
    // forced a relaxation, the tally has to know, or the next pick would
    // steer off a fiction.
    const actual = occupancyOf(chosen.humanTeamKeys);
    this.tally.served += 1;
    if (actual.car3) this.tally.car3 += 1;
    if (actual.car4) this.tally.car4 += 1;

    return chosen;
  }
}

function firstNonEmpty<T>(lists: readonly (readonly T[])[]): readonly T[] | null {
  for (const list of lists) if (list.length > 0) return list;
  return null;
}
