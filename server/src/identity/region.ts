/**
 * Region buckets. Spec §2.4.
 *
 * A region is a matchmaking + race-hour bucket, NOT an identity. The player's
 * country is separate and purely cosmetic.
 */
export const REGIONS = ['EU', 'NA', 'LATAM', 'MENA', 'APAC', 'SEA', 'OCE'] as const;
export type Region = (typeof REGIONS)[number];

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value);
}

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
