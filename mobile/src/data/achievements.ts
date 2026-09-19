/**
 * What a weekend is worth beyond points: achievements, career score, rank.
 *
 * Points pay the championship; this pays the PLAYER. Every notable thing the
 * team does on a weekend — a pole, a win, a fastest lap, the rarer combined
 * feats — earns a base score, multiplied by how unfancied the team is: the
 * same win is worth far more from the ninth-strongest car than from the
 * first. The career total maps onto ten ranks shown on the profile.
 *
 * "Grand Slam", "hat-trick", "double" and "clean sweep" are the sport's own
 * generic terms; nothing here is a trademark.
 */

import { POINTS_FOR_PLACE, playerTeam } from './teams';
import { strengthRank, type RaceResult, type TimedEntry } from './raceEngine';

export type AchievementKey =
  | 'podium'
  | 'pole'
  | 'fastestLap'
  | 'win'
  | 'double'
  | 'hatTrick'
  | 'grandSlam'
  | 'cleanSweep';

export interface AchievementDef {
  key: AchievementKey;
  /** Turkish label shown in the app. */
  label: string;
  /** How it is earned, in Turkish. */
  description: string;
  base: number;
  /** Two-letter mono glyph, in the nav-capsule style. */
  glyph: string;
}

export const achievementDefs: AchievementDef[] = [
  { key: 'podium', label: 'Podyum', description: 'Yarışı ilk üçte bitir.', base: 10, glyph: 'P3' },
  { key: 'pole', label: 'Pole Pozisyonu', description: 'Sıralamada en hızlı turu at, yarışa 1. sıradan başla.', base: 15, glyph: 'P1' },
  { key: 'fastestLap', label: 'En Hızlı Tur', description: 'Yarışın en hızlı turunu kaydet.', base: 10, glyph: 'FL' },
  { key: 'win', label: 'Galibiyet', description: 'Yarışı 1. sırada bitir.', base: 30, glyph: 'W1' },
  { key: 'double', label: 'Duble', description: 'İki aracın yarışı 1. ve 2. bitirsin.', base: 40, glyph: 'DB' },
  { key: 'hatTrick', label: 'Hat-trick', description: 'Pole + galibiyet + en hızlı tur; liderliği en az bir tur kaptırdıysan.', base: 60, glyph: 'HT' },
  { key: 'grandSlam', label: 'Grand Slam', description: 'Pole + galibiyet + en hızlı tur + her turu lider geç.', base: 100, glyph: 'GS' },
  { key: 'cleanSweep', label: 'Clean Sweep', description: 'Üç antrenman, sıralama ve yarış — hepsini lider tamamla.', base: 150, glyph: 'CS' },
];

export const achievementByKey = (key: AchievementKey): AchievementDef =>
  achievementDefs.find((a) => a.key === key) ?? achievementDefs[0];

/**
 * The underdog multiplier. Rank 1 (the strongest car on the grid) earns 0.6×;
 * each step down the pecking order adds 0.2×, so the eleventh team earns
 * 2.6× — taking a backmarker to a win is the whole game.
 */
export const underdogMultiplier = (teamKey: string): number =>
  Math.round((0.6 + 0.2 * (strengthRank(teamKey) - 1)) * 100) / 100;

// ── Targets ────────────────────────────────────────────────────────────────

/**
 * What the team is expected to do this weekend, from its place in the
 * pecking order: the strongest team is expected to win and bank both cars'
 * points, the eleventh to finish ahead of nobody in particular. The owner's
 * rule: rank score is only paid when the FINISH target is met; meeting the
 * points target alone earns nothing, and missing both by a distance costs.
 */
export interface WeekendTargets {
  /** Lead car must finish here or better. */
  position: number;
  /** Both cars together must score at least this many championship points. */
  points: number;
}

export function targetsFor(teamKey: string = playerTeam.key): WeekendTargets {
  const r = strengthRank(teamKey);
  const position = Math.min(20, 2 * r - 1);
  const lead = POINTS_FOR_PLACE[position - 1] ?? 0;
  const second = POINTS_FOR_PLACE[Math.min(19, position + 2) - 1] ?? 0;
  return { position, points: Math.max(0, Math.round((lead + second) * 0.8)) };
}

export type TargetVerdict = 'position' | 'pointsOnly' | 'missed' | 'collapsed';

