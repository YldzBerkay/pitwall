/**
 * Tests that the server-backed economy slice (`economyApiSlice.ts`) is
 * actually wired into the composed store (`gameStore.ts`/`GameState`), not
 * merely tested in isolation the way `economy-slice.test.ts` already does.
 *
 * Follows `economy-api.test.ts`'s pattern: a real `node:http` server rather
 * than a stubbed `fetch`, so this exercises the real HTTP path the
 * composed store actually takes (`useGameStore.getState().auth` ->
 * `lib/api/economy.ts` -> this server), not a mocked injection point.
 *
 * `gameStore.ts` calls `createEconomyApiSlice(set, get)` with no injected
 * fakes (same as `createRaceSlice(set, get)` in the real store), so there is
 * no seam to inject a fake clock or fake API call here — these tests drive
 * the real client against a real local server and read `auth`/`economyApi`
 * through the store's own `getState()`/`setState()`, the same way a screen
 * would.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { useGameStore } from '@/store/gameStore';
import { remainingMsFor } from '@/store/slices/economyApiSlice';
import type { SlotState, SlotStateJob } from '@/lib/api/economy';
import type { Clock } from '@/store/slices/economyClock';

/**
 * PRE-EXISTING, UNRELATED TO THIS SLICE: `gameStore.ts`'s `persist()`
 * middleware backs its storage with `@react-native-async-storage/async-storage`,
 * which (this package's own `AsyncStorage.ts`) reads/writes through
 * `window.localStorage` — nothing under plain Node provides a `window`.
 * `mobile/test/legacy-league-gone.test.ts`'s "gameStore still constructs"
 * test never noticed this because it only ever calls `getState()`, never an
 * action that calls `set()`. Any test that exercises a REAL mutating action
 * on the REAL composed store (which this task's brief calls for) needs
 * *some* `window.localStorage` to exist, the same way a jsdom-backed test
 * environment would provide one. This is a minimal in-memory stand-in for
 * exactly that — it does not touch `gameStore.ts` or the storage adapter,
 * it just supplies the global the adapter already expects.
 */
const memoryLocalStorage = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryLocalStorage.set(key, value);
    },
    removeItem: (key: string) => {
      memoryLocalStorage.delete(key);
    },
  },
};

const LOBBY_ID = 'lobby-1';
const TOKEN = 'session-token-abc';

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

/** Resets just the two pieces of state these tests touch, leaving the rest
 * of the real store (career, race, etc.) alone between tests. */
function resetAuthAndEconomy(baseUrl: string, token: string | undefined) {
  useGameStore.setState({
    auth: { baseUrl, token, status: 'idle' },
    economyApi: { ...useGameStore.getState().economyApi, lobbyId: undefined, slot: null, anchor: undefined, lastActionOutcome: undefined },
  });
}

test('economyApi is reachable from the composed store and does not collide with the local economy state', () => {
  const state = useGameStore.getState();

  // The local, Date.now()-driven economy slice is still intact with its own
  // signatures — `economySlice.ts`'s `convertGoldToRp` is synchronous and
  // takes one argument.
  assert.equal(typeof state.gold, 'number');
  assert.equal(typeof state.convertGoldToRp, 'function');
  const localResult = state.convertGoldToRp(0);
  assert.equal(typeof localResult, 'number', 'the local convertGoldToRp must still be the synchronous one, not shadowed');

  // The server-backed slice lives entirely under its own `economyApi` key,
  // per economyApiSlice.ts's module doc comment on why (three method names
  // would otherwise collide with existing, incompatible local methods).
  assert.ok(state.economyApi, 'economyApi must be reachable from the composed GameState');
  assert.equal(state.economyApi.slot, null);
  assert.equal(typeof state.economyApi.hydrate, 'function');
  assert.equal(typeof state.economyApi.convertGoldToRp, 'function');

  // The server-backed one is async and takes (lobbyId, gold) — a genuinely
  // different function from the local one, not an accidental shadow.
  const serverResult = state.economyApi.convertGoldToRp(LOBBY_ID, 0);
  assert.ok(serverResult instanceof Promise, 'the server-backed convertGoldToRp must be the async one');
  // Swallow the network attempt (no session configured yet in this test).
  serverResult.catch(() => {});
});

