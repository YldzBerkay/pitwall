/**
 * Tests for the online weekend's qualifying result coming from the server
 * instead of the client's own `simulateQualifying` (`@pitwall/shared/raceEngine`).
 *
 * Context: `server/src/lobby/live.ts`'s `state` frame carries a `qualifying:
 * QualifyingResult` field ALONGSIDE the usual race fields (see its
 * `SerialisedRaceState extends SerialisedRace` — a deliberate type split so
 * `qualifying` can NEVER appear on a `lap` frame: it is fixed for the whole
 * race, derived once from the frozen recipe, and would be pure waste to
 * repeat every tick). This file proves three things end to end:
 *
 *  1. that payload lands in `raceSlice`'s store state (`mobile/src/store/
 *     slices/raceSlice.ts`);
 *  2. a `lap` frame — a FULL replacement of the race image, never a merge
 *     (see `raceSocket.ts`'s own docs) — must not wipe out the `qualifying`
 *     a prior `state` frame delivered, precisely because a naive
 *     "adopt the frame's `race` object wholesale" merge would erase any
 *     field the `lap` frame doesn't carry;
 *  3 & 4. the UI-facing selector (`displayQualifying`, added to
 *     `raceSlice.ts` because the equivalent logic lived un-testably inside
 *     `QualifyingPanel.tsx`, which imports React Native and cannot run under
 *     plain Node) reads the server's grid while seated in a lobby, and NEVER
 *     falls back to a locally-simulated one — not even while disconnected.
 *     Falling back would show the player a grid that is not the one their
 *     race actually started from (see this task's brief: changing a single
 *     qualifying input once moved the race leader from P2 to a car that
 *     started P18).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from 'zustand';
import type { QualifyingResult } from '@pitwall/shared/raceEngine';
import {
  createRaceSocket,
  type RaceSocket,
  type RaceSocketState,
  type SerialisedRace,
  type WebSocketCtor,
} from '@/lib/api/raceSocket';
import {
  createRaceSlice,
  displayQualifying,
  type RaceSlice,
  type RaceSliceDeps,
  type RaceSliceState,
} from '@/store/slices/raceSlice';

const TOKEN = 'session-token-abc';
const LOBBY_ID = 'lobby-1';
const URL = 'ws://example.test/race/live';

function makeQualifying(seed: number): QualifyingResult {
  return {
    grid: [
      { teamKey: 'ferrari', driverIdx: 0, driver: `Driver ${seed}`, sec: 90 + seed },
    ] as unknown as QualifyingResult['grid'],
    playerGrid: [1, 2],
    mistakes: [false, false],
    redRuined: [false, false],
  };
}

function makeRace(lap: number): SerialisedRace {
  return {
    lap,
    laps: 58,
    finished: false,
    wet: false,
    trackKey: 'fictional-1',
    round: 1,
    session: 'race',
    cars: [],
    events: [],
    control: 'green',
    fastestLap: null,
    weather: { forecast: 0.1, wetAtStart: false },
    neutralised: undefined,
  };
}

// ── raceSocket.ts: the real implementation, driven with a fully-scripted
// fake WebSocket (same pattern as race-socket.test.ts). ──────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readonly url: string;
  readyState = 0;
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
    this.readyState = 3;
    this.onclose?.({});
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  triggerMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function latestSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!s) throw new Error('no FakeWebSocket constructed');
  return s;
}

test('raceSocket: qualifying carried on a state frame is exposed on the socket state', () => {
  FakeWebSocket.reset();
  const socket = createRaceSocket(
    { url: URL, lobbyId: LOBBY_ID, token: TOKEN },
    { WebSocketImpl: FakeWebSocket as unknown as WebSocketCtor },
  );
  const ws = latestSocket();
  ws.triggerOpen();

  const q = makeQualifying(1);
  ws.triggerMessage({ type: 'state', lobbyId: LOBBY_ID, race: { ...makeRace(0), qualifying: q } });

  const s: RaceSocketState = socket.getState();
  assert.deepEqual(s.qualifying, q);
  socket.close();
});

test('raceSocket: a lap frame does not clobber the stored qualifying with undefined', () => {
  FakeWebSocket.reset();
  const socket = createRaceSocket(
    { url: URL, lobbyId: LOBBY_ID, token: TOKEN },
    { WebSocketImpl: FakeWebSocket as unknown as WebSocketCtor },
  );
  const ws = latestSocket();
  ws.triggerOpen();

  const q = makeQualifying(2);
  ws.triggerMessage({ type: 'state', lobbyId: LOBBY_ID, race: { ...makeRace(0), qualifying: q } });
  assert.deepEqual(socket.getState().qualifying, q);

  // A `lap` frame is a FULL race replacement, but it never carries
  // `qualifying` at all (server's `SerialisedRace`, not `SerialisedRaceState`)
  // — the stored qualifying result must survive every one of these, sent
  // once at the start of the race and never repeated.
  ws.triggerMessage({ type: 'lap', lobbyId: LOBBY_ID, race: makeRace(1) });
  ws.triggerMessage({ type: 'lap', lobbyId: LOBBY_ID, race: makeRace(2) });
  ws.triggerMessage({ type: 'lap', lobbyId: LOBBY_ID, race: makeRace(3) });

  const s = socket.getState();
  assert.equal(s.race?.lap, 3, 'the race image itself must still advance');
  assert.deepEqual(s.qualifying, q, 'qualifying must survive every subsequent lap frame');
  socket.close();
});

// ── raceSlice.ts: the payload lands in the store. ─────────────────────────

function makeFakeSocket() {
  let status: RaceSocketState['status'] = 'connecting';
  let race: SerialisedRace | null = null;
  let qualifying: QualifyingResult | undefined;
  const listeners = new Set<(s: RaceSocketState) => void>();

  const socket: RaceSocket = {
    getState: () => ({ status, race, qualifying }),
    addListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {},
  };

  return {
    socket,
    // Mirrors raceSocket.ts's own contract: `qualifying` is only ever
    // touched when the caller explicitly passes it (a 'state' frame);
    // omitting it (a 'lap' frame) leaves the previous value untouched.
    emit(next: { status?: RaceSocketState['status']; race?: SerialisedRace | null; qualifying?: QualifyingResult }) {
      if (next.status !== undefined) status = next.status;
      if (next.race !== undefined) race = next.race;
      if ('qualifying' in next) qualifying = next.qualifying;
      const snapshot: RaceSocketState = { status, race, qualifying };
      for (const l of [...listeners]) l(snapshot);
    },
  };
}

function setupSlice() {
  const fake = makeFakeSocket();
  const createSocket = () => fake.socket;
  const useStore = create<RaceSlice & RaceSliceDeps>()((set, get) => ({
    auth: { baseUrl: 'http://example.test', token: TOKEN },
    ...createRaceSlice(set as never, get as never, { createSocket }),
  }));
  return { useStore, fake };
}

test('raceSlice: the qualifying payload in a state frame lands in the store', () => {
  const { useStore, fake } = setupSlice();
  useStore.getState().connectRace(LOBBY_ID);

  const q = makeQualifying(3);
  fake.emit({ status: 'connected', race: makeRace(0), qualifying: q });

  assert.deepEqual(useStore.getState().race.qualifying, q);
});

test('raceSlice: a lap frame does not clobber the stored qualifying with undefined', () => {
  const { useStore, fake } = setupSlice();
  useStore.getState().connectRace(LOBBY_ID);

  const q = makeQualifying(4);
  fake.emit({ status: 'connected', race: makeRace(0), qualifying: q });
  assert.deepEqual(useStore.getState().race.qualifying, q);

  // A lap-only update from the socket (no `qualifying` key at all).
  fake.emit({ race: makeRace(1) });
  assert.equal(useStore.getState().race.data?.lap, 1);
  assert.deepEqual(useStore.getState().race.qualifying, q, 'must survive a subsequent lap update');
});

// ── displayQualifying: the UI-facing selector, no local fallback. ─────────

test('displayQualifying: while connected to a lobby, the server result is read, not local state', () => {
  const serverQ = makeQualifying(5);
  const localQ = makeQualifying(999);
  const race: Pick<RaceSliceState, 'lobbyId' | 'qualifying'> = { lobbyId: LOBBY_ID, qualifying: serverQ };

  const result = displayQualifying(race, localQ);
  assert.deepEqual(result, serverQ);
  assert.notDeepEqual(result, localQ);
});

test('displayQualifying: while disconnected (or before any state frame), it does not fall back to a local grid', () => {
  const localQ = makeQualifying(999);
  // Seated in a lobby, but the server has not (yet, or any more) supplied a
  // qualifying result -- e.g. never received one, or it dropped out at the
  // socket layer.
  const race: Pick<RaceSliceState, 'lobbyId' | 'qualifying'> = { lobbyId: LOBBY_ID, qualifying: undefined };

  const result = displayQualifying(race, localQ);
  assert.equal(result, undefined, 'a missing server result must stay missing, never substituted with the local grid');
});

test('displayQualifying: outside any lobby (legacy solo weekend), the local grid is used', () => {
  const localQ = makeQualifying(6);
  const race: Pick<RaceSliceState, 'lobbyId' | 'qualifying'> = { lobbyId: undefined, qualifying: undefined };

  const result = displayQualifying(race, localQ);
  assert.deepEqual(result, localQ);
});