export interface TargetOutcome {
  targets: WeekendTargets;
  finish: number;
  pointsScored: number;
  verdict: TargetVerdict;
  /** Multiplier applied to the base achievement score: 1, 0, or a penalty below zero expressed as flat points. */
  penalty: number;
}

export function judgeTargets(race: RaceResult, teamKey: string = playerTeam.key): TargetOutcome {
  const targets = targetsFor(teamKey);
  const finish = race.playerFinish > 0 ? race.playerFinish : 22;
  const pointsScored = race.order
    .filter((e) => e.teamKey === teamKey && !e.dnf)
    .reduce((sum, e) => sum + (POINTS_FOR_PLACE[e.position - 1] ?? 0), 0);
  if (finish <= targets.position) return { targets, finish, pointsScored, verdict: 'position', penalty: 0 };
  if (pointsScored >= targets.points) return { targets, finish, pointsScored, verdict: 'pointsOnly', penalty: 0 };
  const gap = finish - targets.position;
  if (gap >= 4) return { targets, finish, pointsScored, verdict: 'collapsed', penalty: Math.max(-20, -2 * (gap - 3)) };
  return { targets, finish, pointsScored, verdict: 'missed', penalty: 0 };
}

export interface WeekendAchievements {
  earned: AchievementKey[];
  /** Base points before the multiplier. */
  base: number;
  multiplier: number;
  /** What this weekend added to the career score, after the target gate. */
  score: number;
  /** Small consolation for finishing: max(0, 12 - finish). */
  finishBonus: number;
  /** Score before the target gate, for the receipt. */
  rawScore: number;
  targets: TargetOutcome;
  /** Engineer briefing items followed (0-N) and what they paid. */
  briefFollowed: number;
  briefScore: number;
}

export interface WeekendFacts {
  race: RaceResult;
  /** Pole slot of each player car, lead driver first, from qualifying. */
  playerGrid: [number, number];
  practice: [TimedEntry[], TimedEntry[], TimedEntry[]];
  /** Sprint weekend: sprint result and sprint pole, for the clean sweep. */
  sprint?: RaceResult;
  sprintGrid?: [number, number];
  /** How many of the engineer's briefing recommendations the manager followed. */
  briefFollowed?: number;
}

/** Career score per followed briefing item. */
export const BRIEF_SCORE_EACH = 5;

/**
 * Work out what the player's team achieved this weekend and score it. Feats
 * are judged per car, then the team keeps the best combination — a hat-trick
 * by the second driver counts as much as one by the first.
 */
export function scoreWeekend(facts: WeekendFacts, teamKey: string = playerTeam.key): WeekendAchievements {
  const { race, playerGrid, practice } = facts;
  const earned = new Set<AchievementKey>();

  const teamCars = race.order.filter((e) => e.teamKey === teamKey);
  const podium = teamCars.some((e) => !e.dnf && e.position <= 3);
  const win = teamCars.some((e) => !e.dnf && e.position === 1);
  const pole = playerGrid.includes(1);
  const fastest = race.fastestLap?.teamKey === teamKey;
  const first = race.order[0];
  const second = race.order[1];
  const double = Boolean(first && second && !first.dnf && !second.dnf && first.teamKey === teamKey && second.teamKey === teamKey);

  if (podium) earned.add('podium');
  if (pole) earned.add('pole');
  if (fastest) earned.add('fastestLap');
  if (win) earned.add('win');
  if (double) earned.add('double');

  // The combined feats belong to ONE car: the same driver must have taken pole,
  // won and set the fastest lap.
  const winner = teamCars.find((e) => !e.dnf && e.position === 1);
  if (winner) {
    const winnerPole = winner.gridPosition === 1;
    const winnerFastest = race.fastestLap?.teamKey === teamKey && race.fastestLap.driver === winner.driver;
    if (winnerPole && winnerFastest) {
      if (winner.lapsLed >= race.laps) earned.add('grandSlam');
      else earned.add('hatTrick');
    }
    const ledAllPractice = practice.every((session) => session.length === 0 || session[0]?.teamKey === teamKey);
    // On a sprint weekend the sweep also needs sprint pole and the sprint win.
    const sweptSprint = !facts.sprint || (facts.sprintGrid?.includes(1) && facts.sprint.order[0]?.teamKey === teamKey && !facts.sprint.order[0]?.dnf);
    if (winnerPole && ledAllPractice && sweptSprint) earned.add('cleanSweep');
  }

  const base = [...earned].reduce((sum, k) => sum + achievementByKey(k).base, 0);
  const multiplier = underdogMultiplier(teamKey);
  const finishBonus = race.playerFinish > 0 ? Math.max(0, 12 - race.playerFinish) : 0;
  const briefFollowed = facts.briefFollowed ?? 0;
  const briefScore = briefFollowed * BRIEF_SCORE_EACH;
  const rawScore = Math.round(base * multiplier) + finishBonus + briefScore;
  const targets = judgeTargets(race, teamKey);
  // The gate: finish target met → everything; points only → nothing; a collapse → a fine.
  const score = targets.verdict === 'position' ? rawScore : targets.verdict === 'collapsed' ? targets.penalty : 0;
  return { earned: [...earned], base, multiplier, score, finishBonus, rawScore, targets, briefFollowed, briefScore };
}

