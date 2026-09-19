import { goldPrices, rpPrices } from '@/data/economy';
import {
  BAD_INTEL_FACTOR,
  CAUGHT_FINE_MIN,
  CAUGHT_FINE_SHARE,
  RIVAL_GAIN,
  SPY_BOOST,
  SPY_COOLDOWN_ROUNDS,
  SPY_RESOLVE_ROUNDS,
  outcomeText,
  resolveMission,
  rivalAttempt,
  type AgentKind,
  type GarageHide,
  type SpyMission,
} from '@/data/espionage';
import { aiStrength, type AiBonus } from '@/data/raceEngine';
import { teamByKey, teams } from '@/data/teams';
import type { StatKey } from '@/data/driverMarket';
import type { SliceCreator } from './types';

export type SpyStart = 'ok' | 'cooldown' | 'noGold' | 'noRp' | 'pending';
export type HideDays = 1 | 3 | 7;

/**
 * Intelligence, both directions. Missions resolve at the next settlement;
 * boosts apply to the next upgrade of that stat; a hidden garage blocks rival
 * attempts; rivals that get through gain permanent strength (`aiBonus`, read
 * by the race engine).
 */
export interface EspionageSlice {
  missions: SpyMission[];
  /** Multiplier waiting for the next upgrade of each stat (×1.5 success, ×0.5 bad intel). */
  upgradeBoosts: Partial<Record<StatKey, number>>;
  hide?: GarageHide;
  aiBonus: AiBonus;
  /** Latest intelligence headlines, newest first. */
  intelNews: string[];
  /** Round from which a new mission may start. */
  nextMissionRound: () => number;
  startMission: (targetTeam: string, stat: StatKey, agent: AgentKind) => SpyStart;
  hideGarage: (days: HideDays) => boolean;
  isHidden: () => boolean;
  /** Called at settlement: resolve due missions and let rivals try their luck. */
  resolveIntel: () => void;
  /** Take (and clear) the boost waiting on a stat. */
  takeBoost: (stat: StatKey) => number;
}

const FREE_AGENT_RP = 25;

export const createEspionageSlice: SliceCreator<EspionageSlice> = (set, get) => ({
  missions: [],
  upgradeBoosts: {},
  hide: undefined,
  aiBonus: {},
  intelNews: [],

  nextMissionRound: () => {
    const last = get().missions[get().missions.length - 1];
    return last ? last.startedRound + SPY_COOLDOWN_ROUNDS : 0;
  },

  startMission: (targetTeam, stat, agent) => {
    const state = get();
    if (state.missions.some((m) => !m.outcome)) return 'pending';
    if (state.round < state.nextMissionRound()) return 'cooldown';
    if (agent === 'premium') {
      if (!state.spendGold(goldPrices.premiumAgent)) return 'noGold';
    } else {
      if (state.rp < FREE_AGENT_RP) return 'noRp';
      set({ rp: state.rp - FREE_AGENT_RP });
    }
    const mission: SpyMission = {
      id: `${state.season}-${state.round}-${targetTeam}-${stat}`,
      targetTeam,
      stat,
      agent,
      startedRound: state.round,
      resolvesRound: state.round + SPY_RESOLVE_ROUNDS,
    };
    set((s) => ({ missions: [...s.missions, mission] }));
    return 'ok';
  },

  hideGarage: (days) => {
    const state = get();
    if (days === 1) {
      if (state.rp < rpPrices.hide1Day) return false;
      set({ rp: state.rp - rpPrices.hide1Day });
    } else if (!state.spendGold(days === 3 ? goldPrices.hide3Days : goldPrices.hide7Days)) {
      return false;
    }
    const from = Math.max(state.round, state.hide?.untilRound ?? 0);
    set({ hide: { untilRound: from + days - 1 } });
    return true;
  },

  isHidden: () => {
    const { hide, round } = get();
    return Boolean(hide && hide.untilRound >= round);
  },

  resolveIntel: () => {
    const state = get();
    const news: string[] = [];
    const boosts = { ...state.upgradeBoosts };
    const aiBonus = { ...state.aiBonus };
    let rp = state.rp;

    const value = (label: string) => state.carStats.find((c) => c.label === label)?.value ?? 50;
    const own: Record<StatKey, number> = { motor: value('MOTOR'), aero: value('AERO'), grip: value('GRIP') };

    const missions = state.missions.map((m) => {
      if (m.outcome || state.round < m.resolvesRound) return m;
      const target = teamByKey(m.targetTeam);
      // AI cars have one strength for every stat; the player's own sheet is the comparison.
      const targetStat = aiStrength(target, state.round) + (aiBonus[target.key] ?? 0);
      const outcome = resolveMission(m, false, targetStat > own[m.stat]);
      if (outcome === 'success') boosts[m.stat] = SPY_BOOST;
      if (outcome === 'badIntel') boosts[m.stat] = BAD_INTEL_FACTOR;
      if (outcome === 'caught') {
        const fine = Math.max(CAUGHT_FINE_MIN, Math.round(rp * CAUGHT_FINE_SHARE));
        rp = Math.max(0, rp - fine);
        aiBonus[target.key] = (aiBonus[target.key] ?? 0) + RIVAL_GAIN;
        news.push(`${target.short}: ajanımız yakalandı, ${fine} RP ceza.`);
      } else {
        news.push(`${target.short} / ${m.stat.toUpperCase()}: ${outcomeText[outcome]}`);
      }
      return { ...m, outcome };
    });

    // Rivals only bother with the front of the table.
    const rivals = teams.filter((t) => !t.isPlayer).map((t) => t.key);
    const attempt = rivalAttempt(state.round, state.season, state.championshipPosition, state.isHidden(), rivals);
    if (attempt) {
      const short = teamByKey(attempt.team).short;
      if (attempt.success) {
        aiBonus[attempt.team] = (aiBonus[attempt.team] ?? 0) + RIVAL_GAIN;
        news.push(`${short} garajımızdan veri sızdırdı; araçları güçlendi.`);
      } else {
        news.push(`${short} garajımıza sızmayı denedi — ${state.isHidden() ? 'garaj gizliydi, ' : ''}başaramadı.`);
      }
    }

    set({ missions, upgradeBoosts: boosts, aiBonus, rp, intelNews: [...news, ...state.intelNews].slice(0, 12) });
  },

  takeBoost: (stat) => {
    const boost = get().upgradeBoosts[stat] ?? 1;
    if (boost !== 1) {
      set((s) => {
        const next = { ...s.upgradeBoosts };
        delete next[stat];
        return { upgradeBoosts: next };
      });
    }
    return boost;
  },
});
