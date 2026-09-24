/**
 * The server's own copy of "what does this team's offer sheet look like
 * right now" — the piece that makes signing trustworthy.
 *
 * `generateOffers` (shared/src/sponsors.ts) is a PURE function: it seeds its
 * randomness from `round * 7919 + position * 104729` and otherwise only
 * reads its arguments, so the same (round, position, baseStrength, running,
 * takenSlots, totalRounds) always produces the exact same offer sheet. That
 * determinism is the whole point — it means the server never has to store
 * an offer to be able to check one later. Given a lobby and a team, this
 * module rebuilds the inputs the same way the mobile client's `offers()`
 * selector does (see `mobile/src/store/gameStore.ts`), so its output is
 * always the CURRENT, canonical sheet for that team.
 *
 * Every caller that needs to verify an offer (the sign route) MUST go
 * through this function rather than trust anything the client sent — see
 * `sponsorRoutes.ts` for where that boundary is enforced.
 */
import { teamByKey, positionOf } from '@pitwall/shared/teams';
import { SEASON_ROUNDS } from '@pitwall/shared/season';
import { generateOffers, type SponsorOffer, type SlotKey } from '@pitwall/shared/sponsors';
import { loadLobby } from '../lobby/lobbyRepo.ts';
import { standingsBeforeRound } from '../lobby/runner.ts';
import { loadTeamSponsorships } from './sponsorshipRepo.ts';

export class SponsorOffersError extends Error {
  reason: 'no_lobby';
  constructor(reason: 'no_lobby') {
    super(`sponsorOffersFor: ${reason}`);
    this.reason = reason;
  }
}

/**
 * This weekend's offer sheet for one team, rebuilt from the lobby's own
 * round/season and championship table — never from anything a client sent.
 *
 * `client` is accepted so a caller that already holds a transaction's
 * connection can pass it through to `loadTeamSponsorships`, for the same
 * reason `loadLobbyEconomy` does (see that module's docblock): a bare-pool
 * read while holding a checked-out connection can deadlock a full pool.
 */
export async function offerSheetFor(
  lobbyId: string, teamKey: string, client?: import('pg').PoolClient,
): Promise<{ offers: SponsorOffer[]; running: import('@pitwall/shared/sponsors').Sponsorship[]; round: number }> {
  const lobby = await loadLobby(lobbyId);
  if (!lobby) throw new SponsorOffersError('no_lobby');

  // Standings (and therefore championship position) are, like a race
  // itself, DERIVED from the recipe rather than stored — see
  // `standingsBeforeRound`'s own docblock in runner.ts.
  const standings = await standingsBeforeRound(lobbyId, lobby.seasonNo, lobby.roundNo);
  const position = positionOf(standings, teamKey);
  const baseStrength = teamByKey(teamKey).baseStrength;

  const running = await loadTeamSponsorships(lobbyId, teamKey, client);
  const takenSlots: SlotKey[] = running.map((s) => s.slot);

  const offers = generateOffers({
    round: lobby.roundNo,
    running,
    position,
    baseStrength,
    takenSlots,
    totalRounds: SEASON_ROUNDS,
  });

  return { offers, running, round: lobby.roundNo };
}
