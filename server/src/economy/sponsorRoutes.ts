/**
 * HTTP front for the sponsor system: read a team's current offer sheet,
 * sign one of its offers, release a signed deal.
 *
 *   GET  /sponsors/offers?lobbyId=   this weekend's offer sheet (read-only)
 *   POST /sponsors/sign              {lobbyId, offerId}
 *   POST /sponsors/release           {lobbyId, slot}
 *
 * ── THE TRUST BOUNDARY THIS FILE EXISTS TO ENFORCE ─────────────────────────
 * `generateOffers` (shared/src/sponsors.ts) is a PURE function: it seeds its
 * randomness from `round * 7919 + position * 104729` and reads nothing but
 * its own arguments, so the same (round, position, baseStrength, running
 * deals, taken slots, totalRounds) always produces the exact same offer
 * sheet. That determinism is what makes signing SAFE to implement at all —
 * `offerSheetFor` (sponsorOffers.ts) regenerates the sheet from the lobby's
 * own state, and `sign` below looks the client's `offerId` up in THAT
 * regenerated sheet. Every field written to `sponsorships` — `per_race`,
 * `bonus`, `target_position`, `streak_target`, the signing bonus paid out —
 * comes from the matched offer the SERVER built, never from the request
 * body. A `perRace`/`bonus`/`signing` sent by the client is read nowhere in
 * this file. A later "simplify the payload, just post the terms" change
 * would look like a harmless refactor and would in fact let any client
 * write itself an arbitrary income — that is the exact regression this
 * comment, and `sponsor-routes.test.ts`'s "ignores client-supplied terms"
 * and "an offer not on the table cannot be signed" tests, exist to catch.
 *
 * ── OTHER HOUSE RULES THIS FOLLOWS ──────────────────────────────────────
 * The team acted on comes from the caller's OWN `lobby_seats` row for this
 * lobby — never from the request body or query string (same as
 * `economy/routes.ts`). No session → 401; no seat in this lobby → 403.
 * `already on your table but the slot just got taken by someone faster` and
 * `that offer id doesn't exist on your table at all` are kept as two
 * DISTINCT failure codes (`slot_taken` vs `offer_not_found`) rather than
 * collapsed into one generic rejection — they are different bugs on the
 * client's side and different attacks from a hostile one.
 *
 * The actual race-safety for "two concurrent signs land on the same slot"
 * is `sponsorships_pk` (lobby_id, team_key, slot) — see 007_sponsorships.sql
 * — not the pre-check this route also does for a fast, friendly error. The
 * pre-check narrows the window; the constraint is what makes it impossible.
 */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { verifySession } from '../auth/jwt.ts';
import { query, withTransaction } from '../db/pool.ts';
import { offerSheetFor, SponsorOffersError } from './sponsorOffers.ts';
import { insertSponsorship, deleteDeal, loadTeamSponsorships } from './sponsorshipRepo.ts';
import { addRp, chargeRpFloor } from './repo.ts';
import type { SlotKey } from '@pitwall/shared/sponsors';
import { sponsorSlots } from '@pitwall/shared/sponsors';

interface SeatRow {
  team_key: string;
}

/** The player's own seat for this lobby — the ONLY source of `teamKey`. */
async function findOwnTeamKey(lobbyId: string, userId: string): Promise<string | null> {
  const res = await query<SeatRow>(
    `select team_key from lobby_seats where lobby_id = $1 and user_id = $2`,
    [lobbyId, userId],
  );
  return res.rows[0]?.team_key ?? null;
}

function unauthorized(): RouteResult {
  return { status: 401, body: { error: 'unauthorized' } };
}

function forbidden(): RouteResult {
  return { status: 403, body: { error: 'forbidden' } };
}

function badRequest(): RouteResult {
  return { status: 400, body: { error: 'invalid_request' } };
}

const VALID_SLOTS = new Set<SlotKey>(sponsorSlots.map((s) => s.key));

const SLOT_TAKEN_CONSTRAINT = 'sponsorships_pk';
function isSlotTakenConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: string }).code === '23505'
    && (err as { constraint?: string }).constraint === SLOT_TAKEN_CONSTRAINT;
}

