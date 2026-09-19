/**
 * Sponsorship system.
 *
 * The car carries eight branding slots, each worth a different amount because
 * of how much television time it gets. Brands make offers every race weekend;
 * which brands bother offering, and how much they pay, both key off the team's
 * championship position — winning teams get courted by global brands, backmarkers
 * get local ones.
 *
 * All brands are fictional.
 */

import { ECONOMY_SCALE } from './economy';
import { rng } from './rng';

// ── Slots on the car ───────────────────────────────────────────────────────

export type SlotTier = 'title' | 'primary' | 'secondary' | 'minor';

export interface SponsorSlot {
  key: SlotKey;
  label: string;
  tier: SlotTier;
  /** Base per-race fee before brand budget and standing are applied. */
  baseValue: number;
  /** Where the decal sits on the side-profile car, in design-space units. */
  decal: { x: number; y: number; w: number; h: number; rotate?: number };
  /**
   * Width ÷ height of the real ad area on the 3D car, from
   * `tools/blender/build_toon_car.py::SPONSOR_DECALS`. The decal texture is
   * painted at this shape, so a logo lands on the car undistorted — the floor
   * strip is nearly twenty times wider than it is tall, and a square-ish
   * texture stretched onto it turned every wordmark into a smear.
   */
  aspect: number;
}

export type SlotKey =
  | 'sidepod'
  | 'coverFront'
  | 'coverMid'
  | 'coverRear'
  | 'noseFront'
  | 'noseRear'
  | 'rearWingMain'
  | 'rearWingTop'
  | 'rearWingLow'
  | 'frontWingEnd'
  | 'frontWingFlap'
  | 'cockpitFront'
  | 'cockpitRear'
  | 'halo'
  | 'mirror'
  | 'floorEdge';

/**
 * Decal boxes are in the CarIllustration's 400x170 design space, so the
 * in-app car can draw each signed sponsor exactly where its contract says.
 */
/**
 * Where the car carries branding, and how much of it.
 *
 * Tiers follow how the real market values placements, which is by CAMERA TIME
 * rather than by how much bodywork the ad covers. RTR Sports' 2026 breakdown
 * sorts the car into three bands: sidepods, engine cover, airbox and the rear
 * wing's main plane are premium; halo, nose, front wing and cockpit sides are
 * the "sweet spot" high-value band; rear-wing endplates, mirrors and the floor
 * edge are supporting assets. The halo in particular is worth far more than
 * its size suggests — it is in every onboard shot.
 *
 * Modelled on how real cars are actually signed rather than on one flat list
 * of interchangeable panels: a 2025 Mercedes, Red Bull and Ferrari all put ONE
 * enormous title sponsor across the sidepod, then run a vertical STACK of
 * three or four medium logos down the engine cover, two along the nose, one
 * big name across the rear wing's main plane with a pair stacked on its
 * endplate, and a scattering of small ones around the cockpit, halo, mirrors
 * and front wing. The zones below follow that: sixteen positions grouped into
 * eleven areas, priced by how much television time each one gets.
 */
