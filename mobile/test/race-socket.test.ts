/**
 * Tests for the live-race WebSocket client (`mobile/src/lib/api/raceSocket.ts`),
 * which talks to the server's per-lobby room at `server/src/lobby/live.ts`
 * (`LIVE_PATH = '/race/live'`).
 *
 * Server contract confirmed by reading `live.ts` directly (see the report in
 * the session that wrote this file):
 *  - First application message must be `{type:'subscribe', lobbyId, token}`.
 *    The token travels in the body, never a `?token=` query string.
 *  - Frames the server sends: `{type:'state', lobbyId, race: SerialisedRace|null}`,
 *    `{type:'lap', lobbyId, race: SerialisedRace}`, `{type:'unsubscribed', lobbyId}`,
 *    and `{type:'error', error: string}` — note `error` frames carry NO
 *    `lobbyId`, only a string code (`invalid_request` | `unauthorized` |
 *    `forbidden` | `internal_error`).
 *  - There is no `session-invalid` code on the wire. The server's
 *    `unauthorized` ("your token didn't verify") is the one that means a
 *    bad/expired session; `forbidden` means "valid session, no seat in this
 *    lobby" — a different, non-session problem. This client maps only
 *    `unauthorized` to the `session-invalid` status.
 *  - `lap` frames carry the FULL serialised race each time (same shape as
 *    `state`), not a diff — so adopting a `lap`/`state` frame is always a
 *    plain replace, never a merge.
 *
 * A fake, fully-controlled `WebSocket` is injected (never the real network),
 * so every scenario below is driven by hand — no wall-clock sleeps.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRaceSocket, type RaceSocketState, type WebSocketCtor } from '@/lib/api/raceSocket';

const TOKEN = 'session-token-abc';
const LOBBY_ID = 'lobby-1';
const URL = 'ws://example.test/race/live';

/** Minimal, fully-scriptable stand-in for the DOM/RN `WebSocket` class. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readonly url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({});
  }

  /** Test helper: simulate the server accepting the TCP/WS handshake. */
  triggerOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  /** Test helper: simulate a frame arriving from the server. */
  triggerMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** Test helper: simulate the connection dropping. */
  triggerClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

/** Records every `(fn, ms)` scheduled, without ever actually waiting. */
class FakeClock {
  scheduled: { fn: () => void; ms: number; id: number }[] = [];
  private nextId = 1;

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.scheduled.push({ fn, ms, id });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.scheduled = this.scheduled.filter((t) => t.id !== id);
  };

  /** Fires the oldest still-pending timer, as if its delay had elapsed. */
  flushNext(): void {
    const next = this.scheduled.shift();
    if (!next) throw new Error('no timer scheduled');
    next.fn();
  }
}

function latestSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!s) throw new Error('no FakeWebSocket constructed');
  return s;
}

function makeRace(lap: number) {
  return {
    lap,
    laps: 58,
    finished: false,
    wet: false,
    trackKey: 'fictional-1',
    round: 1,
    session: 'race' as const,
    cars: [],
    events: [],
    control: 'green',
    fastestLap: null,
  };
}

function setup(overrides: { backoffMs?: (attempt: number) => number } = {}) {
  FakeWebSocket.reset();
  const clock = new FakeClock();
  const socket = createRaceSocket(
    { url: URL, lobbyId: LOBBY_ID, token: TOKEN },
    {
      WebSocketImpl: FakeWebSocket as unknown as WebSocketCtor,
      setTimeoutImpl: clock.setTimeout as unknown as typeof setTimeout,
      clearTimeoutImpl: clock.clearTimeout as unknown as typeof clearTimeout,
      backoffMs: overrides.backoffMs,
    },
  );
  return { socket, clock };
}

test('on open, the handshake is sent and carries the token and lobbyId', () => {
  const { socket } = setup();
  const ws = latestSocket();
  assert.equal(ws.sent.length, 0, 'nothing sent before open');
  ws.triggerOpen();
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'subscribe', lobbyId: LOBBY_ID, token: TOKEN });
  assert.equal(socket.getState().status, 'connecting');
  socket.close();
});

test('a state frame installs the full race; lap frames advance it', () => {
  const { socket } = setup();
  const ws = latestSocket();
  ws.triggerOpen();

  ws.triggerMessage({ type: 'state', lobbyId: LOBBY_ID, race: makeRace(3) });
  let s: RaceSocketState = socket.getState();
  assert.equal(s.status, 'connected');
  assert.equal(s.race?.lap, 3);

  ws.triggerMessage({ type: 'lap', lobbyId: LOBBY_ID, race: makeRace(4) });
  s = socket.getState();
  assert.equal(s.race?.lap, 4);
  socket.close();
});

