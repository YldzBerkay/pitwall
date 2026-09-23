/**
 * Live-race WebSocket client for the server's per-lobby room
 * (`server/src/lobby/live.ts`, `LIVE_PATH = '/race/live'`).
 *
 * THERE IS NO LOCAL FALLBACK. This was a deliberate decision, not an
 * oversight: the server owns the race (it freezes a seed + entries + an
 * immutable pit-decision log at lights-out and ticks it deterministically),
 * which is what makes "everyone in the lobby sees the same race" a
 * structural guarantee rather than a hope. A client that falls back to
 * simulating its own race the moment the socket drops draws a DIFFERENT
 * race from the one the server is running — at the single most visible
 * possible moment (mid-disconnect). So when the connection is down, this
 * module does not compute anything: it freezes on the last frame it was
 * given and reports that it is disconnected. See the task brief this was
 * built against for the fuller argument.
 *
 * ── HANDSHAKE: TOKEN IN THE BODY, NOT THE URL ────────────────────────────
 * The server's `attach()` (`live.ts`) expects the FIRST application message
 * to be `{type:'subscribe', lobbyId, token}`. This mirrors the server's own
 * reasoning: the browser/React Native `WebSocket` API cannot set headers on
 * the handshake, and a `?token=` query string would leak a session key into
 * access logs, proxies and `Referer`. So the token rides in a message sent
 * right after `onopen`, never in the URL.
 *
 * ── FOUR CONNECTION STATUSES, NOT TWO ────────────────────────────────────
 * `disconnected` and `session-invalid` are kept apart on purpose. A dropped
 * TCP connection is fixed by waiting (this module backs off and retries on
 * its own); an expired/invalid session is not — no amount of retrying will
 * make the server's `unauthorized` response go away, and a UI that shows
 * "reconnecting…" forever for that case sends the player nowhere. Only the
 * server's `error: 'unauthorized'` frame (bad/expired token) maps to
 * `session-invalid`; `forbidden` (valid session, no seat in this lobby) and
 * other error codes are surfaced without changing the connection status,
 * since they are not a transport problem this module can act on.
 *
 * ── STATE IS NEVER FABRICATED ────────────────────────────────────────────
 * `lap` and `state` frames both carry the FULL serialised race (see
 * `serialise()` in `live.ts`) — adopting one is always a plain replace,
 * never an interpolation. On reconnect this module does not try to guess
 * which laps it missed; it waits for the server's next `state` frame (built
 * from the authoritative, stored `last_lap`, never the wall clock) and
 * jumps straight to it.
 *
 * ── NO TIMERS AT MODULE LOAD, NO REACT NATIVE ────────────────────────────
 * Nothing here runs until `createRaceSocket()` is called, and every piece of
 * I/O (the `WebSocket` constructor, `setTimeout`/`clearTimeout`) is an
 * injected dependency defaulting to the global — this keeps the module
 * runnable under plain Node (`tsx --test`) with a fully scripted fake
 * `WebSocket` in tests, and keeps React Native/Expo out of it entirely.
 *
 * ── QUALIFYING RIDES SEPARATELY FROM `race` ───────────────────────────────
 * The server's `state` frame (`live.ts`'s `SerialisedRaceState`) carries a
 * `qualifying: QualifyingResult` field the `lap` frame never has — it is
 * fixed for the whole race (derived once from the frozen recipe), so
 * resending it every tick would be pure waste. Both frame types are still
 * FULL replacements of `race` (see above), so if `qualifying` lived inside
 * that same object, adopting the next `lap` frame would silently wipe it out
 * the moment `frame.race` doesn't carry the key. It is kept in its own
 * module-level slot instead: only a `state` frame ever assigns it, and it is
 * mirrored onto `RaceSocketState` alongside `race` so it survives every
 * subsequent `lap` frame untouched — a locally-simulated grid is never
 * substituted in its place; see the module doc above's "no local fallback"
 * for why.
 */
import type { QualifyingResult, RaceState } from '@pitwall/shared/raceEngine';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'session-invalid';

/** Mirrors `SerialisedRace` in `server/src/lobby/live.ts`. Kept structural
 * (no import from the server) since this module must stay Node/RN-neutral
 * and the server doesn't publish this type for client consumption. */