export const sponsorSlots: SponsorSlot[] = [
  {
    key: 'sidepod',
    label: 'Yan Kutu (başlık)',
    tier: 'title',
    baseValue: 32,
    decal: { x: 124, y: 84, w: 78, h: 15 },
    aspect: 3.35,
  },
  {
    key: 'coverFront',
    label: 'Motor Kapağı 1',
    tier: 'primary',
    baseValue: 16,
    decal: { x: 150, y: 64, w: 34, h: 9 },
    aspect: 4.0,
  },
  {
    key: 'coverMid',
    label: 'Motor Kapağı 2',
    tier: 'primary',
    baseValue: 11,
    decal: { x: 118, y: 68, w: 32, h: 9 },
    aspect: 4.0,
  },
  {
    key: 'coverRear',
    label: 'Motor Kapağı 3',
    tier: 'minor',
    baseValue: 5,
    decal: { x: 88, y: 74, w: 30, h: 8 },
    aspect: 4.0,
  },
  {
    key: 'noseFront',
    label: 'Burun Ucu',
    tier: 'secondary',
    baseValue: 10,
    decal: { x: 330, y: 97, w: 38, h: 9 },
    aspect: 3.06,
  },
  {
    key: 'noseRear',
    label: 'Burun',
    tier: 'secondary',
    baseValue: 9,
    decal: { x: 258, y: 88, w: 46, h: 11 },
    aspect: 4.0,
  },
  {
    key: 'rearWingMain',
    label: 'Arka Kanat',
    tier: 'primary',
    baseValue: 15,
    decal: { x: 30, y: 66, w: 54, h: 9 },
    aspect: 7.3,
  },
  {
    key: 'rearWingTop',
    label: 'Arka Kanat Üst',
    tier: 'minor',
    baseValue: 5,
    decal: { x: 30, y: 54, w: 50, h: 8 },
    aspect: 3.47,
  },
  {
    key: 'rearWingLow',
    label: 'Arka Kanat Alt',
    tier: 'minor',
    baseValue: 4,
    decal: { x: 32, y: 79, w: 42, h: 8 },
    aspect: 3.47,
  },
  {
    key: 'frontWingEnd',
    label: 'Ön Kanat Endplate',
    tier: 'secondary',
    baseValue: 8,
    decal: { x: 350, y: 120, w: 36, h: 6 },
    aspect: 2.5,
  },
  {
    key: 'frontWingFlap',
    label: 'Ön Kanat Flap',
    tier: 'secondary',
    baseValue: 6,
    decal: { x: 345, y: 111, w: 32, h: 5 },
    aspect: 9.3,
  },
  {
    key: 'cockpitFront',
    label: 'Kokpit Önü',
    tier: 'secondary',
    baseValue: 7,
    decal: { x: 196, y: 82, w: 28, h: 8 },
    aspect: 3.2,
  },
  {
    key: 'cockpitRear',
    label: 'Kokpit Arkası',
    tier: 'minor',
    baseValue: 5,
    decal: { x: 226, y: 84, w: 26, h: 8 },
    aspect: 3.2,
  },
  {
    key: 'halo',
    label: 'Halo',
    tier: 'secondary',
    baseValue: 9,
    decal: { x: 202, y: 46, w: 40, h: 7 },
    aspect: 3.57,
  },
  {
    key: 'mirror',
    label: 'Ayna',
    tier: 'minor',
    baseValue: 3,
    decal: { x: 248, y: 68, w: 14, h: 10 },
    aspect: 0.95,
  },
  {
    key: 'floorEdge',
    label: 'Zemin Kenarı',
    tier: 'minor',
    baseValue: 4,
    decal: { x: 130, y: 107, w: 64, h: 6 },
    aspect: 18.3,
  },
];

export const slotByKey = (key: SlotKey): SponsorSlot =>
  sponsorSlots.find((s) => s.key === key) ?? sponsorSlots[0];

/** Tier ordering used for sorting offers and gating brands. */
export const tierRank: Record<SlotTier, number> = {
  title: 4,
  primary: 3,
  secondary: 2,
  minor: 1,
};

// ── Brands ─────────────────────────────────────────────────────────────────

export type Prestige = 'global' | 'national' | 'regional' | 'local';

export interface Brand {
  key: string;
  name: string;
  /** Short form painted on the car — long names get chopped otherwise. */
  short: string;
  sector: string;
  prestige: Prestige;
  /** Multiplier on a slot's base value. */
  budget: number;
  /**
   * Worst championship position this brand will still deal with. A global
   * brand simply will not put its name on a backmarker.
   */
  maxPosition: number;
  /** Slot tiers this brand is interested in. */
  wants: SlotTier[];
  /**
   * How many positions the brand insists on as one contract. A title backer
   * does not buy a single panel — it wants the sidepod AND the cover AND the
   * nose, and it will not split the deal. Smaller names take whatever one
   * position they can get. This is what makes the car fill up in blocks
   * instead of one interchangeable rectangle at a time.
   */
  slotsWanted: 1 | 2 | 3;
  /** Brand colour for the decal. */
  color: string;
  /** How the brand signs the car. */
  logo: BrandLogo;
}

/**
 * A brand's identity, as drawing instructions rather than an image file.
 *
 * Decals are painted at runtime (see `CarTurntable.paintDecalPng`), so a logo
 * has to be something that can be drawn at any size into any aspect ratio —
 * the ad areas on the car run from a 1:1 mirror plate to an 18:1 floor strip,
 * and a single bitmap stretched across both would be unreadable on one and
 * squashed on the other. A path plus a wordmark can be laid out to fit each.
 *
 * `mark` is an SVG path in a 0..100 box. Keep marks BOLD and geometric: on the
 * halo plate the whole logo is about 40 px tall on a phone, and anything finer
 * than a few units wide disappears.
 */
/**
 * Typeface families, mapped per platform where they are painted. Kept to four
 * that both iOS and Android actually ship, because a missing family silently
 * falls back and the brand loses its voice.
 */
export type LogoFont = 'sans' | 'serif' | 'mono' | 'condensed';

