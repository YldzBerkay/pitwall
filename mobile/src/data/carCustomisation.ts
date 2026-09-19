/**
 * Car customisation catalogue — the app-side mirror of
 * `tools/blender/car_config.py`. Keep the two in sync: the Blender builder
 * renders showcase images from the same liveries, compounds and rims that the
 * in-app car draws live.
 */

import { ECONOMY_SCALE } from './economy';

export interface Livery {
  key: string;
  label: string;
  /** Main body paint. */
  primary: string;
  /** Engine cover / sidepod shading. */
  secondary: string;
  /** Stripes, endplate lips, nose tip, helmet. */
  accent: string;
  /** Carbon-fibre parts (wings, floor, suspension). */
  trim: string;
  style: LiveryStyle;
}

export type LiveryStyle = 'stripe' | 'flash' | 'duotone' | 'split' | 'bare';

export const liveries: Livery[] = [
  {
    key: 'pitwall',
    label: 'Pit Wall',
    primary: '#D4FF3D',
    secondary: '#8FB026',
    accent: '#9B5CFF',
    trim: '#2E2F35',
    style: 'stripe',
  },
  {
    key: 'midnight',
    label: 'Midnight',
    primary: '#13254F',
    secondary: '#0B1632',
    accent: '#2DD4BF',
    trim: '#292B32',
    style: 'flash',
  },
  {
    key: 'scarlet',
    label: 'Scarlet',
    primary: '#C8141B',
    secondary: '#7A090E',
    accent: '#F2CA53',
    trim: '#2F2B2B',
    style: 'stripe',
  },
  {
    key: 'monza',
    label: 'Monza',
    primary: '#E6E8E5',
    secondary: '#A3A7AA',
    accent: '#D41D2E',
    trim: '#303033',
    style: 'duotone',
  },
  {
    key: 'sunset',
    label: 'Sunset',
    primary: '#F16D1B',
    secondary: '#A3370B',
    accent: '#6532A3',
    trim: '#302C2B',
    style: 'flash',
  },
  {
    key: 'stealth',
    label: 'Stealth',
    primary: '#191A1E',
    secondary: '#0E0F12',
    accent: '#D4FF3D',
    trim: '#25282D',
    style: 'flash',
  },
  {
    key: 'aqua',
    label: 'Aqua',
    primary: '#2DC7CE',
    secondary: '#16737D',
    accent: '#FAFAFA',
    trim: '#2B2E30',
    style: 'duotone',
  },
  {
    key: 'emerald',
    label: 'Emerald',
    primary: '#0F6B44',
    secondary: '#0A1F17',
    accent: '#E8C45A',
    trim: '#232A26',
    style: 'split',
  },
  {
    key: 'fuchsia',
    label: 'Fuchsia',
    primary: '#E01D84',
    secondary: '#2B0A1E',
    accent: '#2BE3D0',
    trim: '#2E262C',
    style: 'split',
  },
  {
    key: 'solar',
    label: 'Solar',
    primary: '#FFD21E',
    secondary: '#C08A00',
    accent: '#2456E8',
    trim: '#2A2A2E',
    style: 'stripe',
  },
];

export const liveryByKey = (key: string): Livery =>
  liveries.find((l) => l.key === key) ?? liveries[0];

/** F1 tyre compounds with their real sidewall colours. */
export interface Compound {
  key: CompoundKey;
  label: string;
  short: string;
  /** Sidewall ring colour. */
  band: string;
  /** Intermediates and wets show tread blocks. */
  grooved: boolean;
}

export type CompoundKey = 'SOFT' | 'MEDIUM' | 'HARD' | 'INTERMEDIATE' | 'WET';

export const compounds: Compound[] = [
  { key: 'SOFT', label: 'Soft', short: 'S', band: '#E7202A', grooved: false },
  { key: 'MEDIUM', label: 'Medium', short: 'M', band: '#FFD12E', grooved: false },
  { key: 'HARD', label: 'Hard', short: 'H', band: '#F1F2F1', grooved: false },
  { key: 'INTERMEDIATE', label: 'Inter', short: 'I', band: '#3FA34A', grooved: true },
  { key: 'WET', label: 'Wet', short: 'W', band: '#1E64C8', grooved: true },
];

export const compoundByKey = (key: string): Compound =>
  compounds.find((c) => c.key === key) ?? compounds[0];