export interface SerialisedRace {
  lap: number;
  laps: number;
  finished: boolean;
  wet: boolean;
  trackKey: string;
  round: number;
  session: 'race' | 'sprint';
  // Tightened to what `serialise()` in `server/src/lobby/live.ts` actually
  // sends (checked directly against that function): these six fields are
  // copied straight off the server's own `RaceState`, so mirroring their
  // real shapes here — via the `@pitwall/shared/raceEngine` subpath import,
  // since a bare `@pitwall/shared` import fails `tsc` (TS5097) — lets
  // `LiveRacePanel.tsx` draw the feed without an `unknown`-cast escape
  // hatch. `entries`/`standings`/`rosters` stay OFF this type on purpose:
  // the feed doesn't carry them (a server test guards their absence), and
  // adding them here would invite exactly the "recompute the race locally"
  // move this phase exists to remove.
  cars: RaceState['cars'];
  events: RaceState['events'];
  control: RaceState['control'];
  fastestLap: RaceState['fastestLap'];
  weather: RaceState['weather'];
  neutralised: RaceState['neutralised'];
}

/** Mirrors `SerialisedRaceState` in `server/src/lobby/live.ts` — the ONE
 * extra field only a `state` frame's `race` object carries. Kept as its own
 * type for the same reason the server keeps it separate from
 * `SerialisedRace`: so a `lap` frame's payload structurally CANNOT carry
 * `qualifying`, making "a lap frame silently wipes the grid" a type error
 * here rather than a runtime bug. `QualifyingResult` is a plain data type
 * (no server/React-Native coupling), so importing it type-only from
 * `@pitwall/shared` doesn't violate this module's Node/RN-neutrality. */
export interface SerialisedRaceState extends SerialisedRace {
  qualifying: QualifyingResult;
}

export interface RaceSocketState {
  status: ConnectionStatus;
  /** The last race image the server sent. Preserved across disconnects —
   * never cleared just because the socket dropped. */
  race: SerialisedRace | null;
  /** The server's real qualifying result, delivered once on the `state`
   * frame. Preserved across every subsequent `lap` frame (which never
   * carries it) and across disconnects — same "never cleared, never
   * fabricated" rule as `race`. Undefined until the first `state` frame for
   * a live race arrives (or once one arrives with `race: null`, i.e. the
   * lobby isn't racing). NEVER filled in from a local simulation. Optional
   * (rather than always-present-but-possibly-`undefined`) so existing call
   * sites/tests built against a `{status, race}` shape from before this
   * field existed keep typechecking unchanged. */
  qualifying?: QualifyingResult;
}

export interface RaceSocketOptions {
  /** e.g. `wss://host/race/live`. */
  url: string;
  lobbyId: string;
  token: string;
}

type MinimalWebSocket = {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type WebSocketCtor = new (url: string) => MinimalWebSocket;

export interface RaceSocketDeps {
  WebSocketImpl?: WebSocketCtor;
  setTimeoutImpl?: (fn: () => void, ms: number) => number;
  clearTimeoutImpl?: (id: number) => void;
  /** Delay before reconnect attempt N (N = 0, 1, 2, ...). Default: capped
   * exponential backoff, 500ms * 2^N up to 15s. */
  backoffMs?: (attempt: number) => number;
}

export interface RaceSocket {
  getState(): RaceSocketState;
  /** Notified on every status or race change. Returns an unsubscribe fn. */
  addListener(listener: (state: RaceSocketState) => void): () => void;
  /** Stops reconnecting and tears the socket down for good (component
   * unmount). Does not clear the last known race state. */
  close(): void;
}

const OPEN = 1;

function defaultBackoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 15_000);
}

type IncomingFrame =
  | { type: 'state'; lobbyId: string; race: SerialisedRaceState | null }
  | { type: 'lap'; lobbyId: string; race: SerialisedRace }
  | { type: 'unsubscribed'; lobbyId: string }
  | { type: 'error'; error: string };

function parseFrame(raw: string): IncomingFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as IncomingFrame;
  } catch {
    return null;
  }
}

