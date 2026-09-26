/**
 * Client for the server's economy command endpoint
 * (`server/src/economy/routes.ts`, `server/src/economy/actions.ts`,
 * `server/src/economy/state.ts`). Same base URL, `Bearer` auth and
 * `ApiResult` shape as `./race.ts` and `./identity.ts` — one process serves
 * all of it (`server/src/index.ts`).
 *
 * ONE route, `POST /economy/action`. The router does exact path matching
 * with no path parameters, so `lobbyId` travels in the request BODY
 * alongside `type` and whatever the action needs (`routes.ts`'s own doc
 * comment). Every function below posts to that one path with a different
 * `type`.
 *
 * THE TEAM KEY IS NEVER SENT. The server reads it from the caller's own
 * `lobby_seats` row (`findOwnTeamKey` in `routes.ts`); a `teamKey` in the
 * body would be read nowhere there. None of the functions below accept one.
 *
 * Every response — success or failure — is reported through `ApiResult`
 * (`./identity.ts`). A successful call returns the WHOLE slot state
 * (`SlotState` below, mirroring `server/src/economy/state.ts`'s own
 * `SlotState`) including `serverNow`, never a fragment — see that module's
 * doc comment for why. A failure carries the server's own short `code`
 * (`unknown_action`, `not_enough_rp`, `cap_reached`, ...) UNCHANGED — never
 * flattened into one generic failure string, because "you can't afford
 * this" and "you hit today's cap" need different player-facing words.
 *
 * `serverNow` IS THE POINT: every remaining-time countdown a screen shows
 * must be derived from it (and a job's `endsAt`), never from this device's
 * own clock — see `../../store/slices/economyClock.ts` for the pure
 * functions that do that derivation, and its own doc comment for the
 * anti-cheat story this whole module exists to serve.
 */
import { request, type ApiResult } from './identity';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonAuth = (token: string) => ({ 'content-type': 'application/json', ...auth(token) });

const ECONOMY_ACTION_PATH = '/economy/action';
const ECONOMY_STATE_PATH = '/economy/state';

const post = (baseUrl: string, token: string, body: Record<string, unknown>): Promise<ApiResult<SlotState>> =>
  request<SlotState>(baseUrl, ECONOMY_ACTION_PATH, { method: 'POST', headers: jsonAuth(token), body: JSON.stringify(body) });

/** Mirrors `server/src/economy/state.ts`'s own `SlotStateJob`. */
export interface SlotStateJob {
  jobId: string;
  kind: 'upgrade' | 'training' | 'spy';
  payload: Record<string, unknown>;
  /** ISO instant, computed server-side against the server's own clock. */
  endsAt: string;
  /** Whether the job is claimable right now, per the server's own clock —
   * never recomputed on the device from `endsAt` alone for this flag; use
   * this value as-is to decide whether a claim call can succeed. */
  ready: boolean;
  skipCostGold: number;
}

/** Mirrors `server/src/economy/state.ts`'s own `SlotStateCaps`. */
export interface SlotStateCaps {
  adsLeft: number;
  convertibleLeft: number;
}

/**
 * Mirrors `server/src/economy/state.ts`'s own `SlotStateHide` — garage-hide
 * state exposed as the round it holds through, NEVER a wall-clock time (a
 * hide's expiry is genuinely round-based; see `010_garage_hide.sql`).
 * `null` on `SlotState.hide` means "never hidden", not "hidden until round
 * 0" — the same absence `garage_hides` itself represents.
 */
export interface SlotStateHide {
  hidden: boolean;
  untilRound: number;
}

/**
 * Mirrors `server/src/economy/actions.ts`'s own `SpyClaimResult` — returned
 * ONLY by `claimSpyReport`, alongside the whole `SlotState`, never instead
 * of it. `fine` is the amount the server ACTUALLY charged (`chargeRpFloor`'s
 * own return value), never a client-recomputed nominal figure.
 */
export interface SpyClaimResult {
  outcome: 'success' | 'nothing' | 'badIntel' | 'caught' | 'blocked';
  targetTeam: string;
  stat: string;
  fine?: number;
}

/**
 * Mirrors `server/src/economy/state.ts`'s own `SlotState` — the WHOLE state
 * of a team's economy slot, returned in full by every action call below.
 * `serverNow` is the server's own clock reading at the moment this snapshot
 * was built, sampled independently of anything the client sent — see that
 * module's doc comment.
 */
