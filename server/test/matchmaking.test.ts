import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CandidateShaper,
  DEFAULT_TARGETS,
  honestCeiling,
  occupancyOf,
  type Candidate,
} from '../src/lobby/matchmaking.ts';
import {
  SEAT_LADDER,
  TEAM_COUNT,
  baseRankPoints,
  carRating,
  objectivePosition,
  previewSeats,
  rankPointsFor,
} from '../src/lobby/grid.ts';
import { nextRaceAt } from '../src/lobby/schedule.ts';
import { simulate, mulberry32 } from '../scripts/matchmaking-sim.ts';

describe('grid ladder', () => {
  it('has eleven seats, one per team', () => {
    assert.equal(SEAT_LADDER.length, 11);
    assert.equal(TEAM_COUNT, 11);
    assert.equal(new Set(SEAT_LADDER).size, 11);
  });

  it('orders the seat ladder by the same rating the card prints', () => {
    const ratings = SEAT_LADDER.map(carRating);
    for (let i = 1; i < ratings.length; i += 1) {
      assert.ok(ratings[i - 1] >= ratings[i], `ladder not descending at ${i}: ${ratings.join(',')}`);
    }
  });

  it('pays the spec card values for P5, P8 and P10', () => {
    // The three rows printed in §3.3's example.
    assert.equal(baseRankPoints(5), 850);
    assert.equal(baseRankPoints(8), 600);
    assert.equal(baseRankPoints(10), 400);
  });

  it('applies the AI difficulty multipliers to rank points (§3.5)', () => {
    const team = SEAT_LADDER[4];
    const normal = rankPointsFor(team, 'normal');
    assert.equal(rankPointsFor(team, 'easy'), Math.round(normal * 0.7));
    assert.equal(rankPointsFor(team, 'hard'), Math.round(normal * 1.4));
  });

  it('gives every team an objective inside the grid', () => {
    for (const key of SEAT_LADDER) {
      const p = objectivePosition(key);
      assert.ok(p >= 1 && p <= TEAM_COUNT, `${key} → P${p}`);
    }
  });

  it('lists the free teams best car first, with objective and reward', () => {
    const rows = previewSeats([SEAT_LADDER[6], SEAT_LADDER[1], SEAT_LADDER[9]], 'normal');
    assert.deepEqual(rows.map((r) => r.teamKey), [SEAT_LADDER[1], SEAT_LADDER[6], SEAT_LADDER[9]]);
    for (const row of rows) {
      assert.ok(row.rankPoints > 0);
      assert.ok(row.carRating > 0);
      assert.equal(row.objective, objectivePosition(row.teamKey));
    }
  });
});

describe('occupancyOf', () => {
  it('reads the top teams off the real seat keys', () => {
    assert.deepEqual(occupancyOf([]), { topPair: false, team3: false, team4: false });
    // The top pair is the strongest TWO teams, so one of them is not enough.
    assert.deepEqual(occupancyOf([SEAT_LADDER[0]]), { topPair: false, team3: false, team4: false });
    assert.deepEqual(occupancyOf([SEAT_LADDER[0], SEAT_LADDER[1]]), {
      topPair: true,
      team3: false,
      team4: false,
    });
    assert.deepEqual(occupancyOf([SEAT_LADDER[2]]), { topPair: false, team3: true, team4: false });
    assert.deepEqual(occupancyOf(SEAT_LADDER.slice(0, 4)), { topPair: true, team3: true, team4: true });
  });

  it('ignores team keys that are not on the grid', () => {
    assert.deepEqual(occupancyOf(['not-a-team']), { topPair: false, team3: false, team4: false });
  });
});

describe('CandidateShaper', () => {
  const full: Candidate = { lobbyId: 'full', humanTeamKeys: SEAT_LADDER.slice(0, 4) };
  const team3Only: Candidate = { lobbyId: 'team3', humanTeamKeys: [SEAT_LADDER[2]] };
  const team4Only: Candidate = { lobbyId: 'team4', humanTeamKeys: [SEAT_LADDER[3]] };
  const empty: Candidate = { lobbyId: 'empty', humanTeamKeys: [SEAT_LADDER[10]] };
  const varied = [full, team3Only, team4Only, empty];

  it('returns null for an empty pool so the caller opens a fresh lobby', () => {
    assert.equal(new CandidateShaper().pick([]), null);
  });

  it('only ever returns a candidate that was in the pool', () => {
    // The honesty rule: the shaper selects, it never synthesises.
    const shaper = new CandidateShaper();
    const random = mulberry32(11);
    for (let i = 0; i < 500; i += 1) {
      const chosen = shaper.pick([full, empty], random);
      assert.ok(chosen === full || chosen === empty);
    }
  });

  it('holds the 85/75 split when the pool can serve both shapes', () => {
    const shaper = new CandidateShaper();
    const random = mulberry32(3);
    for (let i = 0; i < 4000; i += 1) shaper.pick(varied, random);
    const { team3, team4 } = shaper.ratios;
    assert.ok(Math.abs(team3 - DEFAULT_TARGETS.team3) < 0.01, `team3 ${team3}`);
    assert.ok(Math.abs(team4 - DEFAULT_TARGETS.team4) < 0.01, `team4 ${team4}`);
  });

  it('splits the difference when the pool couples the two teams', () => {
    // Every candidate here either has BOTH top teams or neither, so no
    // selection can put the 3rd team at 85% and the 4th at 75% at the same
    // time. The shaper lands between the two targets rather than satisfying
    // one and letting the other drift — and, crucially, without inventing
    // the candidate that would satisfy both.
    const shaper = new CandidateShaper();
    const random = mulberry32(3);
    for (let i = 0; i < 4000; i += 1) shaper.pick([full, empty], random);
    const { team3, team4 } = shaper.ratios;
    assert.equal(team3, team4);
    assert.ok(team3 > DEFAULT_TARGETS.team4 && team3 < DEFAULT_TARGETS.team3, `${team3}`);
  });

  it('never exceeds what the pool really holds', () => {
    // A pool with nothing above the 3rd team can only ever produce 0% — the
    // shaper must report the shortfall, not invent occupancy (§3.4).
    const shaper = new CandidateShaper();
    const random = mulberry32(4);
    for (let i = 0; i < 500; i += 1) shaper.pick([empty], random);
    assert.equal(shaper.ratios.team3, 0);
    assert.equal(shaper.ratios.team4, 0);
  });
});

