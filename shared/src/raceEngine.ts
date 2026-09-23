/**
 * The race weekend as arithmetic.
 *
 * Car + driver + circuit → a pace number for each of the twenty-two cars.
 * Practice and qualifying turn pace plus a seeded shake into a classification.
 * The race is run LAP BY LAP: each lap every car adds a lap time built from
 * its pace, its tyre's age, the weather, a pit stop if it takes one, and a
 * shake; cars that would pass the car ahead only do so as often as the
 * circuit allows. Cumulative time is the order; the order is the result.
 *
 * `startRace` / `advanceLap` / `finishRace` expose that loop one lap at a time
 * so a screen can play it out and let the player call a pit stop mid-race.
 * `simulateRace` runs the same loop to the flag in one call, with an
 * automatic strategy for the player, for tests and for "skip to end".
 *
 * Pure TypeScript: no React, no store. Everything random is seeded (see
 * `rng.ts`) and each lap draws from its own seed, so a race replayed from any
 * saved state gives the same laps — nobody can re-roll a bad afternoon.
 */

import type { CompoundKey } from './carCustomisation';
import { bell, rng } from './rng';
import { applyRacePoints, applySprintPoints, playerTeam, teams, type Driver, type Team, type TeamStanding } from './teams';
import { sprintLaps, type Track } from './tracks';

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface CarSetup {
  motor: number;
  aero: number;
  grip: number;
  /** Starting compound (and the qualifying tyre). */
  compound: CompoundKey;
  /**
   * Practice setup bias, -1 (all aero) to +1 (all mechanical). Shifts a few
   * points between AERO and GRIP so the manager can lean the car toward what
   * the circuit wants.
   */
  bias?: number;
}

// ── Yarış günü kilidi ──────────────────────────────────────────────────────
// Işıklar söndüğünde fabrikada hâlâ bir parça varsa araç sökük yarışır.
// Ceza yarış sonunda kalkar ve geliştirme kaldığı yerden devam eder: oyuncu
// bir yarışı kaybeder, yatırımını değil. Bu, "hangisini başlatayım, yarışa
// yetişir mi" kararının gerçek bedelidir — zaman da bir kaynak olsun diye.

/** Sökük araçta güvenilirlik bu katsayıya bölünür, yani DNF riski katlanır. */
export const CRIPPLED_DNF_SCALE = 2;

const statFieldOf: Record<string, 'motor' | 'aero' | 'grip' | undefined> = {
  MOTOR: 'motor',
  AERO: 'aero',
  GRIP: 'grip',
};

/**
 * Pişen stat'ı yarı değerine indirir. `buildingLabel` yoksa setup'ı aynen
 * döner (referans eşitliği korunur, gereksiz yeniden hesap olmasın).
 */
export function crippleSetup(setup: CarSetup, buildingLabel: string | undefined): CarSetup {
  const field = buildingLabel ? statFieldOf[buildingLabel] : undefined;
  if (!field) return setup;
  return { ...setup, [field]: Math.round(setup[field] / 2) };
}

export interface RaceConditions {
  track: Track;
  wet: boolean;
}

/** Qualifying approach. Aggressive buys pace at the risk of a ruined lap. */
export type QualiRisk = 'safe' | 'aggressive';

export type Session = 'practice' | 'quali' | 'race';

/** One car on the grid or in the results. */
export interface GridEntry {
  teamKey: string;
  /** Index into the team's `drivers` tuple. */
  driverIdx: 0 | 1;
  driver: string;
}

/** Stable id for one car across a weekend: `teamKey:driverIdx`. */
export const carId = (e: GridEntry): string => `${e.teamKey}:${e.driverIdx}`;

/** How a pit wall behaves when it runs on its own (the assistant, or a preset). */
export type TacticPreset = 'conservative' | 'balanced' | 'aggressive';

/**
 * A team that races on its OWN sheet rather than on `baseStrength`: the
 * player, and in the online game every other human-run team. `managed` says
 * who calls the pit stops this race — the human live, or the assistant bot on
 * the team's preset tactics (with a margin of error) when the manager did not
 * check in before lights out.
 */
export interface TeamEntry {
  setup: CarSetup;
  reliability: number;
  tactics: TacticPreset;
  managed: 'human' | 'assistant';
  /** The team's own driver pair when it differs from `teams.ts` (training, transfers). */
  drivers?: [Driver, Driver];
  /** Pit crew: seconds saved per stop and the chance a stop goes wrong (+5 s). */
  pitSecondsSaved?: number;
  pitFailChance?: number;
  /** Strategist: 0-1 multiplier on the assistant bot's error rates. */
  assistantErrorScale?: number;
}

/** Permanent strength gained by AI teams (rival intelligence), by team key. */
export type AiBonus = Record<string, number>;

/** Every team's live driver pair, by team key; falls back to `teams.ts` when a team is absent. */
export type Rosters = Record<string, [Driver, Driver]>;

/** Teams racing on their own sheet, by team key. Teams absent here are AI. */
export type Entries = Record<string, TeamEntry>;

/** Pit calls for this lap, by `carId`. Only human-managed cars are read. */
export type Decisions = Record<string, PitDecision | undefined>;

// ── Pace ───────────────────────────────────────────────────────────────────

/** Car is three quarters of the pace, driver one quarter — F1 is a car sport, and this is a development game. */
const CAR_WEIGHT = 0.75;
const DRIVER_WEIGHT = 0.25;

/** How many points of AERO/GRIP a full setup bias moves. */
const BIAS_SWING = 4;

/** The stat sheet after the practice bias is applied. */
export function effectiveStats(setup: CarSetup): Pick<CarSetup, 'motor' | 'aero' | 'grip'> {
  const b = Math.max(-1, Math.min(1, setup.bias ?? 0));
  return {
    motor: setup.motor,
    aero: Math.max(0, Math.min(100, setup.aero - b * BIAS_SWING)),
    grip: Math.max(0, Math.min(100, setup.grip + b * BIAS_SWING)),
  };
}

/** How much of the track's demand the car's stats cover, 0-100. */
export function statScore(setup: CarSetup, track: Track): number {
  const s = effectiveStats(setup);
  const { demand } = track;
  return s.motor * demand.motor + s.aero * demand.aero + s.grip * demand.grip;
}

/**
 * Tyre pace over ONE LAP, in the same units as `statScore`, for the timed
 * sessions where tyre age does not matter. Softer is faster; the wrong family
 * for the weather is a disaster, and the bad choice costs far more than the
 * good one gains — the weekend's real gamble is reading the forecast right.
 */
export function tyreDelta(compound: CompoundKey, wet: boolean): number {
  if (wet) {
    switch (compound) {
      case 'WET': return 3;
      case 'INTERMEDIATE': return 1;
      case 'HARD': return -7;
      case 'MEDIUM': return -8;
      case 'SOFT': return -12;
    }
  }
  switch (compound) {
    case 'SOFT': return 3;
    case 'MEDIUM': return 1.5;
    case 'HARD': return 0;
    case 'INTERMEDIATE': return -4;
    case 'WET': return -6;
  }
}

/** A car's raw speed on this circuit before tyres, roughly 0-100. */
export function corePace(setup: CarSetup, driverSkill: number, track: Track): number {
  return statScore(setup, track) * CAR_WEIGHT + driverSkill * DRIVER_WEIGHT;
}

/** Single-lap pace including the tyre, for practice and qualifying. */
export function paceOf(setup: CarSetup, driverSkill: number, cond: RaceConditions): number {
  return corePace(setup, driverSkill, cond.track) + tyreDelta(setup.compound, cond.wet);
}

// ── The other ten teams ────────────────────────────────────────────────────

