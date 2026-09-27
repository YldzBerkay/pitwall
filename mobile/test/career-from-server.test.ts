/**
 * THE CAREER IS READ, NOT FROZEN LOCALLY.
 *
 * Achievements and the career record stopped moving when the client's local
 * settlement was removed (`823ddd4`) — the only thing that ever called
 * `scoreWeekend`/`recordWeekend` was gone. The server now runs both itself,
 * at settlement, for every human seat, inside the flag's own transaction
 * (`server/src/economy/settle.ts`, `server/src/economy/careerRepo.ts`), and
 * exposes:
 *  - the weekend's achievements and the career score they added, alongside
 *    the settlement breakdown (`GET /economy/settlement`,
 *    `server/src/economy/routes.ts`);
 *  - the whole career, read on its own — it belongs to the USER, not a
 *    lobby, since a player races in 3-5 lobbies and all of them fold into
 *    the same `user_careers` row (`GET /economy/career`).
 *
 * This file covers the READ PATH end to end for both, following the exact
 * shape `settlement-from-server.test.ts` and `standings-from-server.test.ts`
 * already established: the HTTP client, the slice that holds the answer, and
 * the pure selector a screen reads — including the rule every one of those
 * selectors already follows (`displayRace`, `displayFactory`,
 * `displaySponsors`, `displaySettlement`, `displayStandings`): with no data
 * it SAYS SO rather than falling back to a local, frozen number.
 *
 * ── WHY THIS MATTERS MORE HERE THAN ANYWHERE ELSE ─────────────────────────
 * `gameStore.ts`'s local `career` field is not dead weight — it still moves
 * (a correct pre-season test programme adds +5 to `career.score`,
 * `gameStore.ts`'s own `career:` assignment). A stale local score sitting
 * right next to a real one is not an empty screen an honest player would
 * question; it is a plausible-looking WRONG number. `displayCareer` must
 * never read it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { create } from 'zustand';
import type { ApiResult } from '@/lib/api/identity';
import { getCareer, type CareerResponse } from '@/lib/api/career';
import {
  createCareerApiSlice,
  type CareerApiSlice,
  type CareerApiSliceDeps,
  type CareerApiSliceInjected,
} from '@/store/slices/careerApiSlice';
import { displayCareer } from '@/store/slices/careerDisplay';
import { emptyCareer, rankFor, type Career } from '@pitwall/shared/achievements';
import type { SettlementBreakdown } from '@/lib/api/settlement';
import { displaySettlement } from '@/store/slices/settlementDisplay';
import {
  createSettlementApiSlice,
  type SettlementApiSlice,
  type SettlementApiSliceDeps,
  type SettlementApiSliceInjected,
} from '@/store/slices/settlementApiSlice';

const TOKEN = 'session-token-abc';
const BASE_URL = 'http://example.test';
const AUTH_USER = { id: 'user-1' };

/** The exact row `GET /economy/career` returns for a user with a real record. */
const SERVER_CAREER: Career = {
  ...emptyCareer(),
  score: 940,
  races: 12,
  wins: 3,
  podiums: 6,
  poles: 2,
  fastestLaps: 4,
  dnfs: 1,
  counts: { podium: 6, pole: 2, fastestLap: 4, win: 3, double: 1, hatTrick: 0, grandSlam: 0, cleanSweep: 0 },
};

type CareerStore = CareerApiSlice & CareerApiSliceDeps;

