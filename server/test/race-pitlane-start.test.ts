/**
 * Pit yolundan başlangıç — parc fermé ihlalinin gerçek bedeli.
 *
 * Gerçek F1'de araç parkfermé sonrası kurcalandığında grid yerini kaybeder:
 * pit çıkışında bekler ve saha tamamen geçtikten sonra salınır. Bu "sondan
 * başlamak"tan DAHA KÖTÜdür, çünkü salındığında saha çoktan açılmıştır.
 * Karşılığında iki gerçek telafi vardır: sınırsız setup serbestisi ve
 * başlangıç lastiğinin serbest seçimi.
 *
 * Bu dosyanın en önemli testi 4 numaralı olan: bayrak konmamış bir yarışın
 * değişiklikten ÖNCE alınmış çıktıyla bit bit aynı kalması.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackForRound } from '@pitwall/shared/tracks';
import { freshStandings } from '@pitwall/shared/season';
import {
  advanceLap,
  autoDecisions,
  carId,
  finishRace,
  fullGrid,
  simulateQualifying,
  startRace,
  weatherFor,
  type CarSetup,
  type Entries,
  type GridEntry,
  type QualiRisk,
  type RaceInput,
  type TeamEntry,
  type WeatherPlan,
} from '@pitwall/shared/raceEngine';

const ROUND = 8;
const SEED = 4242;

const TEAM_KEYS = [
  'aurelia', 'silberpfad', 'bravado', 'northgate', 'ravensworth', 'bosphorus',
  'ridgeline', 'castellan', 'verano', 'falkirk', 'orenda',
] as const;

const setup = (motor: number, aero: number, grip: number): CarSetup =>
  ({ motor, aero, grip, compound: 'MEDIUM', bias: 0 });

function makeEntries(): { entries: Entries; risks: Record<string, QualiRisk> } {
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
  return { entries, risks };
}

const DRY: WeatherPlan = { forecast: 0, wetAtStart: false };

/** Sabit, kuru, hava sürprizi olmayan bir yarış girdisi — pist değiştirilebilir. */
function plainInput(round: number, pitLaneStarts?: RaceInput['pitLaneStarts']): RaceInput {
  const { entries } = makeEntries();
  const track = trackForRound(round);
  const grid: GridEntry[] = fullGrid({}, entries);
  return {
    standings: freshStandings(),
    track,
    entries,
    weather: DRY,
    grid,
    round: ROUND,
    seed: SEED,
    aiBonus: {},
    rosters: {},
    pitLaneStarts,
  };
}

