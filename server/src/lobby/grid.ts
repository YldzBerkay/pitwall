/**
 * The shared, pure vocabulary of a lobby's grid: which seat is "the strongest
 * car", what a team's season objective is, and what meeting it pays.
 *
 * Nothing here touches the database or the network, so the matchmaking
 * simulation (`scripts/matchmaking-sim.ts`) and the real server read exactly
 * the same numbers.
 */
import { teams, type Team } from '../../../mobile/src/data/teams.ts';
import { aiStrength } from '../../../mobile/src/data/raceEngine.ts';

export const AI_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type AiDifficulty = (typeof AI_DIFFICULTIES)[number];

export function isAiDifficulty(v: unknown): v is AiDifficulty {
  return typeof v === 'string' && (AI_DIFFICULTIES as readonly string[]).includes(v);
}

/** Spec §3.5 — the multiplier that stops everyone from simply picking Easy. */
export const RANK_POINT_MULTIPLIER: Record<AiDifficulty, number> = {
  easy: 0.7,
  normal: 1.0,
  hard: 1.4,
};

/** Spec §3.5 — how much faster the AI develops its car at each tier. */
export const AI_DEVELOPMENT_RATE: Record<AiDifficulty, number> = {
  easy: 0.75,
  normal: 1.0,
  hard: 1.3,
};

/**
 * THE SEAT LADDER — the grid's eleven teams, strongest first.
 *
 * §3.4 phrases its rows as "the strongest 1st / 2nd / 3rd / 4th car". A seat
 * in a lobby is a whole TEAM (both of its cars, one manager), and the spec
 * means the n-th team on this ladder — not the n-th of the 22 individual
 * cars. So "the strongest 3rd car is taken" reads here as SEAT_LADDER[2]
 * being held by a human.
 *
 * A team's strength is the pace of its best car under the race engine's own
 * formula, so the ladder, the preview card's order and the "araç NN" it
 * prints are all one number. CAR_WEIGHT/DRIVER_WEIGHT are module-private in
 * raceEngine.ts (which this phase does not touch), so they are restated here
 * and must be kept in step with it if the engine is ever re-balanced.
 */
const CAR_WEIGHT = 0.75;
const DRIVER_WEIGHT = 0.25;

const carPace = (team: Team, driver: Team['drivers'][number]): number =>
  aiStrength(team, 1) * CAR_WEIGHT + driver.skill * DRIVER_WEIGHT;

const BEST_CAR_PACE = new Map(
  teams.map((team) => [team.key, Math.max(...team.drivers.map((d) => carPace(team, d)))]),
);

export const SEAT_LADDER: readonly string[] = [...teams]
  .map((t) => t.key)
  .sort((a, b) => (BEST_CAR_PACE.get(b) ?? 0) - (BEST_CAR_PACE.get(a) ?? 0) || a.localeCompare(b));

export const TEAM_COUNT = SEAT_LADDER.length;

const NAME_BY_KEY = new Map(teams.map((t) => [t.key, t.name]));

export function isTeamKey(v: unknown): v is string {
  return typeof v === 'string' && BEST_CAR_PACE.has(v);
}

/** The "araç 81" on the preview card (§3.3): the pace of the team's best car. */
export function carRating(teamKey: string): number {
  return Math.round(BEST_CAR_PACE.get(teamKey) ?? 0);
}

export function teamName(teamKey: string): string {
  return NAME_BY_KEY.get(teamKey) ?? teamKey;
}

/** 1-based position of a team on the seat ladder; TEAM_COUNT+1 if unknown. */
export function seatRank(teamKey: string): number {
  const i = SEAT_LADDER.indexOf(teamKey);
  return i === -1 ? TEAM_COUNT + 1 : i + 1;
}

/**
 * The season objective the manager signs up for: finish where the car
 * belongs. A team sitting 5th on the pre-season ladder is asked for P5 — no
 * more, no less — so the target is legible before the player commits.
 */
export function objectivePosition(teamKey: string): number {
  return Math.min(seatRank(teamKey), TEAM_COUNT);
}

/**
 * What meeting the objective pays, before the AI-difficulty multiplier.
 *
 * Descending with the objective: a stronger car is asked for a harder result
 * and is worth more. The three values the spec prints on its example card
 * (§3.3) — P5 → 850, P8 → 600, P10 → 400 — are fixed points of this table;
 * the rest fill in monotonically around them.
 */
const BASE_RANK_POINTS = [1300, 1200, 1100, 975, 850, 775, 675, 600, 500, 400, 300] as const;

export function baseRankPoints(objective: number): number {
  const i = Math.min(Math.max(objective, 1), BASE_RANK_POINTS.length) - 1;
  return BASE_RANK_POINTS[i];
}

/** Rank points actually on offer for a seat in a lobby at this difficulty. */
export function rankPointsFor(teamKey: string, difficulty: AiDifficulty): number {
  return Math.round(baseRankPoints(objectivePosition(teamKey)) * RANK_POINT_MULTIPLIER[difficulty]);
}

export interface SeatPreview {
  teamKey: string;
  teamName: string;
  carRating: number;
  objective: number;
  rankPoints: number;
}

/** The "Sana kalan takımlar" block of the preview card (§3.3), best car first. */
export function previewSeats(freeTeamKeys: readonly string[], difficulty: AiDifficulty): SeatPreview[] {
  return [...freeTeamKeys]
    .sort((a, b) => seatRank(a) - seatRank(b))
    .map((teamKey) => ({
      teamKey,
      teamName: teamName(teamKey),
      carRating: carRating(teamKey),
      objective: objectivePosition(teamKey),
      rankPoints: rankPointsFor(teamKey, difficulty),
    }));
}
