import type { CompoundKey } from '@pitwall/shared/carCustomisation';
import type { QualifyingResult } from '@pitwall/shared/raceEngine';
import type { ApiResult } from '@/lib/api/identity';
import {
  checkin as checkinApi,
  pit as pitApi,
  weekendChoices as weekendChoicesApi,
  type PitInput,
  type PitResponse,
  type RaceActionResponse,
  type WeekendChoicesInput,
} from '@/lib/api/race';
import {
  createRaceSocket,
  type ConnectionStatus,
  type RaceSocket,
  type RaceSocketDeps,
  type RaceSocketOptions,
  type SerialisedRace,
} from '@/lib/api/raceSocket';
import type { SliceGet, SliceSet } from './types';

/**
 * The slice that sits between the server's race clients
 * (`lib/api/race.ts`, `lib/api/raceSocket.ts`) and the screens. Wired into
 * `gameStore.ts`/`GameState` via `...createRaceSlice(set, get)`, the same
 * pattern `lobbySlice.ts` uses.
 *
 * ── NO LOCAL FALLBACK, NO QUEUE ───────────────────────────────────────────
 * Mirrors the two load-bearing decisions already made in `raceSocket.ts`:
 * there is no client-side race simulation to fall back to when disconnected
 * (the socket module itself enforces that by freezing `race.data` and never
 * fabricating laps), and a pit call made while `race.status !== 'connected'`
 * is refused immediately rather than held for later delivery. Queuing it
 * would be actively wrong: by the time a queued call reached the server the
 * lap it targeted would already have run, the server would reject it with
 * `lap_already_run`, and the player would have believed — for however long
 * the call sat queued — that their pit call had landed. Refusing up front is
 * the only outcome that doesn't lie to the player, and `callPit` below
 * contains no queue, timer, or retry of any kind for the disconnected case.
 */

export type PitOutcome =
  | { ok: true; driverIdx: 0 | 1; compound: CompoundKey; lap: number }
  /** `error` is always the server's own code (or the local `disconnected`
   * refusal below) — never flattened into one generic failure string, since
   * `lap_already_run` and `not_checked_in` etc. need different
   * player-facing words (see `lib/api/race.ts`'s `pit()` doc comment). */
  | { ok: false; error: string };

/**
 * Outcome of `setWeekendChoices`/`checkinRace`. Same shape and same rule as
 * `PitOutcome`: `error` is always the server's own code (`wrong_phase`,
 * `forbidden`, ...) or the local `not_signed_in` refusal below — never
 * flattened into one generic failure string. A `wrong_phase` rejection means
 * the rule worked (lights are already out), not that something went wrong;
 * screens must say that, not "something went wrong".
 */
export type WeekendChoiceOutcome = { ok: true } | { ok: false; error: string };

export interface RaceSliceState {
  /**
   * `'signed-out'` is distinct from `'session-invalid'` (from
   * `raceSocket.ts`'s `ConnectionStatus`): the latter means a token was sent
   * and the server rejected it (expired/bad — "your session died"), the
   * former means there was never a token to send ("you aren't signed in").
   * Those need different player-facing words, so `connectRace` never opens a
   * socket with an empty token just to have the server hand back
   * `unauthorized` and land here in `session-invalid`.
   */
  status: ConnectionStatus | 'idle' | 'signed-out';
  /** The lobby currently subscribed to, or undefined before `connectRace`
   * / after `leaveRace`. */
  lobbyId?: string;
  /** The last full race image the server sent. Preserved across a
   * disconnect (mirrors `raceSocket.ts`'s own `race` field) — the screen
   * freezes on the last real lap rather than going blank. */
  data: SerialisedRace | null;
  /** The server's real qualifying result — mirrors `raceSocket.ts`'s own
   * `qualifying` field 1:1, including its "never on a lap frame, never
   * cleared by one, never fabricated locally" rules. See `displayQualifying`
   * below for how a screen is meant to read this. */
  qualifying?: QualifyingResult;
  /** The most recent pit call's result, kept distinct from `data` so a
   * rejection (e.g. `lap_already_run`) can be shown to the player without
   * being swallowed into the race state. */
  lastPitOutcome?: PitOutcome;
  /** The most recent weekend-choices (or check-in) result — see
   * `WeekendChoiceOutcome`. Kept distinct from `data` for the same reason
   * as `lastPitOutcome`. */
  lastWeekendChoiceOutcome?: WeekendChoiceOutcome;
}

