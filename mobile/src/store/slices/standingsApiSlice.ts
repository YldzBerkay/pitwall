/**
 * The server-backed championship-table slice: holds whatever
 * `GET /lobby/standings` last answered, and nothing else.
 *
 * Follows the shape `settlementApiSlice.ts`, `economyApiSlice.ts` and
 * `sponsorsApiSlice.ts` already established: an `ApiResult`-returning API
 * client, `Bearer` auth via a `session()` read of `auth`, distinct server
 * error codes preserved rather than flattened, and standalone testability
 * (`StandingsApiSliceDeps`/`StandingsApiSliceInjected` below) so this
 * slice's tests don't need the whole `GameState`.
 *
 * ── WHY ITS OWN `standingsApi` KEY ─────────────────────────────────────────
 * Same reason `settlementApiSlice.ts` keeps `settlementApi` separate from
 * `GameState`'s local `lastSettlement`: `standings` already exists on
 * `GameState` (`gameStore.ts`'s local `TeamStanding[]`, seeded once and
 * never advanced now that the local settlement is gone). Spreading a
 * second `standings` flat would silently shadow one or the other with no
 * compile error — both are plain arrays of the same shape. Keeping this
 * under `standingsApi` also makes the two visibly different things they
 * are, for as long as the frozen seed table still exists on `GameState`.
 *
 * ── NOTHING IS COMPUTED ────────────────────────────────────────────────────
 * `table` is whatever the last successful read returned, verbatim. `undefined`
 * means nothing has been asked for yet — a real "no answer", distinct from an
 * empty table (which never happens: the server always answers with every
 * team, zero points included).
 */
import type { ApiResult } from '@/lib/api/identity';
import { getStandings as getStandingsApi, type StandingsResponse } from '@/lib/api/standings';
import type { TeamStanding } from '@pitwall/shared/teams';

export type StandingsOutcome =
  | { ok: true }
  /** Always the server's own code (`forbidden`, `unauthorized`, ...) or the
   * local `not_signed_in` refusal below — never flattened into one generic
   * failure string. */
  | { ok: false; error: string };

export interface StandingsApiSliceState {
  /** The last table read from the server. `undefined` means nothing has
   * been asked for yet. */
  table?: TeamStanding[];
  /** The lobby the current `table` answers for — lets a screen tell a
   * fresh answer for the lobby it is looking at from a leftover one for a
   * previous lobby. */
  lobbyId?: string;
  lastOutcome?: StandingsOutcome;
}

export interface StandingsApiSliceActions {
  /**
   * Reads the lobby's current championship table (`GET /lobby/standings`).
   * Read-only: the server never writes anything to answer this (see
   * `server/src/lobby/routes.ts`'s own doc comment). Refused locally, with
   * nothing sent, when there is no session.
   */
  hydrate: (lobbyId: string) => Promise<StandingsOutcome>;
}

export interface StandingsApiSlice {
  standingsApi: StandingsApiSliceState & StandingsApiSliceActions;
}

/** Mirrors `SettlementApiSliceDeps`/`EconomyApiSliceDeps`: the one thing
 * this slice reads from the rest of the store. */
export interface StandingsApiSliceDeps {
  auth: { baseUrl: string; token?: string };
}

/** Injectable collaborator, defaulting to the real client — mirrors
 * `SettlementApiSliceInjected`/`SponsorsApiSliceInjected`. */
export interface StandingsApiSliceInjected {
  getStandingsApi?: (
    baseUrl: string,
    token: string,
    input: { lobbyId: string },
  ) => Promise<ApiResult<StandingsResponse>>;
}

type Set = (
  partial: Partial<StandingsApiSlice> | ((state: StandingsApiSlice) => Partial<StandingsApiSlice>),
) => void;
type Get = () => StandingsApiSlice & StandingsApiSliceDeps;

export function createStandingsApiSlice(
  set: Set,
  get: Get,
  injected: StandingsApiSliceInjected = {},
): StandingsApiSlice {
  const read = injected.getStandingsApi ?? getStandingsApi;

  /** Mirrors `settlementApiSlice.ts`'s own `session()` helper. */
  const session = (): { baseUrl: string; token: string } | undefined => {
    const { baseUrl, token } = get().auth;
    return token ? { baseUrl, token } : undefined;
  };

  const fail = (error: string): StandingsOutcome => {
    const outcome: StandingsOutcome = { ok: false, error };
    set((s) => ({ standingsApi: { ...s.standingsApi, lastOutcome: outcome } }));
    return outcome;
  };

  return {
    standingsApi: {
      hydrate: async (lobbyId) => {
        const auth = session();
        if (!auth) return fail('not_signed_in');

        const res = await read(auth.baseUrl, auth.token, { lobbyId });
        if (!res.ok) return fail(res.error);

        const outcome: StandingsOutcome = { ok: true };
        set((s) => ({
          standingsApi: {
            ...s.standingsApi,
            lobbyId,
            table: res.data.standings,
            lastOutcome: outcome,
          },
        }));
        return outcome;
      },
    },
  };
}
