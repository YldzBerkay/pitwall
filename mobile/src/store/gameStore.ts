import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { carStats, teamState, type CarStat } from '@/data/mock';
import {
  DEPARTMENT_MAX_LEVEL,
  departmentCost,
  factoryDepartments,
  factoryEffects,
  type FactoryDepartment,
  type FactoryEffects,
} from '@pitwall/shared/factory';
import { skipCostGold } from '@pitwall/shared/economy';
import { UPGRADE_GAIN, tierOf, upgradeCostFor, upgradeDurationMs, type CompoundKey, type SpokeStyle } from '@pitwall/shared/carCustomisation';
import {
  generateOffers,
  sponsorSlots,
  type SlotKey,
  type SponsorOffer,
  type Sponsorship,
} from '@pitwall/shared/sponsors';
import {
  playerTeam,
  positionOf,
  seedStandings,
  type TeamStanding,
} from '@pitwall/shared/teams';
import { fitOf, trackForRound, type Track, type TrackDemand } from '@pitwall/shared/tracks';
/**
 * TYPES ONLY, PLUS THE TWO PURE HELPERS THAT RUN NO SESSION.
 *
 * `@pitwall/shared/raceEngine` is the ONE engine and the SERVER runs it
 * (`server/src/lobby/runner.ts`). This module may not execute a lap, a
 * start, a qualifying session or a classification of its own — see
 * `mobile/test/no-local-race.test.ts`, which scans for exactly that.
 * `weatherFor` is a deterministic forecast for the weekend card and
 * `reliabilityOf` prices the factory's reliability for the testing report;
 * neither simulates anything.
 */
import {
  reliabilityOf,
  weatherFor,
  type CarSetup,
  type PitDecision,
  type QualiRisk,
  type TacticPreset,
  type WeatherPlan,
} from '@pitwall/shared/raceEngine';
import { emptyCareer, type Career } from '@pitwall/shared/achievements';
import {
  SEASON_ROUNDS,
  TEST_DAYS,
  TEST_GAIN_CORRECT,
  TEST_GAIN_WRONG,
  testReport,
  type TestFocus,
  type TestOutcome,
  type TestReport,
} from '@pitwall/shared/season';
import { briefFor, type BriefItem } from '@pitwall/shared/brief';
import { createEconomySlice, type EconomySlice } from './slices/economySlice';
import { createStaffSlice, type StaffSlice } from './slices/staffSlice';
import { createEspionageSlice, type EspionageSlice } from './slices/espionageSlice';
import { createDriverSlice, type DriverSlice } from './slices/driverSlice';
import { createSettingsSlice, type SettingsSlice } from './slices/settingsSlice';
import { createAuthSlice, type AuthSlice } from './slices/authSlice';
import { createLobbySlice, type LobbySlice } from './slices/lobbySlice';
import { createRaceSlice, type RaceSlice } from './slices/raceSlice';
import { createEconomyApiSlice, type EconomyApiSlice } from './slices/economyApiSlice';
import { createSponsorsApiSlice, type SponsorsApiSlice } from './slices/sponsorsApiSlice';
import { createSettlementApiSlice, type SettlementApiSlice } from './slices/settlementApiSlice';
import type { StatKey } from '@pitwall/shared/driverMarket';

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

// ── Weekend ────────────────────────────────────────────────────────────────

/**
 * WHAT THE PLAYER CHOOSES, AND NOTHING ELSE.
 *
 * This used to be the whole local weekend: a `phase` the local engine walked
 * session by session, the practice timing sheets, the simulated qualifying
 * and grid, a live `RaceState` ticked by a client-side clock, the
 * classification and a locally-computed settlement.
 *
 * All of that is the server's now. The race is frozen at lights-out, ticked
 * server-side and broadcast per lobby (`displayRace`); qualifying arrives in
 * the `state` frame (`displayQualifying`); the phase arrives in the `phase`
 * frame (`displayPhase`/`displayWeekPanel`); the money is settled and
 * persisted server-side and merely read back (`displaySettlement`).
 *
 * What is left here is the set of choices the player SENDS before lights-out
 * — setup bias, the (qualifying-and-start) tyre, qualifying risk and the
 * assistant's tactics — kept locally so the pickers have something to draw
 * while the request is in flight. `race`, `prevRace`, `pending`, `prompt`,
 * `qualifying`, `result` and `settlement` are deliberately absent: a second
 * race image on the client is a second, divergent race, which is the whole
 * thing this migration exists to remove.
 */
export interface Weekend {
  round: number;
  seed: number;
  weather: WeatherPlan;
  /** Setup bias, -1 aero … +1 mechanical, in fifths. */
  bias: number;
  qualiCompound: CompoundKey;
  risk: QualiRisk;
  raceCompound: CompoundKey;
  /** What the assistant follows if the manager is not at the wall. */
  tactics: TacticPreset;
}

/**
 * Nominal real time per lap, used ONLY to size the map's between-laps
 * interpolation and the "about N minutes left" line. It drives nothing: the
 * one race clock belongs to the server (`server/src/lobby/runner.ts`), and
 * no timer in this client advances a lap.
 */
export const RACE_TICK_MS = 2500;

