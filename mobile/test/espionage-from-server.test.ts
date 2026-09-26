/**
 * Espionage stops being computed on this client.
 *
 * The old local slice (`espionageSlice.ts`, now DELETED) never really
 * resolved a mission: `resolveMission`'s only caller was `skipMission` (pay
 * gold to force a result), and `startMission` returned `'pending'` while any
 * unresolved mission sat around — which, since nothing else ever resolved
 * one, meant an expired mission blocked every new one forever unless the
 * player paid.
 *
 * This suite proves the replacement: the server (`server/src/economy/
 * actions.ts`'s `startSpyMission`/`claimSpyReport`/`skipSpy`/`hideGarage`)
 * decides everything, and the client is a thin, passthrough view of it —
 * through the already-existing `economyApiSlice.ts` (start/claim/skip were
 * wired in an earlier task; `hideGarage` and the `spyResult`/`hide`/
 * `spyCooldownUntil` fields are new in this one) and the new pure selector
 * `espionageDisplay.ts` (mirrors `factoryDisplay.ts`'s own discipline: a
 * plain function over data, testable without importing a `.tsx`).
 *
 * Uses a real `node:http` server, the established pattern in
 * `race-api.test.ts` — not a stubbed `fetch` and not (only) the injected-fake
 * pattern `factory-from-server.test.ts` uses, so a header/body/serialisation
 * mistake in the real wire path actually fails a test here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { create } from 'zustand';
import type { SlotState, SlotStateJob } from '@/lib/api/economy';
import type { SettlementResponse } from '@/lib/api/settlement';
import {
  createEconomyApiSlice,
  type EconomyApiSlice,
  type EconomyApiSliceDeps,
} from '@/store/slices/economyApiSlice';
import {
  createSettlementApiSlice,
  type SettlementApiSlice,
  type SettlementApiSliceDeps,
} from '@/store/slices/settlementApiSlice';
import { displayEspionage } from '@/store/slices/espionageDisplay';
import type { Clock } from '@/store/slices/economyClock';
import {
  startSpyMission, claimSpyReport, hideGarage,
} from '@/lib/api/economy';
import { getSettlement } from '@/lib/api/settlement';

// ── real-server harness, same shape as race-api.test.ts's `withServer` ─────

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

async function withServer(
  respond: (req: CapturedRequest) => { status: number; body: unknown },
  fn: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
      const captured: CapturedRequest = { method: req.method, url: req.url, headers: req.headers, body: parsedBody };
      requests.push(captured);
      const { status, body } = respond(captured);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const LOBBY_ID = 'lobby-1';
const TOKEN = 'session-token-abc';

function makeSlotState(overrides: Partial<SlotState> = {}): SlotState {
  return {
    serverNow: '2026-09-24T00:00:00.000Z',
    lobbyId: LOBBY_ID,
    teamKey: 'ferrari',
    rp: 500,
    gold: 3,
    car: { motor: 61, aero: 58, grip: 72 },
    factory: {},
    upgradesDone: {},
    jobs: [],
    teamValue: 999,
    caps: { adsLeft: 8, convertibleLeft: 6 },
    hide: null,
    ...overrides,
  };
}

function makeSpyJob(overrides: Partial<SlotStateJob> = {}): SlotStateJob {
  return {
    jobId: 'spy-1',
    kind: 'spy',
    payload: { targetTeam: 'ridgeline', stat: 'motor', agent: 'free' },
    endsAt: '2026-09-25T00:00:00.000Z',
    ready: false,
    skipCostGold: 12,
    ...overrides,
  };
}

/** Fixed-tick fake clock, same helper `factory-from-server.test.ts` uses. */
function makeFixedClock(start = 0): Clock & { advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

type EconomyStore = EconomyApiSlice & EconomyApiSliceDeps;
function buildEconomyStore(baseUrl: string, injected: Parameters<typeof createEconomyApiSlice>[2] = {}) {
  return create<EconomyStore>((set, get) => ({
    auth: { baseUrl, token: TOKEN },
    ...createEconomyApiSlice(set as never, get as never, injected),
  }));
}

type SettlementStore = SettlementApiSlice & SettlementApiSliceDeps;
function buildSettlementStore(baseUrl: string) {
  return create<SettlementStore>((set, get) => ({
    auth: { baseUrl, token: TOKEN },
    ...createSettlementApiSlice(set as never, get as never),
  }));
}

// ── 1. starting a mission calls the server ─────────────────────────────────

test('1) starting a mission calls the server', async () => {
  await withServer(
    (req) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/economy/action');
      assert.deepEqual(req.body, {
        type: 'startSpyMission', lobbyId: LOBBY_ID, targetTeam: 'ridgeline', stat: 'motor', agent: 'free',
      });
      return { status: 200, body: makeSlotState({ jobs: [makeSpyJob()] }) };
    },
    async (baseUrl, requests) => {
      const store = buildEconomyStore(baseUrl);
      const outcome = await store.getState().economyApi.startSpyMission(LOBBY_ID, {
        targetTeam: 'ridgeline', stat: 'motor', agent: 'free',
      });
      assert.equal(outcome.ok, true);
      assert.equal(requests.length, 1);
    },
  );
});