/**
 * AI teams have no stat sheet; their `baseStrength` stands in for `statScore`.
 *
 * It is compressed toward the middle first: `baseStrength` is a 41-93
 * reputation ladder, but on track a real grid is far tighter than that — and
 * the player's own sheet (67/58/72 ≈ 66) has to land where a 70-strength team
 * lands. A little in-season development, faster for the big teams, keeps the
 * table from being decided in March.
 */
export function aiStrength(team: Team, round: number): number {
  const compressed = 50 + (team.baseStrength - 50) * 0.75;
  const developmentRate = 0.4 + (team.baseStrength / 100) * 0.6;
  return Math.min(100, compressed + (round - 1) * 0.1 * developmentRate);
}

/** Where a team sits in the pre-season pecking order, 1 = strongest. */
export function strengthRank(teamKey: string): number {
  const sorted = [...teams].sort((a, b) => b.baseStrength - a.baseStrength);
  return sorted.findIndex((t) => t.key === teamKey) + 1;
}

/** AI teams read the sky correctly; the player has to. */
const aiCompound = (wet: boolean): CompoundKey => (wet ? 'WET' : 'MEDIUM');

const teamOf = (entry: GridEntry): Team => teams.find((t) => t.key === entry.teamKey) ?? teams[0];

/** The driver in a seat: the team's live pair when the entry carries one, the roster otherwise. */
const driverOf = (entry: GridEntry, entries: Entries, rosters: Rosters = {}): Driver =>
  entries[entry.teamKey]?.drivers?.[entry.driverIdx] ?? rosters[entry.teamKey]?.[entry.driverIdx] ?? teamOf(entry).drivers[entry.driverIdx];

function coreFor(entry: GridEntry, entries: Entries, track: Track, round: number, aiBonus: AiBonus = {}, rosters: Rosters = {}): number {
  const team = teamOf(entry);
  const pace = driverOf(entry, entries, rosters).stats.pace;
  const own = entries[entry.teamKey];
  if (own) return corePace(own.setup, pace, track);
  return (aiStrength(team, round) + (aiBonus[team.key] ?? 0)) * CAR_WEIGHT + pace * DRIVER_WEIGHT;
}

/** 0.8 for a metronome, 1.2 for a driver who has a moment every few laps. */
const shakeOf = (entry: GridEntry, entries: Entries, rosters: Rosters = {}): number => 1.2 - driverOf(entry, entries, rosters).stats.consistency / 250;

/** Seconds a lap a driver gains in the rain on the right tyres; ±0.5 across the field. */
const wetTouch = (entry: GridEntry, entries: Entries, rosters: Rosters = {}): number => (driverOf(entry, entries, rosters).stats.wet - 50) * 0.01;

/**
 * The car-driver axis, spelled out for the UI: where a lap comes from on this
 * circuit. One car stat point is worth about 0.06 s a lap, one driver pace
 * point about 0.02 s (docs/paddock-research.md §2.5).
 */
export interface PaceBreakdown {
  statScore: number;
  carShare: number;
  driverShare: number;
  corePace: number;
  /** Seconds per lap slower than a perfect 100-pace car. */
  lapDeficitSec: number;
  secPerCarPoint: number;
  secPerDriverPoint: number;
}

export function explainPace(setup: CarSetup, driver: Driver, track: Track): PaceBreakdown {
  const sc = statScore(setup, track);
  const core = sc * CAR_WEIGHT + driver.stats.pace * DRIVER_WEIGHT;
  return {
    statScore: Math.round(sc * 10) / 10,
    carShare: Math.round(sc * CAR_WEIGHT * 10) / 10,
    driverShare: Math.round(driver.stats.pace * DRIVER_WEIGHT * 10) / 10,
    corePace: Math.round(core * 10) / 10,
    lapDeficitSec: Math.round((100 - core) * SEC_PER_PACE * 100) / 100,
    secPerCarPoint: Math.round(CAR_WEIGHT * SEC_PER_PACE * 1000) / 1000,
    secPerDriverPoint: Math.round(DRIVER_WEIGHT * SEC_PER_PACE * 1000) / 1000,
  };
}

/** Single-lap pace for any car, on its own sheet or on AI strength. */
function lapPace(entry: GridEntry, entries: Entries, cond: RaceConditions, round: number, aiBonus: AiBonus = {}, rosters: Rosters = {}): number {
  const own = entries[entry.teamKey];
  const compound = own ? own.setup.compound : aiCompound(cond.wet);
  return coreFor(entry, entries, cond.track, round, aiBonus, rosters) + tyreDelta(compound, cond.wet);
}

/** The one-team case: the local player on their sheet, everyone else AI. */
export const soloEntries = (setup: CarSetup, reliability: number, tactics: TacticPreset = 'balanced'): Entries => ({
  [playerTeam.key]: { setup, reliability, tactics, managed: 'human' },
});

export const fullGrid = (rosters: Rosters = {}, entries: Entries = {}): GridEntry[] =>
  teams.flatMap((team) =>
    team.drivers.map((_, i) => ({
      teamKey: team.key,
      driverIdx: i as 0 | 1,
      driver: (entries[team.key]?.drivers ?? rosters[team.key] ?? team.drivers)[i].name,
    })),
  );

const isPlayerEntry = (e: GridEntry) => e.teamKey === playerTeam.key;

// ── Weather ────────────────────────────────────────────────────────────────

export interface WeatherPlan {
  /** What the manager is told before the weekend: chance of rain at some point, 0-1. */
  forecast: number;
  wetAtStart: boolean;
  /** Rain arrives during this lap (1-based), if it arrives mid-race. */
  rainFromLap?: number;
  /** The track dries from this lap, if it does. */
  dryFromLap?: number;
}

/**
 * The weekend's weather, decided at the start of the weekend but revealed
 * only as it happens. Half of a circuit's rain chance is rain from lights out;
 * most of the rest is a shower that arrives mid-race — the moment the live
 * pit decision exists for. The forecast leans toward the truth without giving
 * it away, so a 60% forecast is a genuine decision, not a disguised certainty.
 */
export function weatherFor(track: Track, seed: number): WeatherPlan {
  const random = rng(seed * 6007 + 71);
  const rc = track.rainChance;
  const wetAtStart = random() < rc * 0.5;
  const plan: WeatherPlan = { forecast: 0, wetAtStart };
  if (wetAtStart) {
    if (random() < 0.5) plan.dryFromLap = Math.round(track.laps * (0.35 + random() * 0.35));
  } else if (random() < rc * 0.6) {
    plan.rainFromLap = Math.round(track.laps * (0.25 + random() * 0.5));
  }
  const anyWet = wetAtStart || plan.rainFromLap !== undefined;
  const lean = anyWet ? 0.22 : -0.18;
  plan.forecast = Math.round(Math.min(0.95, Math.max(0.03, rc + lean + bell(random) * 0.1)) * 100) / 100;
  return plan;
}

/** Is the track wet on this lap (1-based)? Lap 0 is the grid. */
export function isWetOnLap(plan: WeatherPlan, lap: number): boolean {
  if (plan.rainFromLap !== undefined) return lap >= plan.rainFromLap;
  if (plan.wetAtStart) return plan.dryFromLap === undefined || lap < plan.dryFromLap;
  return false;
}

// ── Reliability ────────────────────────────────────────────────────────────

/**
 * Factory levels → 0-1 protection against a DNF. Manufacturing builds parts
 * that hold together, the engine lab keeps the power unit alive; five levels
 * of each roughly halve the failure rate.
 */
export function reliabilityOf(levels: { manufacturing?: number; engine_lab?: number }): number {
  const total = (levels.manufacturing ?? 0) + (levels.engine_lab ?? 0);
  return Math.min(1, total / 10);
}

/** AI teams: reliability tracks budget — the big teams break less. */
const aiReliability = (team: Team): number => team.baseStrength / 100;

