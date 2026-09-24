/**
 * What a screen showing "what did my last race pay?" should show
 * (`SponsorScreen.tsx`'s settlement line, `RaceResultSheet.tsx`'s Kazanç
 * card), derived from the server-backed `settlementApi` slice
 * (`settlementApiSlice.ts`) rather than `gameStore.ts`'s local
 * `lastSettlement`.
 *
 * Follows the exact shape `factoryDisplay.ts`'s `displayFactory`,
 * `sponsorsDisplay.ts`'s `displaySponsors` and `raceSlice.ts`'s
 * `displayRace`/`displayQualifying` already established: a plain function
 * over data, no rendering, so it runs under `tsx --test` (the `.tsx`
 * screens import React Native and cannot).
 *
 * ── NO LOCAL FALLBACK ─────────────────────────────────────────────────────
 * Exactly like `displayFactory`/`displaySponsors`: with no lobby this NEVER
 * reaches for the local settlement still on `GameState`
 * (`gameStore.ts`'s `lastSettlement`, computed by the local
 * `settleRaceWeekend`). While a lobby seat exists the server has ALREADY
 * paid this player — a different amount, from a different race — so
 * showing the local figure beside it is not a graceful degradation, it is
 * the player being told the wrong number about their own money.
 * `{ kind: 'no-lobby' }` is a distinct shape from `{ kind: 'ready', ... }`
 * for that reason, and carries no numeric field at all: there is nothing
 * for a screen to render by accident.
 *
 * ── FOUR ANSWERS, TOLD APART ON PURPOSE ───────────────────────────────────
 *  - `'no-lobby'`   — not seated anywhere; there is no server settlement to
 *                     have.
 *  - `'loading'`    — seated, but no answer has come back yet.
 *  - `'none'`       — the server answered, and this round has not been paid
 *                     out (not run, or still running). A real answer, not a
 *                     failure: `settle.ts` pays on its own clock, so "not
 *                     yet" is the normal state of the current round.
 *  - `'ready'`      — the breakdown, field for field as the server sent it.
 *
 * ── THE ONE PIECE OF ARITHMETIC, AND WHY IT IS NOT A RE-DERIVATION ────────
 * `total` is `prize + sponsorIncome + briefBonus`. `settle.ts` accumulates
 * all three into the single `rp` it credits, in one loop, with no separate
 * recomputation — so `rp === prize + sponsorIncome + briefBonus` is an
 * invariant of the server's own code, stated in that module's doc comment.
 * Adding the server's three numbers is arithmetic ON its answer; deriving
 * any one of them from a formula would be a second answer, and is exactly
 * what this module refuses to do (see `lib/api/settlement.ts`).
 */
import type { SettlementBreakdown } from '@/lib/api/settlement';
import type { SettlementApiSliceState } from './settlementApiSlice';

export type SettlementDisplay =
  | { kind: 'no-lobby' }
  | { kind: 'loading' }
  | { kind: 'none' }
  | ({ kind: 'ready'; total: number } & SettlementBreakdown);

/**
 * `lobbyId` is the app's own "are we seated in a lobby" signal — the same
 * one `displayRace`/`displayFactory`/`displaySponsors` key off
 * (`race.lobbyId`), not `settlementApi.lobbyId` (which only appears after
 * the first successful read, so it would report `no-lobby` for a beat after
 * joining even though the player is already seated).
 *
 * `forRound`, when given, is the round the screen is asking about: an answer
 * held for a DIFFERENT round is `loading`, not `ready`. Without that check a
 * screen switching rounds would show the previous round's money under the
 * new round's heading for as long as the new read took.
 */
export function displaySettlement(
  lobbyId: string | undefined,
  settlementApi: Pick<SettlementApiSliceState, 'breakdown' | 'round'>,
  forRound?: number,
): SettlementDisplay {
  if (!lobbyId) return { kind: 'no-lobby' };

  const { breakdown, round } = settlementApi;
  if (breakdown === undefined) return { kind: 'loading' };
  if (forRound !== undefined && round !== forRound) return { kind: 'loading' };
  if (breakdown === null) return { kind: 'none' };

  return {
    kind: 'ready',
    ...breakdown,
    total: breakdown.prize + breakdown.sponsorIncome + breakdown.briefBonus,
  };
}

/**
 * Which round's settlement "what did my last race pay?" actually means.
 *
 * The server's lobby phase already answers this exactly, and it is the only
 * thing that can: the client has no round counter of its own any more that
 * the server would agree with. `lobbies.round_no` points at the round the
 * lobby is CURRENTLY on, and rollover (`server/src/lobby/rollover.ts`)
 * advances it only when the lobby leaves `'result'` — so:
 *
 *  - `'live'`     — this round is running and by definition unsettled
 *                   (`settle.ts` refuses a race that has not reached the
 *                   flag). The last paid race is the one before it.
 *  - `'result'`   — this round has just been settled, in the same commit
 *                   that set the phase (`runner.ts`'s `flag()`). It IS the
 *                   answer.
 *  - `'open'` /
 *    `'checkin'`  — the round has not been run yet; rollover already moved
 *                   the counter on. The last paid race is the one before.
 *  - `'finished'` — the season is over; the final round is the last paid.
 *
 * `undefined` when that lands before round 1 — a lobby whose first race has
 * not happened has no settlement to show, and asking for round 0 would be a
 * 400 rather than an empty answer.
 */
export function settlementRoundFor(
  lobby: { phase: 'open' | 'checkin' | 'live' | 'result' | 'finished'; roundNo: number } | undefined,
): number | undefined {
  if (!lobby) return undefined;
  const settled = lobby.phase === 'result' || lobby.phase === 'finished' ? lobby.roundNo : lobby.roundNo - 1;
  return settled >= 1 ? settled : undefined;
}