// ── 2. a claimed mission's outcome comes from the SERVER response ─────────

test("2) a claimed mission's outcome comes from the server response, not local computation", async () => {
  // An arbitrary, non-round fine — nothing a client-side formula would ever
  // land on by coincidence, so adopting it proves passthrough, not luck.
  const serverSpyResult = { outcome: 'caught' as const, targetTeam: 'ridgeline', stat: 'motor', fine: 37 };
  await withServer(
    () => ({ status: 200, body: { ...makeSlotState({ rp: 463 }), spyResult: serverSpyResult } }),
    async (baseUrl) => {
      const store = buildEconomyStore(baseUrl);
      const outcome = await store.getState().economyApi.claimSpyReport(LOBBY_ID, 'spy-1');
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.deepEqual(
        outcome.state.spyResult,
        serverSpyResult,
        "the client must show exactly the server's outcome/fine — a client that picks its own result would write every mission as a success",
      );
    },
  );
});

// ── 3. an expired, claimed mission does not block a new one ───────────────

test('3) an expired, claimed mission does not block a new one — the inverse of the old lock', async () => {
  // The adopted slot still carries a READY spy job — the shape the server
  // sends for a mission whose timer passed but that has not been claimed
  // yet. The OLD client refused to even ask the server for a new mission
  // while any unresolved mission existed (`startMission`'s own `'pending'`).
  // The new client imposes no such local gate: it always asks the server,
  // and only the server's real answer (cooldown or not) can refuse it.
  await withServer(
    () => ({ status: 200, body: makeSlotState({ jobs: [] }) }),
    async (baseUrl, requests) => {
      const store = buildEconomyStore(baseUrl);
      await store.getState().economyApi.hydrate(LOBBY_ID).then(() => {
        // Force a stale ready spy job into the adopted slot, simulating one
        // the player has not claimed yet.
      });
      // Manually seed the store's slot with a READY (expired) spy job before
      // attempting to start a new one — this is exactly the shape a client
      // with a reintroduced local lock would refuse to act on.
      const current = store.getState().economyApi.slot!;
      (store.getState() as unknown as { economyApi: { slot: SlotState } }).economyApi.slot = {
        ...current, jobs: [makeSpyJob({ ready: true })],
      };

      const outcome = await store.getState().economyApi.startSpyMission(LOBBY_ID, {
        targetTeam: 'ridgeline', stat: 'aero', agent: 'free',
      });
      assert.equal(outcome.ok, true, 'the server must have been asked — no local block stopped it');
      assert.equal(requests.length, 2, 'hydrate + startSpyMission — the second call must actually have been sent');
    },
  );
});

// ── 4. cooldown and remaining time derive from the monotonic anchor ───────

test('4) the cooldown and a mission\'s remaining time derive from the monotonic anchor, never Date.now()', async () => {
  const clock = makeFixedClock(1_000);
  const slotState = makeSlotState({
    serverNow: '2026-09-24T00:00:00.000Z',
    jobs: [makeSpyJob({ endsAt: '2026-09-24T05:00:00.000Z' })],
    spyCooldownUntil: '2026-09-26T00:00:00.000Z',
  });
  await withServer(
    () => ({ status: 200, body: slotState }),
    async (baseUrl) => {
      const store = buildEconomyStore(baseUrl, { clock });
      await store.getState().economyApi.hydrate(LOBBY_ID);

      const first = displayEspionage(LOBBY_ID, store.getState().economyApi, clock);
      assert.equal(first.kind, 'ready');
      if (first.kind !== 'ready') return;
      assert.equal(first.currentMission?.remainingMs, 5 * 3_600_000);
      assert.equal(first.cooldownRemainingMs, 48 * 3_600_000);

      // Advance ONLY the injected monotonic clock, never the real wall clock.
      clock.advance(2 * 3_600_000);
      const second = displayEspionage(LOBBY_ID, store.getState().economyApi, clock);
      if (second.kind !== 'ready') return;
      assert.equal(second.currentMission?.remainingMs, 3 * 3_600_000);
      assert.equal(second.cooldownRemainingMs, 46 * 3_600_000);
    },
  );
});

// ── 5. hiding the garage calls the server with the chosen duration ────────

test('5) hiding the garage calls the server with the chosen duration', async () => {
  await withServer(
    (req) => {
      assert.deepEqual(req.body, { type: 'hideGarage', lobbyId: LOBBY_ID, days: 3 });
      return { status: 200, body: makeSlotState({ hide: { hidden: true, untilRound: 3 } }) };
    },
    async (baseUrl, requests) => {
      const store = buildEconomyStore(baseUrl);
      const outcome = await store.getState().economyApi.hideGarage(LOBBY_ID, 3);
      assert.equal(outcome.ok, true);
      assert.equal(requests.length, 1);
      if (!outcome.ok) return;
      assert.deepEqual(outcome.state.hide, { hidden: true, untilRound: 3 });
    },
  );
});

// ── 6. distinct server errors stay distinct ────────────────────────────────