/** Probability one car fails to finish the WHOLE race. Spread across laps by the engine. */
export function dnfChance(track: Track, wet: boolean, reliability: number): number {
  const p = 0.015 + track.attrition * 0.06 + (wet ? 0.03 : 0);
  return p * (1 - reliability * 0.5);
}

// ── Red flags in practice and qualifying ───────────────────────────────────
//
// A practice or qualifying session is one number per car here, not a lap
// loop, so a stoppage is modelled by what it costs rather than by clock time:
// the car that put it in the wall loses its lap outright, and every car still
// out on track when the flag flew loses the run it was on. Red flags are
// commoner on a Friday than on a Sunday — a crash that only brings out a
// safety car in the race stops a practice session dead — but a session is a
// fraction of a race distance, so the circuit's per-race profile is scaled
// DOWN for both, a little less for qualifying where everyone is on the limit
// at once. That lands at roughly one weekend in six seeing a session stopped,
// and every other weekend at the worst street circuits, with rain on top
// (docs/race-control-research.md).

/** A session stopped by race control. */
export interface SessionStoppage {
  /** How far into the session the flag flew, 0-1. Late is expensive: there is no time to go again. */
  at: number;
  /** The car that caused it. */
  cause: GridEntry;
  /** Cars whose run it ruined, `carId`s, the cause included. */
  ruined: string[];
  text: string;
}

const PRACTICE_RED_SCALE = 0.4;
const QUALI_RED_SCALE = 0.45;
const SESSION_RED_WET = 1.8;
/** Pace points a ruined run costs when the flag flies at the very end; a stoppage early on costs a third of it. */
const RED_RUIN_PACE = 15;
/** The car that caused it loses its lap outright. */
const RED_CAUSE_PACE = 22;
/** Share of the field out on track when the flag flies. */
const RED_FIELD_SHARE: [number, number] = [0.2, 0.55];

/**
 * Does race control stop this session, and what does it cost whom?
 *
 * Returns the pace points each car loses (empty when the session runs clean).
 * The car that causes it is drawn weighted by how loose it is — a shaky
 * driver on an aggressive qualifying run is the likeliest to find the wall.
 */
function rollSessionStoppage(input: {
  grid: GridEntry[];
  track: Track;
  entries: Entries;
  rosters?: Rosters;
  risks?: Record<string, QualiRisk>;
  wet: boolean;
  session: 'practice' | 'quali';
  random: () => number;
}): { stoppage?: SessionStoppage; lost: Record<string, number> } {
  const { grid, track, entries, rosters, risks, wet, session, random } = input;
  // mulberry32's first draw off a structured seed is not well spread, and this
  // is the first thing a session asks it for: warm it up before the coin flip.
  random();
  random();
  const scale = session === 'practice' ? PRACTICE_RED_SCALE : QUALI_RED_SCALE;
  const chance = Math.min(0.5, track.raceControl.red * scale * (wet ? SESSION_RED_WET : 1));
  if (random() >= chance) return { lost: {} };

  // Who put it there: loose cars first, and a car on an aggressive lap twice over.
  const weights = grid.map((e) => shakeOf(e, entries, rosters) * ((risks?.[e.teamKey] ?? 'safe') === 'aggressive' ? 2 : 1));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let pick = random() * total;
  let causeIdx = 0;
  for (let i = 0; i < grid.length; i++) {
    pick -= weights[i];
    if (pick <= 0) { causeIdx = i; break; }
  }
  const cause = grid[causeIdx];

  const at = 0.15 + random() * 0.8;
  const share = RED_FIELD_SHARE[0] + random() * (RED_FIELD_SHARE[1] - RED_FIELD_SHARE[0]);
  const lost: Record<string, number> = { [carId(cause)]: RED_CAUSE_PACE };
  // Later in the session there is less time left to go again, so the same
  // stoppage costs a caught car more.
  const ruinCost = RED_RUIN_PACE * (0.35 + 0.65 * at);
  for (const entry of grid) {
    if (entry === cause) continue;
    if (random() < share) lost[carId(entry)] = ruinCost;
  }

  const label = session === 'practice' ? 'Seans' : 'Sıralama';
  return {
    stoppage: {
      at: Math.round(at * 100) / 100,
      cause,
      ruined: Object.keys(lost),
      text: `KIRMIZI BAYRAK — ${cause.driver} duvarda. ${label} %${Math.round(at * 100)} dolmuşken durdu; ${Object.keys(lost).length - 1} araç turunu tamamlayamadı.`,
    },
    lost,
  };
}

// ── Practice ───────────────────────────────────────────────────────────────

export interface TimedEntry extends GridEntry {
  /** Best lap of the session, seconds. */
  sec: number;
}

export interface PracticeInput {
  track: Track;
  entries: Entries;
  aiBonus?: AiBonus;
  rosters?: Rosters;
  wet: boolean;
  /** 1, 2 or 3. */
  session: 1 | 2 | 3;
  round: number;
  seed: number;
}

export interface PracticeResult {
  /** The session's classification, fastest first. */
  order: TimedEntry[];
  /** Present when race control stopped the session. */
  red?: SessionStoppage;
}

/** Seconds per point of pace, the exchange rate every session shares. */
const SEC_PER_PACE = 0.08;

/** Practice is noisy: teams run different programmes, so the order is a hint, not a verdict. */
const PRACTICE_NOISE = 6;

/** One practice session: a classification, and the red flag if there was one. */
export function simulatePractice(input: PracticeInput): PracticeResult {
  const random = rng(input.seed * 4409 + input.round * 47 + input.session * 811);
  const cond: RaceConditions = { track: input.track, wet: input.wet };
  const base = input.track.baseLapSec + (input.wet ? 8 : 0);
  const grid = fullGrid(input.rosters, input.entries);
  const { stoppage, lost } = rollSessionStoppage({
    grid, track: input.track, entries: input.entries, rosters: input.rosters, wet: input.wet, session: 'practice', random,
  });
  const order = grid
    .map((entry) => {
      const pace = lapPace(entry, input.entries, cond, input.round, input.aiBonus, input.rosters)
        + bell(random) * PRACTICE_NOISE * shakeOf(entry, input.entries, input.rosters)
        - (lost[carId(entry)] ?? 0);
      return { ...entry, sec: round3(base + (100 - pace) * SEC_PER_PACE) };
    })
    .sort((a, b) => a.sec - b.sec);
  return { order, red: stoppage };
}

// ── Qualifying ─────────────────────────────────────────────────────────────

export interface QualifyingInput {
  track: Track;
  entries: Entries;
  aiBonus?: AiBonus;
  rosters?: Rosters;
  wet: boolean;
  /** Qualifying approach per team key; teams absent here run safe. */
  risks: Record<string, QualiRisk>;
  round: number;
  seed: number;
}

export interface QualifyingResult {
  /** Twenty-two cars, pole first, with their lap. */
  grid: TimedEntry[];
  /** 1-based grid slots of the player's two cars, lead driver first. */
  playerGrid: [number, number];
  /** True for each player car whose lap went wrong. */
  mistakes: [boolean, boolean];
  /** Present when race control stopped the session. */
  red?: SessionStoppage;
  /** True for each player car whose run the stoppage ruined. */
  redRuined: [boolean, boolean];
}

/** Aggressive: a better lap on average, but roughly one in seven goes in the wall. */
const AGGRESSIVE_GAIN = 3;
const AGGRESSIVE_MISTAKE = 0.15;
const SAFE_MISTAKE = 0.02;
const MISTAKE_PENALTY = 12;
/** `bell()` has a standard deviation of about a third of its amplitude. */
const QUALI_NOISE = 5;

