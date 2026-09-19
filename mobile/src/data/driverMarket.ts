/**
 * Drivers as people who get better, get older, and can be bought.
 *
 * Every driver carries `age` and `potential` (the overall rating they could
 * reach). Training moves one stat toward that potential over six real hours;
 * how far depends on age and on how much headroom is left, following the
 * usual manager-game shape (young drivers improve fast, 28-32 is the peak,
 * 33+ declines) — docs/paddock-research.md §2.4. Stats are kept fractional
 * and rounded for display so small daily gains are not lost.
 *
 * The market is a seeded pool of free agents per season. Prices scale with
 * ability and a driver is always dearer than a head of department: a driver
 * is a quarter of the lap, a chief mechanic a tenth of an upgrade.
 */

import { rng } from './rng';
import { overallOf, type Driver, type DriverStats } from './teams';

export type StatKey = 'motor' | 'aero' | 'grip';
export type DriverStatKey = keyof DriverStats;

export const driverStatKeys: { key: DriverStatKey; label: string }[] = [
  { key: 'pace', label: 'Hız' },
  { key: 'consistency', label: 'Tutarlılık' },
  { key: 'racecraft', label: 'Yarış zekâsı' },
  { key: 'wet', label: 'Yağmur' },
  { key: 'reaction', label: 'Refleks' },
  { key: 'dev', label: 'Gelişim' },
];

/** Training takes this long in real time. */
export const TRAINING_MS = 6 * 60 * 60 * 1000;

export interface Training {
  driverIdx: 0 | 1;
  stat: DriverStatKey;
  /** Epoch ms when the session completes. */
  endsAt: number;
}

/** Faster when young, flat at the peak, nothing after 33. */
export function ageFactor(age: number): number {
  if (age <= 24) return 1.4;
  if (age <= 28) return 1.0;
  if (age <= 32) return 0.6;
  return 0;
}

/**
 * Points one six-hour session adds to a stat. Headroom is the gap between
 * potential and current overall, scaled so a young driver twenty points
 * short gains about a point a session and a veteran at his ceiling gains
 * nothing.
 */
export function trainingGain(driver: Driver, stat: DriverStatKey): number {
  const headroom = Math.max(0, driver.potential - overallOf(driver.stats));
  const gapFactor = Math.max(0.2, Math.min(1.5, headroom / 20));
  const statRoom = Math.max(0, 99 - driver.stats[stat]) / 99;
  return Math.round(0.6 * ageFactor(driver.age) * gapFactor * (0.5 + statRoom) * 100) / 100;
}

/** End-of-season ageing: a year older; past 33 the sharpest stats start to fade. */
export function ageOneSeason(driver: Driver): Driver {
  const age = driver.age + 1;
  const stats = { ...driver.stats };
  if (age >= 34) {
    stats.pace = Math.max(30, stats.pace - 1);
    stats.reaction = Math.max(30, stats.reaction - 1);
  }
  return { ...driver, age, stats, skill: overallOf(stats) };
}

/**
 * A rival team's season: everyone a year older, the young ones grow toward
 * their potential, the veterans fade. Seeded on team + season so the whole
 * league develops the same way for every manager.
 */
export function developRosterSeason(roster: [Driver, Driver], teamKey: string, season: number): [Driver, Driver] {
  const random = rng(season * 2917 + teamKey.length * 431 + teamKey.charCodeAt(0));
  const grow = (d: Driver): Driver => {
    const aged = ageOneSeason(d);
    const headroom = Math.max(0, aged.potential - overallOf(aged.stats));
    const step = ageFactor(aged.age) * Math.min(3, headroom / 3) * (0.6 + random() * 0.8);
    const stats = { ...aged.stats };
    stats.pace = Math.min(99, Math.round((stats.pace + step) * 10) / 10);
    stats.racecraft = Math.min(99, Math.round((stats.racecraft + step * 0.7) * 10) / 10);
    stats.consistency = Math.min(99, Math.round((stats.consistency + step * 0.5) * 10) / 10);
    return { ...aged, stats, skill: overallOf(stats) };
  };
  return [grow(roster[0]), grow(roster[1])];
}

// ── Market ─────────────────────────────────────────────────────────────────

export interface MarketDriver extends Driver {
  id: string;
  /** One-off transfer fee, RP. */
  fee: number;
  /** RP per race. */
  wage: number;
}