export interface RaceSlice {
  race: RaceSliceState;
  /** Subscribes to the given lobby's live room. Tears down any previous
   * subscription first. */
  connectRace: (lobbyId: string) => void;
  /** Unsubscribes and closes the socket. Does not clear `data` — same
   * "never fabricate, never blank" rule the socket module itself follows. */
  leaveRace: () => void;
  /**
   * A live pit call. Refused locally, with no request ever leaving the
   * device, unless `race.status === 'connected'` — see the module doc
   * comment above for why this is not queued for delivery once reconnected.
   */
  callPit: (driverIdx: 0 | 1, compound: CompoundKey, lap?: number) => Promise<PitOutcome>;
  /**
   * "Bu hafta sonu böyle yarışacağım." Sends whichever of setup bias,
   * (qualifying-and-start) compound, qualifying risk and pit-wall tactics
   * changed — `lobbyId` apart, every field is optional; an omitted one is
   * left untouched server-side. The team key is never part of this call:
   * the server derives it from the session's own seat.
   *
   * Accepted while the lobby is `open` or `checkin`; rejected with
   * `wrong_phase` once it goes `live`, because the frozen race recipe
   * already copied whatever was last saved. That rejection is the rule
   * working, not a failure — screens must say so, not "something went
   * wrong". Refused locally with `not_signed_in`, no request sent, when
   * there is no session.
   */
  setWeekendChoices: (
    lobbyId: string,
    choices: Omit<WeekendChoicesInput, 'lobbyId'>,
  ) => Promise<WeekendChoiceOutcome>;
  /** "Kendi yarışımı süreceğim." — see `lib/api/race.ts`'s `checkin()` doc
   * comment for its own `forbidden`/`wrong_phase` errors. */
  checkinRace: (lobbyId: string) => Promise<WeekendChoiceOutcome>;
}

/**
 * The one thing this slice reads from the rest of the store —
 * `auth.baseUrl` / `auth.token`, the same shape `authSlice.ts` exposes as
 * `AuthSlice['auth']`. Kept exported as its own minimal type so this
 * slice's tests can build a standalone `zustand` store (`RaceSlice &
 * RaceSliceDeps`) without pulling in the whole of `GameState`; the real
 * `createRaceSlice` below is typed against the real `SliceCreator`/
 * `GameState` (see `./types.ts`), same as every other slice in this
 * directory.
 */
export interface RaceSliceDeps {
  auth: { baseUrl: string; token?: string };
}

/** Injectable collaborators, defaulting to the real clients. Tests supply
 * fakes here instead of driving a real `WebSocket`/`http` server, since
 * `raceSocket.ts` and `race.ts` each already have their own dedicated tests
 * proving the wire-level behaviour — this slice's tests are about its own
 * logic (frame -> store state, and the refuse-not-queue rule). */
export interface RaceSliceInjected {
  createSocket?: (options: RaceSocketOptions, deps?: RaceSocketDeps) => RaceSocket;
  pitApi?: (baseUrl: string, token: string, input: PitInput) => Promise<ApiResult<PitResponse>>;
  weekendChoicesApi?: (
    baseUrl: string,
    token: string,
    input: WeekendChoicesInput,
  ) => Promise<ApiResult<RaceActionResponse>>;
  checkinApi?: (baseUrl: string, token: string, lobbyId: string) => Promise<ApiResult<RaceActionResponse>>;
  socketDeps?: RaceSocketDeps;
}

