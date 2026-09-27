/**
 * Client for the server's career read (`GET /economy/career` —
 * `server/src/economy/routes.ts`). Same base URL, `Bearer` auth and
 * `ApiResult` shape as `./economy.ts`, `./settlement.ts` and `./standings.ts`;
 * one process serves all of it (`server/src/index.ts`).
 *
 * ── NO LOBBY, ON PURPOSE ───────────────────────────────────────────────────
 * Every other read in this directory names a lobby, because the thing it
 * reads belongs to one (an economy slot, a settlement, a table). A career
 * does not: it belongs to the USER, who may be seated in 3-5 lobbies at
 * once, all folding into the SAME `user_careers` row
 * (`server/src/economy/careerRepo.ts`'s own doc comment). This function
 * therefore takes no `lobbyId` and the route takes no query string at all.
 *
 * ── NOTHING HERE IS COMPUTED ───────────────────────────────────────────────
 * `gameStore.ts` used to hold a local `career: Career` field, folded by the
 * local `settleRaceWeekend`'s call into `scoreWeekend`/`recordWeekend`
 * (`@pitwall/shared/achievements`). That call no longer exists on the
 * device — the server runs it now, in the same transaction as the RP it
 * pays out (`server/src/economy/settle.ts`). This module only asks for the
 * result; see `store/slices/careerDisplay.ts` for the screen-facing half of
 * the same rule.
 */
import { request, type ApiResult } from './identity';
import type { Career } from '@pitwall/shared/achievements';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const CAREER_PATH = '/economy/career';

export interface CareerResponse {
  career: Career;
}

export function getCareer(baseUrl: string, token: string): Promise<ApiResult<CareerResponse>> {
  return request<CareerResponse>(baseUrl, CAREER_PATH, {
    method: 'GET',
    headers: auth(token),
  });
}
