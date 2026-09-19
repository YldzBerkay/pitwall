import { create } from 'zustand';
import { carStats, teamState, type CarStat } from '@/data/mock';
import {
  DEPARTMENT_MAX_LEVEL,
  departmentCost,
  factoryDepartments,
  factoryEffects,
  type FactoryDepartment,
  type FactoryEffects,
} from '@/data/factory';
import { skipCostGold } from '@/data/economy';
import { UPGRADE_GAIN, tierOf, upgradeCostFor, upgradeDurationMs, type CompoundKey, type SpokeStyle } from '@/data/carCustomisation';
import {
  generateOffers,
  racePrize,
  settleRace,
  sponsorSlots,
  type SlotKey,
  type SponsorOffer,
  type Sponsorship,
} from '@/data/sponsors';
import {
  playerTeam,
  teams,
  positionOf,
  seedStandings,
  type TeamStanding,
} from '@/data/teams';
import { fitOf, trackForRound, type Track, type TrackDemand } from '@/data/tracks';
import {
  advanceLap,
  autoDecisions,
  finishRace,
  playerDecisions,
  reliabilityOf,
  crippleSetup,
  CRIPPLED_DNF_SCALE,
  simulatePractice,
  simulateQualifying,
  soloEntries,
  startRace,
  weatherFor,
  type CarSetup,
  type Entries,
  type PitDecision,
  type PlayerDecisions,
  type QualiRisk,
  type QualifyingResult,
  type RaceEvent,
  type RaceResult,
  type RaceState,
  type TacticPreset,
  type SessionStoppage,
  type TimedEntry,
  type WeatherPlan,
} from '@/data/raceEngine';
import {
  emptyCareer,
  recordWeekend,
  scoreWeekend,
  type Career,
  type WeekendAchievements,
} from '@/data/achievements';
import {
  SEASON_ROUNDS,
  TEST_DAYS,
  TEST_GAIN_CORRECT,
  TEST_GAIN_WRONG,
  championshipPrize,
  freshStandings,
  summariseSeason,
  testReport,
  type SeasonSummary,
  type TestFocus,
  type TestOutcome,
  type TestReport,
} from '@/data/season';
import { BRIEF_RP_EACH, briefCompliance, briefFor, type BriefItem } from '@/data/brief';
import { createEconomySlice, type EconomySlice } from './slices/economySlice';
import { createStaffSlice, type StaffSlice } from './slices/staffSlice';
import { createEspionageSlice, type EspionageSlice } from './slices/espionageSlice';
import { INJURY_ROUNDS, createDriverSlice, type DriverSlice } from './slices/driverSlice';
import { createLeagueSlice, type LeagueSlice } from './slices/leagueSlice';
import type { StatKey } from '@/data/driverMarket';

/** Stat label on the garage card → engine key. */
const statKeyOf: Record<string, StatKey> = { MOTOR: 'motor', AERO: 'aero', GRIP: 'grip' };

/** Stat label → which slice of a circuit's demand it answers to. */
const demandKey: Record<string, keyof TrackDemand> = { MOTOR: 'motor', AERO: 'aero', GRIP: 'grip' };

/** Recolour the fit LEDs for the circuit the team is about to race. */
export function withTrackFit(stats: CarStat[], track: Track): CarStat[] {
  return stats.map((s) => {
    const key = demandKey[s.label];
    return key ? { ...s, fit: fitOf(s.value, track.demand[key]) } : s;
  });
}

/** What an upgrade actually did — the UI uses this to play the right cue. */
export interface UpgradeResult {
  ok: boolean;
  /** True when the spend pushed the stat across a tier line and fitted a part. */
  tierUp: boolean;
  value: number;
}

/** A part on the fabrication bench. Only one is ever in build. */
export interface CarBuild {
  /** Stat being upgraded — MOTOR / AERO / GRIP. */
  label: string;
  /** Epoch ms when the part is ready to fit. */
  endsAt: number;
  /** How long this build takes, for the progress bar. */
  durationMs: number;
}

/** Why a build could not be started. */
export type StartUpgradeResult = 'ok' | 'noRp' | 'busy' | 'missing';

/** Outcome of settling a race weekend. */
export interface RaceSettlement {
  /** Sponsor fees + bonuses + prize money. */
  income: number;
  /** The championship payout inside `income` — the part results cannot take away. */
  prize: number;
  bonusesEarned: string[];
  /** Deals whose streak just reset because the target was missed. */
  streaksBroken: string[];
  expired: SlotKey[];
  /** The race that was paid for. */
  result: RaceResult;
  achievements: WeekendAchievements;
  /** Engineer briefing items the manager followed, and the RP they paid. */
  briefFollowed: number;
  briefRp: number;
  /** Present only when this weekend closed the season. */
  season?: SeasonSummary;
  /** Round that was settled. */
  round: number;
}

