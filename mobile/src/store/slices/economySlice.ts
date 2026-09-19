import { ADS_PER_DAY, GOLD_PER_AD, GOLD_TO_RP, GOLD_TO_RP_DAILY_CAP, dayKey, goldPacks } from '@/data/economy';
import type { SliceCreator } from './types';

/**
 * Premium currency. Gold arrives only through a rewarded ad (capped per day)
 * or a purchase; both entry points are hooks for the real SDKs. Spending goes
 * through `spendGold` so every price check lives here.
 */
export interface EconomySlice {
  gold: number;
  adsToday: { day: string; count: number };
  /** Ads still available today. */
  adsLeft: () => number;
  /** Grant for one completed rewarded ad. Returns false when today's cap is spent. Call only after the SDK reports the reward. */
  watchAd: () => boolean;
  /** Grant a pack. Call only after the store confirmed and finished the purchase. */
  buyGold: (packKey: string) => boolean;
  spendGold: (amount: number) => boolean;
  /** Bugün RP'ye çevrilmiş Altın — günlük tavan bunun üstünden işler. */
  convertedToday: { day: string; gold: number };
  /** Bugün daha kaç Altın RP'ye çevrilebilir. */
  convertibleLeft: () => number;
  /**
   * Altın'ı sabit kurdan RP'ye çevirir. Çevrilebilen Altın'ı döner (0 = olmadı).
   * Günlük tavan, bedava reklam Altını'nın ekonomiyi şişirmesini engeller.
   */
  convertGoldToRp: (gold: number) => number;
}

export const createEconomySlice: SliceCreator<EconomySlice> = (set, get) => ({
  gold: 2,
  adsToday: { day: dayKey(), count: 0 },
  convertedToday: { day: dayKey(), gold: 0 },

  adsLeft: () => {
    const { adsToday } = get();
    return adsToday.day === dayKey() ? Math.max(0, ADS_PER_DAY - adsToday.count) : ADS_PER_DAY;
  },

  watchAd: () => {
    const state = get();
    const today = dayKey();
    const count = state.adsToday.day === today ? state.adsToday.count : 0;
    if (count >= ADS_PER_DAY) return false;
    set({ gold: state.gold + GOLD_PER_AD, adsToday: { day: today, count: count + 1 } });
    return true;
  },

  buyGold: (packKey) => {
    const pack = goldPacks.find((p) => p.key === packKey);
    if (!pack) return false;
    set((state) => ({ gold: state.gold + pack.gold }));
    return true;
  },

  spendGold: (amount) => {
    if (get().gold < amount) return false;
    set((state) => ({ gold: state.gold - amount }));
    return true;
  },

  convertibleLeft: () => {
    const { convertedToday } = get();
    const used = convertedToday.day === dayKey() ? convertedToday.gold : 0;
    return Math.max(0, GOLD_TO_RP_DAILY_CAP - used);
  },

  convertGoldToRp: (gold) => {
    const state = get();
    const today = dayKey();
    const used = state.convertedToday.day === today ? state.convertedToday.gold : 0;
    const allowed = Math.min(gold, state.convertibleLeft(), state.gold);
    if (allowed <= 0) return 0;
    set((s) => ({
      gold: s.gold - allowed,
      rp: s.rp + allowed * GOLD_TO_RP,
      convertedToday: { day: today, gold: used + allowed },
    }));
    return allowed;
  },
});
