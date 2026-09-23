/**
 * Tests for the race zustand slice (`mobile/src/store/slices/raceSlice.ts`),
 * which sits between the two already-tested clients —
 * `mobile/src/lib/api/raceSocket.ts` (the `/race/live` WebSocket) and
 * `mobile/src/lib/api/race.ts` (`POST /race/pit`) — and the screens.
 *
 * This slice is NOT wired into `gameStore.ts`/`GameState` in this task (that
 * wiring is out of scope and `gameStore.ts` must not be touched here), so it
 * is exercised directly against a standalone zustand store built with the
 * real `zustand` `create()` — the same library `gameStore.ts` uses, but with
 * only the `auth` shape this slice actually reads, matching `authSlice`'s
 * `auth.baseUrl` / `auth.token` fields.
 *
 * The two collaborators are faked at the slice's own injection points
 * (`createSocket`, `pitApi`) rather than re-driving a fake `WebSocket` or a
 * real `http` server — `raceSocket.ts` and `race.ts` each have their own
 * dedicated test files already proving the wire-level behaviour. What this
 * file proves is the slice's OWN logic: how socket frames become store
 * state, and — the two rules repeatedly called out in the brief as
 * easy to get wrong — that a pit call while disconnected is refused
 * immediately and never queued for later delivery.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from 'zustand';
import type { ApiResult } from '@/lib/api/identity';
import type { PitInput, PitResponse } from '@/lib/api/race';
import type { ConnectionStatus, RaceSocket, RaceSocketOptions, SerialisedRace } from '@/lib/api/raceSocket';
import { createRaceSlice, type RaceSlice, type RaceSliceDeps } from '@/store/slices/raceSlice';

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
  };
}

/**
 * A fully hand-driven stand-in for `RaceSocket` — no `WebSocket`, no timers.
 * `emit` simulates whatever `raceSocket.ts` would have delivered through its
 * own listener after processing a frame.
 */
function makeFakeSocket() {
  let status: ConnectionStatus = 'connecting';
  let race: SerialisedRace | null = null;
  const listeners = new Set<(s: { status: ConnectionStatus; race: SerialisedRace | null }) => void>();
  let closeCalls = 0;
  let capturedOptions: RaceSocketOptions | undefined;

  const socket: RaceSocket = {
    getState: () => ({ status, race }),
    addListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closeCalls += 1;
    },
  };

  return {
    socket,
    listenerCount: () => listeners.size,
    closeCalls: () => closeCalls,
    capturedOptions: () => capturedOptions,
    setCapturedOptions: (o: RaceSocketOptions) => {
      capturedOptions = o;
    },
    emit(next: { status?: ConnectionStatus; race?: SerialisedRace | null }) {
      if (next.status !== undefined) status = next.status;
      if (next.race !== undefined) race = next.race;
      const snapshot = { status, race };
      for (const l of [...listeners]) l(snapshot);
    },
  };
}

interface PitCall {
  baseUrl: string;
  token: string;
  input: PitInput;
}

function setup(pitResult: ApiResult<PitResponse> = { ok: true, data: { ok: true, teamKey: 'ferrari', driverIdx: 0, compound: 'SOFT', lap: 12 } }) {
  const fake = makeFakeSocket();
  const pitCalls: PitCall[] = [];

  const createSocket = (options: RaceSocketOptions): RaceSocket => {
    fake.setCapturedOptions(options);
    return fake.socket;
  };

  const pitApi = async (baseUrl: string, token: string, input: PitInput): Promise<ApiResult<PitResponse>> => {
    pitCalls.push({ baseUrl, token, input });
    return pitResult;
  };

  const useStore = create<RaceSlice & RaceSliceDeps>()((set, get) => ({
    auth: { baseUrl: 'http://example.test', token: 'session-token-abc' },
    ...createRaceSlice(set as never, get as never, { createSocket, pitApi }),
  }));

  return { useStore, fake, pitCalls };
}

