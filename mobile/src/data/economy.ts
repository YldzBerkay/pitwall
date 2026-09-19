/**
 * Money that is not RP.
 *
 * RP is the soft currency the whole game runs on. Altın ("gold") is the
 * premium one: it can only be earned by watching a rewarded ad or bought with
 * real money, and it buys things that are either faster or safer than the RP
 * route — never things that are impossible without it. The rewarded-ad cap
 * follows the usual mobile guidance (8-12 a day for strategy titles) and the
 * rule that a patient player should progress at roughly two thirds of a
 * paying player's pace. See docs/paddock-research.md §2.1.
 *
 * The ad and purchase calls here are hooks: the real SDKs are wired in later.
 */

/**
 * Oyunun tek ekonomi knob'u.
 *
 * Katalogdaki göreli ağırlıkları RP'ye çevirir. Ne satın aldığına göre
 * okunmalı: en ucuz araç geliştirmesi 750 RP, orta sıra takım yarış başına
 * ~1.100 RP kazanır. Sponsor, ödül, maaş, transfer, fabrika ve casusluk
 * fiyatlarının HEPSİ bunu okur — ekonomi tek yerden ayarlanabilsin diye.
 */
export const ECONOMY_SCALE = 1.5;

export const GOLD_PER_AD = 1;
export const ADS_PER_DAY = 8;

export interface GoldPack {
  key: string;
  gold: number;
  /** Fallback price label until the store returns the localised one. */
  priceLabel: string;
  /** Product id as it must be created in App Store Connect / Google Play. */
  sku: string;
}

export const goldPacks: GoldPack[] = [
  { key: 'pit-pass', gold: 5, priceLabel: '₺49,99', sku: 'com.yberkayarda.pitwall.gold5' },
  { key: 'paddock', gold: 15, priceLabel: '₺129,99', sku: 'com.yberkayarda.pitwall.gold15' },
  { key: 'motorhome', gold: 40, priceLabel: '₺299,99', sku: 'com.yberkayarda.pitwall.gold40' },
];

/** Same-day check for the ad counter, in the device's local calendar. */
export const dayKey = (d: Date = new Date()): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** How gold is spent, so every price lives in one place. */
export const goldPrices = {
  /** A professional agent: no risk of being caught. */
  premiumAgent: 3,
  /** Hide the garage from rival intelligence. */
  hide3Days: 1,
  hide7Days: 2,
} as const;

export const rpPrices = {
  hide1Day: 30,
} as const;
