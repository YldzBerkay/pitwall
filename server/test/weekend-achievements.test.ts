/**
 * `economy/weekendAchievements.ts` — the per-seat facts assembly that bridges
 * settle.ts's race/qualifying/practice data into shared's `scoreWeekend`.
 *
 * Pure and fast (no database): these fixtures are hand-built rather than
 * replayed through the real engine, because Clean Sweep needs a very
 * specific shape (led every practice session, pole, win + fastest lap +
 * every lap led) that the seeded engine has no reason to produce for an
 * arbitrary team on an arbitrary round. The wiring under test — `teamRace`,
 * `teamGridSlots`, `buildPracticeTuple`, `denyCleanSweep` — is exactly what
 * `settle.ts` calls in production (see `scoreSeatWeekend`), so this proves
 * the WIRING, not a re-derivation of `scoreWeekend`'s own rules (already
 * shared's own job to get right).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { teamPlayerFinish, teamGridSlots, type RaceResult, type FinishEntry, type TimedEntry } from '@pitwall/shared/raceEngine';
import { achievementByKey, type WeekendAchievements } from '@pitwall/shared/achievements';
import {
  scoreSeatWeekend, buildPracticeTuple, denyCleanSweep,
  MISSING_PRACTICE_MARKER,
} from '../src/economy/weekendAchievements.ts';

/** Real team keys (shared/src/teams.ts) — `strengthRank`/`underdogMultiplier`
 *  need a real key, an invented one silently ranks as 0. */
const TEAM = 'aurelia';
const RIVAL = 'orenda';

function finishEntry(overrides: Partial<FinishEntry> & Pick<FinishEntry, 'teamKey' | 'driverIdx' | 'position'>): FinishEntry {
  return {
    driver: `${overrides.teamKey}-${overrides.driverIdx}`,
    gridPosition: overrides.position,
    dnf: false,
    lapsLed: 0,
    bestLapSec: 90,
    stops: 1,
    gapSec: overrides.position === 1 ? undefined : overrides.position,
    ...overrides,
  };
}

function timedEntry(teamKey: string, driverIdx: 0 | 1, sec: number): TimedEntry {
  return { teamKey, driverIdx, driver: `${teamKey}-${driverIdx}`, sec };
}

function raceResult(overrides: Partial<RaceResult> = {}): RaceResult {
  return {
    order: [],
    playerFinish: 0,
    playerFinishes: [0, 0],
    standings: [],
    wet: false,
    pole: { teamKey: TEAM, driverIdx: 0, driver: `${TEAM}-0` },
    laps: 50,
    session: 'race',
    control: { yellow: 0, vsc: 0, sc: 0, red: 0 },
    ...overrides,
  };
}

/** A race TEAM wins outright: pole, win, fastest lap, every lap led — a
 *  grand slam by itself, on top of whatever Clean Sweep needs from practice
 *  and qualifying. */
const sweepRace = raceResult({
  order: [
    finishEntry({ teamKey: TEAM, driverIdx: 0, position: 1, gridPosition: 1, lapsLed: 50 }),
    finishEntry({ teamKey: TEAM, driverIdx: 1, position: 2, gridPosition: 2 }),
    finishEntry({ teamKey: RIVAL, driverIdx: 0, position: 3, gridPosition: 3 }),
    finishEntry({ teamKey: RIVAL, driverIdx: 1, position: 4, gridPosition: 4 }),
  ],
  fastestLap: { teamKey: TEAM, driver: `${TEAM}-0`, sec: 88, lap: 10 },
  laps: 50,
});

const sweepGrid: TimedEntry[] = [
  timedEntry(TEAM, 0, 85), timedEntry(TEAM, 1, 86), timedEntry(RIVAL, 0, 87), timedEntry(RIVAL, 1, 88),
];

const ledByTeam = [timedEntry(TEAM, 0, 80)];
const ledByRival = [timedEntry(RIVAL, 0, 80)];