test('a frame for a different lobby is ignored', () => {
  const { socket } = setup();
  const ws = latestSocket();
  ws.triggerOpen();
  ws.triggerMessage({ type: 'state', lobbyId: LOBBY_ID, race: makeRace(5) });

  ws.triggerMessage({ type: 'lap', lobbyId: 'some-other-lobby', race: makeRace(99) });
  const s = socket.getState();
  assert.equal(s.race?.lap, 5, 'the foreign frame must not have been applied');
  socket.close();
});

test('on close, status becomes disconnected and the last known race state is still there', () => {
  const { socket } = setup();
  const ws = latestSocket();
  ws.triggerOpen();
  ws.triggerMessage({ type: 'state', lobbyId: LOBBY_ID, race: makeRace(7) });

  ws.triggerClose();
  const s = socket.getState();
  assert.equal(s.status, 'disconnected');
  assert.equal(s.race?.lap, 7, 'race state must be preserved across a disconnect');
});

test('reconnection backs off instead of looping tightly', () => {
  const delays: number[] = [10, 20, 40];
  let calls = 0;
  const { clock } = setup({
    backoffMs: () => {
      const d = delays[Math.min(calls, delays.length - 1)];
      calls += 1;
      return d;
    },
  });

  latestSocket().triggerOpen();
  latestSocket().triggerClose(); // 1st disconnect -> schedules reconnect #1

  assert.equal(clock.scheduled.length, 1);
  assert.equal(clock.scheduled[0].ms, 10);

  clock.flushNext(); // fires reconnect attempt #1 -> a new socket is created
  assert.equal(FakeWebSocket.instances.length, 2);

  latestSocket().triggerClose(); // fails again immediately -> schedules #2
  assert.equal(clock.scheduled.length, 1);
  assert.equal(clock.scheduled[0].ms, 20, 'backoff must grow, not repeat the same short delay');
});

test('an error frame meaning a bad/expired session maps to session-invalid, not disconnected', () => {
  const { socket, clock } = setup();
  const ws = latestSocket();
  ws.triggerOpen();

  ws.triggerMessage({ type: 'error', error: 'unauthorized' });
  const s = socket.getState();
  assert.equal(s.status, 'session-invalid');
  assert.notEqual(s.status, 'disconnected');
  // A session that needs a fresh login is not fixed by waiting, so no
  // reconnect attempt should be queued.
  assert.equal(clock.scheduled.length, 0);
});

test('after reconnecting, the client adopts the server state frame and does not fabricate missed laps', () => {
  const { socket, clock } = setup({ backoffMs: () => 5 });
  latestSocket().triggerOpen();
  latestSocket().triggerMessage({ type: 'state', lobbyId: LOBBY_ID, race: makeRace(10) });

  latestSocket().triggerClose(); // disconnect at lap 10
  assert.equal(socket.getState().race?.lap, 10);

  clock.flushNext(); // reconnect attempt fires, a fresh socket opens
  const ws2 = latestSocket();
  assert.equal(socket.getState().status, 'connecting');
  // While reconnecting, the OLD race must still be shown — never blanked and
  // never advanced on its own.
  assert.equal(socket.getState().race?.lap, 10);

  ws2.triggerOpen();
  // The server jumps the client straight to its authoritative lap (say the
  // race moved on to lap 26 while disconnected) — the client must NOT
  // interpolate laps 11..25 on its own.
  ws2.triggerMessage({ type: 'state', lobbyId: LOBBY_ID, race: makeRace(26) });
  const s = socket.getState();
  assert.equal(s.status, 'connected');
  assert.equal(s.race?.lap, 26);
});

/**
 * Bağlantı kurulduktan SONRA gelen çerçeveler de abonelere ulaşmalı.
 *
 * `notify()` yalnızca `setStatus()` içinden çağrılıyordu, o da durum zaten
 * `'connected'` ise erken dönüyor — yani ilk çerçeveden sonraki hiçbir tur
 * dinleyicilere ulaşmıyordu ve canlı yarış ekranda hiç ilerlemiyordu.
 *
 * Mevcut testler bunu kaçırdı çünkü hepsi `getState()` okuyor; dinleyici yolu
 * hiç sınanmamıştı. Store dilimi ise tam olarak o yolu kullanıyor.
 */
test('her çerçeve abonelere ulaşır, yalnızca durum değişince değil', () => {
  const { socket } = setup();
  const seen: RaceSocketState[] = [];
  socket.addListener((s) => seen.push(s));

  latestSocket().triggerOpen();
  latestSocket().triggerMessage({ type: 'state', lobbyId: LOBBY_ID, race: makeRace(1) });
  latestSocket().triggerMessage({ type: 'lap', lobbyId: LOBBY_ID, race: makeRace(2) });
  latestSocket().triggerMessage({ type: 'lap', lobbyId: LOBBY_ID, race: makeRace(3) });

  const laps = seen.map((s) => s.race?.lap).filter((l) => l !== undefined);
  assert.deepEqual(laps, [1, 2, 3],
    `dinleyici her turu görmeli, gördükleri: ${JSON.stringify(laps)}`);
});