// ── Ranks ──────────────────────────────────────────────────────────────────

export interface Rank {
  /** 1-10. */
  level: number;
  /** Reads naturally in both English and Turkish. */
  name: string;
  /** Career score needed. */
  threshold: number;
  glyph: string;
  colour: string;
}

export const ranks: Rank[] = [
  { level: 1, name: 'Padok', threshold: 0, glyph: 'PD', colour: '#5C5E63' },
  { level: 2, name: 'Çaylak', threshold: 100, glyph: 'RK', colour: '#9A9C9F' },
  { level: 3, name: 'Grid', threshold: 300, glyph: 'GR', colour: '#B7C2CC' },
  { level: 4, name: 'Apex', threshold: 700, glyph: 'AX', colour: '#2DD4BF' },
  { level: 5, name: 'Podyum', threshold: 1400, glyph: 'PO', colour: '#16A4C8' },
  { level: 6, name: 'Pole', threshold: 2500, glyph: 'PL', colour: '#9B5CFF' },
  { level: 7, name: 'Usta', threshold: 4200, glyph: 'MA', colour: '#E0A21B' },
  { level: 8, name: 'Titan', threshold: 6500, glyph: 'TI', colour: '#F2760C' },
  { level: 9, name: 'Efsane', threshold: 10000, glyph: 'LG', colour: '#FF3B5C' },
  { level: 10, name: 'Grand Slam', threshold: 15000, glyph: 'GS', colour: '#D4FF3D' },
];

export function rankFor(score: number): Rank {
  let current = ranks[0];
  for (const r of ranks) if (score >= r.threshold) current = r;
  return current;
}

/** The next rank up, or undefined at the top. */
export const nextRank = (score: number): Rank | undefined =>
  ranks.find((r) => r.threshold > score);

/** 0-1 progress from the current rank toward the next. */
export function rankProgress(score: number): number {
  const cur = rankFor(score);
  const next = nextRank(score);
  if (!next) return 1;
  return (score - cur.threshold) / (next.threshold - cur.threshold);
}

// ── Career ─────────────────────────────────────────────────────────────────

export interface Career {
  score: number;
  counts: Record<AchievementKey, number>;
  races: number;
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  dnfs: number;
  /** Best championship finish so far, 0 = none completed. */
  bestChampionship: number;
  seasonsCompleted: number;
}

export const emptyCareer = (): Career => ({
  score: 0,
  counts: { podium: 0, pole: 0, fastestLap: 0, win: 0, double: 0, hatTrick: 0, grandSlam: 0, cleanSweep: 0 },
  races: 0,
  wins: 0,
  podiums: 0,
  poles: 0,
  fastestLaps: 0,
  dnfs: 0,
  bestChampionship: 0,
  seasonsCompleted: 0,
});

/** Fold one weekend into the career. */
export function recordWeekend(career: Career, weekend: WeekendAchievements, race: RaceResult): Career {
  const counts = { ...career.counts };
  for (const k of weekend.earned) counts[k] += 1;
  return {
    ...career,
    score: career.score + weekend.score,
    counts,
    races: career.races + 1,
    wins: career.wins + (weekend.earned.includes('win') ? 1 : 0),
    podiums: career.podiums + (weekend.earned.includes('podium') ? 1 : 0),
    poles: career.poles + (weekend.earned.includes('pole') ? 1 : 0),
    fastestLaps: career.fastestLaps + (weekend.earned.includes('fastestLap') ? 1 : 0),
    dnfs: career.dnfs + (race.playerFinish === 0 ? 1 : 0),
  };
}
