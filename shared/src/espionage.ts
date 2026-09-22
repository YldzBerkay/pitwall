/**
 * Intelligence: spying on a rival's car, and hiding your own.
 *
 * A mission targets one team and one stat. It resolves a day (a round) later
 * and can succeed, fail quietly, bring back bad intelligence, or get the
 * agent caught. Success gives the NEXT upgrade of that stat a ×1.5 multiplier
 * — the owner's number — but only if the target is genuinely stronger there;
 * there is nothing to learn from a slower car. Bad intelligence halves the
 * next upgrade instead. Being caught costs money and hands the target a free
 * boost, the way the 2007 affair cost a real team its constructors' title.
 *
 * The premium agent (gold) cannot be caught and almost never brings bad
 * intelligence. Hiding the garage blocks every attempt against you for its
 * duration. All chances are seeded on round + target so a result cannot be
 * re-rolled. Constants in docs/paddock-research.md §2.3.
 */

import { rng } from './rng';
import type { StatKey } from './driverMarket';

export type AgentKind = 'free' | 'premium';

export interface AgentProfile {
  success: number;
  caught: number;
  badIntel: number;
}

export const agentProfiles: Record<AgentKind, AgentProfile> = {
  free: { success: 0.55, caught: 0.12, badIntel: 0.15 },
  premium: { success: 0.85, caught: 0, badIntel: 0.02 },
};

/**
 * İstihbarat gerçek zamanlı çalışır — üçüncü tezgah (spec §5A).
 *
 * Bu grup, araç ve sürücüyü bağlayan 22 saatlik tavanın DIŞINDADIR ve
 * kasıtlı olarak öyle. O tavan, yarışa çıkmayı engelleyen işler için var:
 * tezgahta parça varsa araç sökük yarışır, antrenmandaki sürücü koltuğa
 * oturamaz. Casus görevi ise yarışa hiç dokunmaz — yalnızca bir sonraki
 * geliştirmeye çarpan verir. Bekletmesinin bir bedeli olmadığı için daha
 * uzun sürebilir ve seyrek kalması (48 sa bekleme) dengeyi korur.
 *
 * Eskiden round cinsindendi, yani takvime bağlıydı; artık saate bağlı.
 * Bekleme, eski "3 raunda bir" seyrekliğini takvimden bağımsız korur.
 * Sonuç tohumu hâlâ `startedRound` üzerinden üretilir: oyuncu cihaz saatini
 * ileri alarak sonucu çeviremez, yalnızca bekleme süresini kısaltabilir.
 */
export const SPY_RESOLVE_MS = 24 * 60 * 60 * 1000;
/** Biten görevden sonra bu kadar süre yeni görev açılmaz. */
export const SPY_COOLDOWN_MS = 48 * 60 * 60 * 1000;
/** Multiplier on the next upgrade of the spied stat. */
export const SPY_BOOST = 1.5;
/** Multiplier when the intelligence was wrong. */
export const BAD_INTEL_FACTOR = 0.5;
/** Fine when caught: share of RP, with a floor. */
export const CAUGHT_FINE_SHARE = 0.15;
export const CAUGHT_FINE_MIN = 40;

export type MissionOutcome = 'success' | 'nothing' | 'badIntel' | 'caught' | 'blocked';

export interface SpyMission {
  id: string;
  targetTeam: string;
  stat: StatKey;
  agent: AgentKind;
  /** Tohum bunun üzerinden üretilir — saat değiştirerek sonuç çevrilemesin. */
  startedRound: number;
  /** Görevin başladığı an. */
  startedAt: number;
  /** Raporun düşeceği an. */
  endsAt: number;
  outcome?: MissionOutcome;
}

export interface GarageHide {
  /** Hidden through this round inclusive. */
  untilRound: number;
}

/** Decide a mission's fate. Deterministic for the same mission. */
export function resolveMission(mission: SpyMission, targetHidden: boolean, targetStronger: boolean): MissionOutcome {
  if (targetHidden) return 'blocked';
  const random = rng(mission.startedRound * 6113 + mission.targetTeam.length * 977 + (mission.agent === 'premium' ? 31 : 7));
  const p = agentProfiles[mission.agent];
  const roll = random();
  if (roll < p.caught) return 'caught';
  if (roll < p.caught + p.badIntel) return 'badIntel';
  if (roll < p.caught + p.badIntel + p.success) return targetStronger ? 'success' : 'nothing';
  return 'nothing';
}

export const outcomeText: Record<MissionOutcome, string> = {
  success: 'Başarılı: bir sonraki geliştirme ×1.5.',
  nothing: 'Ajan bir şey getiremedi.',
  badIntel: 'Yanlış istihbarat: bir sonraki geliştirme yarım güçte.',
  caught: 'Ajan yakalandı: ceza kesildi, hedef takım kazandı.',
  blocked: 'Hedef garajını gizlemiş; girişim boşa çıktı.',
};

/**
 * Rival intelligence against the player. Only the front of the table gets
 * spied on; a hidden garage blocks it. Returns the team that succeeded, if any.
 */
export function rivalAttempt(round: number, season: number, playerPosition: number, hidden: boolean, rivals: string[]): { team: string; success: boolean } | undefined {
  if (playerPosition > 4 || rivals.length === 0) return undefined;
  const random = rng(season * 3331 + round * 8887 + 5);
  if (random() >= 0.2) return undefined;
  const team = rivals[Math.floor(random() * rivals.length)];
  if (hidden) return { team, success: false };
  return { team, success: random() < 0.55 };
}

/** How much a successful rival mission adds to that AI team's strength, permanently. */
export const RIVAL_GAIN = 0.4;