describe('matchmaking distribution simulation (§8, Faz 2 gate)', () => {
  const world = {
    requests: 12_000,
    acceptRate: 0.7,
    greedRate: 0.8,
    createRate: 0.065,
    seasonSpan: 2000,
    seed: 2,
  };

  it('meets §3.4\'s targets in a healthy pool', () => {
    const r = simulate(world);
    assert.ok(r.team3 >= DEFAULT_TARGETS.team3 - 0.02, `3rd team ${r.team3}`);
    assert.ok(r.team4 >= DEFAULT_TARGETS.team4 - 0.02, `4th team ${r.team4}`);
  });

  it('keeps the targets under what an eleven-seat grid honestly allows', () => {
    // The guard that made the targets what they are: a lobby only grows
    // because the server keeps sending people into it while its n-th team is
    // still free, which caps that share at (11 - n) / 10. A target above the
    // cap could only be "met" by showing a free seat as taken, which §3.4
    // forbids — so raising DEFAULT_TARGETS past this line has to fail here
    // rather than quietly turn the matchmaker into a liar.
    assert.ok(DEFAULT_TARGETS.team3 < honestCeiling(3), `${DEFAULT_TARGETS.team3} vs ${honestCeiling(3)}`);
    assert.ok(DEFAULT_TARGETS.team4 < honestCeiling(4), `${DEFAULT_TARGETS.team4} vs ${honestCeiling(4)}`);
    const r = simulate(world);
    assert.ok(r.team3 <= honestCeiling(3), `3rd team ${r.team3} above the ceiling`);
    assert.ok(r.team4 <= honestCeiling(4), `4th team ${r.team4} above the ceiling`);
  });

  it('never shows more occupancy than the pool actually had', () => {
    for (const greedRate of [0.2, 0.5, 0.8]) {
      const r = simulate({ ...world, greedRate });
      assert.ok(r.team3 <= r.feasibleTeam3 + 1e-9, `greed ${greedRate}: ${r.team3} > ${r.feasibleTeam3}`);
      assert.ok(r.team4 <= r.feasibleTeam4 + 1e-9, `greed ${greedRate}: ${r.team4} > ${r.feasibleTeam4}`);
    }
  });

  it('falls short honestly when the pool cannot supply the shape', () => {
    // Players picking seats at random never fill the top cars, so no honest
    // selection can reach 85%. The server must report the real number.
    const r = simulate({ ...world, greedRate: 0.2, seed: 5 });
    assert.ok(r.team3 < DEFAULT_TARGETS.team3, `3rd car ${r.team3}`);
    assert.ok(r.team3 <= r.feasibleTeam3 + 1e-9);
  });

  it('is deterministic for a given seed', () => {
    assert.deepEqual(simulate(world), simulate(world));
  });
});

describe('nextRaceAt', () => {
  it('lands on the region race hour in the region time zone', () => {
    const at = nextRaceAt('EU', new Date('2026-06-15T09:00:00Z'));
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
    assert.equal(local, '21:00');
  });

  it('is always in the future, even past the hour', () => {
    const now = new Date('2026-06-15T21:30:00Z');
    const at = nextRaceAt('EU', now);
    assert.ok(at.getTime() > now.getTime());
    assert.ok(at.getTime() - now.getTime() <= 25 * 60 * 60 * 1000);
  });

  it('keeps the local hour across a DST change', () => {
    // Europe/Berlin shifts on 2026-03-29; the race hour must not drift.
    for (const day of ['2026-03-27', '2026-03-30']) {
      const at = nextRaceAt('EU', new Date(`${day}T09:00:00Z`));
      const hour = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin',
        hour: '2-digit',
        hour12: false,
      }).format(at);
      assert.equal(hour, '21', day);
    }
  });

  it('covers every region', () => {
    for (const region of ['EU', 'NA', 'LATAM', 'MENA', 'APAC', 'SEA', 'OCE'] as const) {
      const at = nextRaceAt(region, new Date('2026-06-15T09:00:00Z'));
      assert.ok(Number.isFinite(at.getTime()), region);
    }
  });
});