/** Fee grows with ability and with what is still to come. */
export function driverFee(driver: Driver): number {
  const overall = overallOf(driver.stats);
  const upside = Math.max(0, driver.potential - overall);
  return Math.round(800 * Math.pow(1.075, overall - 55) + upside * 25);
}

/** Menajer komisyonu: satışta değerin %20'si kesilir. */
export const SALE_COMMISSION = 0.2;

/**
 * Bir sürücüyü sattığında eline geçen.
 *
 * Komisyon, "al-sat" döngüsünün kârını yetiştirmekten gelmeye zorlar: aynı
 * sürücüyü aldığın fiyata geri satamazsın, değerini artırman gerekir.
 */
export const saleValue = (driver: Driver): number =>
  Math.round(driverFee(driver) * (1 - SALE_COMMISSION));

export const driverWage = (driver: Driver): number => Math.round(60 + ((overallOf(driver.stats) - 55) / 40) * 190);

const NAMES = ['L. Aydın', 'R. Castellanos', 'M. Ekholm', 'T. Obi', 'J. Fontaine', 'K. Park', 'A. Rossi', 'S. Varga', 'D. Mbatha', 'E. Karlsen', 'B. Yılmaz', 'P. Silva', 'H. Berger', 'N. Laurent', 'C. Ahmadi', 'G. Ito'];

/**
 * This season's free agents: eight drivers, seeded by season, refreshed with
 * each round's number so the list turns over daily without repeating.
 */
export function driverMarket(season: number, round: number, takenNumbers: number[]): MarketDriver[] {
  const random = rng(season * 5417 + round * 97 + 3);
  const numbers = new NumberPool(takenNumbers);
  const out: MarketDriver[] = [];
  for (let i = 0; i < 8; i++) {
    const driver = generateDriver(random, numbers, 19 + Math.floor(random() * 16));
    out.push({ ...driver, id: `${season}-${round}-${i}`, fee: driverFee(driver), wage: driverWage(driver) });
  }
  return out;
}

/** Racing numbers are unique across the grid; this hands out the next free one. */
class NumberPool {
  private next = 60;
  constructor(private readonly taken: number[]) {}
  take(): number {
    while (this.taken.includes(this.next)) this.next += 1;
    const n = this.next;
    this.taken.push(n);
    this.next += 1;
    return n;
  }
}

/** One driver out of thin air: stats around a base, potential set by age. */
function generateDriver(random: () => number, numbers: NumberPool, age: number): Driver {
  const base = 55 + Math.floor(random() * 30) - (age <= 22 ? 8 : 0);
  const stats: DriverStats = {
    pace: clamp(base + random() * 6 - 3),
    consistency: clamp(base + random() * 14 - 7),
    racecraft: clamp(base + random() * 14 - 7),
    wet: clamp(base + random() * 20 - 10),
    reaction: clamp(base + random() * 20 - 10),
    dev: clamp(40 + random() * 50),
  };
  const overall = overallOf(stats);
  const potential = clamp(overall + (age <= 24 ? 8 + random() * 14 : age <= 28 ? 3 + random() * 8 : random() * 3));
  return { name: NAMES[Math.floor(random() * NAMES.length)], number: numbers.take(), skill: overall, stats, age, potential };
}

const clamp = (v: number): number => Math.max(30, Math.min(99, Math.round(v)));

// ── Contracts ──────────────────────────────────────────────────────────────
//
// A driver is signed for a number of SEASONS, not forever. Length is the
// trade the manager actually makes: a one-year deal is cheap to enter and
// expensive to run, a three-year deal costs to sign and then pays for itself
// — and locks the seat if the driver stops improving. Contracts tick down in
// the winter, and a driver whose deal ran out leaves for whoever wants him.

export interface Contract {
  /** Seasons still to run, this one included. 1 = final year: out of contract in the winter. */
  seasonsLeft: number;
  /** RP per race, fixed for the life of the deal. */
  wage: number;
}

export interface ContractTerm {
  seasons: number;
  label: string;
  /** Multiplier on the transfer fee. */
  feeScale: number;
  /** Multiplier on the wage — short deals pay a premium per race. */
  wageScale: number;
}

export const contractTerms: ContractTerm[] = [
  { seasons: 1, label: '1 SEZON', feeScale: 0.7, wageScale: 1.25 },
  { seasons: 2, label: '2 SEZON', feeScale: 1, wageScale: 1 },
  { seasons: 3, label: '3 SEZON', feeScale: 1.45, wageScale: 0.85 },
];

export const termFor = (seasons: number): ContractTerm => contractTerms.find((t) => t.seasons === seasons) ?? contractTerms[1];

