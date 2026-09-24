/**
 * Client for the server's sponsor endpoints
 * (`server/src/economy/sponsorRoutes.ts`). Same base URL, `Bearer` auth and
 * `ApiResult` shape as `./race.ts` and `./economy.ts` — one process serves
 * all of it (`server/src/index.ts`).
 *
 *   GET  /sponsors/offers?lobbyId=   this weekend's offer sheet (read-only)
 *   POST /sponsors/sign              {lobbyId, offerId}
 *   POST /sponsors/release           {lobbyId, slot}
 *
 * ── OFFERS ARE READ FROM THE SERVER, NEVER REGENERATED HERE ───────────────
 * `generateOffers` (`@pitwall/shared/sponsors`) is a pure, deterministic
 * function seeded from round/position/etc — which is exactly what makes it
 * SAFE for the server to regenerate and check a signature against
 * (`sponsorRoutes.ts`'s own doc comment). It would be equally safe for this
 * client to compute the same sheet itself, but doing so would recreate the
 * "second reality" bug this migration exists to remove: whatever inputs
 * this device has locally (round, championship position, running deals) can
 * drift from the lobby's own truth (a stale local `championshipPosition`,
 * for instance), and the two sheets would then silently disagree about what
 * the player is looking at. `getSponsorOffers` below always asks the
 * server, so what's shown is byte-for-byte what `sign` will accept.
 *
 * ── TEAM KEY IS NEVER SENT ─────────────────────────────────────────────────
 * Same rule as `race.ts`/`economy.ts`: the server reads it from the
 * caller's own `lobby_seats` row. None of the functions below accept one.
 *
 * ── SIGNING POSTS AN IDENTIFIER, NEVER TERMS ──────────────────────────────
 * `signSponsorOffer` sends only `{lobbyId, offerId}`. The offer's `perRace`,
 * `bonus`, `signing`, etc. are never part of the request body — the server
 * looks the id up in its own regenerated sheet and pays out from THAT copy
 * (`sponsorRoutes.ts`'s module doc comment explains why: a client able to
 * post its own `perRace` could write itself an arbitrary income).
 *
 * ── DISTINCT SERVER ERROR CODES, NEVER FLATTENED ──────────────────────────
 * `slot_taken` ("someone signed that position first") and `offer_not_found`
 * ("that offer isn't on your table any more — the round probably rolled
 * over") are different, real, player-facing situations and must reach the
 * caller as those exact codes, same as every other client in this
 * directory. `no_lobby` is what a 404 from `offerSheetFor` becomes when the
 * given lobby doesn't exist.
 *
 * ── WHAT THE SERVER DOES NOT RETURN ────────────────────────────────────────
 * `POST /sponsors/release`'s handler computes a break fee and charges it,
 * but its response body is `{ sponsorships }` only — the fee itself is
 * never sent back (`sponsorRoutes.ts`, confirmed against
 * `server/test/sponsor-routes.test.ts`, which never asserts on one either).
 * `releaseSponsorship` below is typed to match that real contract: it
 * returns the post-release `sponsorships`, not a fee, because there is no
 * fee field to surface without inventing one.
 */
import type { SponsorOffer, Sponsorship, SlotKey } from '@pitwall/shared/sponsors';
import { request, type ApiResult } from './identity';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonAuth = (token: string) => ({ 'content-type': 'application/json', ...auth(token) });

export interface SponsorOffersResponse {
  offers: SponsorOffer[];
}

/**
 * `GET /sponsors/offers?lobbyId=` — the team's current offer sheet, rebuilt
 * fresh server-side on every call. Read-only: calling this twice changes
 * nothing (`sponsorRoutes.ts`'s own doc comment on the route).
 */
export function getSponsorOffers(
  baseUrl: string,
  token: string,
  input: { lobbyId: string },
): Promise<ApiResult<SponsorOffersResponse>> {
  return request<SponsorOffersResponse>(baseUrl, `/sponsors/offers?lobbyId=${encodeURIComponent(input.lobbyId)}`, {
    method: 'GET',
    headers: auth(token),
  });
}

export interface SponsorActionResponse {
  sponsorships: Sponsorship[];
}

/**
 * Signs one offer by id. Only `{lobbyId, offerId}` ever leaves the device —
 * see the module doc comment for why the offer's terms are never sent.
 */
export function signSponsorOffer(
  baseUrl: string,
  token: string,
  input: { lobbyId: string; offerId: string },
): Promise<ApiResult<SponsorActionResponse>> {
  return request<SponsorActionResponse>(baseUrl, '/sponsors/sign', {
    method: 'POST',
    headers: jsonAuth(token),
    body: JSON.stringify(input),
  });
}

/**
 * Releases the deal holding the given slot. The break fee is computed and
 * charged server-side; the response carries only the resulting
 * `sponsorships`, not the fee itself — see the module doc comment.
 */
export function releaseSponsorship(
  baseUrl: string,
  token: string,
  input: { lobbyId: string; slot: SlotKey },
): Promise<ApiResult<SponsorActionResponse>> {
  return request<SponsorActionResponse>(baseUrl, '/sponsors/release', {
    method: 'POST',
    headers: jsonAuth(token),
    body: JSON.stringify(input),
  });
}
