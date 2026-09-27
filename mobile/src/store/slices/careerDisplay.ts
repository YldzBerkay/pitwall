/**
 * What the profile screen showing "what is my career?" should show
 * (`ProfileScreen.tsx`), derived from the server-backed `careerApi` slice
 * (`careerApiSlice.ts`) rather than `gameStore.ts`'s local `career`.
 *
 * Follows the exact shape `settlementDisplay.ts`'s `displaySettlement` and
 * `standingsDisplay.ts`'s `displayStandings` already established: a plain
 * function over data, no rendering, so it runs under `tsx --test` (the
 * `.tsx` screens import React Native and cannot).
 *
 * ── NO LOCAL FALLBACK ─────────────────────────────────────────────────────
 * Exactly like `displaySettlement`/`displayStandings`: with no server answer
 * this NEVER reaches for `gameStore.ts`'s local `career` field. That field
 * is not inert — a correct pre-season test programme still adds +5 to its
 * `score` (`gameStore.ts`'s own `career:` assignment) — so a stale local
 * number sitting where the real one belongs is not a graceful degradation,
 * it is the player being shown a plausible-looking WRONG career. This
 * selector's signature enforces the rule structurally: it has no parameter
 * a local career could travel through.
 *
 * ── THE RANK IS `rankFor`'s ANSWER, NEVER A RESTATED THRESHOLD ────────────
 * `ready.rank` is `rankFor(career.score)` (`@pitwall/shared/achievements`),
 * called here and nowhere reimplemented — the ten thresholds live in
 * exactly one place.
 */
import { rankFor, type Career, type Rank } from '@pitwall/shared/achievements';
import type { CareerApiSliceState } from './careerApiSlice';

export type CareerDisplay =
  | { kind: 'not-signed-in' }
  | { kind: 'loading' }
  | { kind: 'ready'; career: Career; rank: Rank };

/**
 * `authUser` is the app's own "is anyone signed in" signal
 * (`gameStore.ts`'s `auth.user`) — a career cannot exist for nobody, so its
 * absence is reported distinctly from "signed in, answer not back yet".
 */
export function displayCareer(
  authUser: { id: string } | undefined,
  careerApi: Pick<CareerApiSliceState, 'career'>,
): CareerDisplay {
  if (!authUser) return { kind: 'not-signed-in' };

  const { career } = careerApi;
  if (career === undefined) return { kind: 'loading' };

  return { kind: 'ready', career, rank: rankFor(career.score) };
}