/** Rim finishes. '@accent' / '@primary' resolve against the active livery. */
export interface Rim {
  key: string;
  label: string;
  color: string | '@accent' | '@primary';
}

export const rims: Rim[] = [
  { key: 'silver', label: 'Silver', color: '#CFD3D6' },
  { key: 'graphite', label: 'Graphite', color: '#272A2E' },
  { key: 'gold', label: 'Gold', color: '#D9AD42' },
  { key: 'bronze', label: 'Bronze', color: '#9C6636' },
  { key: 'accent', label: 'Takım vurgusu', color: '@accent' },
  { key: 'primary', label: 'Takım rengi', color: '@primary' },
  { key: 'white', label: 'Beyaz', color: '#ECEEEC' },
];

export const rimByKey = (key: string): Rim => rims.find((r) => r.key === key) ?? rims[0];

export function resolveRimColor(rim: Rim, livery: Livery): string {
  if (rim.color === '@accent') return livery.accent;
  if (rim.color === '@primary') return livery.primary;
  return rim.color;
}

/** Spoke patterns. The count is arms per half-turn; the star shows double. */
export type SpokeStyle = 'blade' | 'multi' | 'turbine';

export const spokeStyles: { key: SpokeStyle; label: string; count: number }[] = [
  { key: 'blade', label: 'Blade', count: 5 },
  { key: 'multi', label: 'Multi', count: 10 },
  { key: 'turbine', label: 'Turbine', count: 16 },
];

export const spokeCount = (style: SpokeStyle): number =>
  spokeStyles.find((s) => s.key === style)?.count ?? 10;

// ── Development spec ───────────────────────────────────────────────────────

/** T1 below 60, T2 60–69, T3 70 and above. */
export const tierOf = (value: number): 1 | 2 | 3 =>
  value >= 70 ? 3 : value >= 60 ? 2 : 1;

export type SpecLetter = 'A' | 'B' | 'C';

export const specLetter = (average: number): SpecLetter =>
  average >= 70 ? 'A' : average >= 60 ? 'B' : 'C';

export interface CarParts {
  // MOTOR
  exhaust: boolean;
  airboxScoop: boolean;
  exhaustLarge: boolean;
  exhaustGlow: boolean;
  heatHaze: boolean;
  /** 2026 hybrid: battery-cooling ducts on the sidepod shoulders. */
  energyPods: boolean;
  engineLouvres: boolean;
  coolingGills: boolean;
  powerSpine: boolean;
  // AERO
  frontFlap2: boolean;
  frontFlap3: boolean;
  /** 2026 active aero: the rear flap drops to its low-drag X-mode angle. */
  activeAero: boolean;
  rearFlap: boolean;
  beamWing: boolean;
  floorEdgeWing: boolean;
  rearDrsOpen: boolean;
  rearEndplateTall: boolean;
  bargeboards: boolean;
  sharkFin: boolean;
  tWing: boolean;
  endplateLips: boolean;
  mirrorWinglets: boolean;
  // GRIP
  wideTyres: boolean;
  rimRing: boolean;
  brakeDucts: boolean;
  diffuserStrakes: boolean;
  bigDiffuser: boolean;
  rimUpgrade: boolean;
}

export interface CarSpec {
  tiers: { motor: 1 | 2 | 3; aero: 1 | 2 | 3; grip: 1 | 2 | 3 };
  spec: SpecLetter;
  parts: CarParts;
}

/** The part manifest for a development state — this drives what's drawn. */
export function describeSpec(motor: number, aero: number, grip: number): CarSpec {
  const m = tierOf(motor);
  const a = tierOf(aero);
  const g = tierOf(grip);
  return {
    tiers: { motor: m, aero: a, grip: g },
    spec: specLetter((motor + aero + grip) / 3),
    // Mirrors tools/blender/car_config.py::describe_spec — keep the two in step.
    parts: {
      exhaust: m >= 2,
      airboxScoop: m >= 2,
      exhaustLarge: m >= 3,
      exhaustGlow: m >= 3,
      heatHaze: m >= 3,
      energyPods: m >= 2,
      engineLouvres: m >= 3,
      coolingGills: m >= 3,
      powerSpine: m >= 3,
      frontFlap2: a >= 2,
      frontFlap3: a >= 3,
      activeAero: a >= 3,
      rearFlap: a >= 2,
      beamWing: a >= 2,
      floorEdgeWing: a >= 2,
      rearDrsOpen: a >= 3,
      rearEndplateTall: a >= 3,
      bargeboards: a >= 2,
      sharkFin: a >= 3,
      tWing: a >= 3,
      endplateLips: a >= 3,
      mirrorWinglets: a >= 3,
      wideTyres: g >= 2,
      rimRing: g >= 2,
      brakeDucts: g >= 2,
      diffuserStrakes: g >= 3,
      bigDiffuser: g >= 3,
      rimUpgrade: g >= 3,
    },
  };
}

