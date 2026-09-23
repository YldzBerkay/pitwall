/**
 * Tests for the race HTTP client (`mobile/src/lib/api/race.ts`), which talks
 * to the server's `/race/checkin`, `/race/pit` and `/race/weekend-choices`
 * routes (`server/src/lobby/checkin.ts`, `server/src/lobby/weekendChoices.ts`).
 *
 * Follows the pattern of `mobile/test/smoke.test.ts`: a real `node:http`
 * server rather than a stubbed `fetch`, so header/body/serialisation
 * mistakes actually fail the test instead of being waved through by a stub
 * that only checks call arguments.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { checkin, pit, weekendChoices } from '@/lib/api/race';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/**
 * Stands up a real HTTP server whose response for each request is decided
 * by `respond`, and which records every request it receives (method, path,
 * headers, parsed JSON body) for the test to assert on afterwards.
 */
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

test('checkin() hits POST /race/checkin with {lobbyId} and a Bearer header', async () => {
  await withServer(
    () => ({ status: 200, body: { ok: true, teamKey: 'ferrari' } }),
    async (baseUrl, requests) => {
      const result = await checkin(baseUrl, TOKEN, LOBBY_ID);
      assert.equal(result.ok, true);
      assert.equal(requests.length, 1);
      const req = requests[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/race/checkin');
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(req.body, { lobbyId: LOBBY_ID });
    },
  );
});

test('weekendChoices() hits POST /race/weekend-choices with the given fields and a Bearer header', async () => {
  await withServer(
    () => ({ status: 200, body: { ok: true, teamKey: 'ferrari' } }),
    async (baseUrl, requests) => {
      const result = await weekendChoices(baseUrl, TOKEN, {
        lobbyId: LOBBY_ID,
        compound: 'MEDIUM',
        bias: 0.5,
        tactics: 'balanced',
        qualiRisk: 'safe',
      });
      assert.equal(result.ok, true);
      assert.equal(requests.length, 1);
      const req = requests[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/race/weekend-choices');
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(req.body, {
        lobbyId: LOBBY_ID,
        compound: 'MEDIUM',
        bias: 0.5,
        tactics: 'balanced',
        qualiRisk: 'safe',
      });
    },
  );
});

test('pit() hits POST /race/pit with {lobbyId, driverIdx, compound, lap} and a Bearer header', async () => {
  await withServer(
    () => ({ status: 200, body: { ok: true, teamKey: 'ferrari', driverIdx: 0, compound: 'SOFT', lap: 12 } }),
    async (baseUrl, requests) => {
      const result = await pit(baseUrl, TOKEN, { lobbyId: LOBBY_ID, driverIdx: 0, compound: 'SOFT', lap: 12 });
      assert.equal(result.ok, true);
      assert.equal(requests.length, 1);
      const req = requests[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/race/pit');
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(req.body, { lobbyId: LOBBY_ID, driverIdx: 0, compound: 'SOFT', lap: 12 });
    },
  );
});

test('pit() without a lap omits the field entirely, rather than sending undefined/null', async () => {
  await withServer(
    () => ({ status: 200, body: { ok: true, teamKey: 'ferrari', driverIdx: 1, compound: 'HARD', lap: 3 } }),
    async (baseUrl, requests) => {
      await pit(baseUrl, TOKEN, { lobbyId: LOBBY_ID, driverIdx: 1, compound: 'HARD' });
      assert.equal(requests.length, 1);
      const body = requests[0].body as Record<string, unknown>;
      assert.equal('lap' in body, false, 'lap key must not be present at all');
      assert.deepEqual(body, { lobbyId: LOBBY_ID, driverIdx: 1, compound: 'HARD' });
    },
  );
});

test('no teamKey is ever sent in the checkin, pit or weekendChoices request bodies', async () => {
  await withServer(
    () => ({ status: 200, body: { ok: true, teamKey: 'ferrari' } }),
    async (baseUrl, requests) => {
      await checkin(baseUrl, TOKEN, LOBBY_ID);
      await weekendChoices(baseUrl, TOKEN, { lobbyId: LOBBY_ID, compound: 'SOFT' });
      await pit(baseUrl, TOKEN, { lobbyId: LOBBY_ID, driverIdx: 0, compound: 'SOFT', lap: 5 });
      assert.equal(requests.length, 3);
      for (const req of requests) {
        const body = req.body as Record<string, unknown>;
        assert.equal('teamKey' in body, false, `teamKey must never appear in a request body: ${JSON.stringify(body)}`);
      }
    },
  );
});

/**
 * Each of the server's distinct 409 conflict codes, plus its 400/401/403
 * codes, must reach the caller AS THAT CODE — not flattened into one
 * generic failure. `lap_already_run` ("you were too late") and
 * `not_checked_in` ("you never checked in") need different player-facing
 * words, so the client must be able to tell them apart.
 */
const errorCases: { code: string; status: number }[] = [
  { code: 'unauthorized', status: 401 },
  { code: 'forbidden', status: 403 },
  { code: 'invalid_request', status: 400 },
  { code: 'wrong_phase', status: 409 },
  { code: 'race_not_started', status: 409 },
  { code: 'race_finished', status: 409 },
  { code: 'not_checked_in', status: 409 },
  { code: 'already_decided', status: 409 },
  { code: 'lap_already_run', status: 409 },
];

for (const { code, status } of errorCases) {
  test(`pit() surfaces the distinct server error code "${code}" (status ${status})`, async () => {
    await withServer(
      () => ({ status, body: { error: code } }),
      async (baseUrl) => {
        const result = await pit(baseUrl, TOKEN, { lobbyId: LOBBY_ID, driverIdx: 0, compound: 'SOFT' });
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
  // Nothing is listening on this port — the connection itself fails, which
  // must produce a different, recognisable shape than a server 4xx/5xx.
  const unreachableBaseUrl = 'http://127.0.0.1:1';
  const result = await checkin(unreachableBaseUrl, TOKEN, LOBBY_ID);
  assert.equal(result.ok, false);
  if (!result.ok) {
    // A real server error always carries an HTTP status; a network failure
    // must not be confusable with one, so it reports status 0 and a
    // network-specific error code distinct from any server error string.
    assert.equal(result.status, 0);
    assert.notEqual(result.error, 'lap_already_run');
    assert.notEqual(result.error, 'not_checked_in');
    assert.ok(result.error.length > 0);
  }
});
