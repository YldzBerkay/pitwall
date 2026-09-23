/**
 * Tests for the economy HTTP client (`mobile/src/lib/api/economy.ts`), which
 * talks to the server's single `POST /economy/action` route
 * (`server/src/economy/routes.ts`, `server/src/economy/actions.ts`).
 *
 * Follows the pattern of `mobile/test/race-api.test.ts`: a real `node:http`
 * server rather than a stubbed `fetch`, so header/body/serialisation
 * mistakes actually fail the test instead of being waved through by a stub
 * that only checks call arguments.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import {
  startUpgrade,
  startTraining,
  startSpyMission,
  claimUpgrade,
  claimTraining,
  claimSpyReport,
  skipUpgrade,
  skipTraining,
  skipSpy,
  upgradeFactory,
  convertGoldToRp,
  type SlotState,
} from '@/lib/api/economy';

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

const TOKEN = 'session-token-abc';
const LOBBY_ID = 'lobby-1';
const SERVER_NOW = '2026-09-24T12:00:00.000Z';

const okSlotState: SlotState = {
  serverNow: SERVER_NOW,
  lobbyId: LOBBY_ID,
  teamKey: 'ferrari',
  rp: 1000,
  gold: 10,
  car: { motor: 1, aero: 1, grip: 1 },
  factory: {},
  upgradesDone: {},
  jobs: [],
  teamValue: 1234,
  caps: { adsLeft: 8, convertibleLeft: 6 },
};

/**
 * One case per action kind (`server/src/economy/actions.ts`'s `runAction`
 * switch): each must hit `POST /economy/action` with the right `type` and
 * body, and a `Bearer` header — and never a `teamKey`.
 */
const cases: {
  name: string;
  call: (baseUrl: string) => Promise<unknown>;
  expectedBody: Record<string, unknown>;
}[] = [
  {
    name: 'startUpgrade',
    call: (baseUrl) => startUpgrade(baseUrl, TOKEN, { lobbyId: LOBBY_ID, label: 'motor' }),
    expectedBody: { type: 'startUpgrade', lobbyId: LOBBY_ID, label: 'motor' },
  },
  {
    name: 'startTraining',
    call: (baseUrl) => startTraining(baseUrl, TOKEN, { lobbyId: LOBBY_ID, driverIdx: 1 }),
    expectedBody: { type: 'startTraining', lobbyId: LOBBY_ID, driverIdx: 1 },
  },
  {
    name: 'startSpyMission',
    call: (baseUrl) => startSpyMission(baseUrl, TOKEN, { lobbyId: LOBBY_ID, targetTeamKey: 'mercedes' }),
    expectedBody: { type: 'startSpyMission', lobbyId: LOBBY_ID, targetTeamKey: 'mercedes' },
  },
  {
    name: 'claimUpgrade',
    call: (baseUrl) => claimUpgrade(baseUrl, TOKEN, { lobbyId: LOBBY_ID, jobId: 'job-1' }),
    expectedBody: { type: 'claimUpgrade', lobbyId: LOBBY_ID, jobId: 'job-1' },
  },
  {
    name: 'claimTraining',
    call: (baseUrl) => claimTraining(baseUrl, TOKEN, { lobbyId: LOBBY_ID, jobId: 'job-2' }),
    expectedBody: { type: 'claimTraining', lobbyId: LOBBY_ID, jobId: 'job-2' },
  },
  {
    name: 'claimSpyReport',
    call: (baseUrl) => claimSpyReport(baseUrl, TOKEN, { lobbyId: LOBBY_ID, jobId: 'job-3' }),
    expectedBody: { type: 'claimSpyReport', lobbyId: LOBBY_ID, jobId: 'job-3' },
  },
  {
    name: 'skipUpgrade',
    call: (baseUrl) => skipUpgrade(baseUrl, TOKEN, { lobbyId: LOBBY_ID, jobId: 'job-4' }),
    expectedBody: { type: 'skipUpgrade', lobbyId: LOBBY_ID, jobId: 'job-4' },
  },
  {
    name: 'skipTraining',
    call: (baseUrl) => skipTraining(baseUrl, TOKEN, { lobbyId: LOBBY_ID, jobId: 'job-5' }),
    expectedBody: { type: 'skipTraining', lobbyId: LOBBY_ID, jobId: 'job-5' },
  },
  {
    name: 'skipSpy',
    call: (baseUrl) => skipSpy(baseUrl, TOKEN, { lobbyId: LOBBY_ID, jobId: 'job-6' }),
    expectedBody: { type: 'skipSpy', lobbyId: LOBBY_ID, jobId: 'job-6' },
  },
  {
    name: 'upgradeFactory',
    call: (baseUrl) => upgradeFactory(baseUrl, TOKEN, { lobbyId: LOBBY_ID, code: 'wind_tunnel' }),
    expectedBody: { type: 'upgradeFactory', lobbyId: LOBBY_ID, code: 'wind_tunnel' },
  },
  {
    name: 'convertGoldToRp',
    call: (baseUrl) => convertGoldToRp(baseUrl, TOKEN, { lobbyId: LOBBY_ID, gold: 4 }),
    expectedBody: { type: 'convertGoldToRp', lobbyId: LOBBY_ID, gold: 4 },
  },
];

