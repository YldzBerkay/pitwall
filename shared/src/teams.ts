/**
 * The grid: eleven teams, twenty-two cars, and the championship table they
 * race for.
 *
 * Until now the game carried the team's championship position as a single
 * hand-set number, which meant nothing could ever move it and sponsors were
 * priced against a constant. A real grid gives that number something to come
 * from: every team has a `baseStrength` — the pre-season pecking order — and
 * results accumulate into points, so the table (and with it what brands are
 * willing to pay) shifts across a season.
 *
 * All teams and drivers are fictional.
 */

import { rng } from './rng';

/**
 * What a driver is made of, each 0-100. The race engine reads every one of
 * them somewhere: `pace` is the driver's share of lap time, `consistency`
 * shrinks the lap-to-lap shake and looks after the tyres, `racecraft` wins and
 * defends overtakes, `wet` is worth up to half a second a lap in the rain,
 * `reaction` is the launch when the five lights go out, and `dev` is how much
 * the driver's feedback speeds up car development (not yet used by the race).
 */
export interface DriverStats {
  pace: number;
  consistency: number;
  racecraft: number;
  wet: number;
  reaction: number;
  dev: number;
}

export interface Driver {
  name: string;
  /** Racing number, unique across the grid. */
  number: number;
  /**
   * Overall ability, 0-100 — a weighted read of `stats`, kept for tables and
   * sorting. Related to the team's strength but not the same thing: a big team
   * can carry a weak second seat, and a backmarker can hide a star. The car is
   * still what wins — see `corePace` in raceEngine, where the driver is about
   * a quarter of the pace.
   */
  skill: number;
  stats: DriverStats;
  /** Years. Development is fast until the mid-twenties, flat at the peak, negative past 33. */
  age: number;
  /** The overall rating this driver could reach with training. */
  potential: number;
}

/** The overall rating the sport would print next to the name. */
export const overallOf = (s: DriverStats): number =>
  Math.round(s.pace * 0.4 + s.consistency * 0.2 + s.racecraft * 0.2 + s.wet * 0.1 + s.reaction * 0.1);

export interface Team {
  key: string;
  name: string;
  /** Three-letter form used in tables. */
  short: string;
  colour: string;
  /**
   * Pre-season pace, 0-100. This is the "default starting strength" the
   * sponsor market reads: a team with a big reputation keeps some of its
   * pulling power through a bad season, and a backmarker having a lucky run
   * does not suddenly command title money.
   */
  baseStrength: number;
  drivers: [Driver, Driver];
  isPlayer?: boolean;
}

