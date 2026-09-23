/**
 * Tests for the weekend-choices wiring in the race slice
 * (`mobile/src/store/slices/raceSlice.ts`), which sends the player's
 * pre-lights-out choices (setup bias, qualifying/start compound, qualifying
 * risk, pit-wall tactics) to `POST /race/weekend-choices`
 * (`mobile/src/lib/api/race.ts`'s `weekendChoices()`), and `connectRace`'s
 * refusal to open a socket with no session.
 *
 * Same pattern as `race-slice.test.ts`: a real `zustand` store, the real
 * slice, fakes only at the slice's own injection points. `race.ts` already
 * has its own wire-level tests (`race-api.test.ts`); this file proves the
 * slice's own logic — payload shape, the one-compound-field rule, and that a
 * `wrong_phase` rejection is never flattened into a generic failure.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from 'zustand';
import type { ApiResult } from '@/lib/api/identity';
import type { RaceActionResponse, WeekendChoicesInput } from '@/lib/api/race';
import type { RaceSocket, RaceSocketOptions } from '@/lib/api/raceSocket';
import { createRaceSlice, type RaceSlice, type RaceSliceDeps } from '@/store/slices/raceSlice';

interface WeekendChoicesCall {
  baseUrl: string;
  token: string;
  input: WeekendChoicesInput;
}

function setup(options: {
  token?: string | null;
  weekendChoicesResult?: ApiResult<RaceActionResponse>;
} = {}) {
  // `token: null` deliberately means "no session"; a plain omitted key means
  // "use the default" — `token: undefined` would collide with default-value
  // destructuring below, so `null` is the explicit way to ask for no token.
  const token = 'token' in options ? (options.token ?? undefined) : 'session-token-abc';
  const { weekendChoicesResult = { ok: true, data: { ok: true, teamKey: 'ferrari' } } } = options;

  const weekendChoicesCalls: WeekendChoicesCall[] = [];
  const weekendChoicesApi = async (
    baseUrl: string,
    tok: string,
    input: WeekendChoicesInput,
  ): Promise<ApiResult<RaceActionResponse>> => {
    weekendChoicesCalls.push({ baseUrl, token: tok, input });
    return weekendChoicesResult;
  };

  let socketCreateCalls = 0;
  const fakeSocket: RaceSocket = {
    getState: () => ({ status: 'connecting', race: null }),
    addListener: () => () => {},
    close: () => {},
  };
  const createSocket = (_options: RaceSocketOptions): RaceSocket => {
    socketCreateCalls += 1;
    return fakeSocket;
  };

  const useStore = create<RaceSlice & RaceSliceDeps>()((set, get) => ({
    auth: { baseUrl: 'http://example.test', token },
    ...createRaceSlice(set as never, get as never, { createSocket, weekendChoicesApi }),
  }));

  return { useStore, weekendChoicesCalls, socketCreateCalls: () => socketCreateCalls };
}

test('changing a choice sends POST /race/weekend-choices with the right payload', async () => {
  const { useStore, weekendChoicesCalls } = setup();

  const outcome = await useStore.getState().setWeekendChoices('lobby-1', { bias: 0.5 });

  assert.equal(outcome.ok, true);
  assert.equal(weekendChoicesCalls.length, 1);
  assert.equal(weekendChoicesCalls[0].baseUrl, 'http://example.test');
  assert.equal(weekendChoicesCalls[0].token, 'session-token-abc');
  assert.deepEqual(weekendChoicesCalls[0].input, { lobbyId: 'lobby-1', bias: 0.5 });
});

test('no teamKey is ever sent in the weekend-choices body', async () => {
  const { useStore, weekendChoicesCalls } = setup();

  await useStore.getState().setWeekendChoices('lobby-1', { compound: 'SOFT', tactics: 'aggressive', qualiRisk: 'aggressive' });

  assert.equal(weekendChoicesCalls.length, 1);
  assert.ok(!('teamKey' in weekendChoicesCalls[0].input), 'teamKey must never appear in the request body');
});

test('a wrong_phase rejection surfaces distinguishably, not as a generic error', async () => {
  const { useStore } = setup({ weekendChoicesResult: { ok: false, status: 409, error: 'wrong_phase' } });

  const outcome = await useStore.getState().setWeekendChoices('lobby-1', { compound: 'HARD' });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error, 'wrong_phase');
  // Must not be flattened into some generic/shared failure string.
  assert.notEqual((outcome as { error: string }).error, 'error');
  assert.notEqual((outcome as { error: string }).error, 'failed');
  const stored = useStore.getState().race.lastWeekendChoiceOutcome;
  assert.equal(stored?.ok, false);
  if (stored?.ok === false) assert.equal(stored.error, 'wrong_phase');
});

test('there is exactly one compound value in the weekend-choices payload', async () => {
  const { useStore, weekendChoicesCalls } = setup();

  await useStore.getState().setWeekendChoices('lobby-1', { compound: 'MEDIUM' });

  const keys = Object.keys(weekendChoicesCalls[0].input);
  const compoundKeys = keys.filter((k) => k.toLowerCase().includes('compound'));
  assert.deepEqual(compoundKeys, ['compound'], 'only a single, unqualified compound field must be sent');
});

test('connectRace with no session does not open a socket', () => {
  const { useStore, socketCreateCalls } = setup({ token: null });

  useStore.getState().connectRace('lobby-1');

  assert.equal(socketCreateCalls(), 0, 'no socket must be created without a session');
  // "signed out" and "session-invalid" are different situations for the
  // player (never logged in vs. a token the server rejected) and must not
  // collapse into the same status.
  assert.equal(useStore.getState().race.status, 'signed-out');
  assert.notEqual(useStore.getState().race.status, 'session-invalid');
});