/** `http(s)://host` -> `ws(s)://host/race/live`. */
function liveSocketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/race/live`;
}

/**
 * Typed against the real `SliceSet`/`SliceGet` (i.e. the whole `GameState`),
 * the same as every other slice in this directory — `injected` is the one
 * addition beyond the shared `SliceCreator<T>` shape, and is only ever
 * supplied by tests; `gameStore.ts` calls this with just `(set, get)`.
 */
export function createRaceSlice(set: SliceSet, get: SliceGet, injected: RaceSliceInjected = {}): RaceSlice {
  const createSocket = injected.createSocket ?? createRaceSocket;
  const sendPit = injected.pitApi ?? pitApi;
  const sendWeekendChoices = injected.weekendChoicesApi ?? weekendChoicesApi;
  const sendCheckin = injected.checkinApi ?? checkinApi;

  /** The session every server-bound call here needs; undefined while signed
   * out. Mirrors `lobbySlice.ts`'s own `session()` helper. */
  const session = (): { baseUrl: string; token: string } | undefined => {
    const { baseUrl, token } = get().auth;
    return token ? { baseUrl, token } : undefined;
  };

  let socket: RaceSocket | undefined;
  let unsubscribe: (() => void) | undefined;

  const teardown = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    socket?.close();
    socket = undefined;
  };

  return {
    race: { status: 'idle', data: null },

    connectRace: (lobbyId) => {
      teardown();

      const auth = session();
      if (!auth) {
        // No token to send. Opening a socket anyway would come back
        // `unauthorized` from the server and land in `session-invalid` —
        // the wrong word for "you were never signed in" (see
        // `RaceSliceState.status`'s doc comment).
        set((s) => ({
          race: { ...s.race, status: 'signed-out', lobbyId, data: null, qualifying: undefined, lastPitOutcome: undefined },
        }));
        return;
      }

      set((s) => ({
        race: { ...s.race, status: 'connecting', lobbyId, data: null, qualifying: undefined, lastPitOutcome: undefined },
      }));

      const newSocket = createSocket({ url: liveSocketUrl(auth.baseUrl), lobbyId, token: auth.token }, injected.socketDeps);
      socket = newSocket;

      const adopt = (snapshot: { status: ConnectionStatus; race: SerialisedRace | null; qualifying?: QualifyingResult }) => {
        set((s) => ({ race: { ...s.race, status: snapshot.status, data: snapshot.race, qualifying: snapshot.qualifying } }));
      };

      adopt(newSocket.getState());
      unsubscribe = newSocket.addListener(adopt);
    },

    leaveRace: () => {
      teardown();
      set((s) => ({ race: { ...s.race, status: 'idle', lobbyId: undefined } }));
    },

    callPit: async (driverIdx, compound, lap) => {
      const { race, auth } = get();

      if (race.status !== 'connected' || !race.lobbyId) {
        const outcome: PitOutcome = { ok: false, error: 'disconnected' };
        set((s) => ({ race: { ...s.race, lastPitOutcome: outcome } }));
        return outcome;
      }

      const input: PitInput = { lobbyId: race.lobbyId, driverIdx, compound };
      if (lap !== undefined) input.lap = lap;

      const res = await sendPit(auth.baseUrl, auth.token ?? '', input);
      const outcome: PitOutcome = res.ok
        ? { ok: true, driverIdx: res.data.driverIdx, compound: res.data.compound, lap: res.data.lap }
        : { ok: false, error: res.error };

      set((s) => ({ race: { ...s.race, lastPitOutcome: outcome } }));
      return outcome;
    },

    setWeekendChoices: async (lobbyId, choices) => {
      const auth = session();
      if (!auth) {
        const outcome: WeekendChoiceOutcome = { ok: false, error: 'not_signed_in' };
        set((s) => ({ race: { ...s.race, lastWeekendChoiceOutcome: outcome } }));
        return outcome;
      }

      const res = await sendWeekendChoices(auth.baseUrl, auth.token, { lobbyId, ...choices });
      const outcome: WeekendChoiceOutcome = res.ok ? { ok: true } : { ok: false, error: res.error };

      set((s) => ({ race: { ...s.race, lastWeekendChoiceOutcome: outcome } }));
      return outcome;
    },

    checkinRace: async (lobbyId) => {
      const auth = session();
      if (!auth) {
        const outcome: WeekendChoiceOutcome = { ok: false, error: 'not_signed_in' };
        set((s) => ({ race: { ...s.race, lastWeekendChoiceOutcome: outcome } }));
        return outcome;
      }

      const res = await sendCheckin(auth.baseUrl, auth.token, lobbyId);
      const outcome: WeekendChoiceOutcome = res.ok ? { ok: true } : { ok: false, error: res.error };

      set((s) => ({ race: { ...s.race, lastWeekendChoiceOutcome: outcome } }));
      return outcome;
    },
  };
}

/**
 * What the qualifying screen should show: the server's result while this
 * device is seated in a lobby (`race.lobbyId` set), the locally-simulated
 * one otherwise (the legacy no-lobby solo weekend, where there is no server
 * race to ask).
 *
 * This lives here, not in `QualifyingPanel.tsx`, because it is a plain
 * decision over data — no rendering — and `QualifyingPanel.tsx` imports
 * React Native, which cannot run under plain Node (`tsx --test`); keeping
 * the decision here is what makes rule 4 below testable at all.
 *
 * NO LOCAL FALLBACK: once `lobbyId` is set, `localQualifying` is never
 * consulted, even when `race.qualifying` is `undefined` (not yet received
 * from the server, or lost along with everything else on disconnect — see
 * `raceSocket.ts`'s "never fabricate" rule, which this mirrors exactly). A
 * locally-simulated grid is a DIFFERENT grid from the one this lobby's race
 * actually started from — showing it, even briefly, is the exact bug this
 * phase of the project exists to remove (see this task's brief: changing a
 * single qualifying input once moved the race leader from a car that
 * started P2 to one that started P18).
 */
export function displayQualifying(
  race: Pick<RaceSliceState, 'lobbyId' | 'qualifying'>,
  localQualifying: QualifyingResult | undefined,
): QualifyingResult | undefined {
  return race.lobbyId ? race.qualifying : localQualifying;
}