export function simulateQualifying(input: QualifyingInput): QualifyingResult {
  const random = rng(input.seed * 9973 + input.round * 31);
  const cond: RaceConditions = { track: input.track, wet: input.wet };
  const mistakes: [boolean, boolean] = [false, false];
  const redRuined: [boolean, boolean] = [false, false];
  const base = input.track.baseLapSec + (input.wet ? 8 : 0);
  const grid = fullGrid(input.rosters, input.entries);
  const { stoppage, lost } = rollSessionStoppage({
    grid, track: input.track, entries: input.entries, rosters: input.rosters, risks: input.risks, wet: input.wet, session: 'quali', random,
  });

  const timed = grid.map((entry) => {
    let pace = lapPace(entry, input.entries, cond, input.round, input.aiBonus, input.rosters) + bell(random) * QUALI_NOISE * shakeOf(entry, input.entries, input.rosters);
    if (input.entries[entry.teamKey]) {
      const risk = input.risks[entry.teamKey] ?? 'safe';
      const mistakeChance = risk === 'aggressive' ? AGGRESSIVE_MISTAKE : SAFE_MISTAKE;
      if (risk === 'aggressive') pace += AGGRESSIVE_GAIN;
      if (random() < mistakeChance) {
        pace -= MISTAKE_PENALTY;
        if (isPlayerEntry(entry)) mistakes[entry.driverIdx] = true;
      }
    }
    const red = lost[carId(entry)];
    if (red) {
      pace -= red;
      if (isPlayerEntry(entry)) redRuined[entry.driverIdx] = true;
    }
    return { ...entry, sec: round3(base + (100 - pace) * SEC_PER_PACE) };
  });
  timed.sort((a, b) => a.sec - b.sec);

  const slot = (idx: 0 | 1) => timed.findIndex((e) => isPlayerEntry(e) && e.driverIdx === idx) + 1;
  return { grid: timed, playerGrid: [slot(0), slot(1)], mistakes, red: stoppage, redRuined };
}

// ── Tyres over a race distance ─────────────────────────────────────────────

interface TyreSpec {
  /** Seconds per lap relative to MEDIUM when fresh, in its own weather. */
  offset: number;
  /** Wear added per lap on a typical circuit; the car falls off a cliff past 1.0. */
  wearRate: number;
  wetTyre: boolean;
}

const TYRES: Record<CompoundKey, TyreSpec> = {
  SOFT: { offset: -0.6, wearRate: 0.045, wetTyre: false },
  MEDIUM: { offset: 0, wearRate: 0.028, wetTyre: false },
  HARD: { offset: 0.5, wearRate: 0.018, wetTyre: false },
  INTERMEDIATE: { offset: 0.5, wearRate: 0.03, wetTyre: true },
  WET: { offset: 0, wearRate: 0.024, wetTyre: true },
};

/** Slicks in the rain, or rain tyres on a dry track: seconds per lap thrown away. */
const SLICK_IN_WET_SEC = 6;
const WET_TYRE_IN_DRY_SEC = 3;

/** Seconds a tyre adds to this lap given its wear and the weather. */
export function tyreLapSec(compound: CompoundKey, wear: number, wet: boolean): number {
  const spec = TYRES[compound];
  let sec = spec.offset + wear * wear * 3;
  if (wear > 1) sec += 2 + (wear - 1) * 10;
  if (wet && !spec.wetTyre) sec += SLICK_IN_WET_SEC;
  if (!wet && spec.wetTyre) sec += WET_TYRE_IN_DRY_SEC;
  return sec;
}

/** Wear added by one lap. Street circuits chew tyres; the wrong family wears out fast. */
export function wearPerLap(compound: CompoundKey, track: Track, wet: boolean, driverSkill: number): number {
  const spec = TYRES[compound];
  let rate = spec.wearRate * (0.8 + track.attrition * 0.5);
  if (wet && !spec.wetTyre) rate *= 2;
  if (!wet && spec.wetTyre) rate *= 3;
  // A smooth driver looks after the rubber.
  rate *= 1.1 - driverSkill / 1000;
  return rate;
}

/** Roughly how many laps a compound lasts here before the cliff. */
export const tyreLifeLaps = (compound: CompoundKey, track: Track): number =>
  Math.floor(0.95 / wearPerLap(compound, track, false, 75));

// ── Race state ─────────────────────────────────────────────────────────────

export interface CarState extends GridEntry {
  /** 1-based starting slot. */
  gridPosition: number;
  /** 1-based, refreshed every lap. Retired cars sit after the runners. */
  position: number;
  totalSec: number;
  lastLapSec: number;
  bestLapSec: number;
  compound: CompoundKey;
  wear: number;
  stops: number;
  /** True during the lap the car pits, for the map and the log. */
  pitting: boolean;
  dnf: boolean;
  dnfLap?: number;
  /** A retirement heavy enough to hurt the driver (rare). */
  injured?: boolean;
  lapsLed: number;
  /** Player cars only: the player's team key marks them. */
  isPlayer: boolean;
  /**
   * This weekend's form, seconds per lap, drawn once at lights out. Per-lap
   * noise averages away over a race distance; this is what lets a car have a
   * good or a bad Sunday, and it is the main reason the order is not simply
   * the pace order.
   */
  form: number;
}

export type RaceEventKind =
  | 'lights' | 'start' | 'pit' | 'dnf' | 'rain' | 'dry' | 'lead' | 'fastest' | 'flag' | 'cliff'
  | 'yellow' | 'vsc' | 'sc' | 'red' | 'green';

/** Race control's current call. Absent = green flag. */
export interface Neutralisation {
  kind: 'vsc' | 'sc' | 'red';
  /** Last lap (1-based) the neutralisation covers; green again after it. */
  untilLap: number;
}

export interface RaceEvent {
  lap: number;
  kind: RaceEventKind;
  teamKey?: string;
  driver?: string;
  /** Turkish, ready for the log. */
  text: string;
}

export interface RaceState {
  trackKey: string;
  round: number;
  seed: number;
  /** Laps completed so far. 0 is the grid. */
  lap: number;
  laps: number;
  weather: WeatherPlan;
  /** Wet on the lap just completed (or at the start). */
  wet: boolean;
  cars: CarState[];
  events: RaceEvent[];
  fastestLap?: { teamKey: string; driver: string; sec: number; lap: number };
  finished: boolean;
  entries: Entries;
  aiBonus: AiBonus;
  rosters: Rosters;
  standings: TeamStanding[];
  /** Sprint or Grand Prix. Sprints are short, score 8-1 and have no strategy obligation. */
  session: 'race' | 'sprint';
  neutralised?: Neutralisation;
  /** Lap on which a standing restart happens after a red flag; the launch is run again. */
  restartLap?: number;
  /** How many times each flag was shown, for the result and the log. */
  control: { yellow: number; vsc: number; sc: number; red: number };
}

export interface RaceInput {
  standings: TeamStanding[];
  track: Track;
  entries: Entries;
  weather: WeatherPlan;
  /** Starting order, pole first. From `simulateQualifying`, or `fullGrid()` for a plain test. */
  grid: GridEntry[];
  round: number;
  seed: number;
  /** Sprint: a third of the distance, sprint points, no pit strategy needed. */
  session?: 'race' | 'sprint';
  aiBonus?: AiBonus;
  rosters?: Rosters;
  /**
   * Pit yolundan başlayan araçlar, `carId` ile. Araç başınadır: bir araç pit
   * yolundan çıkarken takım arkadaşı grid'deki yerinden normal başlayabilir
   * (araç geliştirmesi iki aracı da cezalandırır, pilot çalışması yalnız
   * birini). Alan isteğe bağlıdır; yoksa yarış bugünkü davranışının aynısıdır.
   */
  pitLaneStarts?: Record<string, PitLaneStart>;
}

/**
 * Parc fermé ihlalinin cezası ve telafisi (bkz. `startRace`).
 * Boş nesne = ceza var, lastik seçimi değişmedi.
 */
