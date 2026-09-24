/**
 * Client for the server's championship-table read
 * (`GET /lobby/standings` — `server/src/lobby/routes.ts`). Same base URL,
 * `Bearer` auth and `ApiResult` shape as `./lobby.ts`, `./economy.ts` and
 * `./settlement.ts`; one process serves all of it (`server/src/index.ts`).
 *
 * ── WHY A READ AT ALL, WHEN A TABLE USED TO LIVE ON THE DEVICE ────────────
 * The local race engine's settlement (`gameStore.ts`'s old
 * `settleRaceWeekend`) was the only thing that ever advanced `standings` —
 * and it is gone (`823ddd4`). The table on the SERVER is not stored either;
 * it is re-derived every time by replaying every round of the season that
 * has actually been run (`server/src/lobby/runner.ts`'s
 * `standingsBeforeRound`, called here for the whole season so this route
 * never has to reason about which round the lobby is currently on). This
 * module's only job is to ask for that answer.
 *
 * ── NOTHING HERE IS COMPUTED ───────────────────────────────────────────────
 * Not one point below is derived on the device — see
 * `store/slices/standingsDisplay.ts`'s doc comment for the screen-facing
 * half of the same rule, and `mobile/test/standings-from-server.test.ts`
 * for the scan that proves it.
 *
 * ── THE TEAM KEY IS NEVER SENT, AND NEITHER IS ONE NEEDED ─────────────────
 * The table belongs to the whole lobby, not to one seat — there is nothing
 * here for a `teamKey` to narrow. The server still requires the caller to
 * hold a seat in the lobby asked about (403 otherwise); it just never
 * returns which one.
 */
import { request, type ApiResult } from './identity';
import type { TeamStanding } from '@pitwall/shared/teams';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const STANDINGS_PATH = '/lobby/standings';

export interface StandingsResponse {
  standings: TeamStanding[];
}

export function getStandings(
  baseUrl: string,
  token: string,
  input: { lobbyId: string },
): Promise<ApiResult<StandingsResponse>> {
  return request<StandingsResponse>(baseUrl, `${STANDINGS_PATH}?id=${encodeURIComponent(input.lobbyId)}`, {
    method: 'GET',
    headers: auth(token),
  });
}
