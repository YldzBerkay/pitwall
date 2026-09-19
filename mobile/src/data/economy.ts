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

/**
 * Sabit kur.
 *
 * Altın hiçbir zaman tek yol değildir: `goldPrices`'taki her satırın
 * `rpPrices`'ta bir karşılığı vardır. Kur, Altın'ın ne kadar "değerli"
 * olduğunu tek yerde söyler, böylece bir Altın fiyatı uydurulduğunda RP
 * karşılığı da hesaplanabilir.
 */
export const GOLD_TO_RP = 50;

/**
 * Hızlandırma fiyatı, saat başına.
 *
 * Yarış gününde de aynıdır — baskı takvimin kendisinden gelsin, fiyat
 * oyunundan değil. 6 saatlik bir geliştirme 30 Altın (1.500 RP eşdeğeri)
 * eder, yani o geliştirmenin RP fiyatının iki katı: sabır her zaman daha
 * ucuzdur, Altın yalnızca acele satar.
 */
export const GOLD_PER_HOUR = 5;

/**
 * Bedava Altın'ın RP'ye dönüşümüne günlük tavan.
 *
 * Günde 8 reklam = 8 Altın = 400 RP eşdeğeri; yarış döngüsü ~2,5 gün olduğu
 * için tavansız bırakılırsa bedava gelir bir yarışın tamamını karşılar ve
 * ekonomi şişer. Tavan yalnızca DÖNÜŞÜME uygulanır — hızlandırmada tavan
 * yoktur, çünkü orada Altın zaman satın alır, para değil.
 */
export const GOLD_TO_RP_DAILY_CAP = 6;

/** Kalan süreyi Altın'a çevirir: saat başı, yukarı yuvarlanarak. Biten iş bedava. */
export const skipCostGold = (remainingMs: number): number =>
  Math.ceil(Math.max(0, remainingMs) / 3_600_000) * GOLD_PER_HOUR;

export interface GoldPack {
  key: string;
  gold: number;
  /** Fallback price label until the store returns the localised one. */
  priceLabel: string;
  /** Product id as it must be created in App Store Connect / Google Play. */
  sku: string;
}

/** Büyük paket Altın başına daha ucuzdur: +%20 ve +%39 değer. */
export const goldPacks: GoldPack[] = [
  { key: 'pit-pass', gold: 60, priceLabel: '₺49,99', sku: 'com.yberkayarda.pitwall.gold5' },
  { key: 'paddock', gold: 180, priceLabel: '₺129,99', sku: 'com.yberkayarda.pitwall.gold15' },
  { key: 'motorhome', gold: 500, priceLabel: '₺299,99', sku: 'com.yberkayarda.pitwall.gold40' },
];

/** Same-day check for the ad counter, in the device's local calendar. */
export const dayKey = (d: Date = new Date()): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/**
 * Altın fiyatları.
 *
 * KURAL: buradaki her anahtarın `rpPrices`'ta bir karşılığı OLMAK ZORUNDA.
 * Sadece Altın'la açılan hiçbir şey yoktur; Altın yalnızca hızlandırır ya da
 * bekleme yerine ödeme imkânı verir.
 */
export const goldPrices = {
  /** Profesyonel ajan: yakalanma riski yok. */
  premiumAgent: 15,
  hide1Day: 3,
  hide3Days: 8,
  hide7Days: 20,
  /** Bir sezonluk ikinci antrenman koltuğu. */
  secondTrainingSeat: 40,
} as const;

/** Aynı şeylerin RP fiyatı. `goldPrices` ile birebir aynı anahtarlar. */
export const rpPrices: Record<keyof typeof goldPrices, number> = {
  premiumAgent: 900,
  hide1Day: 200,
  hide3Days: 500,
  hide7Days: 1200,
  secondTrainingSeat: 2500,
};
