/**
 * What a screen showing the constructors' table (`LeagueScreen.tsx`) should
 * show, derived from the server-backed `standingsApi` slice
 * (`standingsApiSlice.ts`) rather than `gameStore.ts`'s local `standings`.
 *
 * Follows the exact shape `settlementDisplay.ts`'s `displaySettlement`,
 * `factoryDisplay.ts`'s `displayFactory` and `raceSlice.ts`'s `displayRace`
 * already established: a plain function over data, no rendering, so it
 * runs under `tsx --test` (the `.tsx` screen imports React Native and
 * cannot).
 *
 * ── NO LOCAL FALLBACK ─────────────────────────────────────────────────────
 * Exactly like `displaySettlement`/`displayFactory`/`displaySponsors`: with
 * no lobby this NEVER reaches for the local `standings` still on
 * `GameState` — the frozen table `seedStandings` produced once and that
 * nothing advances any more now that the local settlement is gone
 * (`823ddd4`). Showing that beside a real server answer is not a graceful
 * degradation; it is the exact second-reality bug this migration exists to
 * delete. `{ kind: 'no-lobby' }` carries no `standings` field at all, so
 * there is nothing for a screen to render by accident.
 *
 * ── THREE ANSWERS, TOLD APART ON PURPOSE ──────────────────────────────────
 *  - `'no-lobby'` — not seated anywhere; there is no server table to have.
 *  - `'loading'`  — seated, but no answer has come back yet (or the answer
 *                   in the slice is for a different lobby than the one
 *                   asked about).
 *  - `'ready'`    — the table, exactly as the server returned it. Unlike a
 *                   settlement, a table has no "not yet" state worth
 *                   naming: even before a single race the server answers
 *                   with every team on zero points (`freshStandings()`),
 *                   which is `'ready'`, not `'none'`.
 */
import type { TeamStanding } from '@pitwall/shared/teams';
import type { StandingsApiSliceState } from './standingsApiSlice';

export type StandingsDisplay =
  | { kind: 'no-lobby' }
  | { kind: 'loading' }
  | { kind: 'ready'; standings: TeamStanding[] };

/**
 * `lobbyId` is the app's own "are we seated in a lobby" signal — the same
 * one `displayRace`/`displayFactory`/`displaySponsors`/`displaySettlement`
 * key off (`race.lobbyId`), not `standingsApi.lobbyId` (which only appears
 * after the first successful read, so it would report `no-lobby` for a
 * beat after joining even though the player is already seated).
 */
export function displayStandings(
  lobbyId: string | undefined,
  standingsApi: Pick<StandingsApiSliceState, 'table' | 'lobbyId'>,
): StandingsDisplay {
  if (!lobbyId) return { kind: 'no-lobby' };

  const { table, lobbyId: answeredFor } = standingsApi;
  if (table === undefined || answeredFor !== lobbyId) return { kind: 'loading' };

  return { kind: 'ready', standings: table };
}
