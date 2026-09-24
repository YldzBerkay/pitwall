/**
 * THE WEEKEND'S RECEIPT IS READ, NOT COMPUTED.
 *
 * The server settles a race (`server/src/economy/settle.ts`): it replays the
 * frozen recipe to the flag, pays race prize + sponsor income + briefing
 * bonus to every seat, and — in the SAME transaction as the payment —
 * persists the breakdown behind that total (`race_settlement_payouts`,
 * `server/src/economy/settlementRepo.ts`). `GET /economy/settlement` hands
 * that row back.
 *
 * The client's job is therefore to ASK. A client that recomputes the
 * weekend's money locally produces a second, unauthoritative answer to "what
 * did I earn?" — and unlike a mis-drawn lap, a wrong number here is one the
 * player will act on (sign a sponsor, start an upgrade) before the truth
 * catches up.
 *
 * ── WHAT THIS FILE COVERS, AND WHAT IT DELIBERATELY DOES NOT ──────────────
 * It covers the READ PATH end to end: the HTTP client
 * (`lib/api/settlement.ts`), the slice that holds the answer
 * (`settlementApiSlice.ts`) and the pure selector a screen reads
 * (`settlementDisplay.ts`) — including the rule every other display selector
 * in this codebase already follows (`displayRace`, `displayFactory`,
 * `displaySponsors`): with no lobby it SAYS SO rather than falling back to
 * local numbers.
 *
 * It does NOT claim that `gameStore.ts`'s local `settleRaceWeekend` is gone.
 * It is not: removing it also removes the only trigger of the local
 * achievements/career/injury/season/espionage machinery, and — more
 * decisively — the only thing that ever advances `weekend.phase` into
 * `'race'`, which is what mounts `LiveRacePanel` and therefore the only
 * reason the server's live race is visible at all today. That removal is
 * blocked on a server-driven weekend phase, not on this read path. See this
 * task's report and `no-local-race.test.ts`'s module doc.
 *
 * What IS asserted below is narrower and true: nothing in the
 * server-settlement read path computes money. That is a text scan on
 * purpose — "this function is never called" is a property of the SOURCE, not
 * of one execution path, and a `.tsx` screen cannot be imported under plain
 * Node (`tsx --test`) anyway, which is why the decision lives in a pure
 * selector in the first place.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { create } from 'zustand';
import type { ApiResult } from '@/lib/api/identity';
import { getSettlement, type SettlementResponse, type SettlementBreakdown } from '@/lib/api/settlement';
import {
  createSettlementApiSlice,
  type SettlementApiSlice,
  type SettlementApiSliceDeps,
  type SettlementApiSliceInjected,
} from '@/store/slices/settlementApiSlice';
import { displaySettlement, settlementRoundFor } from '@/store/slices/settlementDisplay';

const TOKEN = 'session-token-abc';
const LOBBY_ID = 'lobby-1';
const BASE_URL = 'http://example.test';

/** The exact row `GET /economy/settlement` returns for a settled round. */
const SERVER_BREAKDOWN: SettlementBreakdown = {
  season: 2,
  round: 7,
  position: 4,
  prize: 1300,
  sponsorIncome: 940,
  briefBonus: 180,
  bonusesEarned: ['velox', 'nimbus'],
  streaksBroken: ['aurora'],
  expired: ['sidepod'],
};

type Store = SettlementApiSlice & SettlementApiSliceDeps;

