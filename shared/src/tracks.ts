/**
 * The calendar: twenty-three circuits and what each one asks of a car.
 *
 * A track is described by how it splits its reward between the three car
 * stats (`demand`), how likely it is to rain there, how hard it is on
 * machinery, how easy it is to overtake, and the race-distance numbers the
 * lap engine needs (laps, a base lap time, the cost of a pit stop). Those are
 * what turn "MOTOR 67" from a bar on a screen into a result: a power circuit
 * pays for engine, a twisty one pays for grip, a street circuit punishes a bad
 * grid slot and breaks cars.
 *
 * Everything here is fictional on purpose. Several real circuits protect their
 * outline and their name as trademarks, and the official race titles belong
 * to the sport's promoter — so the names are invented, and the `layout`
 * shapes are original designs that read as a type of circuit (street, power,
 * flowing) without tracing any real one. Country codes are the only real thing.
 */

export type TrackFit = 'green' | 'yellow' | 'red';

export interface TrackDemand {
  motor: number;
  aero: number;
  grip: number;
}

/** A point on the map, both axes 0-1. Layouts are closed loops; the first point is the start line. */
export interface Point {
  x: number;
  y: number;
}

export type TrackRegion = 'europe' | 'middleEast' | 'asiaPacific' | 'americas';

/**
 * How often race control has to step in here, per race. Calibrated from the
 * 2024-2025 seasons and the official per-circuit figures F1 publishes before
 * each round (see docs/race-control-research.md §2). `yellow` is a modelled
 * estimate — no public per-circuit statistic exists for local yellows.
 */
export interface RaceControlProfile {
  /** Probability of at least one full safety car. */
  sc: number;
  /** Probability of at least one virtual safety car. */
  vsc: number;
  /** Probability the race is red-flagged. */
  red: number;
  /** Expected local yellow-flag episodes per race. */
  yellow: number;
}

export interface Track {
  key: string;
  gp: string;
  /** Three-letter country code, as shown on the ticket. */
  country: string;
  circuit: string;
  /** How the circuit rewards each stat. The three sum to 1.0. */
  demand: TrackDemand;
  /** What the manager sees: 'Sokak pisti · motor gücü'. Follows from `demand`. */
  label: string;
  /** Probability of a wet race, 0-1. */
  rainChance: number;
  /** Mechanical and accident pressure, 0-1. Street circuits run high. */
  attrition: number;
  /** How easy passing is, 0-1. Low means the grid slot decides more of the race. */
  overtaking: number;
  /** Race distance. Street circuits run longer; the game clock follows (see plan §2). */
  laps: number;
  /** What a 100-pace car laps in, seconds. Everything slower is added on top. */
  baseLapSec: number;
  /** Time lost to a pit stop, seconds. Long pit lanes cost more. */
  pitLossSec: number;
  /** The map, clockwise. Original design, not a real circuit. */
  layout: Point[];
  raceControl: RaceControlProfile;
  /** Sprint weekend: FP1 → sprint qualifying → sprint → qualifying → race. */
  sprint: boolean;
  /** Sets the session clock (see `weekendSchedule`). */
  region: TrackRegion;
}

const p = (x: number, y: number): Point => ({ x, y });

/** Local yellows are not published per circuit; modelled as 2 + 3 × attrition, filled in below. */
const rc = (sc: number, vsc: number, red: number): RaceControlProfile => ({ sc, vsc, red, yellow: 0 });

const t = (
  key: string,
  gp: string,
  country: string,
  circuit: string,
  demand: TrackDemand,
  label: string,
  rainChance: number,
  attrition: number,
  overtaking: number,
  laps: number,
  baseLapSec: number,
  pitLossSec: number,
  layout: Point[],
  raceControl: RaceControlProfile,
  sprint: boolean,
  region: TrackRegion,
): Track => ({ key, gp, country, circuit, demand, label, rainChance, attrition, overtaking, laps, baseLapSec, pitLossSec, layout, raceControl, sprint, region });