/** What signing this driver on this term costs up front. */
export const signingCost = (driver: Driver, seasons: number): number => Math.round(driverFee(driver) * termFor(seasons).feeScale);

/** What he is then paid per race. */
export const contractWage = (driver: Driver, seasons: number): number => Math.round(driverWage(driver) * termFor(seasons).wageScale);

/**
 * Keeping a driver you already have: no transfer fee, only a signing bonus —
 * but at his CURRENT price, so a driver who improved on your watch is dearer
 * to keep than he was to sign.
 */
export const renewalCost = (driver: Driver, seasons: number): number => Math.round(driverFee(driver) * 0.45 * termFor(seasons).feeScale);

/** Rival deals at the start of a career: one to three seasons, seeded per team. */
export function initialContracts(teamKey: string, roster: [Driver, Driver]): [Contract, Contract] {
  const random = rng(teamKey.charCodeAt(0) * 131 + teamKey.length * 17 + 5);
  const one = (d: Driver): Contract => ({ seasonsLeft: 1 + Math.floor(random() * 3), wage: driverWage(d) });
  return [one(roster[0]), one(roster[1])];
}

// ── The transfer window ────────────────────────────────────────────────────
//
// Between seasons every expired deal opens a seat, and the grid reshuffles to
// fill them: the strongest team picks first, from the free agents and from
// the drivers sitting on final-year deals at weaker teams. Poaching cascades —
// a seat filled from another team opens one there — and anything still empty
// when the pool runs dry is filled by a rookie. All of it is seeded on the
// season, so every manager in a league sees the same winter.

export interface TransferMove {
  driver: string;
  /** The team he left; absent when he was already a free agent. */
  fromKey?: string;
  /** The team he joined. */
  toKey: string;
  seat: 0 | 1;
  /** How he got the seat. */
  kind: 'poached' | 'freeAgent' | 'rookie';
}

export interface TransferWindowInput {
  season: number;
  /** Every team's roster, already aged and developed. Keyed by team. */
  rosters: Record<string, [Driver, Driver]>;
  contracts: Record<string, [Contract, Contract]>;
  /** The teams the window may touch — the player's is not one of them. */
  teamKeys: string[];
  /** Pecking order: the strongest team picks first. */
  strength: Record<string, number>;
  /** Drivers already looking for a seat — the player's departed, above all. */
  freeAgents: Driver[];
  /** Numbers in use across the grid, so a new face gets a free one. */
  takenNumbers: number[];
}

export interface TransferWindowResult {
  rosters: Record<string, [Driver, Driver]>;
  contracts: Record<string, [Contract, Contract]>;
  moves: TransferMove[];
  /** Drivers who hung up the helmet rather than look for a seat. */
  retired: Driver[];
  /** Drivers nobody took. */
  unsigned: Driver[];
}

/**
 * A driver out of contract at this age stops rather than shop around; from 34
 * it is a coin toss. Without this nobody would ever leave the sport and no
 * rookie would ever get a seat.
 */
const RETIRE_AGE = 36;
const LATE_CAREER_AGE = 34;
const LATE_CAREER_RETIRE_CHANCE = 0.4;

const retires = (driver: Driver, random: () => number): boolean =>
  driver.age >= RETIRE_AGE || (driver.age >= LATE_CAREER_AGE && random() < LATE_CAREER_RETIRE_CHANCE);

/** A team lets a driver go early this often when he is well below what the team is worth. */
const EARLY_RELEASE_CHANCE = 0.25;
/** How far below the team's own level a driver has to be before that is even considered. */
const UNDERPERFORM_GAP = 8;