describe('pit yolundan başlangıç', () => {
  it('sahanın tamamının arkasına koyar, son grid yerine değil', () => {
    const base = plainInput(8);
    const victim = base.grid[3];
    const state = startRace(plainInput(8, { [carId(victim)]: {} }));

    const car = state.cars.find((c) => carId(c) === carId(victim));
    assert.ok(car, 'cezalı araç sahada olmalı');
    const others = state.cars.filter((c) => carId(c) !== carId(victim));
    const last = Math.max(...others.map((c) => c.totalSec));

    // Grid yerini kaybeder: en arkaya numaralanır.
    assert.equal(car.gridPosition, state.cars.length);
    // Ve sadece "son sıra" değil, son sıranın da ölçülebilir şekilde gerisinde.
    assert.ok(car.totalSec > last + 1, `pit yolu aracı ${car.totalSec}, son araç ${last}`);
  });

  it('ek boşluk pistin pitLaneSec değeriyle ölçeklenir', () => {
    const cheapRound = 11;  // alpenring, 10.5 s
    const costlyRound = 18; // marinalights, 19.5 s
    const gapOn = (round: number): number => {
      const base = plainInput(round);
      const victim = base.grid[3];
      const state = startRace(plainInput(round, { [carId(victim)]: {} }));
      const car = state.cars.find((c) => carId(c) === carId(victim))!;
      const last = Math.max(...state.cars.filter((c) => carId(c) !== carId(victim)).map((c) => c.totalSec));
      return car.totalSec - last;
    };
    const cheap = gapOn(cheapRound);
    const costly = gapOn(costlyRound);
    assert.ok(costly > cheap, `pahalı pit yolu ${costly} > ucuz ${cheap} olmalı`);
    const delta = trackForRound(costlyRound).pitLaneSec - trackForRound(cheapRound).pitLaneSec;
    assert.ok(Math.abs((costly - cheap) - delta) < 1e-6, `fark ${costly - cheap}, beklenen ${delta}`);
  });

  it('lastik seçimini serbest bırakır (setup.compound kilidinden)', () => {
    const base = plainInput(8);
    const victim = base.grid[3];
    const mate = base.grid.find((e) => e.teamKey === victim.teamKey && e.driverIdx !== victim.driverIdx)!;
    const state = startRace(plainInput(8, { [carId(victim)]: { compound: 'SOFT' } }));
    const car = state.cars.find((c) => carId(c) === carId(victim))!;
    const mateCar = state.cars.find((c) => carId(c) === carId(mate))!;
    // Takımın sıralama lastiği MEDIUM; normalde başlangıç lastiği de odur.
    assert.equal(mateCar.compound, 'MEDIUM');
    assert.equal(car.compound, 'SOFT');
  });

  it('ceza araç başınadır, takım başına değil', () => {
    const base = plainInput(8);
    const victim = base.grid[3];
    const mate = base.grid.find((e) => e.teamKey === victim.teamKey && e.driverIdx !== victim.driverIdx)!;
    const mateSlotBefore = startRace(base).cars.find((c) => carId(c) === carId(mate))!;
    const state = startRace(plainInput(8, { [carId(victim)]: {} }));
    const car = state.cars.find((c) => carId(c) === carId(victim))!;
    const mateCar = state.cars.find((c) => carId(c) === carId(mate))!;

    assert.equal(car.gridPosition, state.cars.length);
    assert.ok(mateCar.gridPosition < car.gridPosition, 'takım arkadaşı normal başlar');
    assert.equal(mateCar.compound, 'MEDIUM');
    // Takım arkadaşı yalnızca cezalı araç önündeyse bir sıra öne kayar.
    assert.ok(mateCar.gridPosition <= mateSlotBefore.gridPosition);
  });

  /**
   * Bayraksız yarış, değişiklikten ÖNCE alınmış çıktıyla birebir aynı olmalı.
   * Aşağıdaki altın çıktı `main` üzerinde, pit yolu kodu yazılmadan önce
   * üretildi. Tek bir hane oynarsa motorun determinizmi kırılmış demektir.
   */
  it('bayraksız yarış eski davranışla birebir aynı', () => {
    const { entries, risks } = makeEntries();
    const track = trackForRound(ROUND);
    const weather = weatherFor(track, SEED);
    const quali = simulateQualifying({
      track, entries, risks, aiBonus: {}, rosters: {}, wet: weather.wetAtStart, round: ROUND, seed: SEED,
    });
    let state = startRace({
      standings: freshStandings(), track, entries, weather, grid: quali.grid, round: ROUND, seed: SEED, aiBonus: {}, rosters: {},
    });
    while (!state.finished) state = advanceLap(state, track, autoDecisions(state, track));
    const result = finishRace(state);

    const lines = result.order.map((e) =>
      `${e.position} ${e.teamKey}:${e.driverIdx} grid=${e.gridPosition} dnf=${e.dnf} gap=${e.gapSec} best=${e.bestLapSec} stops=${e.stops}`);
    assert.deepEqual(lines, GOLDEN);
  });
});

/** Değişiklikten önce yakalanan bitiş sırası. Dokunmayın. */
const GOLDEN = [
  '1 bravado:0 grid=2 dnf=false gap=0 best=73.736 stops=2',
  '2 bosphorus:0 grid=5 dnf=false gap=8.371 best=73.748 stops=2',
  '3 aurelia:0 grid=6 dnf=false gap=8.657 best=73.433 stops=2',
  '4 bosphorus:1 grid=10 dnf=false gap=27.2 best=74.298 stops=2',
  '5 ravensworth:1 grid=3 dnf=false gap=55.189 best=73.885 stops=2',
  '6 ridgeline:1 grid=22 dnf=false gap=69.081 best=74.309 stops=2',
  '7 castellan:0 grid=13 dnf=false gap=75.819 best=74.569 stops=2',
  '8 bravado:1 grid=4 dnf=false gap=76.857 best=74.629 stops=2',
  '9 ridgeline:0 grid=1 dnf=false gap=77.008 best=74.406 stops=2',
  '10 orenda:0 grid=19 dnf=false gap=77.408 best=74.045 stops=2',
  '11 aurelia:1 grid=9 dnf=false gap=93.86 best=74.34 stops=2',
  '12 northgate:0 grid=11 dnf=false gap=99.222 best=75.523 stops=1',
  '13 orenda:1 grid=16 dnf=false gap=99.622 best=74.801 stops=2',
  '14 verano:0 grid=15 dnf=false gap=100.022 best=75.502 stops=2',
  '15 silberpfad:1 grid=14 dnf=false gap=100.422 best=74.218 stops=2',
  '16 northgate:1 grid=12 dnf=false gap=100.822 best=75.26 stops=2',
  '17 falkirk:1 grid=21 dnf=false gap=101.222 best=74.359 stops=2',
  '18 falkirk:0 grid=18 dnf=false gap=101.622 best=75.109 stops=2',
  '19 silberpfad:0 grid=8 dnf=false gap=102.022 best=74.37 stops=2',
  '20 verano:1 grid=17 dnf=false gap=102.422 best=75.888 stops=2',
  '21 castellan:1 grid=20 dnf=false gap=102.822 best=75.086 stops=2',
  '22 ravensworth:0 grid=7 dnf=true gap=undefined best=75.975 stops=0',
];