// ── Weekend ────────────────────────────────────────────────────────────────

export type WeekendPhase =
  | 'practice'
  | 'sprintQualifying'
  | 'sprintGrid'
  | 'sprint'
  | 'qualifying'
  | 'grid'
  | 'race'
  | 'result';

export interface Weekend {
  round: number;
  seed: number;
  phase: WeekendPhase;
  weather: WeatherPlan;
  /** Practice setup bias, -1 aero … +1 mechanical, in fifths. */
  bias: number;
  /** Completed practice sessions, FP1 first. */
  practice: TimedEntry[];
  practiceSessions: TimedEntry[][];
  /** Race control's stoppage in each practice session, aligned with `practiceSessions`. */
  practiceReds: (SessionStoppage | undefined)[];
  qualiCompound: CompoundKey;
  risk: QualiRisk;
  qualifying?: QualifyingResult;
  raceCompound: CompoundKey;
  /** What the assistant follows if the manager is not at the wall. */
  tactics: TacticPreset;
  /** Sprint weekends: the Saturday-style short race and its own qualifying. */
  sprintQualifying?: QualifyingResult;
  sprintResult?: RaceResult;
  /** How many practice sessions this weekend has (one on a sprint weekend). */
  practiceCount: number;
  race?: RaceState;
  /** The lap before `race`, kept so the map can animate between the two. */
  prevRace?: RaceState;
  /** Pit calls queued for the next lap, lead driver first. */
  pending: PlayerDecisions;
  /** The latest moment that wants a decision; the pit wall highlights it for a few laps. */
  prompt?: RaceEvent;
  result?: RaceResult;
  settlement?: RaceSettlement;
}

/**
 * Real time per lap. There is no fast-forward and no pause: the race runs at
 * the same clock for every manager in the league, as it will online. Sixty
 * laps is about two and a half minutes.
 */
export const RACE_TICK_MS = 2500;

/** Events the pit wall surfaces as a decision moment. */
const PROMPT_ON: RaceEvent['kind'][] = ['rain', 'dry', 'cliff', 'sc', 'vsc', 'red'];

/** The one race clock. Module-level so a re-render can never start a second one. */
let raceClock: ReturnType<typeof setInterval> | undefined;
const stopRaceClock = () => {
  if (raceClock) clearInterval(raceClock);
  raceClock = undefined;
};

const newWeekend = (round: number, season: number): Weekend => {
  const seed = season * 1000 + round;
  const weather = weatherFor(trackForRound(round), seed);
  return {
    round,
    seed,
    phase: 'practice',
    weather,
    bias: 0,
    practice: [],
    practiceSessions: [],
    practiceReds: [],
    qualiCompound: weather.wetAtStart ? 'WET' : 'SOFT',
    risk: 'safe',
    raceCompound: weather.wetAtStart ? 'WET' : 'MEDIUM',
    tactics: 'balanced',
    pending: [undefined, undefined],
    practiceCount: trackForRound(round).sprint ? 1 : 3,
  };
};

/** Pre-season testing: three days before round one. `day` past TEST_DAYS means done. */
export interface Testing {
  day: number;
  outcomes: TestOutcome[];
}

interface CoreState {
  teamName: string;
  round: number;
  totalRounds: number;
  season: number;
  rp: number;
  weekEarned: number;
  carStats: CarStat[];
  departments: FactoryDepartment[];
  /** The circuit this round is run at. */
  track: () => Track;
  /** The car as the race engine sees it: stats + starting compound + practice bias. */
  setup: () => CarSetup;
  /** This team as a race entry; every other team is AI until the league goes online. */
  entries: () => Entries;

  /** Car appearance — drives both the in-app car and the Blender renders. */
  livery: string;
  compound: CompoundKey;
  rim: string;
  spokes: SpokeStyle;
  setLivery: (key: string) => void;
  setCompound: (key: CompoundKey) => void;
  setRim: (key: string) => void;
  setSpokes: (key: SpokeStyle) => void;