export function runTransferWindow(input: TransferWindowInput): TransferWindowResult {
  const random = rng(input.season * 7717 + 991);
  const rosters: Record<string, [Driver, Driver]> = { ...input.rosters };
  const contracts: Record<string, [Contract, Contract]> = {};
  const numbers = new NumberPool([...input.takenNumbers]);
  const moves: TransferMove[] = [];
  const retired: Driver[] = [];
  const pool: { driver: Driver; fromKey?: string }[] = [];
  for (const driver of input.freeAgents) {
    if (retires(driver, random)) retired.push(driver);
    else pool.push({ driver });
  }
  const openings: { teamKey: string; seat: 0 | 1 }[] = [];

  // Contracts tick down. Expired deals — and the odd early release of a
  // driver the team has outgrown — put a driver in the pool and open a seat.
  for (const teamKey of input.teamKeys) {
    const roster = rosters[teamKey];
    const current = input.contracts[teamKey] ?? initialContracts(teamKey, roster);
    const ticked: [Contract, Contract] = [
      { ...current[0], seasonsLeft: current[0].seasonsLeft - 1 },
      { ...current[1], seasonsLeft: current[1].seasonsLeft - 1 },
    ];
    for (const i of [0, 1] as const) {
      const driver = roster[i];
      const outOfContract = ticked[i].seasonsLeft <= 0;
      const underperforming = overallOf(driver.stats) < (input.strength[teamKey] ?? 70) - UNDERPERFORM_GAP;
      if (outOfContract || (underperforming && random() < EARLY_RELEASE_CHANCE)) {
        if (outOfContract && retires(driver, random)) retired.push(driver);
        else pool.push({ driver, fromKey: teamKey });
        openings.push({ teamKey, seat: i });
      }
    }
    contracts[teamKey] = ticked;
  }

  // The strongest team fills its seat first, and takes the best driver it can
  // reach — free agent, or a final-year driver at a team below it.
  openings.sort((a, b) => (input.strength[b.teamKey] ?? 0) - (input.strength[a.teamKey] ?? 0));
  const seatOpen = (teamKey: string, seat: 0 | 1) => openings.some((o) => o.teamKey === teamKey && o.seat === seat);

  for (let i = 0; i < openings.length; i++) {
    const opening = openings[i];
    const myStrength = input.strength[opening.teamKey] ?? 70;
    const candidates: { driver: Driver; fromKey?: string; poach: boolean }[] = pool.map((p) => ({ ...p, poach: false }));
    // Poaching: a final-year driver at a weaker team can be bought out.
    for (const teamKey of input.teamKeys) {
      if (teamKey === opening.teamKey) continue;
      if ((input.strength[teamKey] ?? 70) >= myStrength) continue;
      for (const seat of [0, 1] as const) {
        if (seatOpen(teamKey, seat)) continue;
        if (contracts[teamKey][seat].seasonsLeft > 1) continue;
        candidates.push({ driver: rosters[teamKey][seat], fromKey: teamKey, poach: true });
      }
    }
    // Value is what he is now plus a share of what he could be, with enough
    // noise that the winter is not simply the ratings list in order.
    const scored = candidates.map((c) => ({
      c,
      score: overallOf(c.driver.stats) + Math.max(0, c.driver.potential - overallOf(c.driver.stats)) * 0.3 + (random() - 0.5) * 8
        - (c.poach ? 2 : 0),
    }));
    scored.sort((a, b) => b.score - a.score);
    const pick = scored[0]?.c;

    if (!pick) {
      const rookie = generateDriver(random, numbers, 19 + Math.floor(random() * 4));
      rosters[opening.teamKey] = seatInto(rosters[opening.teamKey], opening.seat, rookie);
      contracts[opening.teamKey][opening.seat] = { seasonsLeft: 2 + Math.floor(random() * 2), wage: driverWage(rookie) };
      moves.push({ driver: rookie.name, toKey: opening.teamKey, seat: opening.seat, kind: 'rookie' });
      continue;
    }

    rosters[opening.teamKey] = seatInto(rosters[opening.teamKey], opening.seat, pick.driver);
    contracts[opening.teamKey][opening.seat] = { seasonsLeft: 1 + Math.floor(random() * 3), wage: driverWage(pick.driver) };
    moves.push({
      driver: pick.driver.name,
      fromKey: pick.fromKey,
      toKey: opening.teamKey,
      seat: opening.seat,
      kind: scored[0].c.poach ? 'poached' : 'freeAgent',
    });
    if (scored[0].c.poach && pick.fromKey) {
      // The seat he left is now open too, and gets its turn later in the list.
      openings.push({ teamKey: pick.fromKey, seat: seatOf(rosters[pick.fromKey], pick.driver) });
    } else {
      const at = pool.findIndex((p) => p.driver === pick.driver);
      if (at >= 0) pool.splice(at, 1);
    }
  }

  return { rosters, contracts, moves, retired, unsigned: pool.map((p) => p.driver) };
}

const seatInto = (roster: [Driver, Driver], seat: 0 | 1, driver: Driver): [Driver, Driver] =>
  seat === 0 ? [driver, roster[1]] : [roster[0], driver];

const seatOf = (roster: [Driver, Driver], driver: Driver): 0 | 1 => (roster[0] === driver ? 0 : 1);