function buildCareerStore(
  injected: CareerApiSliceInjected = {},
  auth: CareerApiSliceDeps['auth'] = { baseUrl: BASE_URL, token: TOKEN },
) {
  return create<CareerStore>((set, get) => ({
    auth,
    ...createCareerApiSlice(set as never, get as never, injected),
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

// ── 5. THE CAREER LANDS IN THE STORE FROM THE SERVER ───────────────────────

test('the client asks GET /economy/career with a Bearer header, no lobby needed', async () => {
  await withServer(
    () => ({ status: 200, body: { career: SERVER_CAREER } satisfies CareerResponse }),
    async (baseUrl, requests) => {
      const res = await getCareer(baseUrl, TOKEN);
      assert.equal(res.ok, true);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.method, 'GET');
      assert.equal(requests[0]!.url, '/economy/career');
      assert.equal(requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
    },
  );
});

test('hydrating the slice adopts the server career and the screen can read it', async () => {
  const getCareerApi = async (): Promise<ApiResult<CareerResponse>> => ({ ok: true, data: { career: SERVER_CAREER } });
  const store = buildCareerStore({ getCareerApi });

  // Before the answer lands, an authenticated player is `loading` — never a number.
  assert.deepEqual(displayCareer(AUTH_USER, store.getState().careerApi), { kind: 'loading' });

  const outcome = await store.getState().careerApi.hydrate();
  assert.equal(outcome.ok, true);
  const display = displayCareer(AUTH_USER, store.getState().careerApi);
  assert.equal(display.kind, 'ready');
  if (display.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(display.career, SERVER_CAREER);
});

test('with no session nothing leaves the device', async () => {
  let sent = 0;
  const getCareerApi = async (): Promise<ApiResult<CareerResponse>> => {
    sent += 1;
    return { ok: true, data: { career: SERVER_CAREER } };
  };
  const store = buildCareerStore({ getCareerApi }, { baseUrl: BASE_URL, token: undefined });
  const outcome = await store.getState().careerApi.hydrate();
  assert.deepEqual(outcome, { ok: false, error: 'not_signed_in' });
  assert.equal(sent, 0);
});

test('a distinct server error code survives — `forbidden` is not flattened into a generic failure', async () => {
  const getCareerApi = async (): Promise<ApiResult<CareerResponse>> => ({ ok: false, status: 403, error: 'forbidden' });
  const store = buildCareerStore({ getCareerApi });
  const outcome = await store.getState().careerApi.hydrate();
  assert.deepEqual(outcome, { ok: false, error: 'forbidden' });
});

// ── 6. THE RANK SHOWN DERIVES FROM THE CAREER SCORE VIA `rankFor` ──────────

test('displayCareer carries the rank `rankFor` gives the server score — no restated threshold', async () => {
  const getCareerApi = async (): Promise<ApiResult<CareerResponse>> => ({ ok: true, data: { career: SERVER_CAREER } });
  const store = buildCareerStore({ getCareerApi });
  await store.getState().careerApi.hydrate();
  const display = displayCareer(AUTH_USER, store.getState().careerApi);
  assert.equal(display.kind, 'ready');
  if (display.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(display.rank, rankFor(SERVER_CAREER.score));
});

test('a score just below a rank threshold and just at it land on different ranks — proves the real formula runs, not a stand-in', async () => {
  const getCareerApi = (score: number) => async (): Promise<ApiResult<CareerResponse>> => ({
    ok: true,
    data: { career: { ...emptyCareer(), score } },
  });
  const below = buildCareerStore({ getCareerApi: getCareerApi(299) });
  await below.getState().careerApi.hydrate();
  const belowDisplay = displayCareer(AUTH_USER, below.getState().careerApi);
  if (belowDisplay.kind !== 'ready') throw new Error('unreachable');

  const at = buildCareerStore({ getCareerApi: getCareerApi(300) });
  await at.getState().careerApi.hydrate();
  const atDisplay = displayCareer(AUTH_USER, at.getState().careerApi);
  if (atDisplay.kind !== 'ready') throw new Error('unreachable');

  assert.notEqual(belowDisplay.rank.level, atDisplay.rank.level);
  assert.equal(belowDisplay.rank.level, rankFor(299).level);
  assert.equal(atDisplay.rank.level, rankFor(300).level);
});

// ── 7. THE WEEKEND'S ACHIEVEMENTS COME FROM THE SETTLEMENT READ ────────────

const SERVER_BREAKDOWN: SettlementBreakdown = {
  season: 2,
  round: 7,
  position: 4,
  prize: 1300,
  sponsorIncome: 940,
  briefBonus: 180,
  bonusesEarned: ['velox'],
  streaksBroken: [],
  expired: [],
  rivalSpy: null,
  achievements: ['podium', 'fastestLap'],
  careerScore: 55,
};

type SettlementStore = SettlementApiSlice & SettlementApiSliceDeps;

function buildSettlementStore(
  injected: SettlementApiSliceInjected = {},
  auth: SettlementApiSliceDeps['auth'] = { baseUrl: BASE_URL, token: TOKEN },
) {
  return create<SettlementStore>((set, get) => ({
    auth,
    ...createSettlementApiSlice(set as never, get as never, injected),
  }));
}

test("the settlement display carries the weekend's achievements and career score straight off the server row", async () => {
  const getSettlementApi = async (): Promise<ApiResult<{ settlement: SettlementBreakdown | null }>> => ({
    ok: true,
    data: { settlement: SERVER_BREAKDOWN },
  });
  const store = buildSettlementStore({ getSettlementApi });
  await store.getState().settlementApi.hydrate('lobby-1', 7);
  const display = displaySettlement('lobby-1', store.getState().settlementApi);
  assert.equal(display.kind, 'ready');
  if (display.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(display.achievements, SERVER_BREAKDOWN.achievements);
  assert.equal(display.careerScore, SERVER_BREAKDOWN.careerScore);
});

// ── 8. WITH NO DATA THE SELECTOR SAYS SO — NO LOCAL CAREER ─────────────────

test('displayCareer() with no session reports "not-signed-in", never a number', () => {
  assert.deepEqual(displayCareer(undefined, { career: undefined }), { kind: 'not-signed-in' });
});

test('displayCareer() before the server has answered reports "loading", never the local frozen career', () => {
  // A signed-in player whose `careerApi.career` has not landed yet must not
  // be shown ANYTHING numeric — in particular not `gameStore.ts`'s local
  // `career` field, which still moves on its own (the pre-season test
  // programme's +5). This call passes no local career in at all: the
  // selector has no parameter it could reach for one through.
  const display = displayCareer(AUTH_USER, { career: undefined });
  assert.deepEqual(display, { kind: 'loading' });
});

test('the not-signed-in and loading answers carry no `career` or `rank` field at all', () => {
  const notSignedIn = displayCareer(undefined, { career: undefined });
  assert.deepEqual(Object.keys(notSignedIn), ['kind']);
  const loading = displayCareer(AUTH_USER, { career: undefined });
  assert.deepEqual(Object.keys(loading), ['kind']);
});

// ── THE CLIENT DOES NOT COMPUTE THE CAREER ─────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const readPath = [
  '../src/lib/api/career.ts',
  '../src/store/slices/careerApiSlice.ts',
  '../src/store/slices/careerDisplay.ts',
];

/** Same helper `settlement-from-server.test.ts`/`standings-from-server.test.ts` use. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

test('nothing in the career read path computes the career — `scoreWeekend`/`recordWeekend` are the server`s job', () => {
  const banned = /\b(scoreWeekend|recordWeekend|emptyCareer)\s*\(/;
  for (const rel of readPath) {
    const code = codeOnly(readFileSync(path.join(here, rel), 'utf8'));
    assert.ok(!banned.test(code), `${rel} must not compute or fabricate a career — it is read from GET /economy/career`);
  }
});