export const calendar: Track[] = [
  t('dunes', 'Gulf GP', 'BHR', 'Al Rimal Desert Circuit', { motor: 0.4, aero: 0.25, grip: 0.35 }, 'Karışık · fren', 0.02, 0.35, 0.75, 57, 91, 21,
    [p(0.08, 0.55), p(0.1, 0.25), p(0.3, 0.15), p(0.5, 0.2), p(0.55, 0.4), p(0.75, 0.35), p(0.9, 0.5), p(0.85, 0.75), p(0.6, 0.82), p(0.45, 0.65), p(0.3, 0.8), p(0.12, 0.75)], rc(0.2, 0.25, 0.03), false, 'middleEast'),
  t('corniche', 'Red Sea GP', 'SAU', 'Corniche Lights Street Circuit', { motor: 0.4, aero: 0.4, grip: 0.2 }, 'Sokak pisti · hız', 0.03, 0.6, 0.55, 50, 89, 20,
    [p(0.1, 0.9), p(0.08, 0.2), p(0.2, 0.08), p(0.35, 0.15), p(0.5, 0.08), p(0.65, 0.18), p(0.8, 0.1), p(0.92, 0.3), p(0.9, 0.6), p(0.75, 0.55), p(0.6, 0.7), p(0.45, 0.62), p(0.3, 0.8), p(0.25, 0.92)], rc(0.55, 0.25, 0.15), false, 'middleEast'),
  t('harbourpark', 'Southern Cross GP', 'AUS', 'Harbour Park Circuit', { motor: 0.3, aero: 0.35, grip: 0.35 }, 'Park pisti · karışık', 0.25, 0.45, 0.5, 58, 80, 19,
    [p(0.15, 0.7), p(0.1, 0.4), p(0.25, 0.2), p(0.45, 0.25), p(0.6, 0.12), p(0.85, 0.2), p(0.9, 0.45), p(0.7, 0.55), p(0.75, 0.78), p(0.5, 0.88), p(0.3, 0.85)], rc(0.5, 0.6, 0.12), false, 'asiaPacific'),
  t('kashima', 'Rising Sun GP', 'JPN', 'Kashima Figure-Eight', { motor: 0.25, aero: 0.45, grip: 0.3 }, 'Aero · akıcı virajlar', 0.35, 0.3, 0.4, 53, 92, 22,
    [p(0.12, 0.8), p(0.08, 0.5), p(0.22, 0.3), p(0.4, 0.42), p(0.55, 0.28), p(0.6, 0.1), p(0.8, 0.08), p(0.92, 0.28), p(0.85, 0.5), p(0.65, 0.6), p(0.5, 0.78), p(0.3, 0.9)], rc(0.35, 0.2, 0.08), false, 'asiaPacific'),
  t('pearlriver', 'Pearl River GP', 'CHN', 'Pearl River International', { motor: 0.4, aero: 0.3, grip: 0.3 }, 'Motor gücü · uzun düzlük', 0.2, 0.3, 0.7, 56, 94, 22,
    [p(0.12, 0.85), p(0.08, 0.6), p(0.2, 0.3), p(0.35, 0.2), p(0.42, 0.35), p(0.3, 0.5), p(0.5, 0.6), p(0.7, 0.35), p(0.92, 0.3), p(0.9, 0.7), p(0.7, 0.9), p(0.4, 0.92)], rc(0.35, 0.35, 0.05), true, 'asiaPacific'),
  t('bayfront', 'Bayfront GP', 'USA', 'Bayfront Stadium Circuit', { motor: 0.35, aero: 0.3, grip: 0.35 }, 'Sokak pisti · karışık', 0.3, 0.5, 0.6, 57, 88, 21,
    [p(0.1, 0.5), p(0.15, 0.2), p(0.4, 0.12), p(0.6, 0.2), p(0.7, 0.4), p(0.88, 0.45), p(0.92, 0.7), p(0.75, 0.85), p(0.55, 0.75), p(0.4, 0.88), p(0.2, 0.8)], rc(0.45, 0.5, 0.1), true, 'americas'),
  t('valledoro', 'Riviera GP', 'ITA', "Valle d'Oro Autodromo", { motor: 0.3, aero: 0.4, grip: 0.3 }, 'Klasik pist · aero', 0.25, 0.4, 0.3, 63, 78, 23,
    [p(0.1, 0.35), p(0.2, 0.12), p(0.5, 0.1), p(0.7, 0.2), p(0.9, 0.15), p(0.92, 0.4), p(0.75, 0.5), p(0.85, 0.72), p(0.6, 0.88), p(0.35, 0.8), p(0.25, 0.6), p(0.08, 0.6)], rc(0.4, 0.3, 0.08), false, 'europe'),
  t('principality', 'Principality GP', 'MCO', 'Rocher Harbour Streets', { motor: 0.1, aero: 0.35, grip: 0.55 }, 'Sokak pisti · yol tutuş', 0.2, 0.7, 0.05, 78, 72, 18,
    [p(0.15, 0.6), p(0.1, 0.35), p(0.3, 0.2), p(0.45, 0.3), p(0.55, 0.12), p(0.75, 0.1), p(0.9, 0.25), p(0.8, 0.45), p(0.9, 0.7), p(0.7, 0.8), p(0.55, 0.65), p(0.4, 0.85), p(0.2, 0.85)], rc(0.55, 0.45, 0.2), false, 'europe'),
  t('montjuic', 'Iberian GP', 'ESP', 'Sierra Blanca Circuit', { motor: 0.3, aero: 0.45, grip: 0.25 }, 'Aero · test pisti', 0.1, 0.25, 0.5, 66, 79, 21,
    [p(0.1, 0.7), p(0.08, 0.3), p(0.3, 0.12), p(0.55, 0.15), p(0.7, 0.3), p(0.9, 0.25), p(0.92, 0.55), p(0.75, 0.65), p(0.8, 0.85), p(0.5, 0.9), p(0.35, 0.72), p(0.2, 0.88)], rc(0.25, 0.25, 0.04), false, 'europe'),
  t('islandloop', 'Maple GP', 'CAN', 'Île du Nord Loop', { motor: 0.45, aero: 0.2, grip: 0.35 }, 'Motor gücü · duvarlar yakın', 0.3, 0.55, 0.65, 70, 74, 19,
    [p(0.08, 0.6), p(0.12, 0.3), p(0.3, 0.25), p(0.5, 0.35), p(0.7, 0.2), p(0.92, 0.3), p(0.9, 0.55), p(0.72, 0.6), p(0.6, 0.78), p(0.35, 0.72), p(0.15, 0.82)], rc(0.7, 0.3, 0.12), true, 'americas'),
  t('alpenring', 'Alpine GP', 'AUT', 'Alpenring', { motor: 0.45, aero: 0.3, grip: 0.25 }, 'Motor gücü · kısa tur', 0.3, 0.3, 0.7, 71, 66, 20,
    [p(0.1, 0.8), p(0.15, 0.3), p(0.4, 0.12), p(0.75, 0.1), p(0.9, 0.3), p(0.8, 0.5), p(0.88, 0.75), p(0.6, 0.85), p(0.35, 0.9)], rc(0.35, 0.35, 0.05), false, 'europe'),
  t('greystone', 'Albion GP', 'GBR', 'Greystone Aerodrome', { motor: 0.3, aero: 0.5, grip: 0.2 }, 'Aero · hızlı virajlar', 0.4, 0.3, 0.55, 52, 87, 22,
    [p(0.1, 0.45), p(0.25, 0.2), p(0.5, 0.12), p(0.6, 0.3), p(0.8, 0.15), p(0.92, 0.35), p(0.85, 0.6), p(0.65, 0.65), p(0.7, 0.88), p(0.4, 0.9), p(0.3, 0.7), p(0.12, 0.75)], rc(0.45, 0.35, 0.08), true, 'europe'),
  t('danubering', 'Danube GP', 'HUN', 'Danube Ring', { motor: 0.2, aero: 0.35, grip: 0.45 }, 'Yol tutuş · dar pist', 0.25, 0.35, 0.2, 70, 76, 20,
    [p(0.12, 0.65), p(0.1, 0.35), p(0.3, 0.15), p(0.5, 0.3), p(0.65, 0.12), p(0.88, 0.2), p(0.9, 0.5), p(0.72, 0.62), p(0.8, 0.85), p(0.5, 0.9), p(0.35, 0.75), p(0.25, 0.9)], rc(0.3, 0.25, 0.05), false, 'europe'),
  t('ardennes', 'Ardennes GP', 'BEL', 'Ardennes Forest Circuit', { motor: 0.4, aero: 0.4, grip: 0.2 }, 'Motor gücü · aero', 0.5, 0.45, 0.7, 44, 106, 24,
    [p(0.08, 0.7), p(0.1, 0.4), p(0.25, 0.3), p(0.35, 0.1), p(0.6, 0.08), p(0.8, 0.2), p(0.92, 0.45), p(0.85, 0.7), p(0.65, 0.8), p(0.5, 0.65), p(0.35, 0.85), p(0.18, 0.9)], rc(0.6, 0.05, 0.15), false, 'europe'),
  t('duinen', 'Lowlands GP', 'NLD', 'Duinen Beach Circuit', { motor: 0.2, aero: 0.4, grip: 0.4 }, 'Yol tutuş · eğimli virajlar', 0.35, 0.4, 0.25, 72, 71, 19,
    [p(0.15, 0.75), p(0.1, 0.4), p(0.3, 0.25), p(0.5, 0.35), p(0.55, 0.15), p(0.8, 0.12), p(0.9, 0.4), p(0.75, 0.55), p(0.85, 0.8), p(0.6, 0.9), p(0.4, 0.78)], rc(0.55, 0.3, 0.12), true, 'europe'),
  t('velocita', 'Lombardy GP', 'ITA', 'Autodromo Velocità', { motor: 0.55, aero: 0.25, grip: 0.2 }, 'Motor gücü · hız tapınağı', 0.2, 0.4, 0.8, 53, 81, 23,
    [p(0.1, 0.85), p(0.08, 0.25), p(0.2, 0.1), p(0.45, 0.15), p(0.7, 0.1), p(0.9, 0.2), p(0.92, 0.45), p(0.8, 0.55), p(0.9, 0.8), p(0.6, 0.9), p(0.35, 0.92)], rc(0.35, 0.3, 0.06), false, 'europe'),
  t('caspian', 'Caspian GP', 'AZE', 'Caspian Old Town Circuit', { motor: 0.5, aero: 0.2, grip: 0.3 }, 'Sokak pisti · motor gücü', 0.1, 0.65, 0.6, 51, 100, 21,
    [p(0.08, 0.5), p(0.1, 0.15), p(0.3, 0.1), p(0.5, 0.2), p(0.55, 0.4), p(0.7, 0.42), p(0.72, 0.25), p(0.9, 0.2), p(0.92, 0.55), p(0.85, 0.85), p(0.55, 0.9), p(0.3, 0.8), p(0.12, 0.85)], rc(0.6, 0.3, 0.3), false, 'middleEast'),
  t('marinalights', 'Straits GP', 'SGP', 'Marina Lights Night Circuit', { motor: 0.15, aero: 0.35, grip: 0.5 }, 'Sokak pisti · yol tutuş', 0.4, 0.75, 0.15, 62, 96, 22,
    [p(0.12, 0.5), p(0.1, 0.2), p(0.3, 0.12), p(0.4, 0.3), p(0.6, 0.25), p(0.65, 0.1), p(0.88, 0.15), p(0.9, 0.4), p(0.75, 0.5), p(0.88, 0.75), p(0.65, 0.88), p(0.45, 0.72), p(0.25, 0.9), p(0.1, 0.8)], rc(0.9, 0.35, 0.15), true, 'asiaPacific'),
  t('prairie', 'Lone Star GP', 'USA', 'Prairie Hill Circuit', { motor: 0.3, aero: 0.4, grip: 0.3 }, 'Karışık · akıcı', 0.2, 0.3, 0.6, 56, 95, 22,
    [p(0.1, 0.8), p(0.15, 0.4), p(0.3, 0.15), p(0.5, 0.25), p(0.65, 0.1), p(0.85, 0.15), p(0.92, 0.4), p(0.75, 0.5), p(0.85, 0.7), p(0.65, 0.9), p(0.4, 0.75), p(0.25, 0.9)], rc(0.4, 0.35, 0.06), false, 'americas'),
  t('altiplano', 'Altiplano GP', 'MEX', 'Altiplano Stadium Circuit', { motor: 0.45, aero: 0.2, grip: 0.35 }, 'Motor gücü · yüksek irtifa', 0.15, 0.4, 0.65, 71, 78, 20,
    [p(0.1, 0.55), p(0.08, 0.2), p(0.35, 0.1), p(0.7, 0.12), p(0.92, 0.25), p(0.85, 0.5), p(0.65, 0.55), p(0.72, 0.8), p(0.5, 0.9), p(0.3, 0.75), p(0.15, 0.85)], rc(0.45, 0.3, 0.1), false, 'americas'),
  t('serrahill', 'Serra GP', 'BRA', 'Serra Hill Circuit', { motor: 0.35, aero: 0.3, grip: 0.35 }, 'Karışık · yağmur riski', 0.55, 0.45, 0.7, 71, 72, 20,
    [p(0.15, 0.5), p(0.1, 0.25), p(0.3, 0.1), p(0.55, 0.15), p(0.75, 0.08), p(0.9, 0.3), p(0.8, 0.5), p(0.9, 0.75), p(0.65, 0.88), p(0.45, 0.7), p(0.3, 0.88), p(0.12, 0.75)], rc(0.65, 0.35, 0.15), false, 'americas'),
  t('neonstrip', 'Neon GP', 'USA', 'Neon Boulevard Circuit', { motor: 0.55, aero: 0.2, grip: 0.25 }, 'Sokak pisti · motor gücü', 0.05, 0.5, 0.7, 50, 98, 21,
    [p(0.08, 0.85), p(0.08, 0.15), p(0.3, 0.1), p(0.35, 0.3), p(0.55, 0.32), p(0.6, 0.1), p(0.9, 0.12), p(0.92, 0.5), p(0.75, 0.6), p(0.9, 0.85), p(0.5, 0.9)], rc(0.35, 0.55, 0.08), false, 'americas'),
  t('lagoon', 'Lagoon GP', 'ARE', 'Lagoon Marina Circuit', { motor: 0.35, aero: 0.35, grip: 0.3 }, 'Karışık · sezon finali', 0.02, 0.3, 0.45, 58, 86, 21,
    [p(0.12, 0.7), p(0.1, 0.35), p(0.25, 0.15), p(0.5, 0.1), p(0.7, 0.2), p(0.9, 0.15), p(0.92, 0.45), p(0.7, 0.5), p(0.75, 0.7), p(0.6, 0.88), p(0.35, 0.8), p(0.25, 0.9)], rc(0.3, 0.45, 0.03), false, 'middleEast'),
];