export function registerSponsorRoutes(router: Router): void {
  router.get('/sponsors/offers', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.url.searchParams.get('lobbyId');
    if (!lobbyId) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    try {
      // Read-only: nothing here writes. `offerSheetFor` rebuilds the sheet
      // fresh from the lobby's own round/standings every call — see its
      // docblock — so calling this twice is guaranteed to answer twice with
      // the same sheet, and to change nothing in between.
      const { offers } = await offerSheetFor(lobbyId, teamKey);
      return { status: 200, body: { offers } };
    } catch (err) {
      if (err instanceof SponsorOffersError) return { status: 404, body: { error: err.reason } };
      throw err;
    }
  });

  router.post('/sponsors/sign', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.body['lobbyId'];
    if (typeof lobbyId !== 'string' || lobbyId.length === 0) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    const offerId = ctx.body['offerId'];
    if (typeof offerId !== 'string' || offerId.length === 0) return badRequest();

    // ── THE CHECK THAT MATTERS ─────────────────────────────────────────
    // The client names WHICH offer it wants signed by id; everything about
    // what that offer actually pays is read from the SERVER's own
    // regenerated sheet below, never from `ctx.body`. See the module
    // docblock. Fields like `ctx.body['perRace']` or `ctx.body['bonus']`
    // are deliberately never read anywhere in this handler.
    let sheet;
    try {
      sheet = await offerSheetFor(lobbyId, teamKey);
    } catch (err) {
      if (err instanceof SponsorOffersError) return { status: 404, body: { error: err.reason } };
      throw err;
    }
    const offer = sheet.offers.find((o) => o.id === offerId);
    if (!offer) return { status: 404, body: { error: 'offer_not_found' } };

    // A renewal replaces the contract it renews, so its own slots are not a
    // clash against the CURRENT holdings — everything else on the team's
    // table is (a package is all-or-nothing). Mirrors the client's
    // `signSponsor` in mobile/src/store/gameStore.ts.
    const kept = offer.renewalOf
      ? sheet.running.filter((s) => s.dealId !== offer.renewalOf)
      : sheet.running;
    if (offer.slots.some((slot) => kept.some((s) => s.slot === slot))) {
      return { status: 409, body: { error: 'slot_taken' } };
    }

    const dealId = `${sheet.round}-${offer.brandKey}-${offer.slots.join('+')}`;
    // The result bonus belongs to the CONTRACT, so it's split across the
    // positions rather than paid once per panel (same remainder-on-first-
    // slot rule the client uses, so a three-slot deal doesn't pay it thrice).
    const evenShare = Math.round(offer.bonus / offer.slots.length);
    const shares = offer.slots.map((_, i) =>
      evenShare + (i === 0 ? offer.bonus - evenShare * offer.slots.length : 0));

    class SlotTaken extends Error {}
    try {
      await withTransaction(async (client) => {
        if (offer.renewalOf) {
          await deleteDeal(client, lobbyId, teamKey, offer.renewalOf);
        }
        for (let i = 0; i < offer.slots.length; i += 1) {
          try {
            await insertSponsorship(client, lobbyId, teamKey, {
              dealId,
              brandKey: offer.brandKey,
              slot: offer.slots[i],
              perRace: offer.perSlot[i],
              targetPosition: offer.targetPosition,
              bonus: shares[i],
              signedRound: sheet.round,
              expiresRound: sheet.round + offer.rounds,
              streakTarget: offer.streakTarget,
              streak: 0,
            });
          } catch (err) {
            if (isSlotTakenConflict(err)) throw new SlotTaken();
            throw err;
          }
        }
        // The signing bonus lands immediately — that's the pull of a long
        // deal (mirrors the client's `rp: state.rp + offer.signing`).
        if (offer.signing > 0) await addRp(client, lobbyId, teamKey, offer.signing);
      });
    } catch (err) {
      if (err instanceof SlotTaken) return { status: 409, body: { error: 'slot_taken' } };
      throw err;
    }

    const sponsorships = await loadTeamSponsorships(lobbyId, teamKey);
    return { status: 200, body: { sponsorships } };
  });

  router.post('/sponsors/release', async (ctx: RequestContext): Promise<RouteResult> => {
    const userId = await verifySession(ctx.bearer);
    if (!userId) return unauthorized();

    const lobbyId = ctx.body['lobbyId'];
    if (typeof lobbyId !== 'string' || lobbyId.length === 0) return badRequest();

    const teamKey = await findOwnTeamKey(lobbyId, userId);
    if (!teamKey) return forbidden();

    const slot = ctx.body['slot'];
    if (typeof slot !== 'string' || !VALID_SLOTS.has(slot as SlotKey)) return badRequest();

    const running = await loadTeamSponsorships(lobbyId, teamKey);
    const deal = running.find((s) => s.slot === slot);
    if (!deal) return { status: 404, body: { error: 'not_signed' } };

    // Releasing gives back the WHOLE contract, and the break fee is charged
    // on the deal's full value — a brand that insisted on three positions
    // does not stay on two of them. Mirrors the client's `releaseSponsor`.
    let lobby;
    try {
      lobby = await offerSheetFor(lobbyId, teamKey);
    } catch (err) {
      if (err instanceof SponsorOffersError) return { status: 404, body: { error: err.reason } };
      throw err;
    }
    const inDeal = running.filter((s) => s.dealId === deal.dealId);
    const roundsLeft = Math.max(0, deal.expiresRound - lobby.round);
    const value = inDeal.reduce((sum, s) => sum + s.perRace, 0);
    const penalty = Math.round(value * roundsLeft * 0.35);

    await withTransaction(async (client) => {
      await deleteDeal(client, lobbyId, teamKey, deal.dealId);
      if (penalty > 0) await chargeRpFloor(client, lobbyId, teamKey, penalty);
    });

    const sponsorships = await loadTeamSponsorships(lobbyId, teamKey);
    return { status: 200, body: { sponsorships } };
  });
}