export interface PitLaneStart {
  /**
   * Telafi: başlangıç lastiği serbest. Motorda normalde başlangıç lastiği
   * `setup.compound`'dur — yani sıralamada kullanılan lastiğin ta kendisi.
   * Burada verilen bileşim o kilidi açar.
   */
  compound?: CompoundKey;
}

/** A pit call for one player car this lap. */
export interface PitDecision {
  compound: CompoundKey;
}

/** The player's two cars, lead driver first. `undefined` = stay out. */
export type PlayerDecisions = [PitDecision | undefined, PitDecision | undefined];

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Standing-start spacing: each grid row is about this far back at the first corner. */
const GRID_GAP_SEC = 0.35;

/** Amplitude of a car's race-long form, seconds per lap (`bell`, so sd ≈ a third of this). */
const FORM_SEC = 1.0;

/**
 * ── Pit yolundan başlangıç ────────────────────────────────────────────────
 * Gerçek F1 kuralı: takım parc fermé'yi bozup araca dokunduğunda araç GRİD
 * YERİNİ KAYBEDER. Grid'e dizilmez; pit çıkışında bekler ve saha tamamen
 * geçtikten sonra salınır.
 *
 * Bu "sondan başlamak" DEĞİLDİR ve ondan daha kötüdür: son gridçi ışıklarla
 * birlikte kalkar, pit yolundaki araç ise saha önünden akıp gittikten sonra,
 * üstüne bir de pit yolu transitini (`track.pitLaneSec`) ödeyerek katılır.
 * Bu yüzden ceza aşağıda "son slot + bir sıra + pitLaneSec" olarak kurulur.
 * Lütfen bunu "en sondan başlar"a sadeleştirmeyin: bütün mesele, cezanın
 * grid sırasından bağımsız ve piste göre değişen bir ZAMAN kaybı olması.
 * Karşılığındaki iki telafi de gerçektir: sınırsız setup ve — motorda
 * `PitLaneStart.compound` ile — serbest başlangıç lastiği.
 */
export function startRace(input: RaceInput): RaceState {
  const wet = input.weather.wetAtStart;
  const random = rng(input.seed * 7717 + input.round * 131 + 7);
  const penalties = input.pitLaneStarts;
  const penaltyOf = (entry: GridEntry): PitLaneStart | undefined => penalties?.[carId(entry)];
  // Grid yerini kaybedenler sahanın arkasına alınır; gerisi sırasını korur.
  const grid = penalties
    ? [...input.grid.filter((e) => !penaltyOf(e)), ...input.grid.filter((e) => penaltyOf(e))]
    : input.grid;
  const cars: CarState[] = grid.map((entry, i) => {
    const isPlayer = isPlayerEntry(entry);
    const own = input.entries[entry.teamKey];
    const penalty = penaltyOf(entry);
    // Cezalılar zaten sahanın arkasına dizildi; üstüne pit yolu transiti.
    // Birden fazla cezalı varsa aralarında normal grid mesafesi kalır.
    const totalSec = i * GRID_GAP_SEC + (penalty ? input.track.pitLaneSec : 0);
    return {
      ...entry,
      gridPosition: i + 1,
      position: i + 1,
      totalSec,
      lastLapSec: 0,
      bestLapSec: Infinity,
      compound: penalty?.compound ?? (own ? own.setup.compound : aiCompound(wet)),
      wear: 0,
      stops: 0,
      pitting: false,
      dnf: false,
      lapsLed: 0,
      isPlayer,
      form: bell(random) * FORM_SEC,
    };
  });
  return {
    trackKey: input.track.key,
    round: input.round,
    seed: input.seed,
    lap: 0,
    laps: input.session === 'sprint' ? sprintLaps(input.track) : input.track.laps,
    weather: input.weather,
    wet,
    cars,
    events: [{ lap: 0, kind: 'lights', text: wet ? 'Işıklar söndü — ıslak pist!' : 'Işıklar söndü.' }],
    finished: false,
    entries: input.entries,
    aiBonus: input.aiBonus ?? {},
    rosters: input.rosters ?? {},
    standings: input.standings,
    session: input.session ?? 'race',
    control: { yellow: 0, vsc: 0, sc: 0, red: 0 },
  };
}

/** Which dry compound gets a car to the flag from here, softest that will last. */
export function dryCompoundFor(lapsRemaining: number, track: Track): CompoundKey {
  if (tyreLifeLaps('SOFT', track) >= lapsRemaining) return 'SOFT';
  if (tyreLifeLaps('MEDIUM', track) >= lapsRemaining) return 'MEDIUM';
  return 'HARD';
}

/**
 * The pit wall every AI team (and the player on auto) runs: react to the
 * weather within a lap, otherwise stop when the tyre is nearly done and there
 * is still a race left to use the new set in. The threshold is jittered per
 * car so the whole grid does not dive in on the same lap.
 */
export function autoStrategy(car: CarState, track: Track, lap: number, laps: number, wet: boolean, random: () => number, tactics: TacticPreset = 'balanced'): PitDecision | undefined {
  const remaining = laps - lap;
  const onWetTyre = TYRES[car.compound].wetTyre;
  if (wet && !onWetTyre) return { compound: 'WET' };
  if (!wet && onWetTyre && remaining > 3) return { compound: dryCompoundFor(remaining, track) };
  if (remaining <= 6) return undefined;
  if (laps <= sprintLaps(track)) return undefined;
  const base = tactics === 'conservative' ? 0.62 : tactics === 'aggressive' ? 0.8 : 0.7;
  const threshold = base + random() * 0.1;
  if (car.wear > threshold) {
    let compound = wet ? 'WET' : dryCompoundFor(remaining, track);
    // An aggressive wall takes the softer tyre and plans on stopping again.
    if (!wet && tactics === 'aggressive' && compound === 'HARD') compound = 'MEDIUM';
    if (!wet && tactics === 'conservative' && compound === 'SOFT') compound = 'MEDIUM';
    return { compound };
  }
  return undefined;
}

/** How often the assistant gets a call wrong, per lap the call is due. */
const ASSISTANT_SLOW_WEATHER_CALL = 0.6;
const ASSISTANT_STRETCHED_STINT = 0.45;
const ASSISTANT_WRONG_TYRE = 0.15;

/**
 * The assistant that runs a team whose manager did not check in before the
 * race. It follows the team's preset tactics on the same logic as the AI, but
 * it is deliberately not as sharp as a present manager: it is slow to react
 * to a change in the weather (the expensive mistake — slicks in the rain cost
 * six seconds a lap), it tends to stretch a stint toward the cliff, and one
 * call in seven puts on a tyre one step harder than the situation wants.
 */
export function assistantStrategy(car: CarState, track: Track, lap: number, laps: number, wet: boolean, random: () => number, tactics: TacticPreset, errorScale: number = 1): PitDecision | undefined {
  const ideal = autoStrategy(car, track, lap, laps, wet, random, tactics);
  if (!ideal) return undefined;
  const weatherCall = wet !== TYRES[car.compound].wetTyre;
  if (weatherCall && random() < ASSISTANT_SLOW_WEATHER_CALL * errorScale) return undefined;
  if (!weatherCall && car.wear < 1.05 && random() < ASSISTANT_STRETCHED_STINT * errorScale) return undefined;
  if (random() < ASSISTANT_WRONG_TYRE * errorScale) {
    const harder: Record<CompoundKey, CompoundKey> = { SOFT: 'MEDIUM', MEDIUM: 'HARD', HARD: 'HARD', INTERMEDIATE: 'WET', WET: 'WET' };
    return { compound: harder[ideal.compound] };
  }
  return ideal;
}