export interface BrandLogo {
  /** Mark path in a 0..100 box. Omit for a wordmark-only brand. */
  mark?: string;
  /** Stroke the mark at this width (0..100 units) instead of filling it. */
  stroke?: number;
  /** Plate background. Defaults to the brand colour. */
  bg?: string;
  /**
   * The plate's outline. Not every sign is a rounded rectangle:
   *
   *   rect   rounded rectangle filling the ad area (default)
   *   pill   fully rounded ends
   *   hex    hexagon — falls back to a pill on very wide areas
   *   round  a circular BADGE holding the mark, with the wordmark printed on
   *          the bare paint beside it rather than on a plate
   *
   * The ad areas are not all the same shape, so a preference is resolved
   * against the actual aspect ratio at paint time — a circle stamped onto an
   * 18:1 floor strip would be a dot with a lot of wasted strip either side.
   */
  shape?: 'rect' | 'pill' | 'hex' | 'round';
  /**
   * Print straight onto the bodywork with no plate behind it, the way a
   * confident brand actually signs a car. The decal then has a transparent
   * background and is drawn in one tone picked to carry against whatever the
   * livery painted underneath it — so the ink, not `ink`, decides the colour.
   * Defaults to true (a coloured plate).
   */
  plate?: boolean;
  /**
   * Fill the mark with the even-odd rule, so an inner subpath punches a hole
   * (COREVEX's hexagon, VOLTRIDE's bolt). Marks that are a UNION of shapes —
   * a truck body plus its wheels — must leave this off, or every overlap gets
   * XOR'd into a notch.
   */
  evenOdd?: boolean;
  /**
   * The wordmark's typeface. Seventeen brands set in one bold sans read as one
   * company with seventeen names — a watchmaker and a software house do not
   * sign a car in the same letters.
   */
  font?: LogoFont;
  /** Wordmark weight. Defaults to bold. */
  weight?: '500' | '700' | '900';
  italic?: boolean;
  /** Letter-spacing as a fraction of the font size. Defaults to 0.05. */
  tracking?: number;
  /** Mark and wordmark colour — must carry against `bg`. */
  ink: string;
  /** Wordmark text. Defaults to the brand's `short`. */
  word?: string;
}