describe('weekendAchievements — per-seat facts assembly', () => {
  it('teamPlayerFinish reads the classified finish of the GIVEN team, not a hardcoded one', () => {
    assert.equal(teamPlayerFinish(sweepRace.order, TEAM), 1);
    assert.equal(teamPlayerFinish(sweepRace.order, RIVAL), 3);
    // Both cars retired: 0, matching finishRace's own "no classified finish" contract.
    const bothOut = [
      finishEntry({ teamKey: TEAM, driverIdx: 0, position: 21, dnf: true }),
      finishEntry({ teamKey: TEAM, driverIdx: 1, position: 22, dnf: true }),
    ];
    assert.equal(teamPlayerFinish(bothOut, TEAM), 0);
  });

  it('teamGridSlots reads grid slots for the GIVEN team', () => {
    assert.deepEqual(teamGridSlots(sweepGrid, TEAM), [1, 2]);
    assert.deepEqual(teamGridSlots(sweepGrid, RIVAL), [3, 4]);
  });

  it('awards Clean Sweep to a seat that led every practice session, qualifying and the race', () => {
    const weekend = scoreSeatWeekend({
      race: sweepRace,
      qualifyingGrid: sweepGrid,
      practiceSessions: [ledByTeam, ledByTeam, ledByTeam],
      sprint: false,
    }, TEAM);
    assert.ok(weekend.earned.includes('cleanSweep'), 'takım her şeyi lider bitirdi, Clean Sweep kazanmalı');
    assert.ok(weekend.earned.includes('grandSlam'));
    assert.ok(weekend.earned.includes('win'));
  });

  it('does NOT award Clean Sweep to a seat that did not lead every practice session', () => {
    const weekend = scoreSeatWeekend({
      race: sweepRace,
      qualifyingGrid: sweepGrid,
      // FP2 (index 1) is led by the rival instead.
      practiceSessions: [ledByTeam, ledByRival, ledByTeam],
      sprint: false,
    }, TEAM);
    assert.ok(!weekend.earned.includes('cleanSweep'), 'FP2 liderliği kaçırıldı, Clean Sweep kazanılmamalı');
    // The rest of the sweep is untouched by the practice miss.
    assert.ok(weekend.earned.includes('grandSlam'));
  });

  it('does not award Clean Sweep to the rival team either', () => {
    const weekend = scoreSeatWeekend({
      race: sweepRace,
      qualifyingGrid: sweepGrid,
      practiceSessions: [ledByTeam, ledByTeam, ledByTeam],
      sprint: false,
    }, RIVAL);
    assert.ok(!weekend.earned.includes('cleanSweep'));
    assert.ok(!weekend.earned.includes('win'));
  });

  it('denies Clean Sweep — rather than crashing or guessing — when a practice session was never frozen', () => {
    const weekend = scoreSeatWeekend({
      race: sweepRace,
      qualifyingGrid: sweepGrid,
      // FP1 (index 0) was never frozen — a late join, or a server that was down.
      practiceSessions: [undefined, ledByTeam, ledByTeam],
      sprint: false,
    }, TEAM);
    assert.ok(!weekend.earned.includes('cleanSweep'), 'eksik pratik Clean Sweep açmamalı');
    // Nothing else about the weekend is invented or withheld because of the gap.
    assert.ok(weekend.earned.includes('grandSlam'));
    assert.ok(weekend.earned.includes('win'));
  });

  it('buildPracticeTuple marks a missing session so it can never read as "led"', () => {
    const [fp1] = buildPracticeTuple([undefined, ledByTeam, ledByTeam], false);
    assert.equal(fp1.length, 1);
    assert.equal(fp1[0].teamKey, MISSING_PRACTICE_MARKER.teamKey);
    assert.notEqual(fp1[0].teamKey, TEAM);
  });

  it('buildPracticeTuple treats a sprint weekend\'s absent 2nd/3rd slot as "no session" (vacuously led), not "missing"', () => {
    const [fp1, fp2, fp3] = buildPracticeTuple([ledByTeam], true);
    assert.deepEqual(fp1, ledByTeam);
    assert.deepEqual(fp2, []);
    assert.deepEqual(fp3, []);
  });

  it('denies Clean Sweep on a sprint weekend even when every fact scoreWeekend CAN see says sweep', () => {
    const weekend = scoreSeatWeekend({
      race: sweepRace,
      qualifyingGrid: sweepGrid,
      // Sprint weekend: only one real practice session.
      practiceSessions: [ledByTeam],
      sprint: true,
    }, TEAM);
    assert.ok(
      !weekend.earned.includes('cleanSweep'),
      'sprint hafta sonunda sprint yarışı sunucuda henüz doğrulanamıyor — Clean Sweep reddedilmeli',
    );
    // Everything scoreWeekend CAN honestly verify (practice + quali + race)
    // is untouched by the sprint override.
    assert.ok(weekend.earned.includes('grandSlam'));
    assert.ok(weekend.earned.includes('win'));
    assert.ok(weekend.earned.includes('pole'));
  });

  it('denyCleanSweep recomputes base/rawScore/score, and leaves every other field and achievement untouched', () => {
    const weekend = scoreSeatWeekend({
      race: sweepRace,
      qualifyingGrid: sweepGrid,
      practiceSessions: [ledByTeam, ledByTeam, ledByTeam],
      sprint: false,
    }, TEAM);
    assert.ok(weekend.earned.includes('cleanSweep'));

    const denied = denyCleanSweep(weekend);
    assert.ok(!denied.earned.includes('cleanSweep'));
    for (const k of weekend.earned) {
      if (k !== 'cleanSweep') assert.ok(denied.earned.includes(k), `${k} silinmemeliydi`);
    }
    const cleanSweepBase = achievementByKey('cleanSweep').base;
    assert.equal(denied.base, weekend.base - cleanSweepBase);
    const expectedRaw = Math.round(denied.base * denied.multiplier) + denied.finishBonus + denied.briefScore;
    assert.equal(denied.rawScore, expectedRaw);
    const expectedScore = denied.targets.verdict === 'position' ? expectedRaw
      : denied.targets.verdict === 'collapsed' ? denied.targets.penalty : 0;
    assert.equal(denied.score, expectedScore);
    assert.ok(denied.score < weekend.score, 'Clean Sweep silinince skor düşmeli');
    // A weekend without Clean Sweep is untouched.
    const untouched: WeekendAchievements = { ...weekend, earned: weekend.earned.filter((k) => k !== 'cleanSweep') };
    assert.deepEqual(denyCleanSweep(untouched), untouched);
  });
});