test('connectRace(lobbyId) subscribes; status goes connecting -> connected', () => {
  const { useStore, fake } = setup();

  useStore.getState().connectRace('lobby-1');
  assert.equal(useStore.getState().race.status, 'connecting');
  assert.equal(fake.listenerCount(), 1, 'the slice must have subscribed to the socket');

  fake.emit({ status: 'connected', race: makeRace(1) });
  assert.equal(useStore.getState().race.status, 'connected');
});

test('an incoming lap frame updates the stored race state', () => {
  const { useStore, fake } = setup();
  useStore.getState().connectRace('lobby-1');

  fake.emit({ status: 'connected', race: makeRace(3) });
  assert.equal(useStore.getState().race.data?.lap, 3);

  fake.emit({ race: makeRace(4) });
  assert.equal(useStore.getState().race.data?.lap, 4);
});

test('while disconnected, a pit call is refused and nothing is sent to the server', async () => {
  const { useStore, fake, pitCalls } = setup();
  useStore.getState().connectRace('lobby-1');
  fake.emit({ status: 'disconnected', race: makeRace(9) });

  const outcome = await useStore.getState().callPit(0, 'SOFT');

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error, 'disconnected');
  assert.equal(pitCalls.length, 0, 'no HTTP call must have been made while disconnected');
});

test('while disconnected, a pit call is not queued -- after reconnecting, no pending call is sent', async () => {
  const { useStore, fake, pitCalls } = setup();
  useStore.getState().connectRace('lobby-1');
  fake.emit({ status: 'disconnected', race: makeRace(9) });

  await useStore.getState().callPit(0, 'SOFT');
  assert.equal(pitCalls.length, 0);

  // Reconnect: the server races on; this must NOT trigger a delayed send of
  // the call that was refused above.
  fake.emit({ status: 'connected', race: makeRace(15) });

  assert.equal(pitCalls.length, 0, 'the refused call must not have been queued and flushed on reconnect');
});

test('a lap_already_run response becomes a distinct, player-meaningful outcome', async () => {
  const { useStore, fake } = setup({ ok: false, status: 409, error: 'lap_already_run' });
  useStore.getState().connectRace('lobby-1');
  fake.emit({ status: 'connected', race: makeRace(20) });

  const outcome = await useStore.getState().callPit(1, 'HARD');

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error, 'lap_already_run');
  const storedOutcome = useStore.getState().race.lastPitOutcome;
  assert.equal(storedOutcome?.ok, false);
  if (storedOutcome?.ok === false) {
    assert.equal(storedOutcome.error, 'lap_already_run');
  }
  // Must not be flattened into some generic/shared failure string.
  assert.notEqual((outcome as { error: string }).error, 'error');
  assert.notEqual((outcome as { error: string }).error, 'failed');
});

test('leaving the lobby unsubscribes', () => {
  const { useStore, fake } = setup();
  useStore.getState().connectRace('lobby-1');
  assert.equal(fake.listenerCount(), 1);

  useStore.getState().leaveRace();
  assert.equal(fake.listenerCount(), 0, 'the listener must have been removed');
  assert.equal(fake.closeCalls(), 1, 'the socket must have been closed');

  // A frame arriving after leaving (a straggler) must not resurrect state.
  fake.emit({ status: 'connected', race: makeRace(50) });
  assert.equal(useStore.getState().race.status, 'idle');
});

test('a pit call carries the driverIdx the caller chose', async () => {
  const { useStore, fake, pitCalls } = setup();
  useStore.getState().connectRace('lobby-1');
  fake.emit({ status: 'connected', race: makeRace(1) });

  await useStore.getState().callPit(1, 'HARD', 30);

  assert.equal(pitCalls.length, 1);
  assert.equal(pitCalls[0].input.driverIdx, 1);
  assert.equal(pitCalls[0].input.compound, 'HARD');
  assert.equal(pitCalls[0].input.lap, 30);
});
