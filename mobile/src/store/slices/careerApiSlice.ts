/**
 * The server-backed career slice: holds the `Career` `GET /economy/career`
 * returned, and nothing else.
 *
 * Follows the shape `settlementApiSlice.ts`/`standingsApiSlice.ts` already
 * established: an `ApiResult`-returning API client, `Bearer` auth via a
 * `session()` read of `auth`, distinct server error codes preserved rather
 * than flattened, and standalone testability (`CareerApiSliceDeps`/
 * `CareerApiSliceInjected` below) so this slice's tests don't need the whole
 * `GameState`.
 *
 * ── WHY ITS OWN `careerApi` KEY ────────────────────────────────────────────
 * Same reason `settlementApi`/`standingsApi` each keep one namespace:
 * `career` already exists on `GameState` (`gameStore.ts`'s local `Career`,
 * still folded a little by the pre-season test programme). Spreading a
 * second `career` flat would silently shadow one or the other with no
 * compile error — both are plain data. Keeping this under `careerApi` also
 * makes the two visibly different things they are, for as long as both
 * exist.
 *
 * ── NO LOBBY TO HYDRATE FOR ────────────────────────────────────────────────
 * Unlike every other slice in this directory, `hydrate` takes no arguments:
 * a career belongs to the signed-in user, not a lobby (see `lib/api/career.ts`).
 */
import type { ApiResult } from '@/lib/api/identity';
import { getCareer as getCareerApi, type CareerResponse } from '@/lib/api/career';
import type { Career } from '@pitwall/shared/achievements';

export type CareerOutcome =
  | { ok: true }
  /** Always the server's own code, or the local `not_signed_in` refusal
   * below — never flattened into one generic failure string. */
  | { ok: false; error: string };

export interface CareerApiSliceState {
  /** The last career read from the server. `undefined` means nothing has
   * been asked for yet. */
  career?: Career;
  lastOutcome?: CareerOutcome;
}

export interface CareerApiSliceActions {
  /** Reads the signed-in user's career (`GET /economy/career`). Read-only.
   * Refused locally, with nothing sent, when there is no session. */
  hydrate: () => Promise<CareerOutcome>;
}

export interface CareerApiSlice {
  careerApi: CareerApiSliceState & CareerApiSliceActions;
}

/** Mirrors `SettlementApiSliceDeps`/`StandingsApiSliceDeps`: the one thing
 * this slice reads from the rest of the store. */
export interface CareerApiSliceDeps {
  auth: { baseUrl: string; token?: string };
}

/** Injectable collaborator, defaulting to the real client — mirrors
 * `SettlementApiSliceInjected`/`StandingsApiSliceInjected`. */
export interface CareerApiSliceInjected {
  getCareerApi?: (baseUrl: string, token: string) => Promise<ApiResult<CareerResponse>>;
}

type Set = (
  partial: Partial<CareerApiSlice> | ((state: CareerApiSlice) => Partial<CareerApiSlice>),
) => void;
type Get = () => CareerApiSlice & CareerApiSliceDeps;

export function createCareerApiSlice(
  set: Set,
  get: Get,
  injected: CareerApiSliceInjected = {},
): CareerApiSlice {
  const read = injected.getCareerApi ?? getCareerApi;

  /** Mirrors `settlementApiSlice.ts`'s own `session()` helper. */
  const session = (): { baseUrl: string; token: string } | undefined => {
    const { baseUrl, token } = get().auth;
    return token ? { baseUrl, token } : undefined;
  };

  const fail = (error: string): CareerOutcome => {
    const outcome: CareerOutcome = { ok: false, error };
    set((s) => ({ careerApi: { ...s.careerApi, lastOutcome: outcome } }));
    return outcome;
  };

  return {
    careerApi: {
      hydrate: async () => {
        const auth = session();
        if (!auth) return fail('not_signed_in');

        const res = await read(auth.baseUrl, auth.token);
        if (!res.ok) return fail(res.error);

        const outcome: CareerOutcome = { ok: true };
        set((s) => ({
          careerApi: {
            ...s.careerApi,
            career: res.data.career,
            lastOutcome: outcome,
          },
        }));
        return outcome;
      },
    },
  };
}