export interface SlotState {
  serverNow: string;
  lobbyId: string;
  teamKey: string;
  rp: number;
  gold: number;
  car: { motor: number; aero: number; grip: number };
  factory: Record<string, number>;
  upgradesDone: Record<string, number>;
  jobs: SlotStateJob[];
  teamValue: number;
  caps: SlotStateCaps;
  hide: SlotStateHide | null;
  /** ISO instant, or `undefined` if no spy mission has ever been claimed —
   * derive the remaining cooldown from this against the slice's own
   * monotonic anchor (`economyClock.ts`), never `Date.now()`. */
  spyCooldownUntil?: string;
  /** Present ONLY on a `claimSpyReport` response — see `SpyClaimResult`. */
  spyResult?: SpyClaimResult;
  /**
   * Mirrors `server/src/economy/state.ts`'s own `spyBoosts` — pending
   * espionage multipliers (server's lowercase stat key -> multiplier)
   * awaiting that stat's NEXT upgrade claim, e.g. `{ motor: 1.5 }` after a
   * successful mission or `{ aero: 0.5 }` after bad intel. A stat absent
   * here has nothing pending. Optional (rather than always-present) so an
   * older cached response or a hand-built test fixture that predates this
   * field still type-checks; `factoryDisplay.ts` treats a missing key and a
   * missing object the same way — nothing to flag. This is the server's own
   * figure, never recomputed on the device.
   */
  spyBoosts?: Record<string, number>;
}

/**
 * Starts a car-stat upgrade job. The server's field for the targeted stat
 * is called `label` (`actions.ts`'s `startUpgrade` case) — `jobs.ts`
 * validates the actual value and turns an unknown one into `bad_payload`.
 */
export function startUpgrade(
  baseUrl: string,
  token: string,
  input: { lobbyId: string; label: string },
): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'startUpgrade', lobbyId: input.lobbyId, label: input.label });
}

export function startTraining(
  baseUrl: string,
  token: string,
  input: { lobbyId: string; driverIdx: number },
): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'startTraining', lobbyId: input.lobbyId, driverIdx: input.driverIdx });
}

/**
 * Starts a spy mission. Whatever extra fields the caller passes beyond
 * `lobbyId` become the job payload as-is (`actions.ts`'s `startSpyMission`
 * case stores everything but the routing fields verbatim).
 */
export function startSpyMission(
  baseUrl: string,
  token: string,
  input: { lobbyId: string } & Record<string, unknown>,
): Promise<ApiResult<SlotState>> {
  const { lobbyId, ...rest } = input;
  return post(baseUrl, token, { type: 'startSpyMission', lobbyId, ...rest });
}

export function claimUpgrade(baseUrl: string, token: string, input: { lobbyId: string; jobId: string }): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'claimUpgrade', lobbyId: input.lobbyId, jobId: input.jobId });
}

export function claimTraining(baseUrl: string, token: string, input: { lobbyId: string; jobId: string }): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'claimTraining', lobbyId: input.lobbyId, jobId: input.jobId });
}

export function claimSpyReport(baseUrl: string, token: string, input: { lobbyId: string; jobId: string }): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'claimSpyReport', lobbyId: input.lobbyId, jobId: input.jobId });
}

export function skipUpgrade(baseUrl: string, token: string, input: { lobbyId: string; jobId: string }): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'skipUpgrade', lobbyId: input.lobbyId, jobId: input.jobId });
}

export function skipTraining(baseUrl: string, token: string, input: { lobbyId: string; jobId: string }): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'skipTraining', lobbyId: input.lobbyId, jobId: input.jobId });
}

export function skipSpy(baseUrl: string, token: string, input: { lobbyId: string; jobId: string }): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'skipSpy', lobbyId: input.lobbyId, jobId: input.jobId });
}

/**
 * Hides the garage for `days` (1, 3 or 7) — `actions.ts`'s `hideGarage` case.
 * The real price for each duration (RP for 1 day, gold for 3/7) is decided
 * and charged entirely server-side (`shared/src/economy.ts`'s
 * `rpPrices`/`goldPrices`, mirrored nowhere on this client); this function
 * only names which duration was bought.
 */
export function hideGarage(baseUrl: string, token: string, input: { lobbyId: string; days: 1 | 3 | 7 }): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'hideGarage', lobbyId: input.lobbyId, days: input.days });
}

/** `code` is a factory department code (`@pitwall/shared/factory`'s `factoryDepartments`). */
export function upgradeFactory(baseUrl: string, token: string, input: { lobbyId: string; code: string }): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'upgradeFactory', lobbyId: input.lobbyId, code: input.code });
}

export function convertGoldToRp(baseUrl: string, token: string, input: { lobbyId: string; gold: number }): Promise<ApiResult<SlotState>> {
  return post(baseUrl, token, { type: 'convertGoldToRp', lobbyId: input.lobbyId, gold: input.gold });
}

/**
 * `GET /economy/state?lobbyId=` — the read-only counterpart to every action
 * above (`server/src/economy/routes.ts`'s own doc comment). Returns the
 * WHOLE `SlotState`, `serverNow` included, exactly like a mutating call —
 * this is how a screen opened cold learns the player's state without
 * having to fire a mutation just to read one back. Mutates nothing on the
 * server: proven by that route calling neither `runAction` nor any
 * mutating repo function.
 */
export function getEconomyState(baseUrl: string, token: string, input: { lobbyId: string }): Promise<ApiResult<SlotState>> {
  return request<SlotState>(baseUrl, `${ECONOMY_STATE_PATH}?lobbyId=${encodeURIComponent(input.lobbyId)}`, {
    method: 'GET',
    headers: auth(token),
  });
}
