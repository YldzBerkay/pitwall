/**
 * The people behind the car: chief mechanic, strategist, pit crew chief.
 *
 * Each seat holds one head of department with a 0-100 skill and a per-race
 * wage. Skill is turned into game effects by `staffEffects`, and everything
 * else in the game reads those effects rather than the skill directly, so the
 * scale can be tuned here alone:
 *
 *   mechanic   → extra points per car upgrade, a little reliability
 *   strategist → how often the briefing is right, how tight the rain forecast
 *                is, how sharp the assistant bot is when the manager is away
 *   pitCrew    → seconds saved per pit stop, chance of a botched stop
 *
 * Real-world anchor for the pit crew: in 2025 the best crew averaged 2.44 s
 * stationary, the slowest 3.05 s, and a wheel-gun failure costs 6-7 s
 * (docs/paddock-research.md §1).
 */

import { rng } from './rng';

export type StaffRole = 'mechanic' | 'strategist' | 'pitCrew';

export const staffRoles: { key: StaffRole; label: string; description: string; glyph: string }[] = [
  { key: 'mechanic', label: 'Baş Mekanik', description: 'Her yükseltmeden daha fazla değer çıkarır, güvenilirliği artırır.', glyph: 'MK' },
  { key: 'strategist', label: 'Stratejist', description: 'Brifing doğruluğu, yağmur tahmini ve yardımcı botun keskinliği.', glyph: 'ST' },
  { key: 'pitCrew', label: 'Pit Şefi', description: 'Pit stop süresini kısaltır, hatalı stop olasılığını düşürür.', glyph: 'PC' },
];

export interface StaffMember {
  id: string;
  name: string;
  role: StaffRole;
  /** 0-100. */
  skill: number;
  /** RP per race. */
  wage: number;
  /** Rounds left on the contract; renewals happen at the market. */
  contractRounds: number;
}

/** The three seats; an empty seat means the role runs on defaults. */
export type StaffRoster = Partial<Record<StaffRole, StaffMember>>;

export interface StaffEffects {
  /** Extra stat points per upgrade, 0-1.5 (fractional carries over). */
  upgradeBonus: number;
  /** Added to factory reliability, 0-0.2. */
  reliabilityBonus: number;
  /** 0-1: share of briefing items that are guaranteed correct. Below it, an item may be wrong. */
  briefAccuracy: number;
  /** ± band shown around the rain forecast, 0.05-0.3. */
  forecastBand: number;
  /** 0-1 multiplier on the assistant bot's error rates (1 = default bot). */
  assistantErrorScale: number;
  /** Seconds taken off every pit stop, 0.2-1.2. */
  pitSecondsSaved: number;
  /** Probability a stop goes wrong (+5 s). */
  pitFailChance: number;
}

/** What an empty seat gives: the effects of a skill-40 head. */
const DEFAULT_SKILL = 40;

const lerp = (skill: number, at40: number, at90: number): number => {
  const t = Math.max(0, Math.min(1, (skill - 40) / 50));
  return at40 + (at90 - at40) * t;
};

export function staffEffects(roster: StaffRoster): StaffEffects {
  const mech = roster.mechanic?.skill ?? DEFAULT_SKILL;
  const strat = roster.strategist?.skill ?? DEFAULT_SKILL;
  const pit = roster.pitCrew?.skill ?? DEFAULT_SKILL;
  return {
    upgradeBonus: lerp(mech, 0, 1.5),
    reliabilityBonus: lerp(mech, 0, 0.2),
    briefAccuracy: lerp(strat, 0.7, 1.0),
    forecastBand: lerp(strat, 0.3, 0.05),
    assistantErrorScale: lerp(strat, 1.0, 0.4),
    pitSecondsSaved: lerp(pit, 0.2, 1.2),
    pitFailChance: lerp(pit, 0.08, 0.01),
  };
}

/**
 * Yarış başına maaş.
 *
 * Yetenek 90 bir bölüm başkanı 119 RP alır: orta sıra takımın yarış gelirinin
 * (~1.100 RP) yaklaşık %11'i. Üç koltuğu birden elit doldurmak geliri araç
 * geliştirmesine yetmeyecek kadar yer — tasarımın istediği acı verici tercih
 * budur (spec §7).
 */
export const wageFor = (skill: number): number => Math.round(25 + ((skill - 30) / 70) * 110);

/** Signing fee: two races of wages. */
export const hiringFee = (member: StaffMember): number => member.wage * 2;

const FIRST = ['Deniz', 'Elif', 'Marco', 'Sofia', 'Hiro', 'Amara', 'Lukas', 'Nadia', 'Tomás', 'Ingrid', 'Kaan', 'Yara', 'Pieter', 'Zeynep', 'Rafael', 'Mei'];
const LAST = ['Aksoy', 'Bianchi', 'Okafor', 'Lindgren', 'Sato', 'Duarte', 'Novak', 'Haddad', 'Kowalski', 'Öztürk', 'Moreau', 'Ferreira', 'Nakamura', 'Costa', 'Weber', 'Demir'];

/**
 * This round's candidates: six heads across the three roles, seeded by the
 * round so the list is stable and cannot be re-rolled by navigating away.
 */
export function staffMarket(round: number, season: number): StaffMember[] {
  const random = rng(season * 7919 + round * 104729 + 17);
  const roles: StaffRole[] = ['mechanic', 'mechanic', 'strategist', 'strategist', 'pitCrew', 'pitCrew'];
  return roles.map((role, i) => {
    const skill = Math.round(35 + random() * 55);
    return {
      id: `${season}-${round}-${role}-${i}`,
      name: `${FIRST[Math.floor(random() * FIRST.length)]} ${LAST[Math.floor(random() * LAST.length)]}`,
      role,
      skill,
      wage: wageFor(skill),
      contractRounds: 6 + Math.floor(random() * 10),
    };
  });
}

/** The roster the mid-season save starts with: a modest mechanic, nobody else. */
export const startingRoster: StaffRoster = {
  mechanic: { id: 'seed-mech', name: 'Cem Yalçın', role: 'mechanic', skill: 52, wage: wageFor(52), contractRounds: 8 },
};
