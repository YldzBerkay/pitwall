/**
 * What the sponsor screen (`SponsorScreen.tsx`) should show, derived from
 * the server-backed `sponsorsApi` slice (`sponsorsApiSlice.ts`) rather than
 * `gameStore.ts`'s local `offers()`/`sponsorships`/`signSponsor`/
 * `releaseSponsor`.
 *
 * Follows the exact shape `factoryDisplay.ts`'s `displayFactory` and
 * `raceSlice.ts`'s `displayRace`/`displayQualifying` already established: a
 * plain function over data, no rendering, so it can run under `tsx --test`
 * (`SponsorScreen.tsx` itself imports React Native and cannot).
 *
 * NO LOCAL FALLBACK: exactly like `displayFactory`, once there is no
 * lobby, this never reaches for the local sponsorship numbers still on
 * `GameState` (`gameStore.ts`'s `sponsorships`/`offers()`/`signSponsor`/
 * `releaseSponsor`). A lobby-less player seeing local sponsorship figures
 * next to a lobby-seated player seeing the server's figures is the exact
 * second-reality bug this migration phase exists to close - see this
 * task's brief and `factoryDisplay.ts`'s own doc comment on the same
 * point. `{ kind: 'no-lobby' }` is a distinct shape from `{ kind: 'ready',
 * ... }` for that reason: a screen must be able to say "you're not in a
 * lobby" rather than silently render *something*.
 *
 * A REAL GAP: `GET /sponsors/offers` does not return `sponsorships`.
 * `offerSheetFor` (`server/src/economy/sponsorOffers.ts`) computes the
 * team's currently-signed `running` deals internally (it needs them to
 * know which slots are taken), but the route
 * (`server/src/economy/sponsorRoutes.ts`'s `GET /sponsors/offers` handler)
 * only ever returns `{ offers }` - `running` is discarded, never sent to
 * the client. There is no other endpoint that reads a team's current
 * sponsorships; `sign` and `release` each return the post-action
 * `sponsorships` as a side effect of mutating, but nothing returns them on
 * a plain read. That means, on a fresh load, this module genuinely cannot
 * know what's currently signed until the player signs or releases
 * something in this session - `sponsorships` below stays `null` in that
 * window rather than being guessed at (e.g. from stale local state, which
 * would be exactly the fabrication this migration exists to remove). This
 * is reported in this task's write-up as a server gap, not solved by
 * inventing a client-side substitute.
 */
import type { SponsorsApiSliceState } from './sponsorsApiSlice';

export type SponsorsDisplay =
  | { kind: 'no-lobby' }
  /** In a lobby, but no `hydrateOffers` response has landed yet. */
  | { kind: 'loading' }
  | {
      kind: 'ready';
      offers: NonNullable<SponsorsApiSliceState['offers']>;
      /** `null` until a `sign`/`release` response has landed this session -
       * see the module doc comment on the server gap this reflects. */
      sponsorships: SponsorsApiSliceState['sponsorships'];
    };

/**
 * `lobbyId` is the app's own "are we seated in a lobby" signal - the same
 * one `raceSlice.ts`'s `displayRace`/`displayQualifying` and
 * `factoryDisplay.ts`'s `displayFactory` key off (`race.lobbyId`), not
 * `sponsorsApi.lobbyId` (which only appears after the first successful
 * call, so it would show `no-lobby` for a beat after joining even though
 * the player is already seated).
 */
export function displaySponsors(
  lobbyId: string | undefined,
  sponsorsApi: Pick<SponsorsApiSliceState, 'offers' | 'sponsorships'>,
): SponsorsDisplay {
  if (!lobbyId) return { kind: 'no-lobby' };

  const { offers, sponsorships } = sponsorsApi;
  if (offers === null) return { kind: 'loading' };

  return { kind: 'ready', offers, sponsorships };
}
