/**
 * THE CONSTRUCTORS' TABLE IS READ, NOT ADVANCED.
 *
 * Removing the local race engine and local settlement (`823ddd4`) left
 * `gameStore.ts`'s `standings` field with nothing to move it any more — it
 * used to be advanced by the local settlement's `applyRacePoints`, which is
 * gone. The table on screen (`LeagueScreen.tsx`) was left reading that
 * frozen, seeded array: the player races, the server records results, and
 * the table never changes. This is the second-reality bug this whole
 * migration exists to delete.
 *
 * The server does not store a table either — `server/src/lobby/runner.ts`'s
 * `standingsBeforeRound` docblock is explicit that a stored table could
 * diverge from the races, so it is re-derived by replay every time
 * (`GET /lobby/standings`, `server/src/lobby/routes.ts`).
 *
 * ── WHAT THIS FILE COVERS, AND WHAT IT DELIBERATELY DOES NOT ──────────────
 * It covers the READ PATH end to end: the HTTP client (`lib/api/standings.ts`),
 * the slice that holds the answer (`standingsApiSlice.ts`) and the pure
 * selector a screen reads (`standingsDisplay.ts`) — including the rule
 * every other display selector in this codebase already follows
 * (`displayRace`, `displayFactory`, `displaySponsors`, `displaySettlement`):
 * with no lobby it SAYS SO rather than falling back to the local seed table.
 *
 * It does NOT claim `gameStore.ts`'s local `standings` field is gone. It is
 * not — `LeagueScreen.tsx` still needs a migration of its own to switch from
 * it to `displayStandings`, and that is this task's job, not this file's.
 * What IS asserted below is narrower and true: nothing in the server-standings
 * read path computes points, and the selector never reaches for the local
 * array.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { create } from 'zustand';
import type { ApiResult } from '@/lib/api/identity';
import { getStandings, type StandingsResponse } from '@/lib/api/standings';
import {
  createStandingsApiSlice,
  type StandingsApiSlice,
  type StandingsApiSliceDeps,
  type StandingsApiSliceInjected,
} from '@/store/slices/standingsApiSlice';
import { displayStandings } from '@/store/slices/standingsDisplay';
import type { TeamStanding } from '@pitwall/shared/teams';

const TOKEN = 'session-token-abc';
const LOBBY_ID = 'lobby-1';
const BASE_URL = 'http://example.test';

/** The exact rows `GET /lobby/standings` returns for a lobby with one race run. */
const SERVER_TABLE: TeamStanding[] = [
  { teamKey: 'aurora', points: 25, position: 1 },
  { teamKey: 'velox', points: 18, position: 2 },
  { teamKey: 'axion', points: 0, position: 3 },
];

type Store = StandingsApiSlice & StandingsApiSliceDeps;

function buildStore(
  injected: StandingsApiSliceInjected = {},
  auth: StandingsApiSliceDeps['auth'] = { baseUrl: BASE_URL, token: TOKEN },
) {
  return create<Store>((set, get) => ({
    auth,
    ...createStandingsApiSlice(set as never, get as never, injected),
  }));
}

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
}