test('hydrate(lobbyId) calls GET /economy/state and lands the whole SlotState, serverNow included', async () => {
  const slotState = makeSlotState({ rp: 777 });
  await withServer(
    () => ({ status: 200, body: slotState }),
    async (baseUrl, requests) => {
      resetAuthAndEconomy(baseUrl, TOKEN);

      const outcome = await useGameStore.getState().economyApi.hydrate(LOBBY_ID);

      assert.deepEqual(outcome, { ok: true, state: slotState });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'GET');
      assert.match(requests[0].url ?? '', /^\/economy\/state\?lobbyId=lobby-1$/);
      assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`);
      // A cold-opened screen must not have had to mutate anything to get here
      // — this was a GET, and no POST /economy/action was ever sent.

      const { economyApi } = useGameStore.getState();
      assert.deepEqual(economyApi.slot, slotState);
      assert.equal(economyApi.slot?.serverNow, slotState.serverNow);
      assert.ok(economyApi.anchor, 'hydrate must anchor the monotonic clock, exactly like an action response does');
    },
  );
});

test('the monotonic anchor is refreshed by every server response, not only the first', async () => {
  const responses = [
    makeSlotState({ serverNow: '2026-09-24T00:00:00.000Z', rp: 1 }),
    makeSlotState({ serverNow: '2026-09-25T00:00:00.000Z', rp: 2 }),
  ];
  let call = 0;
  await withServer(
    () => ({ status: 200, body: responses[call++] }),
    async (baseUrl) => {
      resetAuthAndEconomy(baseUrl, TOKEN);

      const beforeFirst = performance.now();
      await useGameStore.getState().economyApi.hydrate(LOBBY_ID);
      const anchorAfterFirst = useGameStore.getState().economyApi.anchor;
      assert.ok(anchorAfterFirst);
      assert.equal(anchorAfterFirst.serverNowMs, Date.parse(responses[0].serverNow));

      // A tiny real delay so a second monotonic reading is provably later
      // than the first, then a second response with a different serverNow.
      await new Promise((r) => setTimeout(r, 5));

      await useGameStore.getState().economyApi.hydrate(LOBBY_ID);
      const anchorAfterSecond = useGameStore.getState().economyApi.anchor;
      assert.ok(anchorAfterSecond);

      // THE POINT: the anchor must reflect the SECOND response, not the
      // first. A slice that only anchors once would still show `rp: 1`'s
      // serverNow here.
      assert.equal(anchorAfterSecond.serverNowMs, Date.parse(responses[1].serverNow));
      assert.notEqual(
        anchorAfterSecond.serverNowMs,
        anchorAfterFirst.serverNowMs,
        'the anchor must change between the two responses',
      );
      assert.ok(
        anchorAfterSecond.monotonicAtReceipt > anchorAfterFirst.monotonicAtReceipt,
        'the monotonic reading itself must also have been retaken, not reused from the first response',
      );
      assert.ok(anchorAfterSecond.monotonicAtReceipt >= beforeFirst);
    },
  );
});

test('distinct server error codes stay distinct in the store', async () => {
  await withServer(
    (req) => {
      const body = req.body as { type: string };
      if (body.type === 'startUpgrade') return { status: 409, body: { error: 'not_enough_rp' } };
      if (body.type === 'convertGoldToRp') return { status: 409, body: { error: 'cap_reached' } };
      throw new Error(`unexpected action type ${body.type}`);
    },
    async (baseUrl) => {
      resetAuthAndEconomy(baseUrl, TOKEN);

      const rpOutcome = await useGameStore.getState().economyApi.startUpgrade(LOBBY_ID, 'motor');
      const capOutcome = await useGameStore.getState().economyApi.convertGoldToRp(LOBBY_ID, 4);

      assert.deepEqual(rpOutcome, { ok: false, error: 'not_enough_rp' });
      assert.deepEqual(capOutcome, { ok: false, error: 'cap_reached' });
      assert.notEqual((rpOutcome as { error: string }).error, (capOutcome as { error: string }).error);
    },
  );
});

test('with no session, hydrate refuses locally and nothing is sent', async () => {
  await withServer(
    () => ({ status: 200, body: makeSlotState() }),
    async (baseUrl, requests) => {
      resetAuthAndEconomy(baseUrl, undefined);

      const outcome = await useGameStore.getState().economyApi.hydrate(LOBBY_ID);

      assert.deepEqual(outcome, { ok: false, error: 'not_signed_in' });
      assert.equal(requests.length, 0, 'no request may be sent without a session');
      assert.equal(useGameStore.getState().economyApi.slot, null);
    },
  );
});

test('a job\'s remaining time still derives from the anchor, not Date.now(), once wired into the real store', async () => {
  const job: SlotStateJob = {
    jobId: 'job-1',
    kind: 'upgrade',
    payload: { stat: 'motor' },
    endsAt: '2026-09-24T05:00:00.000Z',
    ready: false,
    skipCostGold: 25,
  };
  const slotState = makeSlotState({ serverNow: '2026-09-24T00:00:00.000Z', jobs: [job] });

  await withServer(
    () => ({ status: 200, body: slotState }),
    async (baseUrl) => {
      resetAuthAndEconomy(baseUrl, TOKEN);
      await useGameStore.getState().economyApi.hydrate(LOBBY_ID);

      const { economyApi } = useGameStore.getState();

      // A fixed fake clock proves the derivation reads the stored anchor,
      // not this test process's real Date.now() (which the exploit this
      // whole stage exists to close would otherwise let a device manipulate).
      // It starts at the anchor's own monotonic reading (taken from the
      // real `defaultClock` inside the real slice — this composed store has
      // no seam to inject a fake clock) so "no time has passed yet" reads
      // as exactly 0 elapsed, matching `estimatedServerNowMs`'s own math.
      let t = economyApi.anchor?.monotonicAtReceipt ?? 0;
      const fixedClock: Clock = { now: () => t };
      assert.equal(remainingMsFor(economyApi, job, fixedClock), 5 * 3_600_000);

      t += 2 * 3_600_000;
      assert.equal(remainingMsFor(economyApi, job, fixedClock), 3 * 3_600_000);

      // Moving the real wall clock (what device-clock tampering would do)
      // must have no bearing at all: fixedClock never moved with it, and the
      // anchor's own serverNowMs/monotonicAtReceipt are untouched by it.
      assert.equal(economyApi.anchor?.serverNowMs, Date.parse(slotState.serverNow));
    },
  );
});