for (const track of calendar) track.raceControl.yellow = Math.round((2 + 3 * track.attrition) * 10) / 10;

// ── Session clock ──────────────────────────────────────────────────────────

export type SessionKey = 'FP1' | 'FP2' | 'FP3' | 'SQ' | 'SPRINT' | 'Q' | 'RACE';

export interface ScheduledSession {
  key: SessionKey;
  /** Turkish label. */
  label: string;
  /** Start, minutes after 00:00 UTC on race day. */
  startUtcMin: number;
}

/**
 * Every circuit is one game day; the day sits in its region's evening so
 * the league's managers can be at the wall. Real weekends spread this over
 * three days (2026 Zandvoort: FP1 Fri 09:30, SQ 13:30, Sprint Sat 10:00, Q
 * 14:00, race Sun 13:00); here the same order is compressed with the gaps the
 * owner asked for — an hour between practices, half an hour before
 * qualifying, ninety minutes before the race.
 */
const REGION_FP1_UTC_MIN: Record<TrackRegion, number> = {
  europe: 12 * 60,
  middleEast: 13 * 60,
  asiaPacific: 5 * 60,
  americas: 17 * 60,
};

export function weekendSchedule(track: Track): ScheduledSession[] {
  const t0 = REGION_FP1_UTC_MIN[track.region];
  if (track.sprint) {
    return [
      { key: 'FP1', label: 'Antrenman 1', startUtcMin: t0 },
      { key: 'SQ', label: 'Sprint Sıralaması', startUtcMin: t0 + 60 },
      { key: 'SPRINT', label: 'Sprint', startUtcMin: t0 + 120 },
      { key: 'Q', label: 'Sıralama', startUtcMin: t0 + 180 },
      { key: 'RACE', label: 'Yarış', startUtcMin: t0 + 270 },
    ];
  }
  return [
    { key: 'FP1', label: 'Antrenman 1', startUtcMin: t0 },
    { key: 'FP2', label: 'Antrenman 2', startUtcMin: t0 + 60 },
    { key: 'FP3', label: 'Antrenman 3', startUtcMin: t0 + 120 },
    { key: 'Q', label: 'Sıralama', startUtcMin: t0 + 150 },
    { key: 'RACE', label: 'Yarış', startUtcMin: t0 + 240 },
  ];
}

