import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerGoldRoutes } from '../src/gold/routes.ts';
import { signSession } from '../src/auth/jwt.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { bumpAdsWatched, capsFor } from '../src/gold/repo.ts';
import type { SsvVerifyResult } from '../src/gold/ssv.ts';
import type { VerifyReceiptResult } from '../src/gold/receipts.ts';
import { ADS_PER_DAY } from '@pitwall/shared/economy';

let server: Server;
let base: string;
let uidCounter = 0;

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, body, text };
}

async function makeUser(): Promise<{ id: string; token: string }> {
  uidCounter += 1;
  const user = await createUserWithIdentity({
    provider: 'google',
    providerUid: `gold-http-${uidCounter}-${Date.now()}`,
    emailHash: null,
    base: `GoldTester${uidCounter}`,
  });
  const token = await signSession(user.id);
  return { id: user.id, token };
}

function fakeSsv(result: SsvVerifyResult): (raw: string) => Promise<SsvVerifyResult> {
  return async () => result;
}

/**
 * Unlike `fakeSsv`, the transaction id is derived from the request's own
 * query string (a `tx` param) so a single server instance can be driven
 * with many distinct, "genuinely signed" callbacks for the same user —
 * needed to exercise the daily ad cap, which only kicks in across
 * multiple non-duplicate grants.
 */
function fakeSsvSeq(userId: string, rewardAmount = 25): (raw: string) => Promise<SsvVerifyResult> {
  return async (raw: string) => {
    const params = new URLSearchParams(raw);
    const tx = params.get('tx') ?? 'default';
    return { ok: true, transactionId: tx, userId, rewardAmount };
  };
}

function fakeReceipt(result: VerifyReceiptResult): () => Promise<VerifyReceiptResult> {
  return async () => result;
}

