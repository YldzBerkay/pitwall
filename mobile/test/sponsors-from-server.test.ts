/**
 * Tests that the sponsor system is fully server-owned on the client:
 *
 *  1. Offers are fetched from the server, not generated locally.
 *  2. Signing posts the offer's identifier, not its terms.
 *  3. Releasing posts the slot and adopts whatever the server reports.
 *  4. Distinct server errors stay distinct.
 *  5. With no lobby, the selector says so - it never falls back to local
 *     sponsorship numbers.
 *  6. No session -> nothing is sent.
 *
 * Follows `race-api.test.ts`'s pattern: a real `node:http` server rather
 * than a stubbed `fetch`, so header/body/serialisation mistakes actually
 * fail the test instead of being waved through by a stub that only checks
 * call arguments.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { getSponsorOffers, signSponsorOffer, releaseSponsorship } from '@/lib/api/sponsors';
import { createSponsorsApiSlice, type SponsorsApiSlice, type SponsorsApiSliceDeps } from '@/store/slices/sponsorsApiSlice';
import { displaySponsors } from '@/store/slices/sponsorsDisplay';
import type { SponsorOffer, Sponsorship } from '@pitwall/shared/sponsors';

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
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody,
      };
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

const sampleOffer: SponsorOffer = {
  id: 'offer-1',
  brandKey: 'acme',
  slots: ['sidepod'],
  perSlot: [500],
  rounds: 5,
  perRace: 500,
  signing: 1000,
  targetPosition: 3,
  bonus: 200,
  streakTarget: 3,
};

const sampleSponsorship: Sponsorship = {
  dealId: '1-acme-sidepod',
  brandKey: 'acme',
  slot: 'sidepod',
  perRace: 500,
  targetPosition: 3,
  bonus: 200,
  signedRound: 1,
  expiresRound: 6,
  streakTarget: 3,
  streak: 0,
};

// ── 1. Offers come from the server ────────────────────────────────────────

test('getSponsorOffers() hits GET /sponsors/offers?lobbyId= with a Bearer header and returns the server sheet', async () => {
  await withServer(
    () => ({ status: 200, body: { offers: [sampleOffer] } }),
    async (baseUrl, requests) => {
      const result = await getSponsorOffers(baseUrl, TOKEN, { lobbyId: LOBBY_ID });
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.data.offers, [sampleOffer]);
      assert.equal(requests.length, 1);
      const req = requests[0];
      assert.equal(req.method, 'GET');
      assert.equal(req.url, `/sponsors/offers?lobbyId=${LOBBY_ID}`);
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    },
  );
});

// ── 2. Signing posts the identifier, never the terms ──────────────────────

test('signSponsorOffer() posts only {lobbyId, offerId} - never perRace/bonus/signing', async () => {
  await withServer(
    () => ({ status: 200, body: { sponsorships: [sampleSponsorship] } }),
    async (baseUrl, requests) => {
      const result = await signSponsorOffer(baseUrl, TOKEN, { lobbyId: LOBBY_ID, offerId: sampleOffer.id });
      assert.equal(result.ok, true);
      assert.equal(requests.length, 1);
      const req = requests[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/sponsors/sign');
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(req.body, { lobbyId: LOBBY_ID, offerId: sampleOffer.id });
      const body = req.body as Record<string, unknown>;
      for (const forbidden of ['perRace', 'bonus', 'signing', 'targetPosition', 'streakTarget', 'slots']) {
        assert.equal(forbidden in body, false, `${forbidden} must never be sent to /sponsors/sign`);
      }
    },
  );
});

test('sponsorsApi.sign() sends the offer id from the store, not the offer object', async () => {
  await withServer(
    () => ({ status: 200, body: { sponsorships: [sampleSponsorship] } }),
    async (baseUrl, requests) => {
      const slice = buildSlice({ baseUrl, token: TOKEN });
      const outcome = await slice.get().sponsorsApi.sign(LOBBY_ID, sampleOffer.id);
      assert.deepEqual(outcome, { ok: true });
      assert.deepEqual(slice.get().sponsorsApi.sponsorships, [sampleSponsorship]);
      assert.deepEqual(requests[0].body, { lobbyId: LOBBY_ID, offerId: sampleOffer.id });
    },
  );
});

// ── 3. Releasing posts the slot and adopts what the server reports ───────

test('releaseSponsorship() posts {lobbyId, slot} and adopts the returned sponsorships', async () => {
  await withServer(
    () => ({ status: 200, body: { sponsorships: [] } }),
    async (baseUrl, requests) => {
      const result = await releaseSponsorship(baseUrl, TOKEN, { lobbyId: LOBBY_ID, slot: 'sidepod' });
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.data.sponsorships, []);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].url, '/sponsors/release');
      assert.deepEqual(requests[0].body, { lobbyId: LOBBY_ID, slot: 'sidepod' });
    },
  );
});

test('sponsorsApi.release() posts the slot and adopts the post-release sponsorships the server reports', async () => {
  await withServer(
    () => ({ status: 200, body: { sponsorships: [] } }),
    async (baseUrl, requests) => {
      const slice = buildSlice({ baseUrl, token: TOKEN });
      const outcome = await slice.get().sponsorsApi.release(LOBBY_ID, 'sidepod');
      assert.deepEqual(outcome, { ok: true });
      assert.deepEqual(slice.get().sponsorsApi.sponsorships, []);
      assert.deepEqual(requests[0].body, { lobbyId: LOBBY_ID, slot: 'sidepod' });
      // NOTE: the real server response for /sponsors/release is only
      // `{ sponsorships }` - it never carries the break fee it charged
      // (see `sponsorRoutes.ts` and `lib/api/sponsors.ts`'s doc comment).
      // There is therefore no separate fee field to assert on here.
    },
  );
});

// ── 4. Distinct server errors stay distinct ───────────────────────────────

const signErrorCases: { code: string; status: number }[] = [
  { code: 'unauthorized', status: 401 },
  { code: 'forbidden', status: 403 },
  { code: 'invalid_request', status: 400 },
  { code: 'offer_not_found', status: 404 },
  { code: 'slot_taken', status: 409 },
  { code: 'no_lobby', status: 404 },
];

for (const { code, status } of signErrorCases) {
  test(`signSponsorOffer() surfaces the distinct server error code "${code}" (status ${status})`, async () => {
    await withServer(
      () => ({ status, body: { error: code } }),
      async (baseUrl) => {
        const result = await signSponsorOffer(baseUrl, TOKEN, { lobbyId: LOBBY_ID, offerId: sampleOffer.id });
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error, code);
          assert.equal(result.status, status);
        }
      },
    );
  });
}

test('"slot_taken" and "offer_not_found" are never collapsed into the same code', async () => {
  await withServer(
    (req) => {
      const body = req.body as Record<string, unknown>;
      return body.offerId === 'taken'
        ? { status: 409, body: { error: 'slot_taken' } }
        : { status: 404, body: { error: 'offer_not_found' } };
    },
    async (baseUrl) => {
      const takenResult = await signSponsorOffer(baseUrl, TOKEN, { lobbyId: LOBBY_ID, offerId: 'taken' });
      const missingResult = await signSponsorOffer(baseUrl, TOKEN, { lobbyId: LOBBY_ID, offerId: 'gone' });
      assert.equal(takenResult.ok, false);
      assert.equal(missingResult.ok, false);
      if (!takenResult.ok && !missingResult.ok) {
        assert.equal(takenResult.error, 'slot_taken');
        assert.equal(missingResult.error, 'offer_not_found');
        assert.notEqual(takenResult.error, missingResult.error);
      }
    },
  );
});

test('sponsorsApi.sign() surfaces the server error code unchanged, not a generic failure', async () => {
  await withServer(
    () => ({ status: 409, body: { error: 'slot_taken' } }),
    async (baseUrl) => {
      const slice = buildSlice({ baseUrl, token: TOKEN });
      const outcome = await slice.get().sponsorsApi.sign(LOBBY_ID, sampleOffer.id);
      assert.deepEqual(outcome, { ok: false, error: 'slot_taken' });
      assert.deepEqual(slice.get().sponsorsApi.lastActionOutcome, { ok: false, error: 'slot_taken' });
    },
  );
});

// ── 5. No lobby -> the selector says so, no local fallback ───────────────

test('displaySponsors() with no lobby reports "no-lobby", never local sponsorship numbers', () => {
  const display = displaySponsors(undefined, { offers: [sampleOffer], sponsorships: [sampleSponsorship] });
  assert.deepEqual(display, { kind: 'no-lobby' });
});

test('displaySponsors() reports "loading" in a lobby before offers have arrived', () => {
  const display = displaySponsors(LOBBY_ID, { offers: null, sponsorships: null });
  assert.deepEqual(display, { kind: 'loading' });
});

test('displaySponsors() reports "ready" with the server offers once they have arrived', () => {
  const display = displaySponsors(LOBBY_ID, { offers: [sampleOffer], sponsorships: [sampleSponsorship] });
  assert.deepEqual(display, { kind: 'ready', offers: [sampleOffer], sponsorships: [sampleSponsorship] });
});

// ── 6. No session -> nothing is sent ──────────────────────────────────────

test('sponsorsApi.hydrateOffers()/sign()/release() refuse locally with no session, sending nothing', async () => {
  const slice = buildSlice({ baseUrl: 'http://127.0.0.1:1', token: undefined });

  const hydrateOutcome = await slice.get().sponsorsApi.hydrateOffers(LOBBY_ID);
  const signOutcome = await slice.get().sponsorsApi.sign(LOBBY_ID, sampleOffer.id);
  const releaseOutcome = await slice.get().sponsorsApi.release(LOBBY_ID, 'sidepod');

  assert.deepEqual(hydrateOutcome, { ok: false, error: 'not_signed_in' });
  assert.deepEqual(signOutcome, { ok: false, error: 'not_signed_in' });
  assert.deepEqual(releaseOutcome, { ok: false, error: 'not_signed_in' });
  assert.equal(slice.get().sponsorsApi.offers, null);
  assert.equal(slice.get().sponsorsApi.sponsorships, null);
});

// ── Test helper: a minimal standalone store, same shape as
// `RaceSliceDeps`/`EconomyApiSliceDeps` standalone tests use ──────────────

function buildSlice(auth: { baseUrl: string; token?: string }) {
  let state: SponsorsApiSlice & SponsorsApiSliceDeps;
  const set = (partial: Partial<SponsorsApiSlice> | ((s: SponsorsApiSlice) => Partial<SponsorsApiSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  state = { auth, ...createSponsorsApiSlice(set, get) };
  return { get };
}
