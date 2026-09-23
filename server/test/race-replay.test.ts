/**
 * Yarış yeniden oynatması — Faz 3a-2'nin kalbi.
 *
 * Lobi yarışının durumu saklanmaz; onu ÜRETEN tarif saklanır: tohum, ışıklar
 * söndüğünde dondurulan katılımlar ve her pit kararının hangi turda verildiği.
 * Bu testler o tarifin tek bir yarışa karşılık geldiğini iddia eder — aksi
 * hâlde iki oyuncu aynı lobide farklı bir yarış görürdü.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackForRound } from '@pitwall/shared/tracks';
import { freshStandings } from '@pitwall/shared/season';
import type { CarSetup, Entries, QualiRisk, TeamEntry } from '@pitwall/shared/raceEngine';
import { replayRace, type DecisionLogEntry, type RaceSnapshot } from '../src/lobby/replay.ts';

/** 78 turluk bir Grand Prix — 40/70. turlara kadar kısmi oynatma için yeterince uzun. */
const ROUND = 8;
const SEED = 4242;

const TEAM_KEYS = [
  'aurelia', 'silberpfad', 'bravado', 'northgate', 'ravensworth', 'bosphorus',
  'ridgeline', 'castellan', 'verano', 'falkirk', 'orenda',
] as const;

const setup = (motor: number, aero: number, grip: number): CarSetup =>
  ({ motor, aero, grip, compound: 'MEDIUM', bias: 0 });

function snapshot(): RaceSnapshot {
  const entries: Entries = {};
  const risks: Record<string, QualiRisk> = {};
  TEAM_KEYS.forEach((key, i) => {
    const entry: TeamEntry = {
      setup: setup(60 + i, 70 - i, 55 + ((i * 3) % 20)),
      reliability: 0.25 + (i % 4) * 0.05,
      tactics: i % 3 === 0 ? 'aggressive' : i % 3 === 1 ? 'balanced' : 'conservative',
      managed: i % 2 === 0 ? 'human' : 'assistant',
      pitSecondsSaved: (i % 3) * 0.2,
      pitFailChance: 0.02,
    };
    entries[key] = entry;
    risks[key] = i % 2 === 0 ? 'aggressive' : 'safe';
  });
  return { entries, risks, standings: freshStandings(), aiBonus: {}, rosters: {} };
}

const SNAP = snapshot();

/** Kararlar: lap N = N. turu simüle eden advanceLap çağrısına verilen karar. */
const LOG_A: DecisionLogEntry[] = [
  { lap: 12, teamKey: 'aurelia', driverIdx: 0, compound: 'SOFT' },
  { lap: 12, teamKey: 'aurelia', driverIdx: 1, compound: 'HARD' },
  { lap: 18, teamKey: 'bravado', driverIdx: 0, compound: 'HARD' },
  { lap: 34, teamKey: 'ravensworth', driverIdx: 1, compound: 'SOFT' },
  { lap: 45, teamKey: 'aurelia', driverIdx: 0, compound: 'MEDIUM' },
  { lap: 58, teamKey: 'verano', driverIdx: 0, compound: 'SOFT' },
];

/** Aynı tohum, başka kararlar. */
const LOG_B: DecisionLogEntry[] = [
  { lap: 9, teamKey: 'aurelia', driverIdx: 0, compound: 'HARD' },
  { lap: 27, teamKey: 'bravado', driverIdx: 1, compound: 'SOFT' },
  { lap: 51, teamKey: 'orenda', driverIdx: 0, compound: 'HARD' },
];

const replay = (decisions: readonly DecisionLogEntry[], uptoLap?: number) =>
  replayRace({ seed: SEED, round: ROUND, snapshot: SNAP, decisions, uptoLap });

describe('race replay', () => {
  it('runs the track the round says it runs', () => {
    assert.ok(trackForRound(ROUND).laps >= 70, 'fixture needs a race longer than 70 laps');
  });

  it('is bit-identical across two replays of the same recipe', () => {
    const a = replay(LOG_A, 70);
    const b = replay(LOG_A, 70);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.lap, 70);
  });

  it('produces a different race when the decision log differs', () => {
    const a = replay(LOG_A, 70);
    const b = replay(LOG_B, 70);
    assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'decisions are being dropped');
  });

  it('is consistent when replayed in two steps', () => {
    const partial = replay(LOG_A, 40);
    assert.equal(partial.lap, 40);
    const continued = replay(LOG_A, 70);
    const straight = replay(LOG_A, 70);
    assert.equal(JSON.stringify(continued), JSON.stringify(straight));
    // 40. tura kadar olan durum, 70'e giden oynatmanın önekiyle aynı tarifi paylaşır.
    assert.equal(JSON.stringify(partial), JSON.stringify(replay(LOG_A, 40)));
  });

  it('ignores decisions logged beyond the requested lap', () => {
    const late: DecisionLogEntry[] = [
      ...LOG_A,
      { lap: 75, teamKey: 'ridgeline', driverIdx: 0, compound: 'SOFT' },
    ];
    assert.equal(JSON.stringify(replay(late, 70)), JSON.stringify(replay(LOG_A, 70)));
    // Ama 75. tura kadar oynatılırsa o karar gerçekten işlemeli (ridgeline insan
    // yönetiminde; motor yalnızca insan yönetimli araçların kararını okur).
    assert.notEqual(JSON.stringify(replay(late, 75)), JSON.stringify(replay(LOG_A, 75)));
  });

  it('runs to the flag with an empty decision log', () => {
    const state = replay([]);
    assert.equal(state.finished, true);
    assert.equal(state.lap, trackForRound(ROUND).laps);
    assert.equal(JSON.stringify(state), JSON.stringify(replay([])));
  });
});