/**
 * "18:30" in the device's local time for a UTC minute-of-day. Varsayılanı
 * YOKTUR — hangi anın kastedildiğini çağıran söylemek zorunda (bkz. `dayKey`
 * içindeki aynı gerekçe, `economy.ts`).
 */
export function localClock(startUtcMin: number, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, startUtcMin));
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** Sprint distance: about a third of the Grand Prix. */
export const sprintLaps = (track: Track): number => Math.max(15, Math.round(track.laps / 3));

/** Rounds are 1-based; a round past the end wraps, so a 24th round is a new season's opener. */
export const trackForRound = (round: number): Track =>
  calendar[(((round - 1) % calendar.length) + calendar.length) % calendar.length];

export const trackByKey = (key: string): Track =>
  calendar.find((c) => c.key === key) ?? calendar[0];

/**
 * How well one stat suits this circuit.
 *
 * The bar a stat has to clear scales with how much the track leans on it: a
 * power track asks a lot of MOTOR and forgives a weak AERO. A third of the
 * demand (an even split) needs a tier-two car (60); each extra tenth of demand
 * moves the bar by about seven points.
 */
export function fitOf(value: number, demandShare: number): TrackFit {
  const required = 60 + (demandShare - 1 / 3) * 75;
  if (value >= required) return 'green';
  if (value >= required - 10) return 'yellow';
  return 'red';
}

