/**
 * Tests for moving the factory/car-upgrade screen (`DevelopmentScreen.tsx`)
 * onto the server-backed economy (`economyApiSlice.ts`), through the new
 * pure selector `factoryDisplay.ts` — the same "decisions live in a pure
 * function, not the .tsx" discipline `raceSlice.ts`'s
 * `displayRace`/`displayQualifying` already established, since a `.tsx`
 * screen cannot be imported under plain Node.
 *
 * Follows `economy-slice.test.ts`'s pattern: a standalone zustand store with
 * `createEconomyApiSlice`'s own injection points faked, no HTTP server and
 * no `gameStore.ts` needed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from 'zustand';
import type { ApiResult } from '@/lib/api/identity';
import type { SlotState, SlotStateJob } from '@/lib/api/economy';
import {
  createEconomyApiSlice,
  type EconomyApiSlice,
  type EconomyApiSliceDeps,
  type EconomyApiSliceInjected,
} from '@/store/slices/economyApiSlice';
import type { Clock } from '@/store/slices/economyClock';
import { displayFactory, STAT_LABEL_TO_SERVER } from '@/store/slices/factoryDisplay';

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
    car: { motor: 61, aero: 58, grip: 72 },
    factory: { wind_tunnel: 3 },
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

test('opening the screen hydrates from the server and the selector lands the real state', async () => {
  const slotState = makeSlotState({ rp: 777, gold: 12 });
  const getEconomyStateApi = async (): Promise<ApiResult<SlotState>> => ({ ok: true, data: slotState });

  const store = buildStore({ getEconomyStateApi });
  const outcome = await store.getState().economyApi.hydrate(LOBBY_ID);
  assert.equal(outcome.ok, true);

  const display = displayFactory(LOBBY_ID, store.getState().economyApi);
  assert.equal(display.kind, 'ready');
  if (display.kind !== 'ready') throw new Error('unreachable');
  assert.equal(display.rp, 777);
  assert.equal(display.gold, 12);
  assert.deepEqual(display.carStats, [
    { label: 'MOTOR', value: 61 },
    { label: 'AERO', value: 58 },
    { label: 'GRIP', value: 72 },
  ]);
  assert.deepEqual(display.factoryLevels, { wind_tunnel: 3 });
  assert.equal(display.currentUpgrade, undefined, 'no job means the bench is free');
});

test('a countdown derives from the anchor, not Date.now()', async () => {
  const clock = makeFixedClock(1_000);
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

  const first = displayFactory(LOBBY_ID, store.getState().economyApi, clock);
  assert.equal(first.kind, 'ready');
  if (first.kind !== 'ready') throw new Error('unreachable');
  assert.ok(first.currentUpgrade);
  assert.equal(first.currentUpgrade?.remainingMs, 5 * 3_600_000);

  // Advance only the injected monotonic clock — never the real wall clock —
  // and prove the countdown moves by exactly that much, the same proof
  // `economy-slice.test.ts`'s `remainingMsFor` test already makes for the
  // underlying primitive; this proves the SELECTOR wires it through too.
  clock.advance(2 * 3_600_000);
  const second = displayFactory(LOBBY_ID, store.getState().economyApi, clock);
  if (second.kind !== 'ready') throw new Error('unreachable');
  assert.equal(second.currentUpgrade?.remainingMs, 3 * 3_600_000);
});

test('starting an upgrade calls the server (label translated) and the selector adopts the returned state', async () => {
  let capturedArgs: unknown[] = [];
  const jobAfterStart: SlotStateJob = {
    jobId: 'job-9',
    kind: 'upgrade',
    payload: { stat: 'aero' },
    endsAt: '2026-09-25T00:00:00.000Z',
    ready: false,
    skipCostGold: 40,
  };
  const slotAfterStart = makeSlotState({ rp: 250, jobs: [jobAfterStart] });
  const startUpgradeApi = async (baseUrl: string, token: string, input: unknown): Promise<ApiResult<SlotState>> => {
    capturedArgs = [baseUrl, token, input];
    return { ok: true, data: slotAfterStart };
  };

  const store = buildStore({ startUpgradeApi });
  // The screen's label is uppercase ('AERO'); the wire format is lowercase.
  const outcome = await store.getState().economyApi.startUpgrade(LOBBY_ID, STAT_LABEL_TO_SERVER['AERO']);

  assert.equal(outcome.ok, true);
  assert.deepEqual(capturedArgs, [BASE_URL, TOKEN, { lobbyId: LOBBY_ID, label: 'aero' }]);

  const display = displayFactory(LOBBY_ID, store.getState().economyApi);
  assert.equal(display.kind, 'ready');
  if (display.kind !== 'ready') throw new Error('unreachable');
  assert.equal(display.rp, 250, 'the RETURNED slot must be adopted, not fabricated locally');
  assert.equal(display.currentUpgrade?.jobId, 'job-9');
  assert.equal(display.currentUpgrade?.label, 'AERO', 'the server\'s lowercase stat must be translated back for the UI');
});

test('distinct server errors stay distinct (afford vs. daily cap)', async () => {
  const startUpgradeApi = async (): Promise<ApiResult<SlotState>> => ({ ok: false, status: 409, error: 'not_enough_rp' });
  const upgradeFactoryApi = async (): Promise<ApiResult<SlotState>> => ({ ok: false, status: 409, error: 'cap_reached' });
  const store = buildStore({ startUpgradeApi, upgradeFactoryApi });

  const cantAfford = await store.getState().economyApi.startUpgrade(LOBBY_ID, 'motor');
  const capped = await store.getState().economyApi.upgradeFactory(LOBBY_ID, 'manufacturing');

  assert.deepEqual(cantAfford, { ok: false, error: 'not_enough_rp' });
  assert.deepEqual(capped, { ok: false, error: 'cap_reached' });
  assert.notEqual(
    (cantAfford as { error: string }).error,
    (capped as { error: string }).error,
    '"you cannot afford this" and "you hit today\'s cap" must stay distinct words, never flattened',
  );
});

test('with no lobby, the selector says "no lobby" — it does not fall back to local economy numbers', async () => {
  // A slot IS present in economyApi (e.g. left over from a previous lobby),
  // proving this is a deliberate branch and not just "slot is null".
  const slotState = makeSlotState({ rp: 999999, gold: 999999 });
  const getEconomyStateApi = async (): Promise<ApiResult<SlotState>> => ({ ok: true, data: slotState });
  const store = buildStore({ getEconomyStateApi });
  await store.getState().economyApi.hydrate(LOBBY_ID);

  const display = displayFactory(undefined, store.getState().economyApi);

  assert.deepEqual(display, { kind: 'no-lobby' });
});