export const brands: Brand[] = [
  // Global — only interested in front-running teams, pay the most.
  { key: 'axion', name: 'TAUROX', short: 'TAUROX', sector: 'Enerji içeceği', prestige: 'global', budget: 2.5, maxPosition: 4, wants: ['title', 'primary'], color: '#FF3B5C', slotsWanted: 3, logo: { mark: 'M6 24 L32 14 L50 44 L68 14 L94 24 L50 96 Z', shape: 'rect', font: 'sans', weight: '900', tracking: 0.02, ink: '#14060A' } },
  { key: 'nyxa', name: 'NIMBUS 9', short: 'NIMBUS9', sector: 'Bulut bilişim', prestige: 'global', budget: 2.35, maxPosition: 5, wants: ['title', 'primary'], color: '#2DD4BF', slotsWanted: 3, logo: { mark: 'M26 18 H80 A10 10 0 0 1 80 38 H26 A10 10 0 0 1 26 18 Z M40 44 H92 A10 10 0 0 1 92 64 H40 A10 10 0 0 1 40 44 Z M8 70 H62 A10 10 0 0 1 62 90 H8 A10 10 0 0 1 8 70 Z', shape: 'pill', font: 'sans', weight: '700', tracking: 0.06, ink: '#052624' } },
  { key: 'chronarc', name: 'CHRONARC', short: 'CHRONARC', sector: 'Saat', prestige: 'global', budget: 2.2, maxPosition: 6, wants: ['title', 'primary', 'secondary'], color: '#E3B341', slotsWanted: 2, logo: { mark: 'M16 72 A40 40 0 1 1 84 72 M50 4 L50 30', stroke: 11, plate: false, font: 'serif', weight: '700', tracking: 0.1, ink: '#1A1204' } },
  { key: 'petrolux', name: 'PETROLUX', short: 'PETROLUX', sector: 'Yakıt & yağ', prestige: 'global', budget: 2.4, maxPosition: 5, wants: ['title', 'primary'], color: '#4C82F7', slotsWanted: 3, logo: { mark: 'M50 2 C76 24 78 50 58 72 C48 83 46 90 52 98 C22 86 18 56 40 32 C50 21 54 12 50 2 Z', plate: false, font: 'sans', weight: '700', tracking: 0.08, ink: '#03102E' } },

  // National — the bread and butter of a midfield team.
  { key: 'bogaz', name: 'VOLTARA', short: 'VOLTARA', sector: 'Elektrik', prestige: 'national', budget: 1.65, maxPosition: 12, wants: ['title', 'primary', 'secondary'], color: '#9B5CFF', slotsWanted: 2, logo: { mark: 'M4 24 H96 V76 H4 Z M32 24 L54 24 L36 76 L14 76 Z M68 24 L90 24 L72 76 L50 76 Z', evenOdd: true, shape: 'hex', font: 'condensed', weight: '700', tracking: 0.1, ink: '#150632' } },
  { key: 'telvana', name: 'TELVANA', short: 'TELVANA', sector: 'Telekom', prestige: 'national', budget: 1.55, maxPosition: 12, wants: ['primary', 'secondary'], color: '#F0655E', slotsWanted: 2, logo: { mark: 'M10 90 A80 80 0 0 1 90 10 M30 90 A60 60 0 0 1 90 30 M50 90 A40 40 0 0 1 90 50', stroke: 12, shape: 'round', font: 'sans', weight: '500', tracking: 0.14, ink: '#2A0806' } },
  { key: 'meridian', name: 'MERIDIAN BANK', short: 'MERIDIAN', sector: 'Finans', prestige: 'national', budget: 1.7, maxPosition: 10, wants: ['title', 'primary'], color: '#3FCF8E', slotsWanted: 2, logo: { mark: 'M50 6 A44 44 0 1 1 49.9 6 M50 6 A26 44 0 0 0 50 94 M50 6 A26 44 0 0 1 50 94 M6 50 H94', stroke: 9, shape: 'round', font: 'serif', weight: '700', tracking: 0.06, ink: '#032313' } },
  { key: 'skyra', name: 'SKYRA AIR', short: 'SKYRA', sector: 'Havayolu', prestige: 'national', budget: 1.5, maxPosition: 13, wants: ['primary', 'secondary'], color: '#60A5FA', slotsWanted: 2, logo: { mark: 'M50 4 L96 94 L50 72 L4 94 Z', plate: false, font: 'condensed', weight: '700', italic: true, tracking: 0.04, ink: '#041530' } },
  { key: 'corevex', name: 'COREVEX', short: 'COREVEX', sector: 'Yazılım', prestige: 'national', budget: 1.45, maxPosition: 14, wants: ['primary', 'secondary', 'minor'], color: '#A78BFA', slotsWanted: 1, logo: { mark: 'M50 2 L94 27 L94 73 L50 98 L6 73 L6 27 Z M50 24 A26 26 0 1 0 50 76 L50 64 A14 14 0 1 1 50 36 Z', evenOdd: true, shape: 'hex', font: 'mono', weight: '700', tracking: 0.02, ink: '#170A33' } },

  // Regional — happy to back anyone, modest money.
  { key: 'anadolu', name: 'VECTRA FREIGHT', short: 'VECTRA', sector: 'Lojistik', prestige: 'regional', budget: 1.05, maxPosition: 20, wants: ['secondary', 'minor', 'primary'], color: '#E3B341', slotsWanted: 2, logo: { mark: 'M2 24 L22 24 L44 50 L22 76 L2 76 L24 50 Z M28 24 L48 24 L70 50 L48 76 L28 76 L50 50 Z M54 24 L74 24 L96 50 L74 76 L54 76 L76 50 Z', shape: 'rect', font: 'condensed', weight: '900', tracking: 0.06, ink: '#1A1204' } },
  { key: 'marmara', name: 'VALEMONT', short: 'VALEMONT', sector: 'Sigorta', prestige: 'regional', budget: 1.0, maxPosition: 20, wants: ['secondary', 'minor'], color: '#2DD4BF', slotsWanted: 1, logo: { mark: 'M8 8 H60 V26 H26 V74 H60 V92 H8 Z M92 92 H40 V74 H74 V26 H40 V8 H92 Z', shape: 'pill', font: 'serif', weight: '700', tracking: 0.08, ink: '#052624' } },
  { key: 'kestrel', name: 'KESTREL PARTS', short: 'KESTREL', sector: 'Yedek parça', prestige: 'regional', budget: 0.95, maxPosition: 20, wants: ['minor', 'secondary'], color: '#FF7A45', slotsWanted: 1, logo: { mark: 'M10 6 L32 6 L32 40 L64 6 L94 6 L54 48 L96 94 L64 94 L32 58 L32 94 L10 94 Z', shape: 'rect', font: 'sans', weight: '900', tracking: 0.02, ink: '#2B0C02' } },
  { key: 'grendel', name: 'GRENDEL TOOLS', short: 'GRENDEL', sector: 'El aleti', prestige: 'regional', budget: 0.9, maxPosition: 20, wants: ['minor', 'secondary'], color: '#94A3B8', slotsWanted: 1, logo: { mark: 'M18 6 L42 6 L50 34 L58 6 L82 6 L62 50 L82 94 L58 94 L50 66 L42 94 L18 94 L38 50 Z', plate: false, font: 'condensed', weight: '900', tracking: 0.12, ink: '#0E141C' } },

  // Local — always available, keeps the lights on. One of them will take the
  // title slot at any position, so a backmarker can still fill all eight
  // slots (for very little money) rather than being locked out of its best one.
  { key: 'anadolu2', name: 'HAULBERG', short: 'HAULBERG', sector: 'Nakliyat', prestige: 'local', budget: 0.6, maxPosition: 20, wants: ['title', 'primary', 'minor'], color: '#8C7B6B', slotsWanted: 1, logo: { mark: 'M8 10 L34 10 L34 40 L66 40 L66 10 L92 10 L92 90 L66 90 L66 60 L34 60 L34 90 L8 90 Z', shape: 'rect', font: 'condensed', weight: '700', tracking: 0.08, ink: '#1A140E' } },
  { key: 'apex', name: 'APEX ROAST', short: 'APEX', sector: 'Kahve', prestige: 'local', budget: 0.65, maxPosition: 20, wants: ['minor'], color: '#B08968', slotsWanted: 1, logo: { mark: 'M50 4 L96 92 L4 92 Z M50 42 L72 82 L28 82 Z', evenOdd: true, plate: false, font: 'serif', weight: '700', tracking: 0.12, ink: '#21140A' } },
  { key: 'volt', name: 'VOLTRIDE', short: 'VOLTRIDE', sector: 'Elektrikli scooter', prestige: 'local', budget: 0.7, maxPosition: 20, wants: ['minor', 'secondary'], color: '#D4FF3D', slotsWanted: 1, logo: { mark: 'M26 4 L64 4 L44 40 L74 40 L30 96 L42 56 L14 56 Z', shape: 'pill', font: 'sans', weight: '900', italic: true, tracking: 0.02, ink: '#1A2004' } },
  { key: 'datalume', name: 'DATALUME', short: 'DATALUME', sector: 'Veri analitiği', prestige: 'local', budget: 0.75, maxPosition: 18, wants: ['minor', 'secondary'], color: '#38BDF8', slotsWanted: 1, logo: { mark: 'M50 2 L78 30 L50 58 L22 30 Z M50 44 L78 72 L50 100 L22 72 Z M50 30 L64 44 L50 58 L36 44 Z', evenOdd: true, plate: false, font: 'mono', weight: '700', tracking: 0.06, ink: '#03202E' } },
];