  /** The part currently being built, if any. */
  build?: CarBuild;
  /** Completed upgrades per stat — each one makes the next build 1.5x longer. */
  upgradesDone: Record<string, number>;
  /** How long the next build of this stat would take, in ms. */
  buildTimeFor: (label: string) => number;
  /** Bu stat'ın sıradaki yükseltmesinin RP fiyatı — 750 × 1.5^tamamlanan, fabrika indirimli. */
  buildCostFor: (label: string) => number;
  /** Departman seviyeleri, `factoryEffects` için. */
  factoryLevels: () => Record<string, number>;
  /** Fabrikanın türettiği etkiler — hiçbir yer seviyeye doğrudan bakmaz. */
  factory: () => FactoryEffects;
  /** Tezgahtaki parçayı hemen bitirmenin Altın fiyatı; iş yoksa 0. */
  skipBuildCost: () => number;
  /** Kalan süreyi Altınla satın alır ve parçayı takar. */
  skipBuild: () => boolean;
  /** Pay the RP and put a part on the bench. The gain lands on collect. */
  startUpgrade: (label: string) => StartUpgradeResult;
  /** Fit a finished part. Returns undefined while the build is still running. */
  collectUpgrade: () => UpgradeResult | undefined;
  /** Spend RP on a factory department upgrade. Returns false if not possible. */
  upgradeDepartment: (code: string) => boolean;

  // ── Pre-season testing ──
  testing: Testing;
  /** Today's engineer report, or undefined when testing is over. */
  testReport: () => TestReport | undefined;
  /** Run one test day with the chosen programme. */
  runTestDay: (focus: TestFocus) => TestOutcome | undefined;

  // ── Race weekend ──
  weekend: Weekend;
  /** The engineer's briefing for this weekend. */
  brief: () => BriefItem[];
  setBias: (bias: number) => void;
  /** Sprint weekends: sprint qualifying, then the sprint itself on the race clock. */
  runSprintQualifying: () => void;
  startSprintSession: () => void;
  /** Run the next practice session (FP1 → FP3). After FP3 the weekend moves to qualifying. */
  runPractice: () => void;
  setQualiCompound: (key: CompoundKey) => void;
  setRisk: (risk: QualiRisk) => void;
  runQualifying: () => void;
  setRaceCompound: (key: CompoundKey) => void;
  setTactics: (tactics: TacticPreset) => void;
  /** Lights out: build the race state from the grid and start the clock. */
  startRaceSession: () => void;
  /** Queue (or cancel) a pit call for one car; it is taken on the next lap. */
  queuePit: (driverIdx: 0 | 1, decision: PitDecision | undefined) => void;
  /** One lap, on the clock. Takes the queued pit calls. */
  advanceRaceLap: () => void;
  /** Bank the sprint's points and move on to qualifying. */
  finishSprint: () => void;
  /** Dev/test only: run the remaining laps on the automatic pit wall. */
  skipToFlag: () => void;
  /**
   * Pay out the weekend. Requires a finished race: sponsors are settled on the
   * lead car's finish, prize money on the standing, the table takes the
   * result, the career takes the achievements, and — after round 23 — the
   * season closes.
   */
  settleRaceWeekend: () => RaceSettlement;
  /** Leave the result screen and open the next round's weekend. */
  nextWeekend: () => void;
  /** The most recent settlement, for screens that only show it. */
  lastSettlement?: RaceSettlement;
  lastResult?: RaceResult;

  // ── Career ──
  career: Career;
  seasonSummary?: SeasonSummary;
  dismissSeasonSummary: () => void;

  // ── Sponsorship ──
  /** The constructors' table. The player's position is read off it. */
  standings: TeamStanding[];
  championshipPosition: number;
  /** Signed deals, at most one per slot. */
  sponsorships: Sponsorship[];
  /** Slots declined this round; they stay hidden until the next weekend. */
  declinedOffers: string[];
  /** This weekend's offer sheet, derived from round + position + free slots. */
  offers: () => SponsorOffer[];
  /** Accept an offer. Fails if the slot is already taken. */
  signSponsor: (offerId: string) => boolean;
  /** Turn an offer down for this weekend. */
  declineOffer: (offerId: string) => void;
  /** Break a deal early — costs the remaining signing bonus back. */
  releaseSponsor: (slot: SlotKey) => void;
  setChampionshipPosition: (position: number) => void;

  /** Fractional upgrade points carried between upgrades (mechanic bonus). */
  upgradeCarry: Record<string, number>;
  /** Headlines from the last settlement (wages, injuries, intelligence). */
  paddockNews: string[];
}

export type GameState = CoreState & EconomySlice & StaffSlice & EspionageSlice & DriverSlice & LeagueSlice;

const initialStandings = seedStandings(teamState.round - 1);