export const teams: Team[] = [
  {
    key: 'aurelia',
    name: 'Aurelia Corse',
    short: 'AUR',
    colour: '#D1242F',
    baseStrength: 93,
    drivers: [
      {
        name: 'M. Calvani',
        number: 3,
        skill: 96,
        stats: { pace: 95, consistency: 97, racecraft: 99, wet: 99, reaction: 85, dev: 66 },
        age: 24,
        potential: 99,
      },
      {
        name: 'E. Duarte',
        number: 27,
        skill: 92,
        stats: { pace: 91, consistency: 91, racecraft: 92, wet: 92, reaction: 95, dev: 72 },
        age: 28,
        potential: 99,
      },
    ],
  },
  {
    key: 'silberpfad',
    name: 'Silberpfad GP',
    short: 'SIL',
    colour: '#B7C2CC',
    baseStrength: 91,
    drivers: [
      {
        name: 'J. Hallström',
        number: 9,
        skill: 90,
        stats: { pace: 90, consistency: 86, racecraft: 88, wet: 96, reaction: 99, dev: 73 },
        age: 27,
        potential: 96,
      },
      {
        name: 'T. Brecht',
        number: 44,
        skill: 86,
        stats: { pace: 87, consistency: 85, racecraft: 80, wet: 87, reaction: 94, dev: 49 },
        age: 24,
        potential: 99,
      },
    ],
  },
  {
    key: 'bravado',
    name: 'Bravado Racing',
    short: 'BRV',
    colour: '#2B3EA8',
    baseStrength: 89,
    drivers: [
      {
        name: 'R. Vandermeer',
        number: 1,
        skill: 96,
        stats: { pace: 95, consistency: 97, racecraft: 98, wet: 99, reaction: 94, dev: 42 },
        age: 30,
        potential: 99,
      },
      {
        name: 'K. Osei',
        number: 18,
        skill: 86,
        stats: { pace: 87, consistency: 82, racecraft: 81, wet: 85, reaction: 99, dev: 53 },
        age: 36,
        potential: 87,
      },
    ],
  },
  {
    key: 'northgate',
    name: 'Northgate F1',
    short: 'NGT',
    colour: '#F2760C',
    baseStrength: 82,
    drivers: [
      {
        name: 'O. Lindqvist',
        number: 6,
        skill: 87,
        stats: { pace: 86, consistency: 93, racecraft: 83, wet: 86, reaction: 89, dev: 72 },
        age: 26,
        potential: 96,
      },
      {
        name: 'S. Mbeki',
        number: 31,
        skill: 78,
        stats: { pace: 76, consistency: 80, racecraft: 74, wet: 81, reaction: 89, dev: 41 },
        age: 32,
        potential: 80,
      },
    ],
  },
  {
    key: 'ravensworth',
    name: 'Ravensworth',
    short: 'RVW',
    colour: '#1F7A5A',
    baseStrength: 76,
    drivers: [
      {
        name: 'D. Achterberg',
        number: 12,
        skill: 76,
        stats: { pace: 78, consistency: 77, racecraft: 75, wet: 69, reaction: 72, dev: 75 },
        age: 31,
        potential: 78,
      },
      {
        name: 'L. Moreau',
        number: 25,
        skill: 78,
        stats: { pace: 78, consistency: 82, racecraft: 85, wet: 64, reaction: 73, dev: 60 },
        age: 24,
        potential: 96,
      },
    ],
  },
  {
    key: 'bosphorus',
    name: 'Bosphorus Apex',
    short: 'BSA',
    colour: '#D4FF3D',
    baseStrength: 70,
    isPlayer: true,
    drivers: [
      {
        name: 'A. Kayacan',
        number: 7,
        skill: 77,
        stats: { pace: 78, consistency: 74, racecraft: 77, wet: 70, reaction: 88, dev: 74 },
        age: 24,
        potential: 93,
      },
      {
        name: 'N. Ferreira',
        number: 21,
        skill: 75,
        stats: { pace: 74, consistency: 80, racecraft: 70, wet: 84, reaction: 66, dev: 77 },
        age: 31,
        potential: 80,
      },
    ],
  },
  {
    key: 'ridgeline',
    name: 'Ridgeline Racing',
    short: 'RDG',
    colour: '#7A4BD6',
    baseStrength: 66,
    drivers: [
      {
        name: 'P. Novák',
        number: 14,
        skill: 74,
        stats: { pace: 76, consistency: 68, racecraft: 75, wet: 85, reaction: 69, dev: 85 },
        age: 20,
        potential: 91,
      },
      {
        name: 'H. Tanaka',
        number: 38,
        skill: 73,
        stats: { pace: 69, consistency: 78, racecraft: 78, wet: 76, reaction: 62, dev: 46 },
        age: 36,
        potential: 74,
      },
    ],
  },
  {
    key: 'castellan',
    name: 'Castellan GP',
    short: 'CST',
    colour: '#16A4C8',
    baseStrength: 61,
    drivers: [
      {
        name: 'F. Okonkwo',
        number: 5,
        skill: 81,
        stats: { pace: 84, consistency: 82, racecraft: 74, wet: 80, reaction: 81, dev: 56 },
        age: 31,
        potential: 85,
      },
      {
        name: 'V. Sandoval',
        number: 47,
        skill: 76,
        stats: { pace: 77, consistency: 73, racecraft: 81, wet: 74, reaction: 72, dev: 77 },
        age: 27,
        potential: 83,
      },
    ],
  },
  {
    key: 'verano',
    name: 'Verano Motorsport',
    short: 'VRN',
    colour: '#E0A21B',
    baseStrength: 55,
    drivers: [
      {
        name: 'C. Bellandi',
        number: 11,
        skill: 71,
        stats: { pace: 69, consistency: 75, racecraft: 72, wet: 80, reaction: 57, dev: 78 },
        age: 33,
        potential: 74,
      },
      {
        name: 'Y. Demirağ',
        number: 33,
        skill: 62,
        stats: { pace: 63, consistency: 63, racecraft: 59, wet: 57, reaction: 71, dev: 41 },
        age: 26,
        potential: 68,
      },
    ],
  },
  {
    key: 'falkirk',
    name: 'Falkirk Racing',
    short: 'FLK',
    colour: '#5D6B7A',
    baseStrength: 48,
    drivers: [
      {
        name: 'G. Whitlock',
        number: 16,
        skill: 63,
        stats: { pace: 67, consistency: 61, racecraft: 59, wet: 55, reaction: 66, dev: 61 },
        age: 32,
        potential: 69,
      },
      {
        name: 'I. Petrov',
        number: 52,
        skill: 62,
        stats: { pace: 62, consistency: 53, racecraft: 66, wet: 68, reaction: 64, dev: 81 },
        age: 27,
        potential: 69,
      },
    ],
  },
  {
    key: 'orenda',
    name: 'Orenda GP',
    short: 'ORN',
    colour: '#C4517B',
    baseStrength: 41,
    drivers: [
      {
        name: 'B. Sorensen',
        number: 22,
        skill: 61,
        stats: { pace: 65, consistency: 54, racecraft: 56, wet: 67, reaction: 62, dev: 61 },
        age: 30,
        potential: 67,
      },
      {
        name: 'Z. Haddad',
        number: 77,
        skill: 61,
        stats: { pace: 60, consistency: 65, racecraft: 66, wet: 58, reaction: 52, dev: 63 },
        age: 29,
        potential: 63,
      },
    ],
  },
];

