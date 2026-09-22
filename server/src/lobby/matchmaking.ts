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
 * §3.4 asks that, ACROSS THE CANDIDATES SERVED, the strongest 3rd team is
 * really taken in 85% of them and the strongest 4th in 75%. That is a
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
import { SEAT_LADDER, TEAM_COUNT } from './grid.ts';

export interface Candidate {
  lobbyId: string;
  /** Team keys whose seat is held by a human, exactly as stored. */
  humanTeamKeys: readonly string[];
}

/**
 * §3.4's three rows, read off the real seats: the strongest 1st AND 2nd team
 * (`topPair`), the 3rd (`team3`, the 85% row) and the 4th (`team4`, the 75%
 * row). "The strongest n-th car" means the n-th team on SEAT_LADDER — see
 * its doc comment.
 */
export interface Occupancy {
  topPair: boolean;
  team3: boolean;
  team4: boolean;
}

export function occupancyOf(humanTeamKeys: readonly string[]): Occupancy {
  const held = new Set(humanTeamKeys);
  const at = (rank: number) => held.has(SEAT_LADDER[rank - 1]);
  return { topPair: at(1) && at(2), team3: at(3), team4: at(4) };
}

/**
 * The highest share of offers that can HONESTLY carry a taken n-th team.
 *
 * Players take the best free team, so a lobby's n-th team is taken from its
 * n-th manager onwards. A lobby seats 11, one of whom is its creator, so of
 * the 10 joiners it takes to fill, the first n-1 necessarily arrive while
 * the n-th team is still free. Every one of those joins is an accepted
 * offer, so at best (TEAM_COUNT - n) / (TEAM_COUNT - 1) of all offers can
 * show that team taken — 80% for the 3rd, 70% for the 4th.
 *
 * This is a property of the ecosystem, not of the selection: a lobby only
 * grows because the server sends people into it while it is still thin. No
 * policy can beat it without showing a seat as taken when it is not, which
 * §3.4 forbids outright. §3.4's own targets (85% / 75%) sit ABOVE it, and
 * `scripts/matchmaking-sim.ts` measures the gap rather than papering over
 * it.
 */
export function honestCeiling(rank: number): number {
  return (TEAM_COUNT - rank) / (TEAM_COUNT - 1);
}

export interface DistributionTargets {
  /** Share of served candidates whose strongest 3rd team is really taken. */
  team3: number;
  /** Share of served candidates whose strongest 4th team is really taken. */
  team4: number;
}

/** §3.4's stated aim. Above `honestCeiling` — see the note there. */
export const DEFAULT_TARGETS: DistributionTargets = { team3: 0.85, team4: 0.75 };

/**
 * How much more likely a lobby whose top two teams are taken is to be picked,
 * among the candidates that already match the wanted shape. §3.4 gives that
 * row "high weight — priority candidate", not "always", so this is a weight
 * and not a hard sort: a fresh lobby with an empty front row still gets
 * offered sometimes, which is how it ever fills up.
 */
const TOP_PAIR_WEIGHT = 4;

interface Tally {
  served: number;
  team3: number;
  team4: number;
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
  private tally: Tally = { served: 0, team3: 0, team4: 0 };

  constructor(private readonly targets: DistributionTargets = DEFAULT_TARGETS) {}

  /** Running share of served candidates for each target — for the sim/tests. */
  get ratios(): { served: number; team3: number; team4: number } {
    const { served, team3, team4 } = this.tally;
    return served === 0
      ? { served: 0, team3: 0, team4: 0 }
      : { served, team3: team3 / served, team4: team4 / served };
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
    // behind (serve one WITH that team), negative means ahead (serve one
    // WITHOUT it, so the ratio comes back down to the target).
    const deficit = {
      team3: this.targets.team3 * next - this.tally.team3,
      team4: this.targets.team4 * next - this.tally.team4,
    };
    const want = { team3: deficit.team3 > 0, team4: deficit.team4 > 0 };

    const matching = (wantTeam3: boolean | null, wantTeam4: boolean | null) =>
      pool.filter((c) => {
        const o = occupancyOf(c.humanTeamKeys);
        return (wantTeam3 === null || o.team3 === wantTeam3) && (wantTeam4 === null || o.team4 === wantTeam4);
      });

    // Ideally satisfy both wants at once. When the pool holds nothing of that
    // shape, give way on the target that is CLOSER to where it should be — a
    // fixed "team3 always wins" order would, in a thin pool, let the 4th-team
    // ratio drift while the 3rd-team ratio sat comfortably on target.
    const team3First = Math.abs(deficit.team3) >= Math.abs(deficit.team4);
    const subset =
      firstNonEmpty([
        matching(want.team3, want.team4),
        team3First ? matching(want.team3, null) : matching(null, want.team4),
        team3First ? matching(null, want.team4) : matching(want.team3, null),
        pool,
      ]) ?? pool;

    const chosen = weightedPick(subset, random);

    // Count what was ACTUALLY served, not what was wanted — when the pool
    // forced a relaxation, the tally has to know, or the next pick would
    // steer off a fiction.
    const actual = occupancyOf(chosen.humanTeamKeys);
    this.tally.served += 1;
    if (actual.team3) this.tally.team3 += 1;
    if (actual.team4) this.tally.team4 += 1;

    return chosen;
  }
}

function firstNonEmpty<T>(lists: readonly (readonly T[])[]): readonly T[] | null {
  for (const list of lists) if (list.length > 0) return list;
  return null;
}
