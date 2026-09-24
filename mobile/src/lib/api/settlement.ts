/**
 * Client for the server's race-settlement read
 * (`GET /economy/settlement` — `server/src/economy/routes.ts`). Same base
 * URL, `Bearer` auth and `ApiResult` shape as `./economy.ts`, `./race.ts`
 * and `./sponsors.ts`; one process serves all of it
 * (`server/src/index.ts`).
 *
 * ── WHY A READ AT ALL, WHEN THE PAYMENT IS AUTOMATIC ──────────────────────
 * The server settles a race whether or not anybody is watching: it replays
 * the frozen recipe to the flag and credits every seat in one transaction
 * (`server/src/economy/settle.ts`). The RP therefore arrives on its own —
 * but the BREAKDOWN behind it (what was prize, what was sponsor income,
 * what the briefing paid, which targets were hit, which streaks broke,
 * which contracts lapsed) exists nowhere the player can see unless it is
 * asked for. That is what this route is: `race_settlement_payouts`
 * (`server/src/economy/settlementRepo.ts`) written in the SAME transaction
 * as the payment, handed back verbatim.
 *
 * ── NOTHING HERE IS COMPUTED ──────────────────────────────────────────────
 * Not one number below is derived on the device. The client used to work
 * these out itself (`gameStore.ts`'s `settleRaceWeekend`, calling
 * `finishRace`/`settleRace`/`racePrize`/`briefCompliance` from
 * `@pitwall/shared`) — and the moment the server started paying real RP
 * that became a second, unauthoritative answer to "what did I earn?".
 * Unlike a mis-drawn lap, the player ACTS on that number (signs a sponsor,
 * starts an upgrade) before the truth catches up. See
 * `store/slices/settlementDisplay.ts` for the screen-facing half of the
 * same rule.
 *
 * ── THE TEAM KEY IS NEVER SENT ────────────────────────────────────────────
 * Same rule as every other client in this directory: the server reads it
 * from the caller's own `lobby_seats` row (`findOwnTeamKey` in
 * `routes.ts`). A `teamKey` in the query string is read nowhere there, and
 * this function does not accept one.
 *
 * ── AN UNSETTLED ROUND IS NOT AN ERROR ────────────────────────────────────
 * A round that has not been run, or is still running, comes back as
 * `{ settlement: null }` with a 200 — "nothing yet", not a failure. That
 * distinction is preserved all the way to the screen (`displaySettlement`'s
 * `'none'` vs a rejected outcome): "your race hasn't been paid yet" and
 * "we couldn't reach the server" are different sentences.
 */
import { request, type ApiResult } from './identity';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const SETTLEMENT_PATH = '/economy/settlement';

/**
 * One seat's earnings from one race, exactly as the server's
 * `race_settlement_payouts` row carries them. Mirrors the response body of
 * `GET /economy/settlement` field for field — nothing added, nothing
 * renamed.
 */
export interface SettlementBreakdown {
  season: number;
  round: number;
  /** Championship position AFTER this race — the position the prize was read at. */
  position: number;
  /** `racePrize(position, ...)` — the guaranteed floor of a finishing position. */
  prize: number;
  /** Every active sponsorship's contribution for this race (perRace + bonus). */
  sponsorIncome: number;
  /** What briefing compliance paid; zero for a seat that made no weekend choices. */
  briefBonus: number;
  /** Brand keys whose target position was met. */
  bonusesEarned: string[];
  /** Brand keys whose streak was reset by this race. */
  streaksBroken: string[];
  /**
   * Slot keys whose contract lapsed at the end of this round — the very
   * positions settlement freed by deleting the deal. The deletion is
   * permanent and leaves nothing else to ask, so without this field a
   * player would learn a sponsorship had ended only by finding the panel
   * empty (see `server/src/db/migrations/009_settlement_expired_slots.sql`).
   */
  expired: string[];
}

/** `settlement` is `null` for a round that has not been paid out yet. */
export interface SettlementResponse {
  settlement: SettlementBreakdown | null;
}

export interface SettlementInput {
  lobbyId: string;
  round: number;
  /**
   * Optional. Omitted, the server answers for the lobby's CURRENT season —
   * which is what "what did my last race pay?" almost always means. Sent
   * only when a screen is deliberately looking back at an older season, so
   * a stale local season number can never silently redirect the question.
   */
  season?: number;
}

export function getSettlement(
  baseUrl: string,
  token: string,
  input: SettlementInput,
): Promise<ApiResult<SettlementResponse>> {
  const params = new URLSearchParams({ lobbyId: input.lobbyId, round: String(input.round) });
  if (input.season !== undefined) params.set('season', String(input.season));
  return request<SettlementResponse>(baseUrl, `${SETTLEMENT_PATH}?${params.toString()}`, {
    method: 'GET',
    headers: auth(token),
  });
}
