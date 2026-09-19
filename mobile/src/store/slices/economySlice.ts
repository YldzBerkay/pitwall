import { ADS_PER_DAY, GOLD_PER_AD, dayKey, goldPacks } from '@/data/economy';
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
}

export const createEconomySlice: SliceCreator<EconomySlice> = (set, get) => ({
  gold: 2,
  adsToday: { day: dayKey(), count: 0 },

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
});
