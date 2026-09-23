/**
 * Tests for the live-race panel's data source (`displayRace`, added to
 * `mobile/src/store/slices/raceSlice.ts` alongside its sibling
 * `displayQualifying` — same reasoning, same file, same "no local fallback"
 * rule, added for this task).
 *
 * Context: `LiveRacePanel.tsx` currently renders `weekend.race`, which is
 * produced by the CLIENT's own local race engine — even for a player seated
 * in an online lobby, whose grid already comes from the server
 * (`displayQualifying`, landed in a previous task). That is the exact
 * inconsistency this task removes: a lobby-seated player must see the
 * server's race, or be told plainly that it is not available, never a
 * second, locally-computed one.
 *
 * `displayRace` is pure decision logic extracted from the `.tsx` (which
 * imports React Native/Expo and cannot run under plain Node's `tsx --test`)
 * so the decision itself — which of three sources to show, and whether the
 * server image is fresh or frozen — is testable in isolation, the same way
 * `displayQualifying` made the qualifying screen's equivalent decision
 * testable.
 *
 * Three distinct situations, three distinct answers (see the task brief):
 *  - connected, race running            -> `{ kind: 'server', stale: false }`
 *  - connected, no race yet             -> `{ kind: 'not-started' }`
 *    (NOT an empty/zeroed race object — a screen must be able to tell "the
 *    lobby hasn't gone green yet" apart from "here is lap 0 of a real race")
 *  - disconnected                       -> `{ kind: 'server', stale: true }`,
 *    carrying the LAST server image, never a locally-simulated one
 *  - outside any lobby (legacy solo)    -> `{ kind: 'local' }`, unchanged
 *
 * The fourth scenario below (lap frames advance what the selector returns)
 * exercises the listener path fixed in `56245d6` — before that fix, the
 * socket only notified subscribers when connection STATUS changed, so after
 * the first frame no lap ever reached the store and every socket test
 * reading `getState()` missed the bug because the store uses the listener,
 * not polling.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from 'zustand';
import type { ConnectionStatus, RaceSocket, RaceSocketState, SerialisedRace } from '@/lib/api/raceSocket';
import {
  createRaceSlice,
  displayRace,
  type RaceSlice,
  type RaceSliceDeps,
  type RaceSliceState,
} from '@/store/slices/raceSlice';

const TOKEN = 'session-token-abc';
const LOBBY_ID = 'lobby-1';
const URL = 'ws://example.test/race/live';

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

// ── displayRace: the pure selector, no rendering, no sockets. ─────────────

test('displayRace: connected with a race in progress returns the server race, not stale', () => {
  const serverRace = makeRace(5);
  const race: Pick<RaceSliceState, 'lobbyId' | 'status' | 'data'> = {
    lobbyId: LOBBY_ID,
    status: 'connected',
    data: serverRace,
  };

  const result = displayRace(race, undefined);
  assert.deepEqual(result, { kind: 'server', race: serverRace, stale: false });
});

test('displayRace: connected but the lobby has not gone green yet is "not-started", not an empty race', () => {
  const race: Pick<RaceSliceState, 'lobbyId' | 'status' | 'data'> = {
    lobbyId: LOBBY_ID,
    status: 'connected',
    data: null,
  };

  const result = displayRace(race, undefined);
  assert.deepEqual(result, { kind: 'not-started' });
  assert.notEqual((result as { kind: string }).kind, 'server', 'must not masquerade as a real (even empty) race');
});

test('displayRace: disconnected freezes on the last known server race and flags it stale — never a local one', () => {
  const lastKnown = makeRace(12);
  const localRace = { lap: 999, laps: 58 } as unknown; // would be a full RaceState in the real app
  const race: Pick<RaceSliceState, 'lobbyId' | 'status' | 'data'> = {
    lobbyId: LOBBY_ID,
    status: 'disconnected',
    data: lastKnown,
  };

  const result = displayRace(race, localRace);
  assert.deepEqual(result, { kind: 'server', race: lastKnown, stale: true });
  assert.notDeepEqual(result, { kind: 'local', race: localRace }, 'disconnected must not fall back to the local race');
});

test('displayRace: outside any lobby, the local (solo) race is used unchanged', () => {
  const localRace = { lap: 3, laps: 58 };
  const race: Pick<RaceSliceState, 'lobbyId' | 'status' | 'data'> = {
    lobbyId: undefined,
    status: 'idle',
    data: null,
  };

  const result = displayRace(race, localRace);
  assert.deepEqual(result, { kind: 'local', race: localRace });
});

// ── end to end: lap frames from the socket advance what the selector sees.
// This is the path `56245d6` fixed — the store must react to every frame,
// not only to a connection-status change. ─────────────────────────────────

function makeFakeSocket() {
  let status: RaceSocketState['status'] = 'connecting';
  let race: SerialisedRace | null = null;
  const listeners = new Set<(s: RaceSocketState) => void>();

  const socket: RaceSocket = {
    getState: () => ({ status, race, qualifying: undefined }),
    addListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {},
  };

  return {
    socket,
    emit(next: { status?: RaceSocketState['status']; race?: SerialisedRace | null }) {
      if (next.status !== undefined) status = next.status;
      if (next.race !== undefined) race = next.race;
      const snapshot: RaceSocketState = { status, race, qualifying: undefined };
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

test('displayRace: lap frames delivered through the listener advance the selector', () => {
  const { useStore, fake } = setupSlice();
  useStore.getState().connectRace(LOBBY_ID);

  fake.emit({ status: 'connected', race: makeRace(0) });
  let result = displayRace(useStore.getState().race, undefined);
  assert.deepEqual(result, { kind: 'server', race: makeRace(0), stale: false });

  fake.emit({ race: makeRace(1) });
  result = displayRace(useStore.getState().race, undefined);
  assert.deepEqual(result, { kind: 'server', race: makeRace(1), stale: false });

  fake.emit({ race: makeRace(2) });
  result = displayRace(useStore.getState().race, undefined);
  assert.deepEqual(result, { kind: 'server', race: makeRace(2), stale: false });
});

test('displayRace: once the socket drops, the store keeps the last lap and the selector marks it stale', () => {
  const { useStore, fake } = setupSlice();
  useStore.getState().connectRace(LOBBY_ID);

  fake.emit({ status: 'connected', race: makeRace(7) });
  fake.emit({ status: 'disconnected' });

  const result = displayRace(useStore.getState().race, undefined);
  assert.deepEqual(result, { kind: 'server', race: makeRace(7), stale: true });
});

// ── PROOF: a local fallback while disconnected must fail this suite. ──────
//
// This block is normally SKIPPED. To run the proof, flip
// `PROVE_NO_FALLBACK_IS_LOAD_BEARING` to true and re-run this file: the
// disconnected test below stops asserting "no local race" and instead
// asserts what a well-meaning-but-wrong "fall back to keep the screen
// alive" implementation would do, which the real `displayRace` refuses to
// do — so this block only exists as a manual, reviewable proof, not as a
// test that runs in CI (see the task's step 5 for the actual failing-output
// capture, done by temporarily editing `displayRace` itself).
const PROVE_NO_FALLBACK_IS_LOAD_BEARING = false;
if (PROVE_NO_FALLBACK_IS_LOAD_BEARING) {
  test('[PROOF] a fallback to the local race while disconnected would show a different race', () => {
    const lastKnown = makeRace(12);
    const localRace = { lap: 999 };
    const race: Pick<RaceSliceState, 'lobbyId' | 'status' | 'data'> = {
      lobbyId: LOBBY_ID,
      status: 'disconnected',
      data: lastKnown,
    };
    const result = displayRace(race, localRace) as { kind: string; race?: unknown };
    // A fallback implementation would return the local race here (kind
    // 'local', race: {lap: 999}) instead of the frozen server one — this
    // assertion is written to FAIL against that implementation.
    assert.notDeepEqual(result.race, localRace);
  });
}
