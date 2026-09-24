/**
 * The server-backed sponsor slice.
 *
 * Talks to the server's sponsor endpoints (`../../lib/api/sponsors.ts`,
 * `server/src/economy/sponsorRoutes.ts`) and follows the exact shape
 * `raceSlice.ts` and `economyApiSlice.ts` already established: an
 * `ApiResult`-returning API client, `Bearer` auth via a `session()` read of
 * `auth`, distinct server error codes preserved rather than flattened, and
 * standalone testability (`SponsorsApiSliceDeps`/`SponsorsApiSliceInjected`
 * below) so this slice's own tests don't need to pull in the whole
 * `GameState`.
 *
 * ── WHY THIS LIVES UNDER ONE `sponsorsApi` KEY ────────────────────────────
 * Same collision `economyApiSlice.ts` hit and solved the same way (see that
 * module's doc comment): `offers`, `signSponsor` and `releaseSponsor`
 * already exist on `GameState` today (`gameStore.ts`'s local, synchronous,
 * no-`lobbyId` versions). Spreading this slice's actions flat onto
 * `GameState` would silently shadow — or be shadowed by — those, with no
 * compile error to catch it. Everything this slice contributes therefore
 * lives inside a single `sponsorsApi` object.
 *
 * ── NO LOCAL FALLBACK, NO LOCAL COMPUTATION ───────────────────────────────
 * Offers are read from the server (`hydrateOffers`) and never regenerated
 * on the device — see `lib/api/sponsors.ts`'s module doc comment for why a
 * client-side `generateOffers` call, even though it would produce an
 * identical sheet today, is the second-reality bug this migration removes.
 * Signing and releasing likewise only ever post an identifier
 * (`offerId`/`slot`) and adopt whatever `sponsorships` the server returns —
 * no fee or income is computed here.
 */
import type { ApiResult } from '@/lib/api/identity';
import {
  getSponsorOffers as getSponsorOffersApi,
  signSponsorOffer as signSponsorOfferApi,
  releaseSponsorship as releaseSponsorshipApi,
  type SponsorOffersResponse,
  type SponsorActionResponse,
} from '@/lib/api/sponsors';
import type { SlotKey } from '@pitwall/shared/sponsors';

export type SponsorsActionOutcome =
  | { ok: true }
  /** `error` is always the server's own code (or the local `not_signed_in`
   * refusal below) — never flattened into one generic failure string.
   * `slot_taken` and `offer_not_found` need different player-facing words
   * (see `lib/api/sponsors.ts`'s doc comment). */
  | { ok: false; error: string };

export interface SponsorsApiSliceState {
  /** The lobby this sheet/table belongs to, or undefined before any call
   * has been made. */
  lobbyId?: string;
  /** The last offer sheet the server returned. `null` before the first
   * successful `hydrateOffers` — never fabricated locally. */
  offers: SponsorOffersResponse['offers'] | null;
  /** The team's signed sponsorships, as last returned by the server (from
   * `hydrateOffers`'s own follow-up, or from `sign`/`release`). `null`
   * before anything has landed. */
  sponsorships: SponsorActionResponse['sponsorships'] | null;
  /** The most recent action's result, kept distinct from the state above so
   * a rejection (e.g. `slot_taken`) can be shown without being swallowed —
   * mirrors `raceSlice.ts`'s `lastPitOutcome`. */
  lastActionOutcome?: SponsorsActionOutcome;
}

export interface SponsorsApiSliceActions {
  /** Reads the current offer sheet from the server (`GET /sponsors/offers`).
   * Refused locally, with nothing sent, when there is no session. */
  hydrateOffers: (lobbyId: string) => Promise<SponsorsActionOutcome>;
  /** Signs one offer by id — only the id ever leaves the device. */
  sign: (lobbyId: string, offerId: string) => Promise<SponsorsActionOutcome>;
  /** Releases the deal holding the given slot. */
  release: (lobbyId: string, slot: SlotKey) => Promise<SponsorsActionOutcome>;
}