const newWeekend = (round: number, season: number): Weekend => {
  const seed = season * 1000 + round;
  const weather = weatherFor(trackForRound(round), seed);
  return {
    round,
    seed,
    weather,
    bias: 0,
    // `qualiCompound` and `raceCompound` are always kept equal — the same
    // tyre is used for qualifying and the start (see `setQualiCompound`'s
    // doc comment and `CarSetup.compound` in `@pitwall/shared/raceEngine`).
    qualiCompound: weather.wetAtStart ? 'WET' : 'SOFT',
    risk: 'safe',
    raceCompound: weather.wetAtStart ? 'WET' : 'SOFT',
    tactics: 'balanced',
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
  /**
   * The car as the race engine sees it: stats + starting compound + setup
   * bias. Read by the engineer's briefing and the pre-season test report —
   * NOT by any race: the server builds its own entries from the choices this
   * client sends it (`setWeekendChoices`), which is why the old `entries()`
   * (the local grid `soloEntries` built for the local engine) is gone.
   */
  setup: () => CarSetup;

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
  //
  // Choices only. Running the weekend — practice, qualifying, the race, the
  // flag and the payout — is the server's job end to end; the actions that
  // used to do it here (`runPractice`, `runQualifying`,
  // `runSprintQualifying`, `startRaceSession`, `startSprintSession`,
  // `advanceRaceLap`, `skipToFlag`, `finishSprint`, `settleRaceWeekend`,
  // `nextWeekend`) are gone with the local engine.
  weekend: Weekend;
  /** The engineer's briefing for this weekend. */
  brief: () => BriefItem[];
  setBias: (bias: number) => void;
  /** Sets both `weekend.qualiCompound` and `weekend.raceCompound` together
   * — the same tyre starts the qualifying lap and the race (parc fermé:
   * see `CarSetup.compound`'s doc comment in `@pitwall/shared/raceEngine`).
   * There is deliberately no separate `setRaceCompound` for the UI to call
   * once the grid is known. */
  setQualiCompound: (key: CompoundKey) => void;
  setRisk: (risk: QualiRisk) => void;
  setTactics: (tactics: TacticPreset) => void;
  /** Send a live pit call to the server's decision log. There is no local
   * queue and no local echo — see the implementation's comment. */
  queuePit: (driverIdx: 0 | 1, decision: PitDecision | undefined) => void;

  // ── Career ──
  career: Career;

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
}

export type GameState = CoreState &
  EconomySlice &
  StaffSlice &
  EspionageSlice &
  DriverSlice &
  SettingsSlice &
  AuthSlice &
  LobbySlice &
  RaceSlice &
  EconomyApiSlice &
  SponsorsApiSlice &
  SettlementApiSlice;

const initialStandings = seedStandings(teamState.round - 1);

/**
 * Only display/accessibility preferences and the account session
 * (`auth.baseUrl`/`token`/`user`) persist today — the rest of the game
 * (career, race, economy) has no save/load system yet (`docs/FEATURES.md`),
 * so it stays session-only and is deliberately left out of `partialize` to
 * avoid shipping a half-persisted save.
 */
export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
  ...createEconomySlice(set, get),
  ...createStaffSlice(set, get),
  ...createEspionageSlice(set, get),
  ...createDriverSlice(set, get),
  ...createSettingsSlice(set, get),
  ...createAuthSlice(set, get),
  ...createLobbySlice(set, get),
  ...createRaceSlice(set, get),
  ...createEconomyApiSlice(set, get),
  ...createSponsorsApiSlice(set, get),
  ...createSettlementApiSlice(set, get),
  upgradeCarry: {},
  build: undefined,
  upgradesDone: {},

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
      // One tyre, one weekend: `setQualiCompound` writes both fields, so
      // there is nothing to pick between (parc fermé — see its doc comment).
      compound: weekend.raceCompound,
      bias: weekend.bias,
    };
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

  setQualiCompound: (key) => set((state) => ({ weekend: { ...state.weekend, qualiCompound: key, raceCompound: key } })),
  setRisk: (risk) => set((state) => ({ weekend: { ...state.weekend, risk } })),

  setTactics: (tactics) => set((state) => ({ weekend: { ...state.weekend, tactics } })),

  queuePit: (driverIdx, decision) => {
    const state = get();
    // THE CALL GOES TO THE SERVER, AND NOWHERE ELSE.
    // This weekend's race is the server's (`server/src/lobby/runner.ts`) and
    // its pit-decision log is the only place a call means anything.
    // `raceSlice.callPit` refuses it outright — no request sent — when the
    // socket is not `connected`, and there is deliberately NO queue: a call
    // held on the device would be delivered after the lap it targeted had
    // already run, the server would reject it with `lap_already_run`, and in
    // the meantime the player would have believed it landed. The refusal is
    // surfaced through `race.lastPitOutcome` (see `LiveRacePanel`), never
    // swallowed.
    //
    // Nothing is echoed locally: there is no local race to echo it onto, and
    // a local echo would be a second, unauthoritative answer to "did my call
    // land?". Off a lobby seat there is no race at all, so the call is simply
    // dropped — the app is a view of the server or it is nothing.
    if (!state.race.lobbyId) return;
    // The decision log is append-only and the API has no withdrawal
    // (`lib/api/race.ts`'s `PitInput.lap` doc comment), so cancelling a live
    // call is not a request that can be made.
    if (decision) void state.callPit(driverIdx, decision.compound);
  },

  // ── Career ──
  career: emptyCareer(),

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
    }),
    {
      name: 'pitwall-store',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      partialize: (state) => ({
        colorblindMode: state.colorblindMode,
        textScale: state.textScale,
        hudCompact: state.hudCompact,
        auth: { baseUrl: state.auth.baseUrl, token: state.auth.token, user: state.auth.user, status: 'idle' as const },
      }),
    },
  ),
);