for (const { name, call, expectedBody } of cases) {
  test(`${name}() hits POST /economy/action with the right body and a Bearer header`, async () => {
    await withServer(
      () => ({ status: 200, body: okSlotState }),
      async (baseUrl, requests) => {
        const result = await call(baseUrl);
        assert.equal((result as { ok: boolean }).ok, true);
        assert.equal(requests.length, 1);
        const req = requests[0];
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/economy/action');
        assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
        assert.deepEqual(req.body, expectedBody);
      },
    );
  });
}

test('no teamKey is ever sent by any economy action call', async () => {
  await withServer(
    () => ({ status: 200, body: okSlotState }),
    async (baseUrl, requests) => {
      for (const { call } of cases) {
        await call(baseUrl);
      }
      assert.equal(requests.length, cases.length);
      for (const req of requests) {
        const body = req.body as Record<string, unknown>;
        assert.equal('teamKey' in body, false, `teamKey must never appear in a request body: ${JSON.stringify(body)}`);
      }
    },
  );
});

/**
 * Every code `server/src/economy/routes.ts`'s `STATUS_BY_CODE` maps, plus
 * its own 400/401/403 codes, must reach the caller AS THAT CODE — never
 * flattened into one generic failure. A player who cannot afford something
 * (`not_enough_rp`/`not_enough_gold`) and a player who hit a daily cap
 * (`cap_reached`) need different words.
 */
const errorCases: { code: string; status: number }[] = [
  { code: 'unknown_action', status: 400 },
  { code: 'bad_payload', status: 400 },
  { code: 'not_ready', status: 409 },
  { code: 'already_claimed', status: 409 },
  { code: 'already_running', status: 409 },
  { code: 'not_enough_rp', status: 409 },
  { code: 'not_enough_gold', status: 409 },
  { code: 'no_user', status: 400 },
  { code: 'not_found', status: 404 },
  { code: 'cap_reached', status: 409 },
  { code: 'no_economy', status: 404 },
  { code: 'unauthorized', status: 401 },
  { code: 'forbidden', status: 403 },
  { code: 'invalid_request', status: 400 },
];

for (const { code, status } of errorCases) {
  test(`economy action calls surface the distinct server error code "${code}" (status ${status})`, async () => {
    await withServer(
      () => ({ status, body: { error: code } }),
      async (baseUrl) => {
        const result = await startUpgrade(baseUrl, TOKEN, { lobbyId: LOBBY_ID, label: 'motor' });
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error, code);
          assert.equal(result.status, status);
        }
      },
    );
  });
}

test('a network failure is distinguishable from a server error response', async () => {
  const unreachableBaseUrl = 'http://127.0.0.1:1';
  const result = await startUpgrade(unreachableBaseUrl, TOKEN, { lobbyId: LOBBY_ID, label: 'motor' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 0);
    assert.notEqual(result.error, 'not_enough_rp');
    assert.notEqual(result.error, 'cap_reached');
    assert.ok(result.error.length > 0);
  }
});

test("buildSlotState's response lands in the caller, serverNow included", async () => {
  await withServer(
    () => ({ status: 200, body: okSlotState }),
    async (baseUrl) => {
      const result = await claimUpgrade(baseUrl, TOKEN, { lobbyId: LOBBY_ID, jobId: 'job-1' });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(result.data, okSlotState);
        assert.equal(result.data.serverNow, SERVER_NOW);
      }
    },
  );
});