/**
 * The launch. When the five lights go out a driver's reaction decides the
 * first corner: the sharpest lose almost nothing, a slow starter gives away
 * over a second — three or four grid slots at a standing start.
 */
const LAUNCH_MAX_SEC = 2.0;
const LAUNCH_NOISE_SEC = 0.35;

/** Share of retirements that are heavy enough to sideline the driver for a race or two. */
const HEAVY_CRASH_SHARE = 0.12;

/**
 * A setup pushed to an extreme is a nervous car. The risk grows with how far
 * the bias sits from neutral and doubles when it leans the wrong way for the
 * circuit (all aero on a grip track, or the reverse). Returns a multiplier on
 * incident and heavy-crash chances: 1.0 neutral, up to 2.0 wrong and extreme.
 */
export function setupRiskFactor(setup: CarSetup | undefined, track: Track): number {
  const b = setup?.bias ?? 0;
  if (b === 0) return 1;
  const lean = track.demand.aero - track.demand.grip; // >0: the circuit wants aero
  const wrongWay = (lean > 0.05 && b > 0) || (lean < -0.05 && b < 0);
  return 1 + Math.abs(b) * (wrongWay ? 1.0 : 0.4);
}

/** A botched stop: wheel gun that will not engage, a cross-threaded nut. */
const PIT_FAIL_SEC = 5;

function launchSec(entry: GridEntry, entries: Entries, rosters: Rosters, random: () => number): number {
  const reaction = driverOf(entry, entries, rosters).stats.reaction;
  return ((100 - reaction) / 100) * LAUNCH_MAX_SEC + Math.abs(bell(random)) * LAUNCH_NOISE_SEC;
}

const launchLabel = (sec: number): string => (sec < 0.3 ? 'mükemmel çıkış' : sec < 0.6 ? 'iyi çıkış' : sec < 0.9 ? 'orta çıkış' : 'kötü çıkış');

// ── Race control ───────────────────────────────────────────────────────────
//
// Calibrated to the 2024-2025 seasons (docs/race-control-research.md): about
// half of all races see a full safety car, three quarters see a safety car or
// a virtual one, one in ten is red-flagged; street circuits and rain push all
// of those up. Each circuit carries its own profile in `Track.raceControl`.

/** VSC: 35% slower, gaps preserved, pit lane relatively cheap. */
const VSC_LAP_SEC = 28;
const VSC_PIT_FACTOR = 0.6;
/** SC: the field bunches behind the car; a stop costs half. */
const SC_LAP_SEC = 40;
const SC_PIT_FACTOR = 0.5;
const SC_GAP_SEC = 0.6;
/** A retirement brings out a safety car this often (street circuits more); otherwise a VSC this often. */
const DNF_SC_CHANCE_BASE = 0.35;
const DNF_SC_CHANCE_STREET = 0.6;
const DNF_VSC_CHANCE = 0.3;
/** Local yellow: a share of the field loses time in the affected sector. */
const YELLOW_FIELD_SHARE = 0.3;
const YELLOW_SEC = 1.0;

const isStreet = (track: Track): boolean => track.attrition >= 0.5;

/**
 * Does race control step in this lap? Called once per lap under green;
 * per-lap chances are the per-race profile spread over the distance, with
 * rain raising everything and a retirement as the usual trigger.
 */
function raceControlCall(
  track: Track, laps: number, wet: boolean, retirementThisLap: boolean, random: () => number,
): Neutralisation['kind'] | 'yellow' | undefined {
  const rcp = track.raceControl;
  const rain = wet ? 1.6 : 1;
  if (retirementThisLap) {
    const scChance = (isStreet(track) ? DNF_SC_CHANCE_STREET : DNF_SC_CHANCE_BASE) * rain;
    const r = random();
    if (r < scChance) return 'sc';
    if (r < scChance + DNF_VSC_CHANCE) return 'vsc';
  }
  // Spontaneous calls (debris, a spin, a stranded car that was not a DNF).
  if (random() < (rcp.red * (wet ? 2 : 1)) / laps) return 'red';
  if (random() < (rcp.sc * 0.6 * rain) / laps) return 'sc';
  if (random() < (rcp.vsc * 0.8 * rain) / laps) return 'vsc';
  if (random() < rcp.yellow / laps) return 'yellow';
  return undefined;
}

/** Per-lap shake in seconds, plus the odd lock-up. */
const LAP_NOISE_SEC = 1.4;
const INCIDENT_CHANCE = 0.02;
const INCIDENT_SEC = 3;
/** Fuel: a full tank is this much slower than an empty one, spread over the race. */
const FUEL_SEC = 1.2;
/** A car that fails to pass sits this far behind. */
const HELD_GAP_SEC = 0.4;

/**
 * Run one lap. The player's cars follow `decisions` (or stay out); the AI
 * follows `autoStrategy`. Returns a new state — the old one is untouched, so
 * a screen can keep the last lap for its animation.
 */
