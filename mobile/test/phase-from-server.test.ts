/**
 * THE WEEKEND'S PHASE HAS NO SERVER-DRIVEN SOURCE ON THE CLIENT — YET.
 *
 * `no-local-race.test.ts` and `settlement-from-server.test.ts` both name the
 * same real blocker found while trying (twice) to delete the local race
 * engine: `weekend.phase` (`gameStore.ts`) is advanced ONLY by the local
 * engine's own functions (`runQualifying`, `startRaceSession`,
 * `settleRaceWeekend`, ...). Delete the engine and nothing ever moves the
 * phase again — `LiveRacePanel` never mounts, and the server's live race,
 * which the client already renders correctly once connected, becomes
 * unreachable from the UI.
 *
 * The server side is now fixed (`server/src/lobby/live.ts`'s `publishPhase`,
 * wired from `95dce04`): `/race/live` sends a
 * `{type:'phase', lobbyId, phase, seasonNo, roundNo}` frame once on
 * subscribe (right after `state`) and again on every one of the lobby's four
 * phase transitions (`open→checkin`, `checkin→live`, `live→result`,
 * `result→open`) — including the two that happen with no race ticking,
 * which is exactly what a tick-gated implementation would have missed.
 *
 * This file proves the CLIENT half: `raceSocket.ts` adopts the frame and
 * freezes it across a disconnect exactly like `race`/`qualifying` already
 * do, and a new pure selector (`displayPhase` in `raceSlice.ts`) reports the
 * server's phase while a lobby seat exists, leaving the local, no-lobby path
 * (whatever `weekend.phase` was already going to be) completely alone — the
 * same shape of decision `displayRace`/`displayQualifying`/`displayFactory`/
 * `displaySponsors`/`displaySettlement` already established, and for the
 * same reason: `RaceWeekScreen.tsx` imports React Native and cannot run
 * under plain Node (`tsx --test`), so the decision has to live in a plain
 * function to be testable at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from 'zustand';
import {
  createRaceSocket,
  type RaceSocketState,
  type WebSocketCtor,
} from '@/lib/api/raceSocket';
import {
  createRaceSlice,
  displayPhase,
  type RaceSlice,
  type RaceSliceDeps,
} from '@/store/slices/raceSlice';
import type { ConnectionStatus, RaceSocket, RaceSocketOptions, SerialisedRace } from '@/lib/api/raceSocket';
import type { ApiResult } from '@/lib/api/identity';
import type { PitInput, PitResponse } from '@/lib/api/race';

const TOKEN = 'session-token-abc';
const LOBBY_ID = 'lobby-1';
const URL = 'ws://example.test/race/live';

/** Minimal, fully-scriptable stand-in for the DOM/RN `WebSocket` class —
 * copied from `race-socket.test.ts`'s own fake, which this module doc's
 * frame-handling proof reuses. */
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

  triggerOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  triggerMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  triggerClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function latestSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!s) throw new Error('no FakeWebSocket constructed');
  return s;
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
    control: { yellow: 0, vsc: 0, sc: 0, red: 0 },
    fastestLap: undefined,
    weather: { forecast: 0.1, wetAtStart: false },
    neutralised: undefined,
  };
}

function setupSocket() {
  FakeWebSocket.reset();
  const socket = createRaceSocket(
    { url: URL, lobbyId: LOBBY_ID, token: TOKEN },
    { WebSocketImpl: FakeWebSocket as unknown as WebSocketCtor },
  );
  return socket;
}

// ── 1. A `phase` frame lands in the store with its round and season ────────

test('a phase frame is adopted, carrying its season and round', () => {
  const socket = setupSocket();
  const ws = latestSocket();
  ws.triggerOpen();

  ws.triggerMessage({ type: 'phase', lobbyId: LOBBY_ID, phase: 'checkin', seasonNo: 2, roundNo: 5 });

  const s: RaceSocketState = socket.getState();
  assert.equal(s.phase, 'checkin');
  assert.equal(s.seasonNo, 2);
  assert.equal(s.roundNo, 5);
  socket.close();
});

test('a phase frame for a different lobby is ignored', () => {
  const socket = setupSocket();
  const ws = latestSocket();
  ws.triggerOpen();
  ws.triggerMessage({ type: 'phase', lobbyId: LOBBY_ID, phase: 'open', seasonNo: 1, roundNo: 1 });

  ws.triggerMessage({ type: 'phase', lobbyId: 'some-other-lobby', phase: 'live', seasonNo: 9, roundNo: 9 });

  const s = socket.getState();
  assert.equal(s.phase, 'open', 'the foreign frame must not have been applied');
  assert.equal(s.roundNo, 1);
  socket.close();
});

// ── 2. A `lap` frame must not clobber the stored phase ──────────────────────

