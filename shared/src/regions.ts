/**
 * Mirrors `server/src/identity/region.ts` — a region is a matchmaking + race
 * hour bucket, not an identity. Labels come from the server's
 * `/onboarding/bootstrap` response (`BootstrapResponse.regions`), not from
 * here, so they stay a single source of truth.
 */
export const REGIONS = ['EU', 'NA', 'LATAM', 'MENA', 'APAC', 'SEA', 'OCE'] as const;
export type Region = (typeof REGIONS)[number];