export function advanceLap(state: RaceState, track: Track, decisions: Decisions = {}): RaceState {
  if (state.finished) return state;
  const lap = state.lap + 1;
  const random = rng(state.seed * 7717 + state.round * 131 + lap * 613 + 13);
  const wet = isWetOnLap(state.weather, lap);
  const events: RaceEvent[] = [];

  if (wet && !state.wet) events.push({ lap, kind: 'rain', text: 'Yağmur başladı — slick lastikler tehlikede.' });
  if (!wet && state.wet) events.push({ lap, kind: 'dry', text: 'Pist kuruyor — yağmur lastiği artık yavaş.' });

  const byPosition = [...state.cars].sort((a, b) => a.position - b.position);
  const perLapDnf = (car: CarState) =>
    dnfChance(track, wet, state.entries[car.teamKey]?.reliability ?? aiReliability(teamOf(car))) / state.laps;

  // Under a neutralisation nobody races: no passing, no incidents, everyone
  // slow, and a pit stop is cheap. A red flag is one lap of standing still.
  const under = state.neutralised && lap <= state.neutralised.untilLap ? state.neutralised.kind : undefined;
  const control = { ...state.control };
  const pitFactor = under === 'sc' ? SC_PIT_FACTOR : under === 'vsc' ? VSC_PIT_FACTOR : 1;

  // 1. Each car's provisional lap, front to back.
  const lapped = byPosition.map((car) => {
    if (car.dnf) return { car: { ...car, pitting: false }, lapSec: 0, pit: undefined as PitDecision | undefined, dnf: false, setupRisk: 1 };
    const pace = coreFor(car, state.entries, track, state.round, state.aiBonus, state.rosters);
    const own = state.entries[car.teamKey];
    const pit = !own
      ? autoStrategy(car, track, state.lap, state.laps, wet, random)
      : own.managed === 'human'
        ? decisions[carId(car)]
        : assistantStrategy(car, track, state.lap, state.laps, wet, random, own.tactics, own.assistantErrorScale ?? 1);

    const shake = shakeOf(car, state.entries, state.rosters);
    const setupRisk = setupRiskFactor(state.entries[car.teamKey]?.setup, track);
    let lapSec = track.baseLapSec
      + (wet ? 8 : 0)
      + (100 - pace) * SEC_PER_PACE
      + car.form
      + tyreLapSec(car.compound, car.wear, wet)
      + FUEL_SEC * ((state.laps - lap) / state.laps)
      + (under ? 0 : bell(random) * LAP_NOISE_SEC * shake);
    if (wet && TYRES[car.compound].wetTyre) lapSec -= wetTouch(car, state.entries, state.rosters);
    if (!under && random() < INCIDENT_CHANCE * shake * setupRisk) lapSec += INCIDENT_SEC;
    if (under === 'vsc') lapSec += VSC_LAP_SEC;
    if (under === 'sc') lapSec += SC_LAP_SEC;
    if (under === 'red') lapSec = 0;
    if (lap === 1 || state.restartLap === lap) {
      const launch = launchSec(car, state.entries, state.rosters, random);
      lapSec += launch;
      if (car.isPlayer) {
        events.push({ lap, kind: 'start', teamKey: car.teamKey, driver: car.driver, text: `${car.driver}: ${launchLabel(launch)} (+${launch.toFixed(2)} sn)` });
      }
    }

    let compound = car.compound;
    let wear = car.wear + wearPerLap(car.compound, track, wet, driverOf(car, state.entries, state.rosters).stats.consistency);
    let stops = car.stops;
    if (pit && under !== 'red') {
      // The pit crew: seconds saved every stop, and the occasional botched one.
      lapSec += Math.max(10, track.pitLossSec - (own?.pitSecondsSaved ?? 0)) * pitFactor;
      if (random() < (own?.pitFailChance ?? 0.04)) {
        lapSec += PIT_FAIL_SEC;
        if (car.isPlayer) events.push({ lap, kind: 'pit', teamKey: car.teamKey, driver: car.driver, text: `${car.driver}: yavaş pit stop! Tekerlek tabancası takıldı.` });
      }
      compound = pit.compound;
      wear = 0;
      stops += 1;
    }
    // Red flag: tyres may be changed in the pit lane for free.
    if (under === 'red') { wear = 0; }

    let dnfP = under ? 0 : perLapDnf(car) * (1 + (setupRisk - 1) * 0.5);
    if (!under && car.wear > 1) dnfP += 0.01;
    const dnf = random() < dnfP;

    return { car: { ...car, compound, wear, stops, pitting: Boolean(pit) }, lapSec, pit, dnf, setupRisk };
  });

  // 2. Passing. A car whose lap would carry it past the car ahead only gets by
  //    as often as the circuit allows; otherwise it is held in the dirty air.
  //    A pitting car or a retirement is passed for free.
  let aheadTotal = -Infinity;
  let aheadLapSec = 0;
  let aheadFree = true;
  let aheadCraft = 50;
  const advanced: CarState[] = lapped.map((row) => {
    const { car, lapSec, dnf, setupRisk } = row;
    if (car.dnf) return car;
    if (dnf) {
      // One retirement in eight is a heavy shunt; slicks in the rain double it, a wrong-way extreme setup too.
      const slickInWet = wet && !TYRES[car.compound].wetTyre;
      const injured = random() < Math.min(0.6, HEAVY_CRASH_SHARE * (slickInWet ? 2 : 1) * setupRisk);
      events.push({ lap, kind: 'dnf', teamKey: car.teamKey, driver: car.driver, text: injured ? `${car.driver} ağır kaza — yarış dışı, sağlık kontrolü.` : `${car.driver} yarış dışı.` });
      return { ...car, dnf: true, dnfLap: lap, injured, pitting: false };
    }
    let total = car.totalSec + lapSec;
    const craft = driverOf(car, state.entries, state.rosters).stats.racecraft;
    if (total < aheadTotal && !aheadFree) {
      const paceEdge = Math.max(0, aheadLapSec - lapSec);
      // Racecraft: the attacker's against the defender's, worth up to ±0.15.
      const duel = (craft - aheadCraft) / 100 * 0.3;
      const passChance = track.overtaking * Math.min(1, Math.max(0.05, 0.35 + paceEdge * 0.6 + duel));
      if (random() >= passChance) total = aheadTotal + HELD_GAP_SEC;
    }
    const realLap = total - car.totalSec;
    aheadTotal = total;
    aheadLapSec = realLap;
    aheadFree = car.pitting;
    aheadCraft = craft;
    if (car.pitting) {
      events.push({ lap, kind: 'pit', teamKey: car.teamKey, driver: car.driver, text: `${car.driver} pite girdi → ${car.compound}` });
    }
    return {
      ...car,
      totalSec: round3(total),
      lastLapSec: round3(realLap),
      bestLapSec: car.pitting ? car.bestLapSec : Math.min(car.bestLapSec, round3(realLap)),
    };
  });

  // 3. New order: runners by time, retirements after them (latest retirement first — they lasted longest).
  advanced.sort((a, b) =>
    Number(a.dnf) - Number(b.dnf)
    || (a.dnf ? (b.dnfLap ?? 0) - (a.dnfLap ?? 0) : a.totalSec - b.totalSec));
  const cars = advanced.map((c, i) => ({ ...c, position: i + 1 }));

  // Safety car: the field closes up behind the leader.
  if (under === 'sc') {
    const leaderTotal = cars.find((c) => !c.dnf)?.totalSec ?? 0;
    let slot = 0;
    for (const c of cars) {
      if (c.dnf) continue;
      c.totalSec = round3(leaderTotal + slot * SC_GAP_SEC);
      slot += 1;
    }
  }
  // Red flag: standing restart from the current order, time neutralised.
  let restartLap: number | undefined = state.restartLap;
  if (under === 'red') {
    let slot = 0;
    for (const c of cars) {
      if (c.dnf) continue;
      c.totalSec = round3(slot * GRID_GAP_SEC);
      slot += 1;
    }
    restartLap = lap + 1;
  }

  // Race control for the NEXT laps: only under green, and never in the last two laps.
  let neutralised = state.neutralised && lap < state.neutralised.untilLap ? state.neutralised : undefined;
  if (!under && lap < state.laps - 2) {
    const retirement = events.some((e) => e.kind === 'dnf' && e.lap === lap);
    const call = raceControlCall(track, state.laps, wet, retirement, random);
    if (call === 'yellow') {
      control.yellow += 1;
      // A local yellow: a slice of the field loses time in that sector this lap.
      for (const c of cars) if (!c.dnf && random() < YELLOW_FIELD_SHARE) c.totalSec = round3(c.totalSec + YELLOW_SEC * (0.5 + random()));
      cars.sort((a, b) => Number(a.dnf) - Number(b.dnf) || (a.dnf ? (b.dnfLap ?? 0) - (a.dnfLap ?? 0) : a.totalSec - b.totalSec));
      cars.forEach((c, i) => { c.position = i + 1; });
      events.push({ lap, kind: 'yellow', text: 'Sarı bayrak — sektörde yavaşlama.' });
    } else if (call === 'vsc') {
      control.vsc += 1;
      neutralised = { kind: 'vsc', untilLap: lap + 1 + (random() < 0.4 ? 1 : 0) };
      events.push({ lap, kind: 'vsc', text: 'Sanal güvenlik aracı — delta zamanı, pit ucuz.' });
    } else if (call === 'sc') {
      control.sc += 1;
      neutralised = { kind: 'sc', untilLap: lap + 3 + Math.floor(random() * 3) };
      events.push({ lap, kind: 'sc', text: 'GÜVENLİK ARACI — alan toplanıyor, pit yarı fiyat.' });
    } else if (call === 'red') {
      control.red += 1;
      neutralised = { kind: 'red', untilLap: lap + 1 };
      events.push({ lap, kind: 'red', text: 'KIRMIZI BAYRAK — yarış durdu, duran başlangıçla devam. Lastik serbest.' });
    }
  } else if (under && state.neutralised && lap === state.neutralised.untilLap) {
    events.push({ lap, kind: 'green', text: under === 'red' ? 'Yeşil bayrak — yeniden başlangıç!' : 'Yeşil bayrak — yarış devam.' });
  }

  const leader = cars[0];
  if (leader && !leader.dnf) {
    leader.lapsLed += 1;
    const prevLeader = byPosition[0];
    if (prevLeader && (prevLeader.teamKey !== leader.teamKey || prevLeader.driverIdx !== leader.driverIdx)) {
      events.push({ lap, kind: 'lead', teamKey: leader.teamKey, driver: leader.driver, text: `${leader.driver} liderliği aldı.` });
    }
  }

  // Fastest lap: pit laps and the opening lap do not count.
  let fastestLap = state.fastestLap;
  if (lap > 1 && !under) {
    for (const c of cars) {
      if (!c.dnf && !c.pitting && c.lastLapSec > 0 && (!fastestLap || c.lastLapSec < fastestLap.sec)) {
        fastestLap = { teamKey: c.teamKey, driver: c.driver, sec: c.lastLapSec, lap };
      }
    }
    if (fastestLap && fastestLap.lap === lap && fastestLap !== state.fastestLap) {
      events.push({ lap, kind: 'fastest', teamKey: fastestLap.teamKey, driver: fastestLap.driver, text: `En hızlı tur: ${fastestLap.driver} ${fastestLap.sec.toFixed(3)}` });
    }
  }

  for (const c of cars) {
    if (c.isPlayer && !c.dnf && c.wear > 0.8 && state.cars.find((o) => o.driverIdx === c.driverIdx && o.isPlayer)!.wear <= 0.8) {
      events.push({ lap, kind: 'cliff', teamKey: c.teamKey, driver: c.driver, text: `${c.driver}: lastik bitiyor, pit penceresi açık.` });
    }
  }

  const finished = lap >= state.laps;
  if (finished) events.push({ lap, kind: 'flag', text: `Damalı bayrak — ${leader?.driver ?? ''} kazandı.` });

  return { ...state, lap, wet, cars, events: [...state.events, ...events], fastestLap, finished, neutralised, control, restartLap };
}

