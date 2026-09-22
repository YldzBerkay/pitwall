import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { verifySsvCallback, __setVerifierKeysUrl } from '../src/gold/ssv.ts';

const KEY_ID = '1234567890';
const OTHER_KEY_ID = '999999';

let server: Server;
let baseUrl: string;
let publicKeyPem: string;
let privateKeyPem: string;
let requestCount = 0;

function startKeyServer(keysBody: unknown): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(keysBody));
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: srv, url: `http://127.0.0.1:${port}/keys.json` });
    });
  });
}

function sign(content: string): string {
  const der = cryptoSign('sha256', Buffer.from(content, 'utf8'), {
    key: privateKeyPem,
    dsaEncoding: 'der',
  });
  return encodeURIComponent(der.toString('base64'));
}

function buildSignedCallback(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    ad_network: '12345',
    ad_unit: '67890',
    reward_amount: '10',
    reward_item: 'gold',
    timestamp: '1700000000',
    transaction_id: 'txn-abc-123',
    user_id: 'user-42',
    ...overrides,
  };
  const content = Object.entries(fields)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const signature = sign(content);
  return `${content}&signature=${signature}&key_id=${KEY_ID}`;
}

describe('gold ssv verification', () => {
  before(async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const started = await startKeyServer({
      keys: [{ keyId: KEY_ID, pem: publicKeyPem }],
    });
    server = started.server;
    baseUrl = started.url;
  });

  beforeEach(() => {
    requestCount = 0;
    __setVerifierKeysUrl(baseUrl);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts a correctly signed callback and exposes the parsed fields', async () => {
    const query = buildSignedCallback();
    const result = await verifySsvCallback(query);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.transactionId, 'txn-abc-123');
      assert.equal(result.userId, 'user-42');
      assert.equal(result.rewardAmount, 10);
    }
  });

  it('rejects a tampered reward_amount without re-signing (the core attack)', async () => {
    const query = buildSignedCallback();
    const tampered = query.replace('reward_amount=10', 'reward_amount=999999');
    const result = await verifySsvCallback(tampered);
    assert.equal(result.ok, false);
  });

  it('rejects a callback with no signature parameter', async () => {
    const content = 'ad_network=1&ad_unit=2&reward_amount=10&reward_item=gold' +
      '&timestamp=1700000000&transaction_id=txn-1&user_id=u1&key_id=' + KEY_ID;
    const result = await verifySsvCallback(content);
    assert.equal(result.ok, false);
  });

  it('rejects an unknown key_id', async () => {
    const query = buildSignedCallback().replace(`key_id=${KEY_ID}`, `key_id=${OTHER_KEY_ID}`);
    const result = await verifySsvCallback(query);
    assert.equal(result.ok, false);
    // one initial attempt (cache miss) + one forced refetch before giving up
    assert.ok(requestCount >= 1);
  });

  it('rejects a callback missing transaction_id', async () => {
    const fields: Record<string, string> = {
      ad_network: '12345',
      ad_unit: '67890',
      reward_amount: '10',
      reward_item: 'gold',
      timestamp: '1700000000',
      user_id: 'user-42',
    };
    const content = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('&');
    const signature = sign(content);
    const query = `${content}&signature=${signature}&key_id=${KEY_ID}`;
    const result = await verifySsvCallback(query);
    assert.equal(result.ok, false);
  });

  it('rejects garbage input without throwing', async () => {
    const inputs = ['', 'not a query string at all', '&&&&&', '===', 'a=b', 'a=b&c=d'];
    for (const input of inputs) {
      await assert.doesNotReject(async () => {
        const result = await verifySsvCallback(input);
        assert.equal(result.ok, false);
      });
    }
  });

  it('never throws, even on non-string-like edge cases', async () => {
    // @ts-expect-error deliberately passing wrong types to prove no throw
    await assert.doesNotReject(async () => verifySsvCallback(null));
    // @ts-expect-error deliberately passing wrong types to prove no throw
    await assert.doesNotReject(async () => verifySsvCallback(undefined));
  });
});
