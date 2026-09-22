/**
 * The end of a season: what the championship pays, what the summary says,
 * and what carries over.
 *
 * The prize is flat next to the sponsor curve, like race-day prize money and
 * for the same reason (see `racePrize` in sponsors.ts): it is the floor that
 * keeps a bad year survivable, not the reward for a good one. Car, factory,
 * money and sponsors all carry over; only the table resets.
 */

import { playerTeam, positionOf, teams, type TeamStanding } from './teams';
import { calendar } from './tracks';
import type { Career } from './achievements';

export const SEASON_ROUNDS = calendar.length;

/** Sezonun araç tabanı: kışın herkes buraya doğru geriler. */
export const CAR_BASELINE = 55;

/** Kış resetinde eski statın korunan payı. */
const CARRY_OVER = 0.35;

/**
 * Kış reseti.
 *
 * İlerleme temposu bir sezon olduğu için sezon sonunda araç tavana yaklaşır.
 * Sezon ikinin yapacak bir işi kalsın diye herkesin aracı bu formülle geriler;
 * taşınan tek şey fabrika bonusudur. Yani sezonluk ilerleme araçta, kalıcı
 * ilerleme fabrikada. Aynı formül rakiplere de `baseStrength` üzerinden
 * uygulanır — yoksa oyuncu iki sezonda ligi terk eder.
 */
export function regressCar(stat: number, factoryFloorBonus: number): number {
  return Math.round(CAR_BASELINE + (stat - CAR_BASELINE) * CARRY_OVER + factoryFloorBonus);
}

/**
 * Rakip takımın yapay fabrika seviyesi.
 *
 * Rakiplerin fabrikası yok; sezon öncesi güçleri onun yerine geçer, böylece
 * güçlü takımlar kıştan daha az hasarla çıkar. 41-93 bandı 2-5 seviyeye
 * düşer, yani oyuncununkiyle aynı bant.
 */
export const rivalFactoryLevel = (baseStrength: number): number =>
  Math.round(baseStrength / 18);

/**
 * Sezon ödülü.
 *
 * Şampiyonluk ~6 yarışlık gelir eder: yıldız sürücünün (13 yarışlık bedel)
 * tek gerçekçi finansman kaynağı budur. Taban, son sıradaki takımın da
 * sezonu kârlı bitirebilmesi için.
 */
export function championshipPrize(position: number, gridSize: number = teams.length): number {
  void gridSize;
  return Math.max(2500, 9000 - 650 * (position - 1));
}

export interface SeasonSummary {
  season: number;
  finalStandings: TeamStanding[];
  playerPosition: number;
  playerPoints: number;
  prize: number;
  /** Snapshot of the career counters at the end of the season, for the recap card. */
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  scoreEarned: number;
}

export function summariseSeason(input: {
  season: number;
  standings: TeamStanding[];
  careerBefore: Career;
  careerAfter: Career;
}): SeasonSummary {
  const playerPosition = positionOf(input.standings, playerTeam.key);
  return {
    season: input.season,
    finalStandings: input.standings,
    playerPosition,
    playerPoints: input.standings.find((s) => s.teamKey === playerTeam.key)?.points ?? 0,
    prize: championshipPrize(playerPosition),
    wins: input.careerAfter.wins - input.careerBefore.wins,
    podiums: input.careerAfter.podiums - input.careerBefore.podiums,
    poles: input.careerAfter.poles - input.careerBefore.poles,
    fastestLaps: input.careerAfter.fastestLaps - input.careerBefore.fastestLaps,
    scoreEarned: input.careerAfter.score - input.careerBefore.score,
  };
}

// ── Pre-season testing ─────────────────────────────────────────────────────
//
// The real pre-season is eleven days across two venues; the game gives three
// test days before round one. Each day the engineer reports where the car is
// weakest against the calendar, the manager picks a test programme, and a
// programme that matches the report develops the car twice as fast.

export type TestFocus = 'motor' | 'aero' | 'grip' | 'reliability';

export const TEST_DAYS = 3;

export interface TestReport {
  day: number;
  /** What the engineer recommends. */
  focus: TestFocus;
  /** Turkish explanation for the briefing card. */
  text: string;
}

export interface TestOutcome {
  day: number;
  chosen: TestFocus;
  correct: boolean;
  /** Stat points added (or factory levels for reliability). */
  gain: number;
}

/** Points a correct programme adds to a car stat; a wrong one adds half. */
export const TEST_GAIN_CORRECT = 2;
export const TEST_GAIN_WRONG = 1;

/**
 * Where the calendar says the car is weakest: each stat's shortfall weighted
 * by how much the season's circuits pay for it. Day three looks at
 * reliability instead if the factory is thin.
 */
export function testReport(day: number, stats: { motor: number; aero: number; grip: number }, reliability: number): TestReport {
  const demand = calendar.reduce(
    (acc, t) => ({ motor: acc.motor + t.demand.motor, aero: acc.aero + t.demand.aero, grip: acc.grip + t.demand.grip }),
    { motor: 0, aero: 0, grip: 0 },
  );
  const n = calendar.length;
  const gaps: Record<Exclude<TestFocus, 'reliability'>, number> = {
    motor: (70 - stats.motor) * (demand.motor / n),
    aero: (70 - stats.aero) * (demand.aero / n),
    grip: (70 - stats.grip) * (demand.grip / n),
  };
  if (day === TEST_DAYS && reliability < 0.4) {
    return { day, focus: 'reliability', text: 'Uzun koşularda parça ömrü zayıf; son günü güvenilirlik testine ayıralım.' };
  }
  const ranked = (Object.entries(gaps) as [Exclude<TestFocus, 'reliability'>, number][]).sort((a, b) => b[1] - a[1]);
  // Day two: second-biggest gap, so three days do not all say the same thing.
  const [focus] = ranked[Math.min(day - 1, ranked.length - 1)];
  const label = { motor: 'MOTOR', aero: 'AERO', grip: 'GRIP' }[focus];
  const pct = Math.round((demand[focus] / n) * 100);
  return {
    day,
    focus,
    text: `Takvimin %${pct}'i ${label} istiyor ve orada en gerideyiz. Bugünkü program ${label} üzerine olmalı.`,
  };
}

/** A clean table for the new year. */
export const freshStandings = (): TeamStanding[] =>
  [...teams]
    .sort((a, b) => b.baseStrength - a.baseStrength)
    .map((t, i) => ({ teamKey: t.key, points: 0, position: i + 1 }));