export const brandByKey = (key: string): Brand | undefined =>
  brands.find((b) => b.key === key);

// ── Money ──────────────────────────────────────────────────────────────────

/**
 * How much a championship position is worth to sponsors. P1 pays roughly
 * 2x what a midfield slot does, and the back of the grid barely half.
 */
export function standingFactor(position: number): number {
  const raw = 2.05 - 0.105 * (position - 1);
  return Math.min(2.05, Math.max(0.55, Number(raw.toFixed(3))));
}

/** Per-race fee for a brand in a slot at a given championship position. */
export interface PricingContext {
  /** Where the team sits in the championship right now, 1-based. */
  position: number;
  /** The team's pre-season pace, 0-100 (`Team.baseStrength`). */
  baseStrength: number;
}

/**
 * Reputation, as distinct from form.
 *
 * Standing alone prices a team purely on this season, which is not how the
 * sponsor market works: a famous team having a bad year still sells panels,
 * and a backmarker on a lucky run does not suddenly command title money. The
 * team's default starting strength sets that floor, and the championship
 * position moves the price around it.
 */
function prestigeFactor(baseStrength: number): number {
  return 0.74 + 0.52 * (Math.max(0, Math.min(100, baseStrength)) / 100);
}

/**
 * Converts the catalogue's relative weights into RP.
 *
 * `baseValue` says how positions rank against each other; this says what the
 * whole board is worth against everything else in the game. It has to be read
 * against what RP BUYS: a stat step is 15-18, a factory department 50-250. At
 * full price a filled car paid ~780 RP a race, which is three wind tunnels a
 * weekend and no progression curve left. Tuned so a mid-table team with a
 * well-signed car earns about 150 RP a race, and a season's income builds a
 * factory rather than buying one on Sunday.
 */
export { ECONOMY_SCALE };

/** What one position on the car is worth to one brand, for this team. */
export function slotFee(brand: Brand, slot: SponsorSlot, ctx: PricingContext): number {
  return Math.max(1, Math.round(
    slot.baseValue * brand.budget * standingFactor(ctx.position)
      * prestigeFactor(ctx.baseStrength) * ECONOMY_SCALE,
  ));
}

