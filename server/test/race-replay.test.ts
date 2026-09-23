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
import {
  advanceLap,
  simulateQualifying,
  startRace,
  weatherFor,
  type CarSetup,
  type Entries,
  type QualiRisk,
  type RaceState,
  type TeamEntry,
} from '@pitwall/shared/raceEngine';
import {
  decisionsForLap,
  replayRace,
  type DecisionLogEntry,
  type RaceSnapshot,
} from '../src/lobby/replay.ts';

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

  it('is a genuine prefix: lap 40 events are the head of the lap 70 events', () => {
    const partial = replay(LOG_A, 40);
    const full = replay(LOG_A, 70);
    assert.equal(partial.lap, 40);
    assert.equal(full.lap, 70);
    // Asıl iddia: 40. tura kadar oynatmak, 70'e giden yarışın ÖNEKİDİR. Aynı
    // ifadeyi kendisiyle karşılaştırmak (eski hâli) hiçbir şey kanıtlamıyordu;
    // olayların baş kısmı bayt bayt tutmalı ki geç katılan istemciye
    // gösterilen yarış, ötekilerin izlediğinin ta kendisi olsun.
    assert.ok(partial.events.length > 0, 'fixture 40 tur içinde olay üretmeli');
    assert.ok(full.events.length > partial.events.length, '70 tur daha çok olay üretmeli');
    assert.deepEqual(full.events.slice(0, partial.events.length), partial.events);
    // Önek yalnızca olaylarda değil: o ana kadarki tur sayacı da tutmalı.
    assert.ok(partial.events.every((e) => e.lap <= 40));
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

  /**
   * CANLI TİK: yarışı koşucunun koşacağı gibi ilerletir — `startRace`, sonra
   * tur tur `advanceLap`, her tura o turun kararları verilerek (league.ts
   * `tick()` ile aynı biçim). Kararlar burada KASITLI olarak elle
   * anahtarlanıyor: `decisionsForLap` kullanılsaydı test, sınadığı iki yolun
   * ortak parçasını sınamış olurdu.
   */
  function liveTick(decisions: readonly DecisionLogEntry[], uptoLap: number): RaceState {
    const track = trackForRound(ROUND);
    const weather = weatherFor(track, SEED);
    const qualifying = simulateQualifying({
      track, entries: SNAP.entries, risks: SNAP.risks, wet: weather.wetAtStart,
      round: ROUND, seed: SEED, aiBonus: SNAP.aiBonus, rosters: SNAP.rosters,
    });
    let state = startRace({
      standings: SNAP.standings, track, entries: SNAP.entries, weather,
      grid: qualifying.grid, round: ROUND, seed: SEED,
      aiBonus: SNAP.aiBonus, rosters: SNAP.rosters,
    });
    for (let lap = 1; lap <= uptoLap && !state.finished; lap += 1) {
      const forLap: Record<string, { compound: DecisionLogEntry['compound'] }> = {};
      for (const d of decisions) {
        if (d.lap === lap) forLap[`${d.teamKey}:${d.driverIdx}`] = { compound: d.compound };
      }
      state = advanceLap(state, track, forLap);
    }
    return state;
  }

  it('matches a live-ticked race — the one players actually watch', () => {
    // Bu testin varlık sebebi: diğer bütün testler replayRace'i KENDİSİYLE
    // karşılaştırıyor, yani iki tarafı birden bozan bir gerileme (döngü
    // sınırında bir kayma + tur gruplamasında eşleşen bir değişiklik) hepsini
    // geçerdi — ve her çökme sonrası kurtarma, oyuncuların izlediğinden FARKLI
    // bir yarış üretirdi. Faz 3a-2'nin önlemek için var olduğu hata tam budur.
    const laps = trackForRound(ROUND).laps;
    assert.equal(JSON.stringify(liveTick(LOG_A, laps)), JSON.stringify(replay(LOG_A)));
    assert.equal(JSON.stringify(liveTick(LOG_A, 40)), JSON.stringify(replay(LOG_A, 40)));
  });

  it('exports the lap grouping the tick loop needs', () => {
    // Koşucu bu yardımcıyı kullanacak; elle yeniden yazsaydı yeniden oynatmayla
    // ayrışabilirdi. Anahtar biçimi `takım:sürücü`.
    assert.deepEqual(decisionsForLap(LOG_A, 12), {
      'aurelia:0': { compound: 'SOFT' },
      'aurelia:1': { compound: 'HARD' },
    });
    assert.deepEqual(decisionsForLap(LOG_A, 13), {});
    assert.deepEqual(decisionsForLap(LOG_A, 45), { 'aurelia:0': { compound: 'MEDIUM' } });
  });

  it('throws on a non-finite uptoLap instead of returning the grid', () => {
    // NaN, Math.min üzerinden sessizce "0. tur" döndürürdü: geçerli görünen,
    // yayınlanabilir bir yalan. Bozuk DB okuması gürültüyle patlamalı.
    assert.throws(() => replay(LOG_A, Number.NaN), /uptoLap/);
    assert.throws(() => replay(LOG_A, Number.POSITIVE_INFINITY), /uptoLap/);
  });

  it('runs to the flag with an empty decision log', () => {
    const state = replay([]);
    assert.equal(state.finished, true);
    assert.equal(state.lap, trackForRound(ROUND).laps);
    assert.equal(JSON.stringify(state), JSON.stringify(replay([])));
  });
});