export const teamByKey = (key: string): Team =>
  teams.find((t) => t.key === key) ?? teams[0];

export const playerTeam: Team = teams.find((t) => t.isPlayer) ?? teams[0];

/** Points for the top ten finishers, as in the real championship. */
export const POINTS_FOR_PLACE = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
/** Sprint points, top eight. */
export const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

export interface TeamStanding {
  teamKey: string;
  points: number;
  /** 1-based, recomputed whenever points change. */
  position: number;
}


function ranked(points: Map<string, number>): TeamStanding[] {
  return teams
    .map((t) => ({ teamKey: t.key, points: points.get(t.key) ?? 0, position: 0 }))
    // Ties go to the stronger car, which is how a countback tends to fall.
    .sort((a, b) => b.points - a.points || teamByKey(b.teamKey).baseStrength - teamByKey(a.teamKey).baseStrength)
    .map((row, i) => ({ ...row, position: i + 1 }));
}

/**
 * Add one race's points to the table.
 *
 * `finishOrder` is the twenty-two team keys in finishing order, DNFs last;
 * only the first ten score. This is the ONLY place points are handed out, so
 * the season total is always `rounds * sum(POINTS_FOR_PLACE)`.
 */
export function applyRacePoints(standings: TeamStanding[], finishOrder: string[]): TeamStanding[] {
  const points = new Map(standings.map((s) => [s.teamKey, s.points]));
  finishOrder.slice(0, POINTS_FOR_PLACE.length).forEach((teamKey, place) => {
    points.set(teamKey, (points.get(teamKey) ?? 0) + POINTS_FOR_PLACE[place]);
  });
  return ranked(points);
}

/** Sprint points into the table; same shape as `applyRacePoints`. */
export function applySprintPoints(standings: TeamStanding[], finishOrder: string[]): TeamStanding[] {
  const points = new Map(standings.map((s) => [s.teamKey, s.points]));
  finishOrder.slice(0, SPRINT_POINTS.length).forEach((teamKey, place) => {
    points.set(teamKey, (points.get(teamKey) ?? 0) + SPRINT_POINTS[place]);
  });
  return ranked(points);
}

/**
 * The table as it stands after `roundsRun` races, seeded from pre-season pace.
 *
 * A save that opens mid-season needs a plausible history behind it, and
 * replaying the whole season every launch would be wasteful — so the points
 * are drawn straight from each team's expected scoring rate, with the same
 * seeded noise that makes one team's season better than its car.
 */
export function seedStandings(roundsRun: number): TeamStanding[] {
  const random = rng(4242);
  const points = new Map<string, number>();
  for (const team of teams) {
    // Roughly: the strongest car averages ~30 points a weekend across two
    // cars, the slowest scores almost nothing.
    const rate = Math.max(0, (team.baseStrength - 38) / 62) ** 1.6 * 31;
    const luck = 0.82 + random() * 0.36;
    points.set(team.key, Math.round(rate * roundsRun * luck));
  }
  return ranked(points);
}

export const positionOf = (standings: TeamStanding[], teamKey: string): number =>
  standings.find((s) => s.teamKey === teamKey)?.position ?? teams.length;
