/**
 * Client for the server's race endpoints
 * (`server/src/lobby/checkin.ts`, `server/src/lobby/weekendChoices.ts`).
 * Same base URL and session token as the identity/lobby clients — one
 * process serves all of it (`server/src/index.ts`).
 *
 * THE TEAM KEY IS NEVER SENT. The server reads it from the caller's own
 * `lobby_seats` row (`findOwnTeamKey` in both server files); a `teamKey` in
 * the body would be ignored there and would wrongly suggest from the client
 * side that a player can act for a team they don't hold. None of the
 * functions below accept one.
 *
 * `compound` is UPPERCASE (`CompoundKey` from `@pitwall/shared/carCustomisation`:
 * `SOFT | MEDIUM | HARD | INTERMEDIATE | WET`). The server's check constraint
 * rejects anything else with a 500-turning error if it ever got that far —
 * `checkin.ts`'s `isCompound` catches it earlier as a 400. This client does
 * not re-validate; it only carries the value through.
 */
import { compounds, type CompoundKey } from '@pitwall/shared/carCustomisation';
import type { TacticPreset, QualiRisk } from '@pitwall/shared/raceEngine';
import { request, type ApiResult } from './identity';

const jsonAuth = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

const post = <T>(baseUrl: string, token: string, path: string, body: unknown): Promise<ApiResult<T>> =>
  request<T>(baseUrl, path, { method: 'POST', headers: jsonAuth(token), body: JSON.stringify(body) });

export interface RaceActionResponse {
  ok: true;
  teamKey: string;
}

/**
 * "Kendi yarışımı süreceğim." — only accepted during the `checkin` phase
 * (`registerCheckinRoutes` in `checkin.ts`). Server errors: `forbidden` (no
 * seat in this lobby), `wrong_phase` (not currently `checkin`).
 */
export function checkin(baseUrl: string, token: string, lobbyId: string): Promise<ApiResult<RaceActionResponse>> {
  return post(baseUrl, token, '/race/checkin', { lobbyId });
}

export interface WeekendChoicesInput {
  lobbyId: string;
  compound?: CompoundKey;
  bias?: number;
  tactics?: TacticPreset;
  qualiRisk?: QualiRisk;
}

/**
 * "Bu hafta sonu böyle yarışacağım." Every field but `lobbyId` is optional —
 * an omitted field is left untouched server-side (`coalesce`). Accepted in
 * the `open` and `checkin` phases; rejected with `wrong_phase` from `live`
 * on, because the frozen race recipe already copied whatever was last saved
 * and further edits would have no effect on it.
 */
export function weekendChoices(
  baseUrl: string,
  token: string,
  input: WeekendChoicesInput,
): Promise<ApiResult<RaceActionResponse>> {
  return post(baseUrl, token, '/race/weekend-choices', input);
}

export interface PitInput {
  lobbyId: string;
  driverIdx: 0 | 1;
  compound: CompoundKey;
  /**
   * Omit to let the server pick the next lap the decision can still land on
   * (`targetLap` default in `checkin.ts`). Left out of the request body
   * entirely when omitted here — never sent as `undefined`/`null` — because
   * pit-call cancellation isn't supported: the decision log is append-only
   * and immutable, and `compound: null` is deliberately treated as a client
   * error, not a withdrawal.
   */
  lap?: number;
}

export interface PitResponse {
  ok: true;
  teamKey: string;
  driverIdx: 0 | 1;
  compound: CompoundKey;
  lap: number;
}

/**
 * Live pit call — one line appended to the immutable decision log. Only
 * accepted during `live`. Distinct server error codes the caller must
 * surface separately, never flattened into one generic failure:
 *  - `race_not_started`: phase is `live` but the run recipe hasn't been
 *    written yet.
 *  - `race_finished`: the run already has a `finishedAt`.
 *  - `not_checked_in`: the engine only reads decisions from a
 *    `managed: 'human'` seat; this team isn't one.
 *  - `already_decided`: the immutable log already holds the first, and
 *    only valid, decision for this lap.
 *  - `lap_already_run`: the target lap has already passed the race clock.
 */
export function pit(baseUrl: string, token: string, input: PitInput): Promise<ApiResult<PitResponse>> {
  const body: Record<string, unknown> = {
    lobbyId: input.lobbyId,
    driverIdx: input.driverIdx,
    compound: input.compound,
  };
  if (input.lap !== undefined) {
    body['lap'] = input.lap;
  }
  return post(baseUrl, token, '/race/pit', body);
}

/** Re-exported so callers can validate a compound client-side before sending it. */
export const compoundKeys: CompoundKey[] = compounds.map((c) => c.key);