async function withServer(
  respond: () => { status: number; body: unknown },
  fn: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const { status, body } = respond();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  try {
    await fn(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

// ── 1. THE TABLE IS FETCHED FROM THE SERVER AND LANDS IN THE STORE ────────

test('the client asks GET /lobby/standings for its own lobby, with a Bearer header, and no teamKey', async () => {
  await withServer(
    () => ({ status: 200, body: { standings: SERVER_TABLE } satisfies StandingsResponse }),
    async (baseUrl, requests) => {
      const res = await getStandings(baseUrl, TOKEN, { lobbyId: LOBBY_ID });
      assert.equal(res.ok, true);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.method, 'GET');
      assert.match(requests[0]!.url ?? '', /^\/lobby\/standings\?/);
      const params = new URLSearchParams((requests[0]!.url ?? '').split('?')[1]);
      assert.equal(params.get('id'), LOBBY_ID);
      assert.equal(requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
      // The table is the whole lobby's — there is no seat to narrow it by.
      assert.equal(params.get('teamKey'), null);
    },
  );
});

test('hydrating the slice adopts the server table and the screen can read it', async () => {
  const getStandingsApi = async (): Promise<ApiResult<StandingsResponse>> => ({
    ok: true,
    data: { standings: SERVER_TABLE },
  });
  const store = buildStore({ getStandingsApi });

  // Before the answer lands, a seated player is `loading` — never a table.
  assert.deepEqual(displayStandings(LOBBY_ID, store.getState().standingsApi), { kind: 'loading' });

  const outcome = await store.getState().standingsApi.hydrate(LOBBY_ID);
  assert.equal(outcome.ok, true);
  const display = displayStandings(LOBBY_ID, store.getState().standingsApi);
  assert.equal(display.kind, 'ready');
  if (display.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(display.standings, SERVER_TABLE);
});

test('a distinct server error code survives — `forbidden` is not flattened into a generic failure', async () => {
  const getStandingsApi = async (): Promise<ApiResult<StandingsResponse>> => ({ ok: false, status: 403, error: 'forbidden' });
  const store = buildStore({ getStandingsApi });
  const outcome = await store.getState().standingsApi.hydrate(LOBBY_ID);
  assert.deepEqual(outcome, { ok: false, error: 'forbidden' });
});

test('with no session nothing leaves the device', async () => {
  let sent = 0;
  const getStandingsApi = async (): Promise<ApiResult<StandingsResponse>> => {
    sent += 1;
    return { ok: true, data: { standings: SERVER_TABLE } };
  };
  const store = buildStore({ getStandingsApi }, { baseUrl: BASE_URL, token: undefined });
  const outcome = await store.getState().standingsApi.hydrate(LOBBY_ID);
  assert.deepEqual(outcome, { ok: false, error: 'not_signed_in' });
  assert.equal(sent, 0);
});

// A read for a different lobby than the one on screen must not be shown as
// this lobby's table while the real answer is still in flight.
test('an answer held for a different lobby than the one asked about is "loading", not stale data', async () => {
  const getStandingsApi = async (): Promise<ApiResult<StandingsResponse>> => ({
    ok: true,
    data: { standings: SERVER_TABLE },
  });
  const store = buildStore({ getStandingsApi });
  await store.getState().standingsApi.hydrate(LOBBY_ID);
  assert.equal(displayStandings('another-lobby', store.getState().standingsApi).kind, 'loading');
});

// ── 2. THE CLIENT DOES NOT COMPUTE THE TABLE ───────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const readPath = [
  '../src/lib/api/standings.ts',
  '../src/store/slices/standingsApiSlice.ts',
  '../src/store/slices/standingsDisplay.ts',
];

/** Source with comments and string/template literals blanked out, so a scan
 * sees CODE only — a function named in one of this repo's many doc comments
 * is not a call. Same helper `settlement-from-server.test.ts`/`no-local-race.test.ts` use. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

test('nothing in the standings read path computes points', () => {
  // `applyRacePoints`/`applySprintPoints`/`seedStandings`/`finishRace` are
  // every way this codebase turns a race into points. Doing that is the
  // server's job now (`server/src/lobby/runner.ts`'s `standingsBeforeRound`,
  // `server/src/economy/settle.ts`). A call to any of them here would be a
  // second answer to "what does the table say?".
  const banned = /\b(applyRacePoints|applySprintPoints|seedStandings|finishRace)\s*\(/;
  for (const rel of readPath) {
    const code = codeOnly(readFileSync(path.join(here, rel), 'utf8'));
    assert.ok(
      !banned.test(code),
      `${rel} must not compute the standings — it is read from GET /lobby/standings`,
    );
  }
});

// ── 3. WITH NO LOBBY IT SAYS SO, RATHER THAN SHOWING THE LOCAL SEED TABLE ──

test('displayStandings() with no lobby reports "no-lobby", never the local seed table', async () => {
  const getStandingsApi = async (): Promise<ApiResult<StandingsResponse>> => ({
    ok: true,
    data: { standings: SERVER_TABLE },
  });
  const store = buildStore({ getStandingsApi });
  // Even with a perfectly good server table already in the slice, no lobby
  // means no answer — the same rule `displayFactory`/`displaySponsors`/
  // `displaySettlement` follow. A lobby-less player shown ANY table is shown
  // a second reality.
  await store.getState().standingsApi.hydrate(LOBBY_ID);
  assert.deepEqual(displayStandings(undefined, store.getState().standingsApi), { kind: 'no-lobby' });
});

test('the no-lobby answer carries no `standings` field at all — there is nothing to render by accident', () => {
  const display = displayStandings(undefined, { table: undefined, lobbyId: undefined });
  assert.deepEqual(Object.keys(display), ['kind']);
});