describe('gold http', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();
  });

  beforeEach(async () => {
    await query('delete from users');
  });

  after(async () => {
    await closePool();
  });

  function startServer(deps: Parameters<typeof registerGoldRoutes>[1]) {
    const router = new Router();
    registerGoldRoutes(router, deps);
    server = createServer(async (req, res) => {
      if (await router.handle(req, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
    });
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  }

  function stopServer(): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  describe('GET /gold/admob-ssv', () => {
    it('credits gold on a valid callback and returns 200', async () => {
      const user = await makeUser();
      await startServer({
        verifySsvCallback: fakeSsv({ ok: true, transactionId: 'tx-ssv-1', userId: user.id, rewardAmount: 25 }),
      });
      try {
        const { status, body } = await json('/gold/admob-ssv?whatever=1');
        assert.equal(status, 200);
        assert.equal(body.gold, 25);
      } finally {
        await stopServer();
      }
    });

    it('replaying the same transaction_id returns 200 and does not credit again', async () => {
      const user = await makeUser();
      await startServer({
        verifySsvCallback: fakeSsv({ ok: true, transactionId: 'tx-ssv-replay', userId: user.id, rewardAmount: 25 }),
      });
      try {
        const first = await json('/gold/admob-ssv?whatever=1');
        assert.equal(first.status, 200);
        assert.equal(first.body.gold, 25);

        const second = await json('/gold/admob-ssv?whatever=1');
        assert.equal(second.status, 200, 'a replayed SSV callback must still answer 200, or Google will retry it up to 5 times');
        assert.equal(second.body.gold, 25, 'balance must be unchanged on replay');
      } finally {
        await stopServer();
      }
    });

    it('an invalid signature does not return 200 and credits nothing', async () => {
      const user = await makeUser();
      await startServer({
        verifySsvCallback: fakeSsv({ ok: false, reason: 'invalid_signature' }),
      });
      try {
        const { status } = await json('/gold/admob-ssv?whatever=1');
        assert.notEqual(status, 200);
        const balance = await query<{ gold: number }>('select gold from users where id = $1', [user.id]);
        assert.equal(balance.rows[0].gold, 0);
      } finally {
        await stopServer();
      }
    });

    it('rejects a callback whose user_id matches no account, crediting nothing', async () => {
      await startServer({
        verifySsvCallback: fakeSsv({ ok: true, transactionId: 'tx-no-user', userId: '00000000-0000-0000-0000-000000000000', rewardAmount: 25 }),
      });
      try {
        await json('/gold/admob-ssv?whatever=1');
        const balance = await query<{ gold: number }>('select gold from users');
        assert.equal(balance.rows.length, 0);
      } finally {
        await stopServer();
      }
    });

    it('never echoes the raw query string, signature, or receipt in the response', async () => {
      const user = await makeUser();
      await startServer({
        verifySsvCallback: fakeSsv({ ok: true, transactionId: 'tx-ssv-noleak', userId: user.id, rewardAmount: 25 }),
      });
      try {
        const { text } = await json('/gold/admob-ssv?signature=SECRETSIG&key_id=1');
        assert.ok(!text.includes('SECRETSIG'));
        assert.ok(!text.includes('signature'));
      } finally {
        await stopServer();
      }
    });

    it('a user already at the daily ad cap gets 200 and no gold credited', async () => {
      const user = await makeUser();
      const now = new Date();
      await bumpAdsWatched(user.id, now, ADS_PER_DAY);
      await startServer({ verifySsvCallback: fakeSsvSeq(user.id) });
      try {
        const { status, body } = await json('/gold/admob-ssv?tx=tx-cap-blocked');
        assert.equal(status, 200);
        assert.equal(body.gold, 0, 'a capped user must not be credited');

        const balance = await query<{ gold: number }>('select gold from users where id = $1', [user.id]);
        assert.equal(balance.rows[0].gold, 0);

        const caps = await capsFor(user.id, now);
        assert.equal(caps.adsWatched, ADS_PER_DAY, 'a blocked callback must not bump the counter further');
      } finally {
        await stopServer();
      }
    });

    it('a user below the cap gets gold and ads_watched increments by exactly 1', async () => {
      const user = await makeUser();
      const now = new Date();
      await startServer({ verifySsvCallback: fakeSsvSeq(user.id) });
      try {
        const before = await capsFor(user.id, now);
        assert.equal(before.adsWatched, 0);

        const { status, body } = await json('/gold/admob-ssv?tx=tx-below-cap');
        assert.equal(status, 200);
        assert.equal(body.gold, 25);

        const after = await capsFor(user.id, now);
        assert.equal(after.adsWatched, before.adsWatched + 1);
      } finally {
        await stopServer();
      }
    });

    it('the ad counter is per UTC day: prior usage does not consume the next day\'s allowance', async () => {
      const user = await makeUser();
      const yesterday = new Date(Date.UTC(2020, 0, 1, 12, 0, 0));
      const today = new Date(Date.UTC(2020, 0, 2, 12, 0, 0));

      // Fully use up yesterday's allowance directly against the repo.
      await bumpAdsWatched(user.id, yesterday, ADS_PER_DAY);
      const yesterdayCaps = await capsFor(user.id, yesterday);
      assert.equal(yesterdayCaps.adsWatched, ADS_PER_DAY);

      const todayCapsBefore = await capsFor(user.id, today);
      assert.equal(todayCapsBefore.adsWatched, 0, 'a new UTC day must start with a fresh allowance');

      // The route itself always uses "now" to check/bump the cap, so this
      // confirms the underlying per-day bookkeeping the route relies on
      // does not leak across day boundaries.
      await startServer({ verifySsvCallback: fakeSsvSeq(user.id) });
      try {
        const { status, body } = await json('/gold/admob-ssv?tx=tx-new-day');
        assert.equal(status, 200);
        assert.equal(body.gold, 25, 'today\'s allowance must be unaffected by yesterday\'s usage');
      } finally {
        await stopServer();
      }
    });

    it('the 8th ad of the day succeeds and the 9th is blocked (boundary)', async () => {
      const user = await makeUser();
      await startServer({ verifySsvCallback: fakeSsvSeq(user.id) });
      try {
        let lastGold = 0;
        for (let i = 1; i <= ADS_PER_DAY; i += 1) {
          const { status, body } = await json(`/gold/admob-ssv?tx=tx-boundary-${i}`);
          assert.equal(status, 200);
          assert.equal(body.gold, i * 25, `ad #${i} (<= ADS_PER_DAY) must be credited`);
          lastGold = body.gold;
        }

        const ninth = await json('/gold/admob-ssv?tx=tx-boundary-9');
        assert.equal(ninth.status, 200, 'over-cap must still answer 200, not an error');
        assert.equal(ninth.body.gold, lastGold, 'the 9th ad of the day must not be credited');
      } finally {
        await stopServer();
      }
    });

    it('a duplicate transaction_id does not consume an ad allowance slot', async () => {
      const user = await makeUser();
      const now = new Date();
      await startServer({ verifySsvCallback: fakeSsvSeq(user.id) });
      try {
        const first = await json('/gold/admob-ssv?tx=tx-dup-allowance');
        assert.equal(first.status, 200);
        assert.equal(first.body.gold, 25);

        const afterFirst = await capsFor(user.id, now);
        assert.equal(afterFirst.adsWatched, 1);

        // Replay the exact same transaction id (a Google retry).
        const second = await json('/gold/admob-ssv?tx=tx-dup-allowance');
        assert.equal(second.status, 200);
        assert.equal(second.body.gold, 25, 'a retry must not credit gold again');

        const afterSecond = await capsFor(user.id, now);
        assert.equal(
          afterSecond.adsWatched,
          1,
          'a retried/duplicate callback must not cost the player a second slot in their daily allowance',
        );
      } finally {
        await stopServer();
      }
    });
  });

  describe('POST /gold/purchase', () => {
    it('credits the catalogue amount for a valid receipt and returns 200', async () => {
      const user = await makeUser();
      await startServer({
        verifyReceipt: fakeReceipt({ ok: true, sku: 'gold_500', transactionId: 'tx-iap-1', gold: 500 }),
      });
      try {
        const { status, body } = await json('/gold/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
          body: JSON.stringify({ platform: 'apple', receipt: 'base64receipt' }),
        });
        assert.equal(status, 200);
        assert.equal(body.gold, 500);
      } finally {
        await stopServer();
      }
    });

    it('replaying the same receipt credits nothing', async () => {
      const user = await makeUser();
      await startServer({
        verifyReceipt: fakeReceipt({ ok: true, sku: 'gold_500', transactionId: 'tx-iap-replay', gold: 500 }),
      });
      try {
        const first = await json('/gold/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
          body: JSON.stringify({ platform: 'apple', receipt: 'base64receipt' }),
        });
        assert.equal(first.status, 200);
        assert.equal(first.body.gold, 500);

        const second = await json('/gold/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
          body: JSON.stringify({ platform: 'apple', receipt: 'base64receipt' }),
        });
        assert.equal(second.status, 200, 'a replayed receipt must still answer 200, since the client retries too');
        assert.equal(second.body.gold, 500, 'balance must be unchanged on replay');
      } finally {
        await stopServer();
      }
    });

    it('an unknown SKU credits nothing', async () => {
      const user = await makeUser();
      await startServer({
        verifyReceipt: fakeReceipt({ ok: false, reason: 'unknown_sku' }),
      });
      try {
        await json('/gold/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
          body: JSON.stringify({ platform: 'apple', receipt: 'base64receipt' }),
        });
        const balance = await query<{ gold: number }>('select gold from users where id = $1', [user.id]);
        assert.equal(balance.rows[0].gold, 0);
      } finally {
        await stopServer();
      }
    });

    it('requires a session: 401 without a valid bearer', async () => {
      await startServer({
        verifyReceipt: fakeReceipt({ ok: true, sku: 'gold_500', transactionId: 'tx-iap-nosession', gold: 500 }),
      });
      try {
        const { status } = await json('/gold/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'apple', receipt: 'base64receipt' }),
        });
        assert.equal(status, 401);
      } finally {
        await stopServer();
      }
    });

    it('credits the session user, ignoring a different user id sent in the body', async () => {
      const sessionUser = await makeUser();
      const otherUser = await makeUser();
      await startServer({
        verifyReceipt: fakeReceipt({ ok: true, sku: 'gold_500', transactionId: 'tx-iap-othersent', gold: 500 }),
      });
      try {
        const { status, body } = await json('/gold/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionUser.token}` },
          body: JSON.stringify({ platform: 'apple', receipt: 'base64receipt', userId: otherUser.id }),
        });
        assert.equal(status, 200);
        assert.equal(body.gold, 500);

        const sessionBalance = await query<{ gold: number }>('select gold from users where id = $1', [sessionUser.id]);
        const otherBalance = await query<{ gold: number }>('select gold from users where id = $1', [otherUser.id]);
        assert.equal(sessionBalance.rows[0].gold, 500, 'the session user must be the one credited');
        assert.equal(otherBalance.rows[0].gold, 0, 'the user id from the body must be ignored');
      } finally {
        await stopServer();
      }
    });

    it('never echoes the receipt in the response', async () => {
      const user = await makeUser();
      await startServer({
        verifyReceipt: fakeReceipt({ ok: true, sku: 'gold_500', transactionId: 'tx-iap-noleak', gold: 500 }),
      });
      try {
        const { text } = await json('/gold/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
          body: JSON.stringify({ platform: 'apple', receipt: 'super-secret-receipt-blob' }),
        });
        assert.ok(!text.includes('super-secret-receipt-blob'));
      } finally {
        await stopServer();
      }
    });
  });
});
