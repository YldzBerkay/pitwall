/**
 * Region buckets. Spec §2.4.
 *
 * A region is a matchmaking + race-hour bucket, NOT an identity. The player's
 * country is separate and purely cosmetic.
 *
 * The list itself (`REGIONS`/`Region`/`isRegion`) lives in `@pitwall/shared`
 * and is re-exported here so every existing importer of this file keeps
 * working unchanged. What's genuinely server-side — race-hour timezones and
 * Turkish display labels — stays declared in this file.
 */
export { REGIONS, type Region, isRegion } from '@pitwall/shared/regions';
import type { Region } from '@pitwall/shared/regions';

/**
 * The daily race hour for each bucket, as an IANA zone plus a local hour.
 * Evening prime time in the bucket's most populous timezone.
 */
export const REGION_RACE_HOUR: Record<Region, { timeZone: string; hour: number }> = {
  EU:    { timeZone: 'Europe/Berlin',     hour: 21 },
  NA:    { timeZone: 'America/New_York',  hour: 21 },
  LATAM: { timeZone: 'America/Sao_Paulo', hour: 21 },
  MENA:  { timeZone: 'Asia/Dubai',        hour: 21 },
  APAC:  { timeZone: 'Asia/Tokyo',        hour: 21 },
  SEA:   { timeZone: 'Asia/Singapore',    hour: 21 },
  OCE:   { timeZone: 'Australia/Sydney',  hour: 20 },
};

/** Human-readable label for lobby names and the onboarding picker. */
export const REGION_LABEL: Record<Region, string> = {
  EU:    'Avrupa & Afrika',
  NA:    'Kuzey Amerika',
  LATAM: 'Latin Amerika',
  MENA:  'Orta Doğu & Kuzey Afrika',
  APAC:  'Asya-Pasifik',
  SEA:   'Güneydoğu Asya',
  OCE:   'Okyanusya',
};