/** Human-readable list of what a stat's next tier unlocks — used in the UI. */
export const tierUnlocks: Record<string, Record<2 | 3, string>> = {
  MOTOR: {
    2: 'Egzoz borusu · yüksek airbox ağzı · batarya soğutma podları',
    3: 'Büyük kızgın egzoz · soğutma solungaçları · güç omurgası',
  },
  AERO: {
    2: 'İkinci ön flap · iki elemanlı arka kanat · beam wing · taban kanatçıkları · taban çitleri',
    3: 'Üçüncü flap · aktif aero (X-mod) · yüksek endplate · köpekbalığı yüzgeci · T-kanat',
  },
  GRIP: {
    2: 'Geniş lastikler · jant halkası · fren kanalları',
    3: 'En geniş slickler · büyük difüzör · takım rengi jant kapağı',
  },
};

// ── Yükseltme süresi ───────────────────────────────────────────────────────
// Bir parça artık anında takılmaz: fabrikada üretilir. İlk yükseltme altı
// saat, aynı değerin her sonraki yükseltmesi bir öncekinin 1,5 katı. Böylece
// erken oyun akıcı kalır, geç oyunda her +2 gerçek bir yatırım olur.

/** İlk yükseltmenin süresi. */
export const UPGRADE_BASE_MS = 6 * 60 * 60 * 1000;
/** Her tamamlanmış yükseltmeden sonraki katlanma çarpanı. */
export const UPGRADE_STEP = 1.5;
/**
 * Tavan: katlanma 1,5 kat olunca 10. yükseltme tek başına 9 güne çıkıyordu.
 * Üç gün, bir yarış haftası içinde hâlâ bir parça çıkarılabilen en uzun süre.
 */
export const UPGRADE_MAX_MS = 72 * 60 * 60 * 1000;

/** `done` = o değer için tamamlanmış yükseltme sayısı. 6sa, 9sa, 13,5sa… en çok 72sa. */
export function upgradeDurationMs(done: number): number {
  return Math.min(UPGRADE_MAX_MS, Math.round(UPGRADE_BASE_MS * UPGRADE_STEP ** Math.max(0, done)));
}

// ── Yükseltme fiyatı ───────────────────────────────────────────────────────
// Para merdiveni süreyle AYNI 1,5 çarpanını kullanır, böylece oyuncunun
// aklında tek bir kural kalır: her yükseltme bir öncekinin bir buçuk katı.

/** En ucuz geliştirme: orta sıra takımın bir yarışlık gelirinin (~1.100 RP) yaklaşık %68'i. */
export const UPGRADE_BASE_RP = Math.round(500 * ECONOMY_SCALE);

/**
 * Bir geliştirmenin taban stat kazancı.
 *
 * Tek tezgah ve 1,5 katlanma bir sezona ~12 geliştirme sığdırıyor; +6 ile
 * orta sıra bir araç (ort 66) sezon sonunda şampiyonluk bandına (ort ~90)
 * tam çıkıyor. Baş mekanik ve rüzgar tüneli bunun üstüne biner.
 */
export const UPGRADE_GAIN = 6;

/**
 * `done` = o stat için tamamlanmış yükseltme sayısı.
 *
 * Süre 72 saatte tavan yapar ama fiyat YAPMAZ: geç sezonda fren parasal
 * olsun, takvimsel değil. Yoksa oyuncu zamanla her şeyi alabilirdi.
 */
export function upgradeCostFor(done: number): number {
  return Math.round(UPGRADE_BASE_RP * UPGRADE_STEP ** Math.max(0, done));
}

/** "6 sa", "13 sa 30 dk", "2 gün 6 sa" — geri sayım ve etiketler için. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days} gün ${hours} sa` : `${days} gün`;
  if (hours > 0) return mins > 0 ? `${hours} sa ${mins} dk` : `${hours} sa`;
  return `${mins} dk`;
}
