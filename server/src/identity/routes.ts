/**
 * Onboarding + profile HTTP endpoints: nickname/region/country suggestions
 * for a fresh signup, and the authenticated "me" profile.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import type { User } from '../auth/userRepo.ts';
import { updateProfile, loadUser } from '../auth/userRepo.ts';
import { verifySession } from '../auth/jwt.ts';
import { suggestBases, randomTag, formatNickname, DEFAULT_TAG_WIDTH } from './nickname.ts';
import { COUNTRIES, isCountryCode } from './countries.ts';
import { REGIONS, REGION_LABEL, REGION_RACE_HOUR, isRegion } from './region.ts';
import { regionForIp } from './ipRegion.ts';
import { clientIpOf } from '../http/clientIp.ts';

const SUGGESTED_NICKNAME_COUNT = 4;

/** The client-facing user shape. Carries no email, no password hash. */
export function publicProfile(user: User): {
  id: string;
  nickname: string;
  nicknameBase: string;
  nicknameTag: string;
  country: string | null;
  region: string | null;
  gold: number;
  rankPoints: number;
  createdAt: string;
} {
  return {
    id: user.id,
    nickname: formatNickname(user.nicknameBase, user.nicknameTag),
    nicknameBase: user.nicknameBase,
    nicknameTag: user.nicknameTag,
    country: user.countryCode,
    region: user.region,
    gold: user.gold,
    rankPoints: user.rankPoints,
    createdAt: user.createdAt.toISOString(),
  };
}

async function requireSession(ctx: RequestContext): Promise<User | null> {
  const userId = await verifySession(ctx.bearer);
  if (!userId) return null;
  return loadUser(userId);
}

function unauthorized(): RouteResult {
  return { status: 401, body: { error: 'unauthorized' } };
}

async function handleBootstrap(ctx: RequestContext): Promise<RouteResult> {
  const suggestedNicknames = suggestBases(SUGGESTED_NICKNAME_COUNT).map((base) => ({
    base,
    tag: randomTag(DEFAULT_TAG_WIDTH),
  }));

  // PRIVACY CONTRACT: the client IP is read only long enough to bucket it
  // into a region suggestion via regionForIp() below. It is never stored,
  // logged, or included in any response — clientIpOf's return value is used
  // for nothing else in this function.
  const ip = clientIpOf(ctx.req.headers as Record<string, string | string[] | undefined>, ctx.req.socket.remoteAddress);
  const suggestedRegion = regionForIp(ip);

  return {
    status: 200,
    body: {
      suggestedNicknames,
      suggestedRegion,
      regions: REGIONS.map((id) => ({
        id,
        label: REGION_LABEL[id],
        timeZone: REGION_RACE_HOUR[id].timeZone,
        hour: REGION_RACE_HOUR[id].hour,
      })),
      countries: COUNTRIES,
    },
  };
}

async function handleGetMe(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();
  return { status: 200, body: publicProfile(user) };
}

async function handlePatchMe(ctx: RequestContext): Promise<RouteResult> {
  const user = await requireSession(ctx);
  if (!user) return unauthorized();

  const { countryCode, region } = ctx.body as { countryCode?: unknown; region?: unknown };

  let countryCodeUpdate: string | undefined;
  if (countryCode !== undefined) {
    if (typeof countryCode !== 'string' || !isCountryCode(countryCode)) {
      return { status: 400, body: { error: 'invalid_country' } };
    }
    countryCodeUpdate = countryCode;
  }

  let regionUpdate: import('./region.ts').Region | undefined;
  if (region !== undefined) {
    if (typeof region !== 'string' || !isRegion(region)) {
      return { status: 400, body: { error: 'invalid_region' } };
    }
    regionUpdate = region;
  }

  const updated = await updateProfile(user.id, {
    countryCode: countryCodeUpdate,
    region: regionUpdate,
  });
  /* c8 ignore next 3 -- the row we just loaded above still exists */
  if (!updated) return unauthorized();

  return { status: 200, body: publicProfile(updated) };
}

export function registerIdentityRoutes(router: Router): void {
  router.get('/onboarding/bootstrap', handleBootstrap);
  router.get('/me', handleGetMe);
  router.patch('/me', handlePatchMe);
}