/** 0-100: how much of the circuit's demand the car's stats cover. */
export function fitScore(stats: TrackDemand, track: Track): number {
  const { demand } = track;
  return Math.round(stats.motor * demand.motor + stats.aero * demand.aero + stats.grip * demand.grip);
}

/** Per-stat demand as a percentage bar (the race-week "Track Fit" panel). */
export const demandPct = (track: Track): Record<keyof TrackDemand, number> => ({
  motor: Math.round(track.demand.motor * 100),
  aero: Math.round(track.demand.aero * 100),
  grip: Math.round(track.demand.grip * 100),
});

/**
 * A point along the lap, `progress` 0-1 from the start line, on the smoothed
 * loop (Catmull-Rom through the layout points). Used to place cars on the map.
 */
export function pointAlong(layout: Point[], progress: number): Point {
  const n = layout.length;
  const u = ((progress % 1) + 1) % 1;
  const scaled = u * n;
  const i = Math.floor(scaled);
  const s = scaled - i;
  const p0 = layout[(i - 1 + n) % n];
  const p1 = layout[i % n];
  const p2 = layout[(i + 1) % n];
  const p3 = layout[(i + 2) % n];
  const cr = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * s + (2 * a - 5 * b + 4 * c - d) * s * s + (-a + 3 * b - 3 * c + d) * s * s * s);
  return { x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
}