test('6) distinct server errors stay distinct (cooldown vs. gold vs. RP vs. already-claimed)', async () => {
  const codeFor: Record<string, string> = {
    startSpyMission: 'cooldown',
    hideGarage: 'not_enough_gold',
    claimSpyReport: 'already_claimed',
  };
  await withServer(
    (req) => {
      const type = (req.body as { type: string }).type;
      return { status: 409, body: { error: codeFor[type] } };
    },
    async (baseUrl) => {
      const store = buildEconomyStore(baseUrl);
      const cooldown = await store.getState().economyApi.startSpyMission(LOBBY_ID, { targetTeam: 'ridgeline', stat: 'motor', agent: 'free' });
      const noGold = await store.getState().economyApi.hideGarage(LOBBY_ID, 3);
      const claimed = await store.getState().economyApi.claimSpyReport(LOBBY_ID, 'spy-1');

      assert.deepEqual(cooldown, { ok: false, error: 'cooldown' });
      assert.deepEqual(noGold, { ok: false, error: 'not_enough_gold' });
      assert.deepEqual(claimed, { ok: false, error: 'already_claimed' });
      const codes = new Set([cooldown, noGold, claimed].map((o) => (o as { error: string }).error));
      assert.equal(codes.size, 3, 'three different failures must stay three different words, never flattened');
    },
  );
});

// ── 7. with no lobby, the selector says so ─────────────────────────────────

test('7) with no lobby, the selector says so — no local missions', async () => {
  await withServer(
    () => ({ status: 200, body: makeSlotState({ jobs: [makeSpyJob()], rp: 999999 }) }),
    async (baseUrl) => {
      const store = buildEconomyStore(baseUrl);
      await store.getState().economyApi.hydrate(LOBBY_ID);

      const display = displayEspionage(undefined, store.getState().economyApi);
      assert.deepEqual(display, { kind: 'no-lobby' });
    },
  );
});

// ── 8. no file under mobile/src calls resolveMission any more ─────────────

test('8) no file under mobile/src calls resolveMission — the permanent guard against local computation', async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        const text = await readFile(full, 'utf8');
        if (/\bresolveMission\s*\(/.test(text)) offenders.push(full);
      }
    }
  }
  assert.deepEqual(offenders, [], `found a local resolveMission call: ${offenders.join(', ')}`);
});

// ── additions requested by the coordinator ─────────────────────────────────

test('9) the claimed outcome and fine shown are exactly the server\'s, for a success with no fine', async () => {
  const serverSpyResult = { outcome: 'success' as const, targetTeam: 'ridgeline', stat: 'aero', fine: undefined };
  await withServer(
    () => ({ status: 200, body: { ...makeSlotState(), spyResult: serverSpyResult } }),
    async (baseUrl) => {
      const store = buildEconomyStore(baseUrl);
      const outcome = await store.getState().economyApi.claimSpyReport(LOBBY_ID, 'spy-1');
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.state.spyResult?.outcome, 'success');
      assert.equal(outcome.state.spyResult?.fine, undefined, 'a success must never carry a fabricated fine');
    },
  );
});

test('10) hide state and cooldown come from SlotState', async () => {
  const slotState = makeSlotState({
    hide: { hidden: true, untilRound: 9 },
    spyCooldownUntil: '2026-09-30T00:00:00.000Z',
  });
  await withServer(
    () => ({ status: 200, body: slotState }),
    async (baseUrl) => {
      const store = buildEconomyStore(baseUrl);
      await store.getState().economyApi.hydrate(LOBBY_ID);
      const display = displayEspionage(LOBBY_ID, store.getState().economyApi);
      assert.equal(display.kind, 'ready');
      if (display.kind !== 'ready') return;
      assert.deepEqual(display.hide, { hidden: true, untilRound: 9 });
      assert.ok(display.cooldownRemainingMs !== undefined && display.cooldownRemainingMs > 0);
    },
  );
});

test('11) a rival attempt against the player appears in what the client reads after a race', async () => {
  const response: SettlementResponse = {
    settlement: {
      season: 1, round: 4, position: 2, prize: 100, sponsorIncome: 0, briefBonus: 0,
      bonusesEarned: [], streaksBroken: [], expired: [],
      rivalSpy: { team: 'ridgeline', success: true },
    },
  };
  await withServer(
    (req) => {
      assert.equal(req.method, 'GET');
      assert.match(req.url ?? '', /^\/economy\/settlement\?/);
      return { status: 200, body: response };
    },
    async (baseUrl) => {
      const store = buildSettlementStore(baseUrl);
      const outcome = await store.getState().settlementApi.hydrate(LOBBY_ID, 4);
      assert.equal(outcome.ok, true);
      assert.deepEqual(store.getState().settlementApi.breakdown?.rivalSpy, { team: 'ridgeline', success: true });
    },
  );
});

// Keep the direct wire-level client functions referenced so a future refactor
// of `lib/api/economy.ts`/`lib/api/settlement.ts` that drops an export fails
// THIS file's typecheck too, not just at the call sites above.
void startSpyMission;
void claimSpyReport;
void hideGarage;
void getSettlement;