// ── Result ─────────────────────────────────────────────────────────────────

export interface FinishEntry extends GridEntry {
  /** 1-based finishing position; DNFs are ordered after the finishers. */
  position: number;
  gridPosition: number;
  dnf: boolean;
  injured?: boolean;
  lapsLed: number;
  bestLapSec: number;
  stops: number;
  /** Gap to the winner in seconds; undefined for retirements. */
  gapSec?: number;
}

export interface RaceResult {
  /** Twenty-two cars in finishing order, DNFs last. */
  order: FinishEntry[];
  /** The player's better-placed car; 0 when both retired. */
  playerFinish: number;
  /** Both player cars, lead driver first; 0 for a DNF. */
  playerFinishes: [number, number];
  standings: TeamStanding[];
  /** Did it rain at any point? */
  wet: boolean;
  fastestLap?: { teamKey: string; driver: string; sec: number; lap: number };
  /** Who started on pole. */
  pole: GridEntry;
  laps: number;
  session: 'race' | 'sprint';
  control: { yellow: number; vsc: number; sc: number; red: number };
}

export function finishRace(state: RaceState): RaceResult {
  const winner = state.cars[0];
  const order: FinishEntry[] = state.cars.map((c) => ({
    teamKey: c.teamKey,
    driverIdx: c.driverIdx,
    driver: c.driver,
    position: c.position,
    gridPosition: c.gridPosition,
    dnf: c.dnf,
    injured: c.injured,
    lapsLed: c.lapsLed,
    bestLapSec: c.bestLapSec,
    stops: c.stops,
    gapSec: c.dnf ? undefined : round3(c.totalSec - winner.totalSec),
  }));
  const finishOf = (idx: 0 | 1): number => {
    const car = order.find((e) => e.teamKey === playerTeam.key && e.driverIdx === idx);
    return car && !car.dnf ? car.position : 0;
  };
  const playerFinishes: [number, number] = [finishOf(0), finishOf(1)];
  const classified = playerFinishes.filter((p) => p > 0);
  const pole = state.cars.find((c) => c.gridPosition === 1) ?? state.cars[0];
  const wet = state.weather.wetAtStart || state.weather.rainFromLap !== undefined;
  return {
    order,
    playerFinish: classified.length ? Math.min(...classified) : 0,
    playerFinishes,
    standings: (state.session === 'sprint' ? applySprintPoints : applyRacePoints)(
      state.standings, order.filter((e) => !e.dnf).map((e) => e.teamKey),
    ),
    wet,
    fastestLap: state.fastestLap,
    pole: { teamKey: pole.teamKey, driverIdx: pole.driverIdx, driver: pole.driver },
    laps: state.laps,
    session: state.session,
    control: state.control,
  };
}

/**
 * The whole race in one call, the player's cars on the automatic pit wall.
 * Used by tests and by "skip to the flag".
 */
export function simulateRace(input: RaceInput, track: Track = input.track): RaceResult {
  let state = startRace(input);
  while (!state.finished) state = advanceLap(state, track, autoDecisions(state, track));
  return finishRace(state);
}

/** What the perfect automatic pit wall would do for every human-managed car this lap. */
export function autoDecisions(state: RaceState, track: Track): Decisions {
  const random = rng(state.seed * 7717 + state.round * 131 + (state.lap + 1) * 613 + 99);
  const wet = isWetOnLap(state.weather, state.lap + 1);
  const out: Decisions = {};
  for (const car of state.cars) {
    const own = state.entries[car.teamKey];
    if (!own || own.managed !== 'human' || car.dnf) continue;
    out[carId(car)] = autoStrategy(car, track, state.lap, state.laps, wet, random, own.tactics);
  }
  return out;
}

/** The player's two calls (lead driver first) as engine decisions. */
export function playerDecisions(decisions: PlayerDecisions): Decisions {
  return {
    [`${playerTeam.key}:0`]: decisions[0],
    [`${playerTeam.key}:1`]: decisions[1],
  };
}

// ── Whole weekend ──────────────────────────────────────────────────────────

export interface WeekendInput {
  standings: TeamStanding[];
  track: Track;
  entries: Entries;
  aiBonus?: AiBonus;
  rosters?: Rosters;
  risks: Record<string, QualiRisk>;
  round: number;
  /** Usually the round itself; tests pass something else to sample many weekends. */
  seed: number;
}

export interface WeekendResult {
  weather: WeatherPlan;
  practice: [TimedEntry[], TimedEntry[], TimedEntry[]];
  qualifying: QualifyingResult;
  race: RaceResult;
  /** Sprint weekends only. */
  sprintQualifying?: QualifyingResult;
  sprint?: RaceResult;
}

/** Weather → three practice sessions → qualifying → race, in one call. */
export function simulateWeekend(input: WeekendInput): WeekendResult {
  const weather = weatherFor(input.track, input.seed);
  const wetAtStart = weather.wetAtStart;
  const common = { track: input.track, entries: input.entries, aiBonus: input.aiBonus, rosters: input.rosters, round: input.round, seed: input.seed };
  const practice: WeekendResult['practice'] = [
    simulatePractice({ ...common, wet: wetAtStart, session: 1 }).order,
    simulatePractice({ ...common, wet: wetAtStart, session: 2 }).order,
    simulatePractice({ ...common, wet: wetAtStart, session: 3 }).order,
  ];
  let standings = input.standings;
  let sprintQualifying: QualifyingResult | undefined;
  let sprint: RaceResult | undefined;
  if (input.track.sprint) {
    sprintQualifying = simulateQualifying({ ...common, seed: input.seed + 1, wet: wetAtStart, risks: {} });
    sprint = simulateRace({
      standings, track: input.track, entries: input.entries, aiBonus: input.aiBonus, rosters: input.rosters, weather, grid: sprintQualifying.grid,
      round: input.round, seed: input.seed + 1, session: 'sprint',
    });
    standings = sprint.standings;
  }
  const qualifying = simulateQualifying({ ...common, wet: wetAtStart, risks: input.risks });
  const race = simulateRace({
    standings,
    track: input.track,
    entries: input.entries,
    aiBonus: input.aiBonus,
    rosters: input.rosters,
    weather,
    grid: qualifying.grid,
    round: input.round,
    seed: input.seed,
  });
  return { weather, practice, qualifying, race, sprintQualifying, sprint };
}