export interface SponsorsApiSlice {
  sponsorsApi: SponsorsApiSliceState & SponsorsApiSliceActions;
}

/** Mirrors `RaceSliceDeps`/`EconomyApiSliceDeps`: the one thing this slice
 * reads from the rest of the store. */
export interface SponsorsApiSliceDeps {
  auth: { baseUrl: string; token?: string };
}

/** Injectable collaborators, defaulting to the real clients — mirrors
 * `RaceSliceInjected`/`EconomyApiSliceInjected`. */
export interface SponsorsApiSliceInjected {
  getSponsorOffersApi?: (baseUrl: string, token: string, input: { lobbyId: string }) => Promise<ApiResult<SponsorOffersResponse>>;
  signSponsorOfferApi?: (baseUrl: string, token: string, input: { lobbyId: string; offerId: string }) => Promise<ApiResult<SponsorActionResponse>>;
  releaseSponsorshipApi?: (baseUrl: string, token: string, input: { lobbyId: string; slot: SlotKey }) => Promise<ApiResult<SponsorActionResponse>>;
}

type Set = (partial: Partial<SponsorsApiSlice> | ((state: SponsorsApiSlice) => Partial<SponsorsApiSlice>)) => void;
type Get = () => SponsorsApiSlice & SponsorsApiSliceDeps;

export function createSponsorsApiSlice(
  set: Set,
  get: Get,
  injected: SponsorsApiSliceInjected = {},
): SponsorsApiSlice {
  const getOffers = injected.getSponsorOffersApi ?? getSponsorOffersApi;
  const signOffer = injected.signSponsorOfferApi ?? signSponsorOfferApi;
  const releaseDeal = injected.releaseSponsorshipApi ?? releaseSponsorshipApi;

  /** Mirrors `raceSlice.ts`/`economyApiSlice.ts`'s own `session()` helper. */
  const session = (): { baseUrl: string; token: string } | undefined => {
    const { baseUrl, token } = get().auth;
    return token ? { baseUrl, token } : undefined;
  };

  const fail = (error: string): SponsorsActionOutcome => {
    const outcome: SponsorsActionOutcome = { ok: false, error };
    set((s) => ({ sponsorsApi: { ...s.sponsorsApi, lastActionOutcome: outcome } }));
    return outcome;
  };

  const ok = (): SponsorsActionOutcome => {
    const outcome: SponsorsActionOutcome = { ok: true };
    return outcome;
  };

  return {
    sponsorsApi: {
      offers: null,
      sponsorships: null,

      hydrateOffers: async (lobbyId) => {
        const auth = session();
        if (!auth) return fail('not_signed_in');
        const res = await getOffers(auth.baseUrl, auth.token, { lobbyId });
        if (!res.ok) return fail(res.error);
        const outcome = ok();
        set((s) => ({ sponsorsApi: { ...s.sponsorsApi, lobbyId, offers: res.data.offers, lastActionOutcome: outcome } }));
        return outcome;
      },

      sign: async (lobbyId, offerId) => {
        const auth = session();
        if (!auth) return fail('not_signed_in');
        const res = await signOffer(auth.baseUrl, auth.token, { lobbyId, offerId });
        if (!res.ok) return fail(res.error);
        const outcome = ok();
        set((s) => ({ sponsorsApi: { ...s.sponsorsApi, lobbyId, sponsorships: res.data.sponsorships, lastActionOutcome: outcome } }));
        return outcome;
      },

      release: async (lobbyId, slot) => {
        const auth = session();
        if (!auth) return fail('not_signed_in');
        const res = await releaseDeal(auth.baseUrl, auth.token, { lobbyId, slot });
        if (!res.ok) return fail(res.error);
        const outcome = ok();
        set((s) => ({ sponsorsApi: { ...s.sponsorsApi, lobbyId, sponsorships: res.data.sponsorships, lastActionOutcome: outcome } }));
        return outcome;
      },
    },
  };
}