/**
 * A package is cheaper per position than the same panels sold separately —
 * which is the trade the player is being offered: hand over three of your best
 * areas at once, or hold out and sell them one at a time for more.
 */
export function packageRate(slots: number): number {
  return slots >= 3 ? 0.86 : slots === 2 ? 0.93 : 1;
}

/**
 * What locking a price in for longer is worth.
 *
 * Real teams want three-year commitments and charge a 15-30% per-race premium
 * for a single season (RTR Sports, 2026) — the short deal is the expensive
 * one, because the brand is buying flexibility. Without this the contract
 * length in this game was a number with no consequence: there was never a
 * reason to prefer a short deal over a long one.
 */
export function durationRate(rounds: number): number {
  // 3 rounds → +24%, 5 → break-even, 8+ → -12%.
  return Number((1.24 - 0.045 * Math.max(0, rounds - 3)).toFixed(3));
}

export function perRaceFee(brand: Brand, slots: SponsorSlot[], ctx: PricingContext): number {
  const rate = packageRate(slots.length);
  return slots.reduce((sum, slot) => sum + Math.round(slotFee(brand, slot, ctx) * rate), 0);
}

/** Up-front payment on signing — bigger for longer deals. */
export function signingBonus(perRace: number, rounds: number): number {
  return Math.round(perRace * rounds * 0.35);
}

/**
 * Extra paid when the team beats the contract's target finish. This is what
 * makes a demanding deal worth taking.
 */
export function resultBonus(perRace: number, targetPosition: number): number {
  const demand = Math.max(1, 11 - targetPosition); // P1 target = 10, P10 = 1
  // Deliberately a SECOND-ORDER term. At 0.22 the bonus for a demanding target
  // came to more than the fee itself, so the guaranteed per-race money — the
  // thing that lets a struggling team climb out at all — stopped mattering.
  // At 0.05 a hard target adds about a third, and a full streak on top of that
  // roughly doubles the deal: strong, but never the main event.
  return Math.round(perRace * demand * 0.05);
}

// ── Offers ─────────────────────────────────────────────────────────────────

export interface SponsorOffer {
  id: string;
  brandKey: string;
  /**
   * A renewal of a deal that is running out, rather than a fresh approach.
   * The brand already knows what it got: hit the target and it comes back
   * better, miss it and it comes back worse. Without this a contract just
   * lapsed in silence and the slot went quiet.
   */
  renewalOf?: string;
  /** The positions demanded, as one indivisible contract. */
  slots: SlotKey[];
  /** What each of those positions contributes to `perRace`, in the same order. */
  perSlot: number[];
  /** Contract length in race rounds. */
  rounds: number;
  perRace: number;
  signing: number;
  /** Finish at or better than this to earn the result bonus. */
  targetPosition: number;
  bonus: number;
  /**
   * The run of target-hitting races the brand is betting on, chosen when the
   * deal is written. Each consecutive hit pays a rising share of `bonus` on
   * top of it; one miss and the run resets to zero. A long streak target is
   * worth far more in total and far harder to hold — the player is pricing
   * their own consistency, which is the bet OSM's shirt sponsor asks for.
   */
  streakTarget: number;
}

export interface Sponsorship {
  /**
   * Groups the positions bought in one contract. Deals are stored one record
   * per position — every renderer already asks "who owns this slot?" — and the
   * id is what makes releasing give back the whole package rather than
   * stranding a brand on two thirds of the car it paid for.
   */
  dealId: string;
  brandKey: string;
  slot: SlotKey;
  perRace: number;
  targetPosition: number;
  bonus: number;
  /** Round the deal was signed. */
  signedRound: number;
  /** Round after which the slot frees up. */
  expiresRound: number;
  /** See `SponsorOffer.streakTarget`. */
  streakTarget: number;
  /** Consecutive target-hitting races so far under this contract. */
  streak: number;
}


/**
 * Pick a brand favouring the richest ones available.
 *
 * A flat random pick makes the offer sheet non-monotone — a P1 team can be
 * shown a cheaper headline deal than a P5 team purely by luck, which breaks
 * the promise that climbing the championship pays better. Weighting by budget
 * keeps variety while making the trend hold.
 */
