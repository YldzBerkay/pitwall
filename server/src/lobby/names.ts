/**
 * Lobby names (§3.1): a name from the region's pool plus a rising number —
 * `Anadolu #14`, `Nordschleife #3`.
 *
 * The player never types a lobby name. That is a moderation decision, not a
 * UX shortcut: free-text names in a matchmade, public pool would need review,
 * reporting and a block list before they could ship.
 *
 * Every name is a place the region actually races at or is named for, so the
 * card reads like a venue rather than an id.
 */
import type { Region } from '../identity/region.ts';

export const LOBBY_NAME_POOL: Record<Region, readonly string[]> = {
  EU:    ['Nordschleife', 'Anadolu', 'Monza', 'Spa', 'Silverstone', 'Zandvoort', 'Hungaroring', 'Estoril'],
  NA:    ['Laguna', 'Watkins', 'Sebring', 'Road America', 'Mosport', 'Indianapolis'],
  LATAM: ['Interlagos', 'Hermanos', 'Termas', 'Potrero', 'Curitiba'],
  MENA:  ['Yas', 'Sakhir', 'Jeddah', 'Losail', 'Kyalami'],
  APAC:  ['Suzuka', 'Fuji', 'Shanghai', 'Inje', 'Okayama'],
  SEA:   ['Sepang', 'Marina Bay', 'Chang', 'Clark', 'Sentul'],
  OCE:   ['Bathurst', 'Albert Park', 'Phillip Island', 'Hampton Downs', 'Adelaide'],
};

/** A random name base for a region — the caller pairs it with a free number. */
export function pickNameBase(region: Region, random: () => number = Math.random): string {
  const pool = LOBBY_NAME_POOL[region];
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

export function formatLobbyName(base: string, seq: number): string {
  return `${base} #${seq}`;
}
