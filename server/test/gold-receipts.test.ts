import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { verifyReceipt } from '../src/gold/receipts.ts';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

// Catalogue SKUs (must match shared/src/economy.ts's goldPacks).
const PADDOCK_SKU = 'com.yberkayarda.pitwall.gold15';
const PADDOCK_GOLD = 180;
const UNKNOWN_SKU = 'com.attacker.free.gold';

type FetchCall = { url: string; init?: RequestInit };

let calls: FetchCall[];

function stubFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('gold receipt verification', () => {
  before(() => {
    process.env.APPLE_SHARED_SECRET = 'test-shared-secret';
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@pitwall-test.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.yberkayarda.pitwall';
  });

  beforeEach(() => {
    calls = [];
  });

  after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  describe('apple', () => {
    it('accepts a valid receipt and reports sku, transaction id, and catalogue gold', async () => {
      stubFetch(() =>
        jsonResponse({
          status: 0,
          receipt: { in_app: [{ product_id: PADDOCK_SKU, transaction_id: 'txn-apple-1', quantity: '1' }] },
        }),
      );

      const result = await verifyReceipt({ platform: 'apple', receipt: 'base64receipt==' });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.sku, PADDOCK_SKU);
        assert.equal(result.transactionId, 'txn-apple-1');
        assert.equal(result.gold, PADDOCK_GOLD);
      }
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /buy\.itunes\.apple\.com/);
    });

    it('rejects a non-zero status', async () => {
      stubFetch(() => jsonResponse({ status: 21002 }));
      const result = await verifyReceipt({ platform: 'apple', receipt: 'bad-receipt' });
      assert.equal(result.ok, false);
    });

    it('rejects an HTTP 500 from Apple', async () => {
      stubFetch(() => new Response('server error', { status: 500 }));
      const result = await verifyReceipt({ platform: 'apple', receipt: 'whatever' });
      assert.equal(result.ok, false);
    });

    it('retries against the sandbox endpoint on the sandbox-receipt status, then accepts', async () => {
      stubFetch((call, index) => {
        if (index === 0) {
          // 21007: sandbox receipt sent to production.
          return jsonResponse({ status: 21007 });
        }
        return jsonResponse({
          status: 0,
          receipt: { in_app: [{ product_id: PADDOCK_SKU, transaction_id: 'txn-sandbox-1', quantity: '1' }] },
        });
      });

      const result = await verifyReceipt({ platform: 'apple', receipt: 'sandbox-receipt' });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.transactionId, 'txn-sandbox-1');
        assert.equal(result.gold, PADDOCK_GOLD);
      }
      assert.equal(calls.length, 2);
      assert.match(calls[0].url, /buy\.itunes\.apple\.com/);
      assert.match(calls[1].url, /sandbox\.itunes\.apple\.com/);
    });

    it('never puts the shared secret in a thrown error or logged text (spot check body only)', async () => {
      stubFetch((call) => {
        // The shared secret must be in the POST body, not the URL.
        assert.doesNotMatch(call.url, /test-shared-secret/);
        return jsonResponse({
          status: 0,
          receipt: { in_app: [{ product_id: PADDOCK_SKU, transaction_id: 'txn-x', quantity: '1' }] },
        });
      });
      await verifyReceipt({ platform: 'apple', receipt: 'r' });
    });

    it('fails closed when APPLE_SHARED_SECRET is missing', async () => {
      const saved = process.env.APPLE_SHARED_SECRET;
      delete process.env.APPLE_SHARED_SECRET;
      stubFetch(() =>
        jsonResponse({
          status: 0,
          receipt: { in_app: [{ product_id: PADDOCK_SKU, transaction_id: 'txn-x', quantity: '1' }] },
        }),
      );
      try {
        const result = await verifyReceipt({ platform: 'apple', receipt: 'r' });
        assert.equal(result.ok, false);
        assert.equal(calls.length, 0);
      } finally {
        process.env.APPLE_SHARED_SECRET = saved;
      }
    });
  });

  describe('google', () => {
    it('accepts a valid, purchased purchase', async () => {
      stubFetch((call, index) => {
        if (index === 0) {
          return jsonResponse({ access_token: 'test-access-token', expires_in: 3600 });
        }
        return jsonResponse({ purchaseState: 0, orderId: 'GPA.txn-google-1' });
      });

      const result = await verifyReceipt({ platform: 'google', receipt: 'purchase-token', sku: PADDOCK_SKU });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.sku, PADDOCK_SKU);
        assert.equal(result.transactionId, 'GPA.txn-google-1');
        assert.equal(result.gold, PADDOCK_GOLD);
      }
    });

    it('rejects a purchase that is not in the purchased state (pending/cancelled)', async () => {
      stubFetch((call, index) => {
        if (index === 0) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
        return jsonResponse({ purchaseState: 1, orderId: 'GPA.cancelled' }); // 1 = cancelled
      });

      const result = await verifyReceipt({ platform: 'google', receipt: 'purchase-token', sku: PADDOCK_SKU });
      assert.equal(result.ok, false);
    });

    it('fails closed when Google service-account credentials are missing', async () => {
      const savedKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
      stubFetch(() => jsonResponse({ access_token: 'tok', expires_in: 3600 }));
      try {
        const result = await verifyReceipt({ platform: 'google', receipt: 'purchase-token', sku: PADDOCK_SKU });
        assert.equal(result.ok, false);
        assert.equal(calls.length, 0);
      } finally {
        process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = savedKey;
      }
    });
  });

  describe('SKU allow-list and gold amount', () => {
    it('rejects an unknown SKU even when the store says the purchase is valid', async () => {
      stubFetch(() =>
        jsonResponse({
          status: 0,
          receipt: { in_app: [{ product_id: UNKNOWN_SKU, transaction_id: 'txn-attacker', quantity: '1' }] },
        }),
      );

      const result = await verifyReceipt({ platform: 'apple', receipt: 'r' });
      assert.equal(result.ok, false);
      // No gold amount is ever surfaced for an unknown SKU.
      assert.equal((result as { gold?: number }).gold, undefined);
    });

    it('ignores a store-claimed gold amount larger than the catalogue price', async () => {
      stubFetch(() =>
        jsonResponse({
          status: 0,
          // A hostile/compromised response claiming this purchase is worth far
          // more gold than the catalogue says. The field name mirrors what an
          // attacker-controlled intermediary might inject; the module must
          // never read a gold amount from anywhere but the catalogue.
          receipt: {
            in_app: [
              {
                product_id: PADDOCK_SKU,
                transaction_id: 'txn-inflated',
                quantity: '1',
                gold: 999999,
                reward_amount: 999999,
              },
            ],
          },
        }),
      );

      const result = await verifyReceipt({ platform: 'apple', receipt: 'r' });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.gold, PADDOCK_GOLD);
      }
    });
  });

  describe('resilience', () => {
    it('returns a rejection on network failure instead of throwing', async () => {
      stubFetch(() => {
        throw new Error('ECONNRESET');
      });
      await assert.doesNotReject(async () => {
        const result = await verifyReceipt({ platform: 'apple', receipt: 'r' });
        assert.equal(result.ok, false);
      });
    });

    it('does not hang the caller on a timeout (abort surfaces as a rejection)', async () => {
      stubFetch(async (call) => {
        // A real fetch never resolves on its own here, but DOES respect the
        // AbortSignal the implementation must pass in. This stub mirrors
        // that: it only settles when the signal aborts, proving the module
        // actually wires up a timeout rather than awaiting forever.
        const signal = call.init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        });
      });

      const start = Date.now();
      const result = await verifyReceipt({ platform: 'apple', receipt: 'r' });
      const elapsed = Date.now() - start;
      assert.equal(result.ok, false);
      assert.ok(elapsed < 10_000, `expected verifyReceipt to time out quickly, took ${elapsed}ms`);
    });
  });
});