function pickBrandWeighted(random: () => number, candidates: Brand[]): Brand {
  const weights = candidates.map((b) => b.budget ** 3);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = random() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/**
 * Rotate which slots get offered, keyed off the round.
 *
 * Without this the sheet is always filled from the most valuable slot down, so
 * with only 3-4 offers a weekend the minor slots never come up at all and a
 * midfield or backmarker team can never fill its car.
 */
function rotateSlots(slots: SponsorSlot[], round: number): SponsorSlot[] {
  const byTier = [...slots].sort((a, b) => tierRank[b.tier] - tierRank[a.tier]);
  // The headline areas stay at the front of the queue: with sixteen positions
  // and five offers a weekend, rotating the WHOLE list meant the sidepod could
  // go a month without being offered to a team that brands were queuing for.
  // Only the long tail rotates, which is what it was there for — making sure
  // the minor positions come up at all.
  const lead = byTier.filter((s) => s.tier === 'title' || s.tier === 'primary');
  const tail = byTier.filter((s) => s.tier !== 'title' && s.tier !== 'primary');
  const offset = round % Math.max(1, tail.length);
  return [...lead, ...tail.slice(offset), ...tail.slice(0, offset)];
}

export interface GenerateOffersInput {
  round: number;
  /** Contracts running now — the ones close to expiry come back as renewals. */
  running?: Sponsorship[];
  /** Championship position, 1-based. */
  position: number;
  /** The team's pre-season pace — reputation, as opposed to this season's form. */
  baseStrength: number;
  /** Slots already under contract. */
  takenSlots: SlotKey[];
  totalRounds: number;
}

/**
 * Build this weekend's offer sheet.
 *
 * The number of offers grows with how attractive the team is: a leading team
 * gets a fuller sheet, and only brands whose `maxPosition` tolerates the
 * team's standing show up at all. Contract length is capped at the rounds
 * left in the season.
 */
export function generateOffers({
  round,
  running,
  position,
  baseStrength,
  takenSlots,
  totalRounds,
}: GenerateOffersInput): SponsorOffer[] {
  const random = rng(round * 7919 + position * 104729);
  const ctxAll: PricingContext = { position, baseStrength };
  const offers: SponsorOffer[] = [];

  // Renewals first. A deal in its last round comes back from the brand that
  // already has the slot, priced on how the partnership actually went: hitting
  // the target reads as a brand that wants to stay, missing it as one looking
  // for a discount. These do not consume the fresh-offer budget — they are the
  // contract you already have asking to continue.
  for (const deal of running ?? []) {
    if (deal.expiresRound - round > 1) continue;
    const brand = brands.find((b) => b.key === deal.brandKey);
    if (!brand) continue;
    const group = (running ?? []).filter((s) => s.dealId === deal.dealId);
    if (group[0] !== deal) continue;               // one renewal per contract
    const slots = group.map((s) => slotByKey(s.slot));
    const happy = group.some((s) => s.streak > 0);
    const mood = happy ? 1.12 : 0.88;
    const rounds = Math.min(Math.max(1, totalRounds - round + 1), happy ? 6 : 4);
    const rate = packageRate(slots.length) * durationRate(rounds) * mood;
    const perSlot = slots.map((slot) => Math.round(slotFee(brand, slot, ctxAll) * rate));
    const perRace = perSlot.reduce((a, b) => a + b, 0);
    const targetPosition = Math.min(12, Math.max(1, deal.targetPosition + (happy ? -1 : 1)));
    offers.push({
      id: `renew-${round}-${deal.dealId}`,
      renewalOf: deal.dealId,
      brandKey: brand.key,
      slots: group.map((s) => s.slot),
      perSlot,
      rounds,
      perRace,
      signing: signingBonus(perRace, rounds),
      targetPosition,
      bonus: resultBonus(perRace, targetPosition),
      streakTarget: deal.streakTarget,
    });
  }

  const free = sponsorSlots.filter((s) => !takenSlots.includes(s.key));
  if (free.length === 0) return offers;

  // 3 offers at the back of the grid, up to 6 at the front.
  const count = Math.min(free.length, position <= 3 ? 6 : position <= 8 ? 5 : position <= 14 ? 4 : 3);
  const roundsLeft = Math.max(1, totalRounds - round + 1);
  const ctx: PricingContext = ctxAll;

  const usedSlots = new Set<SlotKey>();
  const usedBrands = new Set<string>();

  // Rotated per round so every slot eventually comes up, even when only a
  // few offers arrive each weekend.
  const candidateSlots = rotateSlots(free, round);

  const fresh = offers.length;
  for (const slot of candidateSlots) {
    if (offers.length - fresh >= count) break;
    if (usedSlots.has(slot.key)) continue;

    const interested = brands.filter(
      (b) => b.wants.includes(slot.tier) && position <= b.maxPosition && !usedBrands.has(b.key),
    );
    if (interested.length === 0) continue;

    const brand = pickBrandWeighted(random, interested);

    // Build the package around the slot that led here: the brand takes as many
    // further positions as it demands, from the tiers it cares about and the
    // most valuable first. A brand that cannot be given its full package is
    // NOT offered a smaller one — that is the point of insisting.
    const extras = candidateSlots.filter(
      (s) =>
        s.key !== slot.key &&
        !usedSlots.has(s.key) &&
        brand.wants.includes(s.tier),
    );
    const wanted = brand.slotsWanted - 1;
    const pack = [slot, ...extras.slice(0, wanted)];
    if (pack.length < brand.slotsWanted) continue;

    const rounds = Math.min(roundsLeft, 3 + Math.floor(random() * 6)); // 3-8 rounds
    const rate = packageRate(pack.length) * durationRate(rounds);
    const perSlot = pack.map((s) => Math.round(slotFee(brand, s, ctx) * rate));
    const perRace = perSlot.reduce((a, b) => a + b, 0);
    // Bigger brands demand a better finish; the target never exceeds P12.
    const targetPosition = Math.min(
      12,
      Math.max(1, position - 1 + Math.floor(random() * 4) - (brand.prestige === 'global' ? 2 : 0)),
    );

    offers.push({
      id: `${round}-${pack.map((s) => s.key).join('+')}-${brand.key}`,
      brandKey: brand.key,
      slots: pack.map((s) => s.key),
      perSlot,
      rounds,
      perRace,
      signing: signingBonus(perRace, rounds),
      targetPosition,
      bonus: resultBonus(perRace, targetPosition),
      // Bigger brands ask for a longer run of results before they pay out.
      streakTarget: brand.prestige === 'global' ? 4 : brand.prestige === 'national' ? 3 : 2,
    });
    pack.forEach((s) => usedSlots.add(s.key));
    usedBrands.add(brand.key);
  }

  return offers;
}

/** Total per-race income from every active deal. */
export function totalPerRace(sponsorships: Sponsorship[]): number {
  return sponsorships.reduce((sum, s) => sum + s.perRace, 0);
}

/**
 * Settle a race: every active deal pays its fee, and any whose target was met
 * also pays its bonus.
 */
/**
 * What a streak of `n` consecutive target finishes is worth, as a multiple of
 * the contract's result bonus. Rising, so the last race of a long run is the
 * one worth holding on for; capped at the contract's own `streakTarget`.
 */
export function streakMultiplier(streak: number, target: number): number {
  if (streak <= 0) return 0;
  const capped = Math.min(streak, target);
  return Number((1 + 0.45 * (capped - 1)).toFixed(2));
}

export interface RaceSettlementDetail {
  income: number;
  bonusesEarned: string[];
  /** Deals whose streak just reset because the target was missed. */
  streaksBroken: string[];
  /** The contracts, with their streaks moved on. */
  sponsorships: Sponsorship[];
}

/**
 * Settle one race.
 *
 * The per-race fee is paid WHATEVER happens. That is deliberate: a struggling
 * team has to be able to climb out, and an income that dries up exactly when
 * results dry up would bury it. The result only ever adds — through the target
 * bonus, and through the streak riding on top of it.
 */
export function settleRace(
  sponsorships: Sponsorship[],
  finishPosition: number,
): RaceSettlementDetail {
  let income = 0;
  const bonusesEarned: string[] = [];
  const streaksBroken: string[] = [];
  const updated = sponsorships.map((s) => {
    income += s.perRace;
    if (finishPosition <= s.targetPosition) {
      const streak = s.streak + 1;
      income += Math.round(s.bonus * streakMultiplier(streak, s.streakTarget));
      bonusesEarned.push(s.brandKey);
      return { ...s, streak };
    }
    if (s.streak > 0) streaksBroken.push(s.brandKey);
    return { ...s, streak: 0 };
  });
  return { income, bonusesEarned, streaksBroken, sponsorships: updated };
}

/**
 * Race-day prize money, by championship position.
 *
 * Kept deliberately FLAT next to the sponsor curve, because that is how the
 * real sport pays: in 2025 the constructors' champion took about $175m and
 * last place about $75m — a spread of only 2.3x — while a premium placement on
 * a top-three car sells for three to five times the midfield price. So prize
 * money is the floor that keeps a bad season survivable, and sponsorship is
 * what actually rewards climbing.
 */
export function racePrize(championshipPosition: number, gridSize: number): number {
  const t = (championshipPosition - 1) / Math.max(1, gridSize - 1);
  // A 2.3x spread, the same as the real payout ladder, on the same scale as
  // the sponsor board (see ECONOMY_SCALE).
  return Math.round((400 - 225 * t) * ECONOMY_SCALE);
}
