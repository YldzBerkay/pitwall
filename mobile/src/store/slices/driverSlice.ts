import { overallOf, playerTeam, teamByKey, teams, type Driver } from '@pitwall/shared/teams';
import type { Rosters } from '@pitwall/shared/raceEngine';
import {
  TRAINING_MS,
  ageOneSeason,
  contractWage,
  dative,
  developRosterSeason,
  driverMarket,
  driverWage,
  initialContracts,
  renewalCost,
  retirementHeadline,
  runTransferWindow,
  signingCost,
  trainingGain,
  saleValue,
  SQUAD_MIN,
  SQUAD_MAX,
  transferHeadline,
  type Contract,
  type DriverStatKey,
  type MarketDriver,
  type Training,
} from '@pitwall/shared/driverMarket';
import type { SliceCreator } from './types';

/** `full` = kadro tavanı (6) dolu, önce biri satılmalı. */
export type SignResult = 'ok' | 'noRp' | 'missing' | 'busy' | 'full';
export type RenewResult = 'ok' | 'noRp' | 'notDue';

/** Races a driver sits out after a heavy crash. */
export const INJURY_ROUNDS: [number, number] = [1, 2];

/** Who is in the seat this weekend when the regular is hurt and there is no reserve. */
export const stopgapDriver = (seat: 0 | 1): Driver => ({
  name: seat === 0 ? 'M. Yedek' : 'S. Yedek',
  number: 90 + seat,
  skill: 55,
  stats: { pace: 56, consistency: 55, racecraft: 52, wet: 50, reaction: 55, dev: 40 },
  age: 27,
  potential: 58,
});

/** A driver in his final year, anywhere on the grid — the season's transfer talk. */
export interface Rumour {
  teamKey: string;
  seat: 0 | 1;
  driver: Driver;
  /** True for the manager's own cars. */
  ours: boolean;
}

/**
 * The player's driver pair, a 0-4 strong squad, training, injuries, contracts and the
 * market.
 *
 * Training is six real hours per session, one stat, gains scaled by age and
 * headroom. Signing a market driver is a straight swap into a seat (the
 * outgoing driver leaves) on a one-, two- or three-season deal: the long deal
 * costs more to sign and less per race. Contracts tick down in the winter and
 * a driver whose deal ran out walks — into the transfer window, where the
 * rest of the grid is reshuffling its own expiries and will happily take him.
 */
/** Asıl koltuk dışındaki bir sürücü ve sözleşmesi. */
export interface SquadMember {
  driver: Driver;
  contract: Contract;
}

export interface DriverSlice {
  /** Every team's live driver pair; the player's is also `drivers`. */
  rosters: Rosters;
  drivers: [Driver, Driver];
  /** The player's two deals, lead driver first. */
  contracts: [Contract, Contract];
  /**
   * İki asıl koltuğun dışındaki sürücüler: yedekler ve yatırım. Toplam kadro
   * `2 + squad.length` ve 2-6 arasında tutulur (SQUAD_MIN / SQUAD_MAX).
   */
  squad: SquadMember[];
  /** Every rival team's deals, by team key. */
  rosterContracts: Record<string, [Contract, Contract]>;
  /** What the winter did to the grid, newest season first. */
  transferNews: string[];
  /** Rounds each seat's regular still misses, 0 = fit. */
  injuries: [number, number];
  training?: Training;
  /** Who actually races in each seat this weekend (injuries applied). */
  raceDrivers: () => [Driver, Driver];
  driverMarket: () => MarketDriver[];
  /** Everyone on the grid whose contract runs out this winter. */
  transferRumours: () => Rumour[];
  /** Kadrodaki toplam sürücü sayısı: 2 + squad.length. */
  squadSize: () => number;
  /** Koltuk numarasından sürücü: 0-1 asıl, 2+ kadro. */
  driverAt: (seat: number) => Driver | undefined;
  /**
   * Bir kadro sürücüsünü satar; eline `saleValue` (%20 komisyon düşülmüş)
   * geçer. Asıl koltuktaki sürücü satılamaz ve kadro tabana inmişken satış
   * yapılamaz — iki araç için iki sürücü şarttır.
   */
  sellDriver: (driverNumber: number) => boolean;
  startTraining: (driverIdx: number, stat: DriverStatKey) => boolean;
  /** Applies a finished session. Returns the gain, or undefined if still running / none. */
  collectTraining: () => { driverIdx: number; stat: DriverStatKey; gain: number } | undefined;
  signDriver: (marketId: string, seat: 0 | 1 | 'reserve', seasons?: number) => SignResult;
  /** Extends a driver already in the seat; only in his final year. */
  renewDriver: (seat: 0 | 1, seasons: number) => RenewResult;

  /** RP owed to the drivers each race — what their contracts say, not what they are worth. */
  driverWages: () => number;
  /** Season turnover: everyone a year older, contracts tick, the grid reshuffles. */
  ageDrivers: () => void;
}

const rivalTeams = teams.filter((t) => !t.isPlayer);