export function createRaceSocket(options: RaceSocketOptions, deps: RaceSocketDeps = {}): RaceSocket {
  const WebSocketImpl = deps.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? ((id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  const backoffMs = deps.backoffMs ?? defaultBackoff;

  let status: ConnectionStatus = 'connecting';
  let race: SerialisedRace | null = null;
  // Separate from `race` on purpose — see the module doc's "qualifying rides
  // separately from `race`". Only a 'state' frame ever assigns this; a 'lap'
  // frame's payload is typed `SerialisedRace` (no `qualifying` key at all),
  // so it structurally cannot touch this variable.
  let qualifying: QualifyingResult | undefined;
  let socket: MinimalWebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  let manuallyClosed = false;
  const listeners = new Set<(state: RaceSocketState) => void>();

  function snapshot(): RaceSocketState {
    return { status, race, qualifying };
  }

  function notify(): void {
    const s = snapshot();
    for (const l of listeners) l(s);
  }

  function setStatus(next: ConnectionStatus): void {
    if (status === next) return;
    status = next;
    notify();
  }

  /**
   * Bir çerçeve geldiğinde: bağlı say ve HER ZAMAN haber ver.
   *
   * `setStatus` durum değişmediyse erken dönüyor ve bu doğru — durum geçişleri
   * için. Ama çerçeveler için yanlıştı: ilk çerçeveden sonra durum hep
   * `'connected'` kaldığı için `notify()` bir daha ateşlenmiyordu, yani
   * dinleyiciler hiçbir turu görmüyordu ve canlı yarış ekranda donuyordu.
   * `getState()` okuyan testler bunu kaçırdı; store dilimi ise dinleyici
   * yolunu kullanıyor.
   */
  function frameArrived(): void {
    status = 'connected';
    notify();
  }

  function scheduleReconnect(): void {
    if (manuallyClosed || status === 'session-invalid') return;
    if (reconnectTimer !== null) return; // already scheduled
    const delay = backoffMs(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleFrame(frame: IncomingFrame): void {
    switch (frame.type) {
      case 'state': {
        if (frame.lobbyId !== options.lobbyId) return;
        race = frame.race;
        // The 'state' frame is the ONLY place `qualifying` is ever
        // (re)assigned — a full replacement, same as `race` itself. When
        // `frame.race` is null (lobby isn't racing), there is no qualifying
        // result either.
        qualifying = frame.race?.qualifying;
        frameArrived();
        return;
      }
      case 'lap': {
        if (frame.lobbyId !== options.lobbyId) return;
        race = frame.race;
        // `qualifying` is DELIBERATELY left untouched here: `frame.race` is
        // `SerialisedRace`, which has no `qualifying` field to begin with —
        // a 'lap' frame cannot clobber it even by accident.
        frameArrived();
        return;
      }
      case 'unsubscribed': {
        return;
      }
      case 'error': {
        // The one server error code that means "this session itself is bad
        // and no retry will fix it." Every other error code (forbidden,
        // invalid_request, internal_error) is a distinct problem this
        // module has no transport-level fix for, so the connection status
        // is left alone.
        if (frame.error === 'unauthorized') {
          manuallyClosed = true; // do not attempt to reconnect with the same bad token
          if (reconnectTimer !== null) {
            clearTimeoutImpl(reconnectTimer);
            reconnectTimer = null;
          }
          setStatus('session-invalid');
          // onclose (fired synchronously by most WebSocket implementations,
          // including the fake used in tests) checks `manuallyClosed` /
          // `status` first, so this does not re-trigger a status change or
          // schedule a reconnect.
          if (socket) socket.close();
        }
        return;
      }
    }
  }

  function connect(): void {
    if (manuallyClosed) return;
    setStatus('connecting');
    const ws = new WebSocketImpl(options.url);
    socket = ws;

    ws.onopen = () => {
      reconnectAttempt = 0;
      ws.send(JSON.stringify({ type: 'subscribe', lobbyId: options.lobbyId, token: options.token }));
    };

    ws.onmessage = (ev) => {
      const frame = parseFrame(ev.data);
      if (frame) handleFrame(frame);
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (manuallyClosed || status === 'session-invalid') return;
      // Race state is deliberately left untouched here: the screen freezes
      // on the last real lap rather than going blank.
      setStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // `ws` (and the DOM WebSocket) always follow an error with a close
      // event, so the actual status transition and reconnect scheduling
      // happen in `onclose` — this avoids double-scheduling a reconnect.
    };
  }

  connect();

  return {
    getState: snapshot,
    addListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      manuallyClosed = true;
      if (reconnectTimer !== null) {
        clearTimeoutImpl(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket && socket.readyState === OPEN) {
        socket.close();
      }
      socket = null;
    },
  };
}
