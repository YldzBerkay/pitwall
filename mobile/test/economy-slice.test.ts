/**
 * Tests for the server-backed economy slice
 * (`mobile/src/store/slices/economyApiSlice.ts`), which sits between the
 * already-tested client (`mobile/src/lib/api/economy.ts`) and the screens.
 *
 * Not wired into `gameStore.ts`/`GameState` in this task (see this task's
 * brief: deleting the local economy slices and rewiring screens is the next
 * task) — exercised directly against a standalone zustand store, same
 * pattern as `race-slice.test.ts`.
 *
 * The API calls are faked at the slice's own injection points; `economy.ts`
 * has its own dedicated wire-level tests (`economy-api.test.ts`). What this
 * file proves is the slice's OWN logic: a successful response lands the
 * WHOLE slot state in the store with a `serverNow`-anchored clock, a failed
 * response is reported with the server's own distinct code, no session
 * means no request is ever sent, and the remaining-time selector reads that
 * anchor rather than `Date.now()`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from 'zustand';
import type { ApiResult } from '@/lib/api/identity';
import type { SlotState, SlotStateJob } from '@/lib/api/economy';
import {
  createEconomyApiSlice,
  remainingMsFor,
  type EconomyApiSlice,
  type EconomyApiSliceDeps,
  type EconomyApiSliceInjected,
} from '@/store/slices/economyApiSlice';
import type { Clock } from '@/store/slices/economyClock';

const LOBBY_ID = 'lobby-1';
const TOKEN = 'session-token-abc';
const BASE_URL = 'http://example.test';

function makeSlotState(overrides: Partial<SlotState> = {}): SlotState {
  return {
    serverNow: '2026-09-24T00:00:00.000Z',
    lobbyId: LOBBY_ID,
    teamKey: 'ferrari',
    rp: 500,
    gold: 3,
    car: { motor: 1, aero: 1, grip: 1 },
    factory: {},
    upgradesDone: {},
    jobs: [],
    teamValue: 999,
    caps: { adsLeft: 8, convertibleLeft: 6 },
    ...overrides,
  };
}

/** A fixed-tick fake clock: `now()` always returns the same value unless advanced. */
function makeFixedClock(start = 0): Clock & { advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

type Store = EconomyApiSlice & EconomyApiSliceDeps;

function buildStore(injected: EconomyApiSliceInjected = {}, auth: EconomyApiSliceDeps['auth'] = { baseUrl: BASE_URL, token: TOKEN }) {
  return create<Store>((set, get) => ({
    auth,
    ...createEconomyApiSlice(set as never, get as never, injected),
  }));
}

test('a successful action lands the whole SlotState in the store, serverNow included', async () => {
  const slotState = makeSlotState({ rp: 250 });
  let capturedArgs: unknown[] = [];
  const startUpgradeApi = async (baseUrl: string, token: string, input: unknown): Promise<ApiResult<SlotState>> => {
    capturedArgs = [baseUrl, token, input];
    return { ok: true, data: slotState };
  };

  const store = buildStore({ startUpgradeApi });
  const outcome = await store.getState().economyApi.startUpgrade(LOBBY_ID, 'motor');

  assert.deepEqual(outcome, { ok: true, state: slotState });
  assert.deepEqual(capturedArgs, [BASE_URL, TOKEN, { lobbyId: LOBBY_ID, label: 'motor' }]);

  const { economyApi } = store.getState();
  assert.equal(economyApi.lobbyId, LOBBY_ID);
  assert.deepEqual(economyApi.slot, slotState);
  assert.equal(economyApi.slot?.serverNow, slotState.serverNow);
  assert.ok(economyApi.anchor, 'a serverNow-anchored clock reading must be stored alongside the slot');
  assert.deepEqual(economyApi.lastActionOutcome, { ok: true, state: slotState });
});

test('a failed action reports the server\'s own distinct code without touching the stored slot', async () => {
  const claimUpgradeApi = async (): Promise<ApiResult<SlotState>> => ({ ok: false, status: 409, error: 'not_ready' });
  const store = buildStore({ claimUpgradeApi });

  const outcome = await store.getState().economyApi.claimUpgrade(LOBBY_ID, 'job-1');

  assert.deepEqual(outcome, { ok: false, error: 'not_ready' });
  assert.equal(store.getState().economyApi.slot, null, 'a failed call must not fabricate a slot');
  assert.deepEqual(store.getState().economyApi.lastActionOutcome, { ok: false, error: 'not_ready' });
});

test('a different failure code (cap_reached) is reported distinctly from not_enough_rp', async () => {
  const convertGoldToRpApi = async (): Promise<ApiResult<SlotState>> => ({ ok: false, status: 409, error: 'cap_reached' });
  const store = buildStore({ convertGoldToRpApi });

  const outcome = await store.getState().economyApi.convertGoldToRp(LOBBY_ID, 4);

  assert.deepEqual(outcome, { ok: false, error: 'cap_reached' });
  assert.notEqual((outcome as { error: string }).error, 'not_enough_rp');
});

test('with no session, the call is refused locally and no request is ever sent', async () => {
  let called = false;
  const startTrainingApi = async (): Promise<ApiResult<SlotState>> => {
    called = true;
    return { ok: true, data: makeSlotState() };
  };
  const store = buildStore({ startTrainingApi }, { baseUrl: BASE_URL, token: undefined });

  const outcome = await store.getState().economyApi.startTraining(LOBBY_ID, 0);

  assert.deepEqual(outcome, { ok: false, error: 'not_signed_in' });
  assert.equal(called, false, 'no request may be sent without a session');
});

test('remainingMsFor reads the stored anchor, not Date.now()', async () => {
  const clock = makeFixedClock(0);
  const job: SlotStateJob = {
    jobId: 'job-1',
    kind: 'upgrade',
    payload: { stat: 'motor' },
    endsAt: '2026-09-24T05:00:00.000Z',
    ready: false,
    skipCostGold: 25,
  };
  const slotState = makeSlotState({ serverNow: '2026-09-24T00:00:00.000Z', jobs: [job] });
  const startUpgradeApi = async (): Promise<ApiResult<SlotState>> => ({ ok: true, data: slotState });

  const store = buildStore({ startUpgradeApi, clock });
  await store.getState().economyApi.startUpgrade(LOBBY_ID, 'motor');

  const { economyApi } = store.getState();
  assert.equal(remainingMsFor(economyApi, job, clock), 5 * 3_600_000);

  // Real time passes (the injected clock ticks); the remaining time must
  // fall accordingly, still without ever consulting Date.now().
  clock.advance(2 * 3_600_000);
  assert.equal(remainingMsFor(economyApi, job, clock), 3 * 3_600_000);
});

test('remainingMsFor is undefined before any slot has been received', () => {
  const job: SlotStateJob = {
    jobId: 'job-1',
    kind: 'training',
    payload: {},
    endsAt: '2026-09-24T05:00:00.000Z',
    ready: false,
    skipCostGold: 0,
  };
  assert.equal(remainingMsFor({ anchor: undefined }, job), undefined);
});
