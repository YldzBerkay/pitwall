import type { CompoundKey } from '@pitwall/shared/carCustomisation';
import type { ApiResult } from '@/lib/api/identity';
import { pit as pitApi, type PitInput, type PitResponse } from '@/lib/api/race';
import {
  createRaceSocket,
  type ConnectionStatus,
  type RaceSocket,
  type RaceSocketDeps,
  type RaceSocketOptions,
  type SerialisedRace,
} from '@/lib/api/raceSocket';

/**
 * The slice that sits between the server's race clients
 * (`lib/api/race.ts`, `lib/api/raceSocket.ts`) and the screens.
 *
 * THIS IS NOT WIRED INTO `gameStore.ts`/`GameState` YET. That wiring is a
 * later task. `GameState` (`store/gameStore.ts`) does not declare a `race`
 * key today, so importing the real `SliceCreator`/`GameState` types from
 * `./types.ts` — the way every other slice in this directory does — and
 * returning `{ race: ... }` from `set()` would fail `tsc` (the key does not
 * exist on the type being partially updated). Rather than touch
 * `gameStore.ts` to add it (out of scope for this task, and a decision that
 * belongs with the actual wiring), this slice declares its OWN minimal
 * `set`/`get` types below. They ask for exactly the one thing this slice
 * reads from the rest of the store — `auth.baseUrl` / `auth.token`, the same
 * shape `authSlice.ts` already exposes as `AuthSlice['auth']` — so plugging
 * this into `GameState` later is a mechanical `...createRaceSlice(set, get)`
 * spread, unchanged from `lobbySlice.ts`'s own pattern.
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

export interface RaceSliceState {
  status: ConnectionStatus | 'idle';
  /** The lobby currently subscribed to, or undefined before `connectRace`
   * / after `leaveRace`. */
  lobbyId?: string;
  /** The last full race image the server sent. Preserved across a
   * disconnect (mirrors `raceSocket.ts`'s own `race` field) — the screen
   * freezes on the last real lap rather than going blank. */
  data: SerialisedRace | null;
  /** The most recent pit call's result, kept distinct from `data` so a
   * rejection (e.g. `lap_already_run`) can be shown to the player without
   * being swallowed into the race state. */
  lastPitOutcome?: PitOutcome;
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
}

/** The one thing this slice needs from the rest of the store — see the
 * module doc comment for why this isn't `GameState` yet. */
export interface RaceSliceDeps {
  auth: { baseUrl: string; token?: string };
}

export type RaceSliceSet = (
  partial:
    | Partial<RaceSlice & RaceSliceDeps>
    | ((state: RaceSlice & RaceSliceDeps) => Partial<RaceSlice & RaceSliceDeps>),
) => void;
export type RaceSliceGet = () => RaceSlice & RaceSliceDeps;

/** Injectable collaborators, defaulting to the real clients. Tests supply
 * fakes here instead of driving a real `WebSocket`/`http` server, since
 * `raceSocket.ts` and `race.ts` each already have their own dedicated tests
 * proving the wire-level behaviour — this slice's tests are about its own
 * logic (frame -> store state, and the refuse-not-queue rule). */
export interface RaceSliceInjected {
  createSocket?: (options: RaceSocketOptions, deps?: RaceSocketDeps) => RaceSocket;
  pitApi?: (baseUrl: string, token: string, input: PitInput) => Promise<ApiResult<PitResponse>>;
  socketDeps?: RaceSocketDeps;
}

/** `http(s)://host` -> `ws(s)://host/race/live`. */
function liveSocketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/race/live`;
}

export function createRaceSlice(
  set: RaceSliceSet,
  get: RaceSliceGet,
  injected: RaceSliceInjected = {},
): RaceSlice {
  const createSocket = injected.createSocket ?? createRaceSocket;
  const sendPit = injected.pitApi ?? pitApi;

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

      const { baseUrl, token } = get().auth;
      set((s) => ({ race: { ...s.race, status: 'connecting', lobbyId, data: null, lastPitOutcome: undefined } }));

      const newSocket = createSocket({ url: liveSocketUrl(baseUrl), lobbyId, token: token ?? '' }, injected.socketDeps);
      socket = newSocket;

      const adopt = (snapshot: { status: ConnectionStatus; race: SerialisedRace | null }) => {
        set((s) => ({ race: { ...s.race, status: snapshot.status, data: snapshot.race } }));
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
  };
}
