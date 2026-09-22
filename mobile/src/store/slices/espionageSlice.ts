import { goldPrices, rpPrices, skipCostGold } from '@pitwall/shared/economy';
import {
  BAD_INTEL_FACTOR,
  CAUGHT_FINE_MIN,
  CAUGHT_FINE_SHARE,
  RIVAL_GAIN,
  SPY_BOOST,
  SPY_COOLDOWN_MS,
  SPY_RESOLVE_MS,
  outcomeText,
  resolveMission,
  rivalAttempt,
  type AgentKind,
  type GarageHide,
  type SpyMission,
} from '@pitwall/shared/espionage';
import { aiStrength, type AiBonus } from '@pitwall/shared/raceEngine';
import { teamByKey, teams } from '@pitwall/shared/teams';
import type { StatKey } from '@pitwall/shared/driverMarket';
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
  /** Yeni görevin açılabileceği an; şimdi ya da öncesiyse serbest. */
  nextMissionAt: () => number;
  /** Bekleyen raporu hemen almanın Altın fiyatı; görev yoksa 0. */
  skipMissionCost: () => number;
  /** Kalan süreyi Altınla satın alır ve raporu hemen çözer. */
  skipMission: () => boolean;
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

  nextMissionAt: () => {
    const last = get().missions[get().missions.length - 1];
    return last?.outcome ? last.endsAt + SPY_COOLDOWN_MS : 0;
  },

  skipMissionCost: () => {
    const pending = get().missions.find((m) => !m.outcome);
    return pending ? skipCostGold(pending.endsAt - Date.now()) : 0;
  },

  skipMission: () => {
    const state = get();
    const pending = state.missions.find((m) => !m.outcome);
    if (!pending) return false;
    const cost = state.skipMissionCost();
    // İstihbaratın değeri zamanında gelmesidir: bir sonraki geliştirmeyi
    // yönlendiremeyecek kadar geç gelen rapor işe yaramaz. Atlama, yarışa
    // yetişmeyecek bir raporu kurtarır — pahalı olması bundan.
    if (cost > 0 && !state.spendGold(cost)) return false;
    set((s) => ({ missions: s.missions.map((m) => (m === pending ? { ...m, endsAt: Date.now() } : m)) }));
    get().resolveIntel();
    return true;
  },

  startMission: (targetTeam, stat, agent) => {
    const state = get();
    if (state.missions.some((m) => !m.outcome)) return 'pending';
    if (Date.now() < state.nextMissionAt()) return 'cooldown';
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
      startedAt: Date.now(),
      endsAt: Date.now() + SPY_RESOLVE_MS,
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
      if (m.outcome || Date.now() < m.endsAt) return m;
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