test('a lap frame does not clobber the stored phase — same class of bug as qualifying', () => {
  const socket = setupSocket();
  const ws = latestSocket();
  ws.triggerOpen();

  ws.triggerMessage({ type: 'phase', lobbyId: LOBBY_ID, phase: 'live', seasonNo: 3, roundNo: 7 });
  ws.triggerMessage({ type: 'state', lobbyId: LOBBY_ID, race: makeRace(1) });
  assert.equal(socket.getState().phase, 'live', 'sanity: phase is set before the lap frame');

  ws.triggerMessage({ type: 'lap', lobbyId: LOBBY_ID, race: makeRace(2) });

  const s = socket.getState();
  assert.equal(s.phase, 'live', 'a lap frame must never wipe the stored phase');
  assert.equal(s.seasonNo, 3);
  assert.equal(s.roundNo, 7);
  assert.equal(s.race?.lap, 2, 'sanity: the lap frame itself was still applied');
  socket.close();
});

// ── 3. On disconnect, the last known phase survives ─────────────────────────

test('on disconnect, the last known phase, season and round survive', () => {
  const socket = setupSocket();
  const ws = latestSocket();
  ws.triggerOpen();
  ws.triggerMessage({ type: 'phase', lobbyId: LOBBY_ID, phase: 'live', seasonNo: 4, roundNo: 12 });

  ws.triggerClose();

  const s = socket.getState();
  assert.equal(s.status, 'disconnected');
  assert.equal(s.phase, 'live', 'phase must be frozen, not cleared, on disconnect');
  assert.equal(s.seasonNo, 4);
  assert.equal(s.roundNo, 12);
});

// ── raceSlice: the frame reaches the store, same as `race`/`qualifying` ────

function makeFakeSocket() {
  let status: ConnectionStatus = 'connecting';
  let race: SerialisedRace | null = null;
  let phase: RaceSocketState['phase'];
  let seasonNo: number | undefined;
  let roundNo: number | undefined;
  const listeners = new Set<(s: RaceSocketState) => void>();

  const socket: RaceSocket = {
    getState: () => ({ status, race, phase, seasonNo, roundNo }),
    addListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {},
  };

  return {
    socket,
    emit(next: Partial<RaceSocketState>) {
      if (next.status !== undefined) status = next.status;
      if (next.race !== undefined) race = next.race;
      if ('phase' in next) phase = next.phase;
      if ('seasonNo' in next) seasonNo = next.seasonNo;
      if ('roundNo' in next) roundNo = next.roundNo;
      const snapshot: RaceSocketState = { status, race, phase, seasonNo, roundNo };
      for (const l of [...listeners]) l(snapshot);
    },
  };
}

function setupStore() {
  const fake = makeFakeSocket();
  const createSocket = (_options: RaceSocketOptions): RaceSocket => fake.socket;
  const pitApi = async (): Promise<ApiResult<PitResponse>> => ({ ok: true, data: { ok: true, teamKey: 't', driverIdx: 0, compound: 'SOFT', lap: 1 } });

  const useStore = create<RaceSlice & RaceSliceDeps>()((set, get) => ({
    auth: { baseUrl: 'http://example.test', token: 'session-token-abc' },
    ...createRaceSlice(set as never, get as never, { createSocket, pitApi }),
  }));

  return { useStore, fake };
}

test('the store carries the server phase, season and round once connected', () => {
  const { useStore, fake } = setupStore();
  useStore.getState().connectRace(LOBBY_ID);

  fake.emit({ status: 'connected', race: makeRace(1), phase: 'checkin', seasonNo: 2, roundNo: 6 });

  const race = useStore.getState().race;
  assert.equal(race.phase, 'checkin');
  assert.equal(race.seasonNo, 2);
  assert.equal(race.roundNo, 6);
});

// ── 4/5. `displayPhase`: server while in a lobby, untouched with no lobby ──

test('displayPhase: with no lobby, reports no-lobby — local behaviour is unchanged', () => {
  const result = displayPhase({ lobbyId: undefined, phase: undefined, seasonNo: undefined, roundNo: undefined });
  assert.deepEqual(result, { kind: 'no-lobby' });
});

test('displayPhase: seated in a lobby but no phase frame yet is loading, not a guess', () => {
  const result = displayPhase({ lobbyId: LOBBY_ID, phase: undefined, seasonNo: undefined, roundNo: undefined });
  assert.deepEqual(result, { kind: 'loading' });
});

test('displayPhase: while in a lobby, the selector reports the server phase', () => {
  const result = displayPhase({ lobbyId: LOBBY_ID, phase: 'live', seasonNo: 3, roundNo: 9 });
  assert.deepEqual(result, { kind: 'ready', phase: 'live', seasonNo: 3, roundNo: 9 });
});

// ── 6. Round and season come from the server while in a lobby ──────────────

test('displayPhase: round and season are exactly what the server sent, not a local counter', () => {
  const result = displayPhase({ lobbyId: LOBBY_ID, phase: 'result', seasonNo: 5, roundNo: 14 });
  assert.deepEqual(result, { kind: 'ready', phase: 'result', seasonNo: 5, roundNo: 14 });
});