export const createDriverSlice: SliceCreator<DriverSlice> = (set, get) => ({
  rosters: Object.fromEntries(teams.map((t) => [t.key, [t.drivers[0], t.drivers[1]] as [Driver, Driver]])),
  drivers: [playerTeam.drivers[0], playerTeam.drivers[1]],
  // The manager inherits a squad mid-deal: the number two is out of contract
  // at the end of this first season, so the winter matters from day one.
  contracts: [
    { seasonsLeft: 3, wage: driverWage(playerTeam.drivers[0]) },
    { seasonsLeft: 1, wage: driverWage(playerTeam.drivers[1]) },
  ],
  rosterContracts: Object.fromEntries(rivalTeams.map((t) => [t.key, initialContracts(t.key, [t.drivers[0], t.drivers[1]])])),
  transferNews: [],
  squad: [],
  injuries: [0, 0],
  training: undefined,

  raceDrivers: () => {
    const { drivers, squad, injuries, training } = get();
    // Yarış günü kilidi (spec §5A): antrenmandaki sürücü koltuğa oturamaz,
    // tıpkı sakat gibi. Yerine kadronun en güçlüsü geçer; kadro tabana
    // inmişse (tam 2 sürücü) yedek yoktur ve geçici sürücü koşar.
    const busy = training && Date.now() < training.endsAt ? training.driverIdx : undefined;
    const bench = [...squad].sort((a, b) => overallOf(b.driver.stats) - overallOf(a.driver.stats));
    const seat = (i: 0 | 1): Driver => {
      if (injuries[i] === 0 && busy !== i) return drivers[i];
      return bench[0]?.driver ?? stopgapDriver(i);
    };
    return [seat(0), seat(1)];
  },

  squadSize: () => 2 + get().squad.length,

  driverAt: (seat) => {
    const { drivers, squad } = get();
    return seat < 2 ? drivers[seat as 0 | 1] : squad[seat - 2]?.driver;
  },

  sellDriver: (driverNumber) => {
    const state = get();
    const idx = state.squad.findIndex((m) => m.driver.number === driverNumber);
    // Asıl koltuktaki sürücü satılamaz: önce yerine biri geçmeli.
    if (idx < 0) return false;
    if (state.squadSize() <= SQUAD_MIN) return false;
    // Antrenmandaki sürücü satılamaz — iş yarıda kalır, para boşa gider.
    if (state.training && Date.now() < state.training.endsAt && state.training.driverIdx === idx + 2) return false;
    const { driver } = state.squad[idx];
    const paid = saleValue(driver);
    set((s) => ({
      squad: s.squad.filter((_, i) => i !== idx),
      rp: s.rp + paid,
    }));
    return true;
  },

  driverMarket: () => {
    const { season, round, drivers } = get();
    return driverMarket(season, round, drivers.map((d) => d.number));
  },

  transferRumours: () => {
    const { drivers, contracts, rosters, rosterContracts } = get();
    const out: Rumour[] = [];
    for (const seat of [0, 1] as const) {
      if (contracts[seat].seasonsLeft <= 1) out.push({ teamKey: playerTeam.key, seat, driver: drivers[seat], ours: true });
    }
    for (const team of rivalTeams) {
      const roster = rosters[team.key] ?? team.drivers;
      const deals = rosterContracts[team.key] ?? initialContracts(team.key, [team.drivers[0], team.drivers[1]]);
      for (const seat of [0, 1] as const) {
        if (deals[seat].seasonsLeft <= 1) out.push({ teamKey: team.key, seat, driver: roster[seat], ours: false });
      }
    }
    return out;
  },

  startTraining: (driverIdx, stat) => {
    const state = get();
    if (state.training) return false;
    set({ training: { driverIdx, stat, endsAt: Date.now() + TRAINING_MS } });
    return true;
  },

  collectTraining: () => {
    const state = get();
    const t = state.training;
    if (!t || Date.now() < t.endsAt) return undefined;
    const driver = state.drivers[t.driverIdx];
    // Sürücü akademisi antrenman kazancını çarpar (spec §6).
    const gain = Math.round(trainingGain(driver, t.stat) * get().factory().trainingScale * 100) / 100;
    const stats = { ...driver.stats, [t.stat]: Math.min(99, Math.round((driver.stats[t.stat] + gain) * 100) / 100) };
    const updated: Driver = { ...driver, stats, skill: overallOf(stats) };
    const drivers: [Driver, Driver] = t.driverIdx === 0 ? [updated, state.drivers[1]] : [state.drivers[0], updated];
    set({ drivers, training: undefined });
    return { driverIdx: t.driverIdx, stat: t.stat, gain };
  },

  signDriver: (marketId, seat, seasons = 2) => {
    const state = get();
    const candidate = state.driverMarket().find((d) => d.id === marketId);
    if (!candidate) return 'missing';
    if (state.training && seat !== 'reserve' && state.training.driverIdx === seat) return 'busy';
    const { id: _id, fee: _fee, wage: _wage, ...driver } = candidate;
    // A reserve is cheaper to sign and cheaper to keep: half of both.
    const fee = seat === 'reserve' ? Math.round(signingCost(driver, seasons) / 2) : signingCost(driver, seasons);
    if (state.rp < fee) return 'noRp';
    const contract: Contract = {
      seasonsLeft: seasons,
      wage: seat === 'reserve' ? Math.round(contractWage(driver, seasons) / 2) : contractWage(driver, seasons),
    };
    if (seat === 'reserve') {
      // Kadro tavanı: yedinci sürücü alınamaz, önce biri satılmalı.
      if (state.squadSize() >= SQUAD_MAX) return 'full';
      set((s) => ({ rp: s.rp - fee, squad: [...s.squad, { driver, contract }] }));
    } else {
      const drivers: [Driver, Driver] = seat === 0 ? [driver, state.drivers[1]] : [state.drivers[0], driver];
      const contracts: [Contract, Contract] = seat === 0 ? [contract, state.contracts[1]] : [state.contracts[0], contract];
      set({ rp: state.rp - fee, drivers, contracts });
    }
    return 'ok';
  },

  renewDriver: (seat, seasons) => {
    const state = get();
    if (state.contracts[seat].seasonsLeft > 1) return 'notDue';
    const driver = state.drivers[seat];
    const cost = renewalCost(driver, seasons);
    if (state.rp < cost) return 'noRp';
    // A renewal runs from the end of the current deal: its final season plus the new term.
    const renewed: Contract = { seasonsLeft: state.contracts[seat].seasonsLeft + seasons, wage: contractWage(driver, seasons) };
    const contracts: [Contract, Contract] = seat === 0 ? [renewed, state.contracts[1]] : [state.contracts[0], renewed];
    set({ rp: state.rp - cost, contracts });
    return 'ok';
  },

  driverWages: () => {
    // Asıl iki koltuk tam maaş, kadrodakiler yarı. Kalabalık kadro tutmak
    // antrenman hızını artırmaz (tek koltuk) ama maaş yükünü artırır.
    const { contracts, squad } = get();
    return contracts[0].wage + contracts[1].wage + squad.reduce((sum, m) => sum + m.contract.wage, 0);
  },

  ageDrivers: () =>
    set((state) => {
      // 1. Everyone a year older; the rivals also develop toward their potential.
      const rosters: Rosters = {};
      for (const team of rivalTeams) {
        rosters[team.key] = developRosterSeason(state.rosters[team.key] ?? [team.drivers[0], team.drivers[1]], team.key, state.season);
      }
      let drivers: [Driver, Driver] = [ageOneSeason(state.drivers[0]), ageOneSeason(state.drivers[1])];

      // 2. The player's deals tick down. A driver out of contract leaves the
      //    team — into the window below, where a rival will take him — and a
      //    junior is promoted so the seat is never empty.
      const news: string[] = [];
      const leaving: Driver[] = [];
      const contracts: [Contract, Contract] = [
        { ...state.contracts[0], seasonsLeft: state.contracts[0].seasonsLeft - 1 },
        { ...state.contracts[1], seasonsLeft: state.contracts[1].seasonsLeft - 1 },
      ];
      for (const seat of [0, 1] as const) {
        if (contracts[seat].seasonsLeft > 0) continue;
        const gone = drivers[seat];
        leaving.push(gone);
        const promoted: Driver = { ...stopgapDriver(seat), name: `${gone.name.split(' ')[0]} Genç`, age: 20, potential: 72 };
        drivers = seat === 0 ? [promoted, drivers[1]] : [drivers[0], promoted];
        contracts[seat] = { seasonsLeft: 1, wage: driverWage(promoted) };
        news.push(`${gone.name} sözleşmesi bitince takımdan ayrıldı; ${dative(`koltuk ${seat + 1}`)} akademiden ${promoted.name} çıktı.`);
      }

      // 3. The rest of the grid resolves its own expiries, and picks over ours.
      const window = runTransferWindow({
        season: state.season,
        rosters,
        contracts: state.rosterContracts,
        teamKeys: rivalTeams.map((t) => t.key),
        strength: Object.fromEntries(rivalTeams.map((t) => [t.key, t.baseStrength])),
        freeAgents: leaving,
        takenNumbers: [...drivers.map((d) => d.number), ...Object.values(rosters).flat().map((d) => d.number)],
      });
      for (const gone of window.retired) news.push(retirementHeadline(gone));
      for (const move of window.moves) {
        news.push(transferHeadline(move, (key) => (key === playerTeam.key ? playerTeam.name : teamByKey(key)?.name ?? key)));
      }

      const nextRosters: Rosters = { ...window.rosters, [playerTeam.key]: drivers };
      return {
        rosters: nextRosters,
        rosterContracts: window.contracts,
        drivers,
        contracts,
        transferNews: news,
        squad: state.squad.map((m) => ({ ...m, driver: ageOneSeason(m.driver) })),
      };
    }),
});