function buildStore(
  injected: SettlementApiSliceInjected = {},
  auth: SettlementApiSliceDeps['auth'] = { baseUrl: BASE_URL, token: TOKEN },
) {
  return create<Store>((set, get) => ({
    auth,
    ...createSettlementApiSlice(set as never, get as never, injected),
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

// ── 1. AFTER A RACE, THE CLIENT READS ITS SETTLEMENT FROM THE SERVER ───────

test('the client asks GET /economy/settlement for its own lobby and round, with a Bearer header', async () => {
  await withServer(
    () => ({ status: 200, body: { settlement: SERVER_BREAKDOWN } satisfies SettlementResponse }),
    async (baseUrl, requests) => {
      const res = await getSettlement(baseUrl, TOKEN, { lobbyId: LOBBY_ID, round: 7 });
      assert.equal(res.ok, true);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.method, 'GET');
      assert.match(requests[0]!.url ?? '', /^\/economy\/settlement\?/);
      const params = new URLSearchParams((requests[0]!.url ?? '').split('?')[1]);
      assert.equal(params.get('lobbyId'), LOBBY_ID);
      assert.equal(params.get('round'), '7');
      assert.equal(requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
      // The team key is NEVER sent: the server reads it off `lobby_seats`.
      assert.equal(params.get('teamKey'), null);
    },
  );
});

test('a season is sent only when one was asked for — otherwise the server picks the lobby`s own', async () => {
  await withServer(
    () => ({ status: 200, body: { settlement: null } satisfies SettlementResponse }),
    async (baseUrl, requests) => {
      await getSettlement(baseUrl, TOKEN, { lobbyId: LOBBY_ID, round: 3 });
      await getSettlement(baseUrl, TOKEN, { lobbyId: LOBBY_ID, round: 3, season: 2 });
      assert.equal(new URLSearchParams((requests[0]!.url ?? '').split('?')[1]).get('season'), null);
      assert.equal(new URLSearchParams((requests[1]!.url ?? '').split('?')[1]).get('season'), '2');
    },
  );
});

test('hydrating the slice adopts the server row and the screen can read it', async () => {
  const getSettlementApi = async (): Promise<ApiResult<SettlementResponse>> => ({
    ok: true,
    data: { settlement: SERVER_BREAKDOWN },
  });
  const store = buildStore({ getSettlementApi });

  // Before the answer lands, a seated player is `loading` — never a number.
  assert.deepEqual(displaySettlement(LOBBY_ID, store.getState().settlementApi), { kind: 'loading' });

  const outcome = await store.getState().settlementApi.hydrate(LOBBY_ID, 7);
  assert.equal(outcome.ok, true);
  assert.equal(displaySettlement(LOBBY_ID, store.getState().settlementApi).kind, 'ready');
});

test('a round that has not been paid yet is "none", not zero and not an error', async () => {
  const getSettlementApi = async (): Promise<ApiResult<SettlementResponse>> => ({ ok: true, data: { settlement: null } });
  const store = buildStore({ getSettlementApi });
  const outcome = await store.getState().settlementApi.hydrate(LOBBY_ID, 9);
  assert.equal(outcome.ok, true, 'an unsettled round is a normal answer, not a failure');
  assert.deepEqual(displaySettlement(LOBBY_ID, store.getState().settlementApi), { kind: 'none' });
});

test('a distinct server error code survives — `forbidden` is not flattened into a generic failure', async () => {
  const getSettlementApi = async (): Promise<ApiResult<SettlementResponse>> => ({ ok: false, status: 403, error: 'forbidden' });
  const store = buildStore({ getSettlementApi });
  const outcome = await store.getState().settlementApi.hydrate(LOBBY_ID, 7);
  assert.deepEqual(outcome, { ok: false, error: 'forbidden' });
});

test('with no session nothing leaves the device', async () => {
  let sent = 0;
  const getSettlementApi = async (): Promise<ApiResult<SettlementResponse>> => {
    sent += 1;
    return { ok: true, data: { settlement: SERVER_BREAKDOWN } };
  };
  const store = buildStore({ getSettlementApi }, { baseUrl: BASE_URL, token: undefined });
  const outcome = await store.getState().settlementApi.hydrate(LOBBY_ID, 7);
  assert.deepEqual(outcome, { ok: false, error: 'not_signed_in' });
  assert.equal(sent, 0);
});

// ── 2. THE CLIENT DOES NOT COMPUTE THE SETTLEMENT ──────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const readPath = [
  '../src/lib/api/settlement.ts',
  '../src/store/slices/settlementApiSlice.ts',
  '../src/store/slices/settlementDisplay.ts',
];

/** Source with comments and string/template literals blanked out, so a scan
 * sees CODE only — a function named in one of this repo's many doc comments
 * is not a call. Same helper `no-local-race.test.ts` uses. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

test('nothing in the settlement read path computes money', () => {
  // `finishRace` reclassifies a race; `settleRace`/`racePrize` price it;
  // `briefCompliance`/`BRIEF_RP_EACH` pay the briefing. Every one of them is
  // the server's job now (`server/src/economy/settle.ts`). A call to any of
  // them here would be a SECOND answer to "what did I earn?".
  const banned = /\b(finishRace|settleRace|racePrize|briefCompliance|BRIEF_RP_EACH|championshipPrize)\s*\(/;
  for (const rel of readPath) {
    const code = codeOnly(readFileSync(path.join(here, rel), 'utf8'));
    assert.ok(
      !banned.test(code),
      `${rel} must not compute the settlement — it is read from GET /economy/settlement`,
    );
  }
});

// ── 3. THE BREAKDOWN THE SCREEN SHOWS IS THE SERVER'S, FIELD FOR FIELD ─────

test('every field the screen shows comes straight off the server row', async () => {
  const getSettlementApi = async (): Promise<ApiResult<SettlementResponse>> => ({
    ok: true,
    data: { settlement: SERVER_BREAKDOWN },
  });
  const store = buildStore({ getSettlementApi });
  await store.getState().settlementApi.hydrate(LOBBY_ID, 7);

  const display = displaySettlement(LOBBY_ID, store.getState().settlementApi);
  assert.equal(display.kind, 'ready');
  if (display.kind !== 'ready') throw new Error('unreachable');

  assert.equal(display.season, SERVER_BREAKDOWN.season);
  assert.equal(display.round, SERVER_BREAKDOWN.round);
  assert.equal(display.position, SERVER_BREAKDOWN.position);
  assert.equal(display.prize, SERVER_BREAKDOWN.prize);
  assert.equal(display.sponsorIncome, SERVER_BREAKDOWN.sponsorIncome);
  assert.equal(display.briefBonus, SERVER_BREAKDOWN.briefBonus);
  assert.deepEqual(display.bonusesEarned, SERVER_BREAKDOWN.bonusesEarned);
  assert.deepEqual(display.streaksBroken, SERVER_BREAKDOWN.streaksBroken);
  assert.deepEqual(display.expired, SERVER_BREAKDOWN.expired);
});

test('the total is the sum of the server`s own three figures, never a re-derived number', async () => {
  // `settle.ts` guarantees `rp === prize + sponsorIncome + briefBonus` (it
  // accumulates all three in one loop). Adding the server's three numbers is
  // arithmetic on its answer; recomputing any of them would not be.
  const getSettlementApi = async (): Promise<ApiResult<SettlementResponse>> => ({
    ok: true,
    data: { settlement: SERVER_BREAKDOWN },
  });
  const store = buildStore({ getSettlementApi });
  await store.getState().settlementApi.hydrate(LOBBY_ID, 7);
  const display = displaySettlement(LOBBY_ID, store.getState().settlementApi);
  if (display.kind !== 'ready') throw new Error('unreachable');
  assert.equal(display.total, 1300 + 940 + 180);
});

// ── 4. WITH NO LOBBY IT SAYS SO, RATHER THAN SHOWING LOCAL NUMBERS ─────────

test('displaySettlement() with no lobby reports "no-lobby", never local settlement numbers', async () => {
  const getSettlementApi = async (): Promise<ApiResult<SettlementResponse>> => ({
    ok: true,
    data: { settlement: SERVER_BREAKDOWN },
  });
  const store = buildStore({ getSettlementApi });
  // Even with a perfectly good server row already in the slice, no lobby
  // means no answer — the same rule `displayFactory`/`displaySponsors`
  // follow. A lobby-less player shown ANY number is shown a second reality.
  await store.getState().settlementApi.hydrate(LOBBY_ID, 7);
  assert.deepEqual(displaySettlement(undefined, store.getState().settlementApi), { kind: 'no-lobby' });
});

test('the no-lobby answer carries no numeric fields at all — there is nothing to render by accident', () => {
  const display = displaySettlement(undefined, { breakdown: undefined, round: undefined });
  assert.deepEqual(Object.keys(display), ['kind']);
});

// ── WHICH ROUND "MY LAST RACE" MEANS — THE SERVER'S PHASE DECIDES ──────────

test('the round asked about follows the lobby phase, not a local counter', () => {
  // Running right now: unsettled by definition, so the last paid race is the
  // one before it.
  assert.equal(settlementRoundFor({ phase: 'live', roundNo: 5 }), 4);
  // Settled in the same commit that set this phase.
  assert.equal(settlementRoundFor({ phase: 'result', roundNo: 5 }), 5);
  // Rollover already moved the counter to the NEXT race.
  assert.equal(settlementRoundFor({ phase: 'open', roundNo: 6 }), 5);
  assert.equal(settlementRoundFor({ phase: 'checkin', roundNo: 6 }), 5);
  assert.equal(settlementRoundFor({ phase: 'finished', roundNo: 23 }), 23);
});

test('a lobby whose first race has not run yet has no round to ask about', () => {
  // Round 0 would be a 400 from the server, not an empty answer.
  assert.equal(settlementRoundFor({ phase: 'open', roundNo: 1 }), undefined);
  assert.equal(settlementRoundFor({ phase: 'live', roundNo: 1 }), undefined);
  assert.equal(settlementRoundFor(undefined), undefined);
});