export const useGameStore = create<GameState>((set, get) => ({
  ...createEconomySlice(set, get),
  ...createStaffSlice(set, get),
  ...createEspionageSlice(set, get),
  ...createDriverSlice(set, get),
  ...createLeagueSlice(set, get),
  upgradeCarry: {},
  build: undefined,
  upgradesDone: {},
  paddockNews: [],

  teamName: teamState.teamName,
  round: teamState.round,
  totalRounds: SEASON_ROUNDS,
  season: 1,
  rp: teamState.rp,
  weekEarned: teamState.weekEarned,
  carStats: withTrackFit(carStats, trackForRound(teamState.round)),
  departments: factoryDepartments,
  track: () => trackForRound(get().round),
  setup: () => {
    const { carStats: stats, weekend } = get();
    const value = (label: string) => stats.find((s) => s.label === label)?.value ?? 50;
    return {
      motor: value('MOTOR'),
      aero: value('AERO'),
      grip: value('GRIP'),
      compound: weekend.phase === 'qualifying' ? weekend.qualiCompound : weekend.raceCompound,
      bias: weekend.bias,
    };
  },
  entries: () => {
    const state = get();
    const levels = state.factoryLevels();
    const fx = state.effects();
    // Yarış günü kilidi: tezgahta parça varken araç sökük yarışır — pişen
    // stat yarı değerinde, güvenilirlik yarıya bölünmüş (yani DNF riski
    // katlanmış). `dnfChance` güvenilirliği 1 - r*0.5 ile okuduğu için ayrı
    // bir alan açmaya gerek yok.
    const building = state.build?.label;
    const reliability = Math.min(1, reliabilityOf(levels) + fx.reliabilityBonus);
    const entries = soloEntries(
      crippleSetup(state.setup(), building),
      building ? reliability / CRIPPLED_DNF_SCALE : reliability,
      state.weekend.tactics,
    );
    const own = entries[playerTeam.key];
    own.drivers = state.raceDrivers();
    own.pitSecondsSaved = fx.pitSecondsSaved;
    own.pitFailChance = fx.pitFailChance;
    own.assistantErrorScale = fx.assistantErrorScale;
    return entries;
  },

  livery: 'pitwall',
  compound: 'SOFT',
  rim: 'accent',
  spokes: 'multi',
  setLivery: (key) => set({ livery: key }),
  setCompound: (key) => set({ compound: key }),
  setRim: (key) => set({ rim: key }),
  setSpokes: (key) => set({ spokes: key }),

  factoryLevels: () => Object.fromEntries(get().departments.map((d) => [d.code, d.level])),
  factory: () => factoryEffects(get().factoryLevels()),

  buildTimeFor: (label) =>
    Math.round(upgradeDurationMs(get().upgradesDone[label] ?? 0) * get().factory().upgradeTimeScale),
  buildCostFor: (label) =>
    Math.round(upgradeCostFor(get().upgradesDone[label] ?? 0) * get().factory().upgradeCostScale),

  skipBuildCost: () => {
    const { build } = get();
    return build ? skipCostGold(build.endsAt - Date.now()) : 0;
  },

  skipBuild: () => {
    const state = get();
    if (!state.build) return false;
    const cost = state.skipBuildCost();
    // Fiyat once tahsil edilir; odeme tutmazsa parca tezgahta kalir.
    if (cost > 0 && !state.spendGold(cost)) return false;
    set((s) => ({ build: s.build ? { ...s.build, endsAt: Date.now() } : undefined }));
    get().collectUpgrade();
    return true;
  },

  startUpgrade: (label) => {
    const state = get();
    const stat = state.carStats.find((s) => s.label === label);
    if (!stat) return 'missing';
    // One bench, one part: the factory cannot build two things at once.
    if (state.build) return 'busy';
    const cost = state.buildCostFor(label);
    if (state.rp < cost) return 'noRp';
    const durationMs = state.buildTimeFor(label);
    set({
      rp: state.rp - cost,
      build: { label, endsAt: Date.now() + durationMs, durationMs },
    });
    return 'ok';
  },

  collectUpgrade: () => {
    const state = get();
    const build = state.build;
    if (!build || Date.now() < build.endsAt) return undefined;
    const stat = state.carStats.find((s) => s.label === build.label);
    if (!stat) {
      set({ build: undefined });
      return undefined;
    }
    // Taban kazanç, baş mekanik bonusu üstüne, istihbarat hepsini çarpar;
    // kesirler bir sonraki yükseltmeye taşınır, 0,5 hiç kaybolmaz. Casusluk
    // boost'u burada harcanır — gerçekten takılan parçanın üstünde.
    const key = statKeyOf[build.label];
    const boost = key ? get().takeBoost(key) : 1;
    const raw = (UPGRADE_GAIN + state.effects().upgradeBonus + state.factory().upgradeGainBonus) * boost
      + (state.upgradeCarry[build.label] ?? 0);
    const gain = Math.floor(raw);
    const carry = Math.round((raw - gain) * 100) / 100;
    const next = Math.min(100, stat.value + gain);
    set((s) => ({
      build: undefined,
      upgradesDone: { ...s.upgradesDone, [build.label]: (s.upgradesDone[build.label] ?? 0) + 1 },
      upgradeCarry: { ...s.upgradeCarry, [build.label]: carry },
      carStats: withTrackFit(
        s.carStats.map((cs) => (cs.label === build.label ? { ...cs, value: next } : cs)),
        trackForRound(s.round),
      ),
    }));
    return { ok: true, tierUp: tierOf(next) > tierOf(stat.value), value: next };
  },
  upgradeDepartment: (code) => {
    const dept = get().departments.find((d) => d.code === code);
    if (!dept || dept.level >= DEPARTMENT_MAX_LEVEL) return false;
    const cost = departmentCost(dept.level);
    if (get().rp < cost) return false;
    set((state) => ({
      rp: state.rp - cost,
      departments: state.departments.map((d) =>
        d.code === code ? { ...d, level: d.level + 1 } : d,
      ),
    }));
    return true;
  },

  // ── Pre-season testing ──
  // The mid-season save opens with testing done; a new season reopens it.
  testing: { day: TEST_DAYS + 1, outcomes: [] },
  testReport: () => {
    const state = get();
    if (state.testing.day > TEST_DAYS) return undefined;
    const levels = state.factoryLevels();
    return testReport(state.testing.day, state.setup(), reliabilityOf(levels));
  },
  runTestDay: (focus) => {
    const state = get();
    const report = state.testReport();
    if (!report) return undefined;
    const correct = report.focus === focus;
    const gain = correct ? TEST_GAIN_CORRECT : TEST_GAIN_WRONG;
    const outcome: TestOutcome = { day: report.day, chosen: focus, correct, gain };
    const label = { motor: 'MOTOR', aero: 'AERO', grip: 'GRIP' }[focus as Exclude<TestFocus, 'reliability'>];
    set({
      testing: { day: state.testing.day + 1, outcomes: [...state.testing.outcomes, outcome] },
      carStats: focus === 'reliability'
        ? state.carStats
        : withTrackFit(
            state.carStats.map((c) => (c.label === label ? { ...c, value: Math.min(100, c.value + gain) } : c)),
            trackForRound(state.round),
          ),
      departments: focus === 'reliability'
        ? state.departments.map((d) => (d.code === 'manufacturing' ? { ...d, level: d.level + (correct ? 1 : 0) } : d))
        : state.departments,
      // A correct programme also earns the engineer's respect: a little career score.
      career: correct ? { ...state.career, score: state.career.score + 5 } : state.career,
    });
    return outcome;
  },

  // ── Race weekend ──
  weekend: newWeekend(teamState.round, 1),
  brief: () => {
    const state = get();
    const fx = state.effects();
    return briefFor(trackForRound(state.weekend.round), state.weekend.weather, state.setup(), fx.briefAccuracy, state.weekend.seed, fx.forecastBand);
  },

  setBias: (bias) =>
    set((state) => ({ weekend: { ...state.weekend, bias: Math.max(-1, Math.min(1, bias)) } })),

  runPractice: () => {
    const state = get();
    const w = state.weekend;
    if (w.phase !== 'practice' || w.practiceSessions.length >= w.practiceCount) return;
    const session = (w.practiceSessions.length + 1) as 1 | 2 | 3;
    const entries = state.entries();
    entries[playerTeam.key].setup.compound = w.weather.wetAtStart ? 'INTERMEDIATE' : 'MEDIUM';
    const result = simulatePractice({
      track: trackForRound(w.round),
      entries,
      aiBonus: state.aiBonus,
      rosters: state.rosters,
      wet: w.weather.wetAtStart,
      session,
      round: w.round,
      seed: w.seed,
    });
    const practiceSessions = [...w.practiceSessions, result.order];
    set({
      weekend: {
        ...w,
        practice: result.order,
        practiceSessions,
        practiceReds: [...w.practiceReds, result.red],
        phase: practiceSessions.length >= w.practiceCount
          ? trackForRound(w.round).sprint ? 'sprintQualifying' : 'qualifying'
          : 'practice',
      },
    });
  },

  runSprintQualifying: () => {
    const state = get();
    const w = state.weekend;
    if (w.phase !== 'sprintQualifying') return;
    const entries = state.entries();
    entries[playerTeam.key].setup.compound = w.qualiCompound;
    const sprintQualifying = simulateQualifying({
      track: trackForRound(w.round),
      entries,
      aiBonus: state.aiBonus,
      rosters: state.rosters,
      wet: w.weather.wetAtStart,
      risks: { [playerTeam.key]: w.risk },
      round: w.round,
      seed: w.seed + 1,
    });
    set({ weekend: { ...w, sprintQualifying, phase: 'sprintGrid' } });
  },

  startSprintSession: () => {
    const state = get();
    const w = state.weekend;
    if (w.phase !== 'sprintGrid' || !w.sprintQualifying) return;
    const entries = state.entries();
    entries[playerTeam.key].setup.compound = w.raceCompound;
    const race = startRace({
      standings: state.standings,
      track: trackForRound(w.round),
      entries,
      weather: w.weather,
      grid: w.sprintQualifying.grid,
      round: w.round,
      seed: w.seed + 1,
      session: 'sprint',
      aiBonus: state.aiBonus,
      rosters: state.rosters,
    });
    set({ weekend: { ...w, race, prevRace: undefined, pending: [undefined, undefined], prompt: undefined, phase: 'sprint' } });
    stopRaceClock();
    raceClock = setInterval(() => get().advanceRaceLap(), RACE_TICK_MS);
  },

  setQualiCompound: (key) => set((state) => ({ weekend: { ...state.weekend, qualiCompound: key } })),
  setRisk: (risk) => set((state) => ({ weekend: { ...state.weekend, risk } })),

  runQualifying: () => {
    const state = get();
    const w = state.weekend;
    if (w.phase !== 'qualifying') return;
    const entries = state.entries();
    entries[playerTeam.key].setup.compound = w.qualiCompound;
    const qualifying = simulateQualifying({
      track: trackForRound(w.round),
      entries,
      aiBonus: state.aiBonus,
      rosters: state.rosters,
      wet: w.weather.wetAtStart,
      risks: { [playerTeam.key]: w.risk },
      round: w.round,
      seed: w.seed,
    });
    set({ weekend: { ...w, qualifying, phase: 'grid' } });
  },

  setRaceCompound: (key) => set((state) => ({ weekend: { ...state.weekend, raceCompound: key } })),
  setTactics: (tactics) => set((state) => ({ weekend: { ...state.weekend, tactics } })),

  startRaceSession: () => {
    const state = get();
    const w = state.weekend;
    if (w.phase !== 'grid' || !w.qualifying) return;
    const entries = state.entries();
    entries[playerTeam.key].setup.compound = w.raceCompound;
    const race = startRace({
      standings: state.standings,
      track: trackForRound(w.round),
      entries,
      weather: w.weather,
      grid: w.qualifying.grid,
      round: w.round,
      seed: w.seed,
      aiBonus: state.aiBonus,
      rosters: state.rosters,
    });
    set({ weekend: { ...w, race, prevRace: undefined, pending: [undefined, undefined], prompt: undefined, phase: 'race' } });
    stopRaceClock();
    raceClock = setInterval(() => get().advanceRaceLap(), RACE_TICK_MS);
  },

  queuePit: (driverIdx, decision) => {
    // Online: the server owns the race, so the call goes there and the local
    // pending list only mirrors it for the button state.
    if (get().isLeagueLive()) void get().leaguePit(driverIdx, decision?.compound ?? null);
    set((state) => {
      const pending: PlayerDecisions = [state.weekend.pending[0], state.weekend.pending[1]];
      pending[driverIdx] = decision;
      return { weekend: { ...state.weekend, pending } };
    });
  },

  advanceRaceLap: () => {
    const w = get().weekend;
    if ((w.phase !== 'race' && w.phase !== 'sprint') || !w.race || w.race.finished) {
      stopRaceClock();
      return;
    }
    const race = advanceLap(w.race, trackForRound(w.round), playerDecisions(w.pending));
    const fresh = race.events.filter((e) => e.lap === race.lap);
    const prompt = fresh.find((e) => PROMPT_ON.includes(e.kind)) ?? w.prompt;
    set({ weekend: { ...w, race, prevRace: w.race, pending: [undefined, undefined], prompt } });
    if (race.finished) stopRaceClock();
  },

  finishSprint: () => {
    const state = get();
    const w = state.weekend;
    if (w.phase !== 'sprint' || !w.race || !w.race.finished) return;
    const sprintResult = finishRace(w.race);
    set({
      standings: sprintResult.standings,
      championshipPosition: positionOf(sprintResult.standings, playerTeam.key),
      weekend: { ...w, sprintResult, race: undefined, prevRace: undefined, prompt: undefined, phase: 'qualifying' },
    });
  },

  skipToFlag: () => {
    const w = get().weekend;
    if ((w.phase !== 'race' && w.phase !== 'sprint') || !w.race) return;
    stopRaceClock();
    const track = trackForRound(w.round);
    let race = w.race;
    while (!race.finished) race = advanceLap(race, track, autoDecisions(race, track));
    set({ weekend: { ...w, race, prevRace: undefined, pending: [undefined, undefined] } });
  },

  settleRaceWeekend: () => {
    const state = get();
    const w = state.weekend;
    if (w.settlement) return w.settlement;
    if (!w.race || !w.race.finished || !w.qualifying) {
      throw new Error('settleRaceWeekend: the race has not been run');
    }
    const result = finishRace(w.race);

    // Sponsors judge the LEAD car. A double retirement counts as last: the fee
    // is still paid whatever happens (sponsors.ts rule), only the target is missed.
    const judged = result.playerFinish > 0 ? result.playerFinish : teams.length * 2;
    const settled = settleRace(state.sponsorships, judged);
    // Prize money is the guaranteed floor; sponsors are what reward climbing.
    const prize = racePrize(state.championshipPosition, teams.length);
    let income = settled.income + prize;
    const nextRound = state.round + 1;
    const expired = settled.sponsorships
      .filter((s) => s.expiresRound <= nextRound)
      .map((s) => s.slot);

    // Paid against the TRUE briefing: following a weak strategist's wrong call earns nothing.
    const briefFollowed = briefCompliance(briefFor(trackForRound(w.round), w.weather, state.setup()), {
      raceCompound: w.raceCompound,
      tactics: w.tactics,
      risk: w.risk,
      bias: w.bias,
    });
    const briefRp = briefFollowed * BRIEF_RP_EACH;
    income += briefRp;
    // Wages come out of the weekend's income; the paddock is not free.
    const wages = state.staffWages() + state.driverWages();
    income -= wages;
    const paddockNews: string[] = [`Maaşlar: ${wages} RP (personel ${state.staffWages()}, sürücüler ${state.driverWages()}).`];

    // Injuries: a heavy crash keeps the regular out for a race or two; the reserve steps in.
    const injuries: [number, number] = [Math.max(0, state.injuries[0] - 1), Math.max(0, state.injuries[1] - 1)];
    for (const idx of [0, 1] as const) {
      const car = result.order.find((e) => e.teamKey === playerTeam.key && e.driverIdx === idx);
      if (car?.injured && state.injuries[idx] === 0) {
        const out = INJURY_ROUNDS[0] + (w.seed % 2 === 0 ? INJURY_ROUNDS[1] - INJURY_ROUNDS[0] : 0);
        injuries[idx] = out;
        paddockNews.push(`${state.drivers[idx].name} ağır kazadan sonra ${out} yarış dışında; ${state.squad[0] ? `${state.squad[0].driver.name} koltuğa geçiyor` : 'yedek yok, geçici sürücü koşacak'}.`);
      }
    }
    const achievements = scoreWeekend({
      race: result,
      playerGrid: w.qualifying.playerGrid,
      practice: [w.practiceSessions[0] ?? [], w.practiceSessions[1] ?? [], w.practiceSessions[2] ?? []],
      sprint: w.sprintResult,
      sprintGrid: w.sprintQualifying?.playerGrid,
      briefFollowed,
    });
    const careerBefore = state.career;
    let career = recordWeekend(careerBefore, achievements, result);

    // Season close: the table pays out and resets; car, factory, money and sponsors carry over.
    let standings = result.standings;
    let season: SeasonSummary | undefined;
    let round = nextRound;
    let seasonNo = state.season;
    if (nextRound > SEASON_ROUNDS) {
      const finalPosition = positionOf(standings, playerTeam.key);
      season = summariseSeason({ season: state.season, standings, careerBefore, careerAfter: career });
      income += championshipPrize(finalPosition);
      career = {
        ...career,
        seasonsCompleted: career.seasonsCompleted + 1,
        bestChampionship: career.bestChampionship === 0 ? finalPosition : Math.min(career.bestChampionship, finalPosition),
      };
      standings = freshStandings();
      round = 1;
      seasonNo = state.season + 1;
    }
    const testing = nextRound > SEASON_ROUNDS ? { day: 1, outcomes: [] } : state.testing;

    const settlement: RaceSettlement = {
      income,
      prize,
      bonusesEarned: settled.bonusesEarned,
      streaksBroken: settled.streaksBroken,
      expired,
      result,
      achievements,
      briefFollowed,
      briefRp,
      season,
      round: state.round,
    };

    set({
      rp: Math.max(0, state.rp + income),
      weekEarned: income,
      injuries,
      paddockNews,
      round,
      season: seasonNo,
      carStats: withTrackFit(state.carStats, trackForRound(round)),
      standings,
      championshipPosition: positionOf(standings, playerTeam.key),
      sponsorships: settled.sponsorships.filter((s) => s.expiresRound > nextRound),
      declinedOffers: [],
      career,
      testing,
      seasonSummary: season ?? state.seasonSummary,
      lastSettlement: settlement,
      lastResult: result,
      weekend: { ...w, result, settlement, phase: 'result' },
    });
    // Intelligence reports back with the new day; rivals try their luck.
    get().resolveIntel();
    // The winter: ageing, contract expiries and the grid's transfer window.
    // Whatever it did leads the paddock news the manager opens next.
    if (season) {
      get().ageDrivers();
      const winter = get().transferNews;
      if (winter.length > 0) set({ paddockNews: [...winter, ...paddockNews] });
    }
    return settlement;
  },

  nextWeekend: () => {
    const state = get();
    if (state.weekend.phase !== 'result') return;
    set({ weekend: newWeekend(state.round, state.season) });
  },

  // ── Career ──
  career: emptyCareer(),
  dismissSeasonSummary: () => set({ seasonSummary: undefined }),

  // ── Sponsorship ──
  standings: initialStandings,
  championshipPosition: positionOf(initialStandings, playerTeam.key),
  sponsorships: teamState.startingSponsorships,
  declinedOffers: [],

  offers: () => {
    const { round, totalRounds, championshipPosition, sponsorships, declinedOffers } = get();
    return generateOffers({
      round,
      running: sponsorships,
      position: championshipPosition,
      // Reputation, not form: what the team is expected to be worth.
      baseStrength: playerTeam.baseStrength,
      takenSlots: sponsorships.map((s) => s.slot),
      totalRounds,
    }).filter((o) => !declinedOffers.includes(o.id));
  },

  signSponsor: (offerId) => {
    const state = get();
    const offer = state.offers().find((o) => o.id === offerId);
    if (!offer) return false;
    // A renewal replaces the contract it renews, so its own slots are not a
    // clash — everything else is: a package is all-or-nothing.
    const kept = offer.renewalOf
      ? state.sponsorships.filter((s) => s.dealId !== offer.renewalOf)
      : state.sponsorships;
    if (offer.slots.some((slot) => kept.some((s) => s.slot === slot))) return false;
    if (kept.length + offer.slots.length > sponsorSlots.length) return false;

    const dealId = `${state.round}-${offer.brandKey}-${offer.slots.join('+')}`;
    // The result bonus belongs to the CONTRACT, so it is split across the
    // positions rather than paid once per panel — otherwise a three-slot deal
    // would quietly pay its bonus three times.
    const shares = offer.slots.map((_, i) => Math.round(offer.bonus / offer.slots.length)
      + (i === 0 ? offer.bonus - Math.round(offer.bonus / offer.slots.length) * offer.slots.length : 0));

    set({
      // The signing bonus lands immediately — that's the pull of a long deal.
      rp: state.rp + offer.signing,
      sponsorships: [
        ...kept,
        ...offer.slots.map((slot, i) => ({
          dealId,
          brandKey: offer.brandKey,
          slot,
          perRace: offer.perSlot[i],
          targetPosition: offer.targetPosition,
          bonus: shares[i],
          signedRound: state.round,
          expiresRound: state.round + offer.rounds,
          streakTarget: offer.streakTarget,
          streak: 0,
        })),
      ],
    });
    return true;
  },

  declineOffer: (offerId) =>
    set((state) => ({ declinedOffers: [...state.declinedOffers, offerId] })),

  releaseSponsor: (slot) =>
    set((state) => {
      const deal = state.sponsorships.find((s) => s.slot === slot);
      if (!deal) return state;
      // Releasing gives back the WHOLE contract. A brand that insisted on
      // three positions does not stay on two of them, and the break fee is
      // charged on the deal's full value for the same reason.
      const inDeal = state.sponsorships.filter((s) => s.dealId === deal.dealId);
      const roundsLeft = Math.max(0, deal.expiresRound - state.round);
      const value = inDeal.reduce((sum, s) => sum + s.perRace, 0);
      const penalty = Math.round(value * roundsLeft * 0.35);
      return {
        rp: Math.max(0, state.rp - penalty),
        sponsorships: state.sponsorships.filter((s) => s.dealId !== deal.dealId),
      };
    }),

  setChampionshipPosition: (position) =>
    set({ championshipPosition: Math.max(1, Math.min(sponsorSlots.length, position)) }),
}));
