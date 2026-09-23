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
 */

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
  cars: unknown;
  events: unknown;
  control: unknown;
  fastestLap: unknown;
}

export interface RaceSocketState {
  status: ConnectionStatus;
  /** The last race image the server sent. Preserved across disconnects —
   * never cleared just because the socket dropped. */
  race: SerialisedRace | null;
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
  | { type: 'state'; lobbyId: string; race: SerialisedRace | null }
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
  let socket: MinimalWebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  let manuallyClosed = false;
  const listeners = new Set<(state: RaceSocketState) => void>();

  function snapshot(): RaceSocketState {
    return { status, race };
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
        setStatus('connected');
        return;
      }
      case 'lap': {
        if (frame.lobbyId !== options.lobbyId) return;
        race = frame.race;
        setStatus('connected');
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
