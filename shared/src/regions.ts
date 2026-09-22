/**
 * A region is a matchmaking + race-hour bucket, not an identity.
 * `server/src/identity/region.ts` imports this list rather than declaring its
 * own; server-only concerns (race-hour timezones, display labels) live there.
 * Labels come from the server's `/onboarding/bootstrap` response
 * (`BootstrapResponse.regions`), not from here, so they stay a single source
 * of truth.
 */
export const REGIONS = ['EU', 'NA', 'LATAM', 'MENA', 'APAC', 'SEA', 'OCE'] as const;
export type Region = (typeof REGIONS)[number];

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value);
}