// Turkish suffixes agree with the last vowel of the word they attach to, and
// an ablative hardens after a voiceless consonant — "Ravensworth'tan
// Northgate F1'e". Team names are data, so the headlines work it out rather
// than hard-coding a suffix that would be wrong half the time. An initialism
// with no vowel of its own ("GP") is read out letter by letter, so it takes
// the suffix its PRONUNCIATION asks for: GP'den, GP'ye.

const BACK_VOWELS = 'aıouâAIOU';
const FRONT_VOWELS = 'eiöüEİÖÜ';
const VOICELESS = 'pçtkfhsşPÇTKFHSŞ';

/** What a suffix needs to know about the sound a name ends on. */
interface Ending {
  /** Last vowel is a back one: the suffix takes a/ı rather than e/i. */
  back: boolean;
  /** Ends on a vowel, so a dative needs its buffer -y-. */
  vowelFinal: boolean;
  /** Ends voiceless, so an ablative hardens to -tan/-ten. */
  voiceless: boolean;
}

/** How a trailing digit is read aloud: "F1'e" (bir), "V6'ya" (altı). */
const DIGITS: Record<string, Ending> = {
  '0': { back: true, vowelFinal: false, voiceless: false }, // sıfır
  '1': { back: false, vowelFinal: false, voiceless: false }, // bir
  '2': { back: false, vowelFinal: true, voiceless: false }, // iki
  '3': { back: false, vowelFinal: false, voiceless: true }, // üç
  '4': { back: false, vowelFinal: false, voiceless: true }, // dört
  '5': { back: false, vowelFinal: false, voiceless: true }, // beş
  '6': { back: true, vowelFinal: true, voiceless: false }, // altı
  '7': { back: false, vowelFinal: true, voiceless: false }, // yedi
  '8': { back: false, vowelFinal: false, voiceless: false }, // sekiz
  '9': { back: true, vowelFinal: false, voiceless: false }, // dokuz
};

const isVowel = (c: string) => BACK_VOWELS.includes(c) || FRONT_VOWELS.includes(c);

function endingOf(name: string): Ending {
  // A suffix attaches to the last word only: "Castellan GP'den", not "Castellan'dan".
  const word = name.trim().split(/\s+/).pop() ?? name;
  const last = word[word.length - 1];
  if (DIGITS[last]) return DIGITS[last];
  for (let i = word.length - 1; i >= 0; i--) {
    if (BACK_VOWELS.includes(word[i])) return { back: true, vowelFinal: isVowel(last), voiceless: VOICELESS.includes(last) };
    if (FRONT_VOWELS.includes(word[i])) return { back: false, vowelFinal: isVowel(last), voiceless: VOICELESS.includes(last) };
  }
  // No vowel of its own: an initialism, read letter by letter, and every
  // Turkish letter name ends on a front vowel — "GP'ye", "GP'den".
  return { back: false, vowelFinal: true, voiceless: false };
}

/** "Ravensworth'tan", "Castellan GP'den". */
export function ablative(name: string): string {
  const e = endingOf(name);
  return `${name}'${e.voiceless ? 't' : 'd'}${e.back ? 'an' : 'en'}`;
}

/** "Bravado Racing'e", "Orenda GP'ye", "Northgate F1'e". */
export function dative(name: string): string {
  const e = endingOf(name);
  return `${name}'${e.vowelFinal ? 'y' : ''}${e.back ? 'a' : 'e'}`;
}

/** A driver leaving the sport. */
export const retirementHeadline = (driver: Driver): string =>
  `${driver.name} ${driver.age} yaşında kaskı astı — sözleşmesi bitti, yenisini aramadı.`;

/** One line of paddock news per move. */
export function transferHeadline(move: TransferMove, nameOf: (key: string) => string): string {
  if (move.kind === 'rookie') return `${move.driver}, ${nameOf(move.toKey)} ile Formula'ya adım atıyor (koltuk ${move.seat + 1}).`;
  // A team can take back a driver it let go: that is a renegotiation, not a transfer.
  if (move.fromKey === move.toKey) return `${move.driver} ${nameOf(move.toKey)} ile yeni şartlarda anlaştı, koltuğunda kalıyor.`;
  if (move.fromKey) return `${move.driver}, ${ablative(nameOf(move.fromKey))} ${dative(nameOf(move.toKey))} transfer oldu.`;
  return `${move.driver} serbest sürücüyken ${nameOf(move.toKey)} ile anlaştı.`;
}
