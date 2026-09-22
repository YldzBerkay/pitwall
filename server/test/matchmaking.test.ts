import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CandidateShaper,
  DEFAULT_TARGETS,
  occupancyOf,
  type Candidate,
} from '../src/lobby/matchmaking.ts';
import {
  CAR_LADDER,
  SEAT_LADDER,
  TEAM_COUNT,
  baseRankPoints,
  carRating,
  objectivePosition,
  previewSeats,
  rankPointsFor,
  teamOfCar,
} from '../src/lobby/grid.ts';
import { nextRaceAt } from '../src/lobby/schedule.ts';
import { simulate, mulberry32 } from '../scripts/matchmaking-sim.ts';

describe('grid ladder', () => {
  it('has eleven seats and twenty-two cars', () => {
    assert.equal(SEAT_LADDER.length, 11);
    assert.equal(TEAM_COUNT, 11);
    assert.equal(CAR_LADDER.length, 22);
  });

  it('spreads the strongest four cars over three different teams', () => {
    // This is what makes §3.4's three rows independent conditions — if the
    // top four cars were two teams' pairs, the 85% and 75% targets would be
    // the same statement. Guarding it here because it is a property of the
    // grid data (teams.ts), which can be re-balanced.
    const top4 = [1, 2, 3, 4].map(teamOfCar);
    assert.equal(top4[0], top4[1], 'cars 1 and 2 should be the same team');
    assert.equal(new Set(top4).size, 3, `expected three teams in ${top4.join(', ')}`);
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
  it('reads the top cars off the real seat keys', () => {
    assert.deepEqual(occupancyOf([]), { topPair: false, car3: false, car4: false });
    assert.deepEqual(occupancyOf([teamOfCar(1)]), { topPair: true, car3: false, car4: false });
    assert.deepEqual(occupancyOf([teamOfCar(3)]), { topPair: false, car3: true, car4: false });
    assert.deepEqual(occupancyOf([teamOfCar(1), teamOfCar(3), teamOfCar(4)]), {
      topPair: true,
      car3: true,
      car4: true,
    });
  });

  it('ignores team keys that are not on the grid', () => {
    assert.deepEqual(occupancyOf(['not-a-team']), { topPair: false, car3: false, car4: false });
  });
});

describe('CandidateShaper', () => {
  const full: Candidate = { lobbyId: 'full', humanTeamKeys: [teamOfCar(1), teamOfCar(3), teamOfCar(4)] };
  const car3Only: Candidate = { lobbyId: 'car3', humanTeamKeys: [teamOfCar(3)] };
  const car4Only: Candidate = { lobbyId: 'car4', humanTeamKeys: [teamOfCar(4)] };
  const empty: Candidate = { lobbyId: 'empty', humanTeamKeys: [teamOfCar(11)] };
  const varied = [full, car3Only, car4Only, empty];

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
    const { car3, car4 } = shaper.ratios;
    assert.ok(Math.abs(car3 - DEFAULT_TARGETS.car3) < 0.01, `car3 ${car3}`);
    assert.ok(Math.abs(car4 - DEFAULT_TARGETS.car4) < 0.01, `car4 ${car4}`);
  });

  it('splits the difference when the pool couples the two cars', () => {
    // Every candidate here either has BOTH top cars or neither, so no
    // selection can put the 3rd car at 85% and the 4th at 75% at the same
    // time. The shaper lands between the two targets rather than satisfying
    // one and letting the other drift — and, crucially, without inventing
    // the candidate that would satisfy both.
    const shaper = new CandidateShaper();
    const random = mulberry32(3);
    for (let i = 0; i < 4000; i += 1) shaper.pick([full, empty], random);
    const { car3, car4 } = shaper.ratios;
    assert.equal(car3, car4);
    assert.ok(car3 > DEFAULT_TARGETS.car4 && car3 < DEFAULT_TARGETS.car3, `${car3}`);
  });

  it('never exceeds what the pool really holds', () => {
    // A pool with nothing above the 3rd car can only ever produce 0% — the
    // shaper must report the shortfall, not invent occupancy (§3.4).
    const shaper = new CandidateShaper();
    const random = mulberry32(4);
    for (let i = 0; i < 500; i += 1) shaper.pick([empty], random);
    assert.equal(shaper.ratios.car3, 0);
    assert.equal(shaper.ratios.car4, 0);
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

  it('meets the 85% / 75% targets in a healthy pool', () => {
    const r = simulate(world);
    assert.ok(r.car3 >= DEFAULT_TARGETS.car3 - 0.02, `3rd car ${r.car3}`);
    assert.ok(r.car4 >= DEFAULT_TARGETS.car4 - 0.02, `4th car ${r.car4}`);
  });

  it('never shows more occupancy than the pool actually had', () => {
    for (const greedRate of [0.2, 0.5, 0.8]) {
      const r = simulate({ ...world, greedRate });
      assert.ok(r.car3 <= r.feasibleCar3 + 1e-9, `greed ${greedRate}: ${r.car3} > ${r.feasibleCar3}`);
      assert.ok(r.car4 <= r.feasibleCar4 + 1e-9, `greed ${greedRate}: ${r.car4} > ${r.feasibleCar4}`);
    }
  });

  it('falls short honestly when the pool cannot supply the shape', () => {
    // Players picking seats at random never fill the top cars, so no honest
    // selection can reach 85%. The server must report the real number.
    const r = simulate({ ...world, greedRate: 0.2, seed: 5 });
    assert.ok(r.car3 < DEFAULT_TARGETS.car3, `3rd car ${r.car3}`);
    assert.ok(r.car3 <= r.feasibleCar3 + 1e-9);
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
