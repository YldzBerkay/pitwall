/**
 * The server-backed race-settlement slice: holds the breakdown
 * `GET /economy/settlement` returned, and nothing else.
 *
 * Follows the shape `raceSlice.ts`, `economyApiSlice.ts` and
 * `sponsorsApiSlice.ts` already established: an `ApiResult`-returning API
 * client, `Bearer` auth via a `session()` read of `auth`, distinct server
 * error codes preserved rather than flattened, and standalone testability
 * (`SettlementApiSliceDeps`/`SettlementApiSliceInjected` below) so this
 * slice's tests don't need the whole `GameState`.
 *
 * ── WHY ITS OWN `settlementApi` KEY ───────────────────────────────────────
 * Same reason `economyApiSlice.ts` and `sponsorsApiSlice.ts` each keep one
 * namespace: `lastSettlement` already exists on `GameState`
 * (`gameStore.ts`'s local `RaceSettlement`, still computed by the local
 * `settleRaceWeekend`). Spreading a second `lastSettlement` flat would
 * silently shadow one or the other with no compile error — both are plain
 * data. Keeping this under `settlementApi` also makes the two visibly
 * different things they are, for as long as both exist.
 *
 * ── NOTHING IS COMPUTED, AND NOTHING IS KEPT WARM ─────────────────────────
 * `breakdown` is whatever the last successful read returned and is never
 * derived, patched or extrapolated. A round with no payment yet stores
 * `null` — a real answer ("not paid yet"), distinct from `undefined`
 * ("never asked"). That distinction is what lets `displaySettlement` tell
 * `'none'` apart from `'loading'` instead of showing the same blank to
 * both.
 */
import type { ApiResult } from '@/lib/api/identity';
import {
  getSettlement as getSettlementApi,
  type SettlementBreakdown,
  type SettlementResponse,
} from '@/lib/api/settlement';

export type SettlementOutcome =
  | { ok: true }
  /** Always the server's own code (`forbidden`, `invalid_request`,
   * `unauthorized`, ...) or the local `not_signed_in` refusal below —
   * never flattened into one generic failure string. */
  | { ok: false; error: string };

export interface SettlementApiSliceState {
  /**
   * The last breakdown read from the server. `undefined` means nothing has
   * been asked for yet; `null` means the server was asked and answered
   * "this round has not been paid out" — see the module doc comment.
   */
  breakdown?: SettlementBreakdown | null;
  /** The round the current `breakdown` answers for. Kept so a screen can
   * tell "the answer for the round I'm looking at" from a leftover answer
   * for a previous one. */
  round?: number;
  lobbyId?: string;
  lastOutcome?: SettlementOutcome;
}

export interface SettlementApiSliceActions {
  /**
   * Reads one round's breakdown (`GET /economy/settlement`). Read-only:
   * this never settles anything — the server settles on its own clock
   * whether or not the app is open (`server/src/economy/settle.ts`).
   * Refused locally, with nothing sent, when there is no session.
   */
  hydrate: (lobbyId: string, round: number, season?: number) => Promise<SettlementOutcome>;
}

export interface SettlementApiSlice {
  settlementApi: SettlementApiSliceState & SettlementApiSliceActions;
}

/** Mirrors `RaceSliceDeps`/`EconomyApiSliceDeps`: the one thing this slice
 * reads from the rest of the store. */
export interface SettlementApiSliceDeps {
  auth: { baseUrl: string; token?: string };
}

/** Injectable collaborator, defaulting to the real client — mirrors
 * `RaceSliceInjected`/`SponsorsApiSliceInjected`. */
export interface SettlementApiSliceInjected {
  getSettlementApi?: (
    baseUrl: string,
    token: string,
    input: { lobbyId: string; round: number; season?: number },
  ) => Promise<ApiResult<SettlementResponse>>;
}

type Set = (
  partial: Partial<SettlementApiSlice> | ((state: SettlementApiSlice) => Partial<SettlementApiSlice>),
) => void;
type Get = () => SettlementApiSlice & SettlementApiSliceDeps;

export function createSettlementApiSlice(
  set: Set,
  get: Get,
  injected: SettlementApiSliceInjected = {},
): SettlementApiSlice {
  const read = injected.getSettlementApi ?? getSettlementApi;

  /** Mirrors `raceSlice.ts`'s own `session()` helper. */
  const session = (): { baseUrl: string; token: string } | undefined => {
    const { baseUrl, token } = get().auth;
    return token ? { baseUrl, token } : undefined;
  };

  const fail = (error: string): SettlementOutcome => {
    const outcome: SettlementOutcome = { ok: false, error };
    set((s) => ({ settlementApi: { ...s.settlementApi, lastOutcome: outcome } }));
    return outcome;
  };

  return {
    settlementApi: {
      hydrate: async (lobbyId, round, season) => {
        const auth = session();
        if (!auth) return fail('not_signed_in');

        const input = season === undefined ? { lobbyId, round } : { lobbyId, round, season };
        const res = await read(auth.baseUrl, auth.token, input);
        if (!res.ok) return fail(res.error);

        const outcome: SettlementOutcome = { ok: true };
        set((s) => ({
          settlementApi: {
            ...s.settlementApi,
            lobbyId,
            round,
            // `null` is adopted as-is: "asked, not paid yet" is an answer.
            breakdown: res.data.settlement,
            lastOutcome: outcome,
          },
        }));
        return outcome;
      },
    },
  };
}
