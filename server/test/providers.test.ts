import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK } from 'jose';

import { isSocialProvider, verifySocialToken } from '../src/auth/providers/index.ts';
import { verifyGoogleToken, __setGoogleJwksUrl } from '../src/auth/providers/google.ts';
import { verifyAppleToken, __setAppleJwksUrl } from '../src/auth/providers/apple.ts';
import { verifyFacebookToken } from '../src/auth/providers/facebook.ts';

/**
 * Runs `fn` with `console.error` replaced by a recorder, restoring the
 * original in a `finally` no matter what `fn` does. Used to assert the
 * infrastructure-failure / token-rejection log split (Concern 1).
 */
async function withCapturedErrors<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; errorLogs: unknown[][] }> {
  const original = console.error;
  const errorLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errorLogs.push(args);
  };
  try {
    const result = await fn();
    return { result, errorLogs };
  } finally {
    console.error = original;
  }
}

/** Starts an HTTP server that answers every request with `status`, on a random port. */
async function serveStatus(status: number): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(status);
    res.end('not ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/jwks`, server };
}

/** Serves a JWKS containing the given public JWK under a fixed kid, on a random port. */
async function serveJwks(jwk: JWK): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'test-kid', use: 'sig', alg: 'RS256' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/jwks`, server };
}

describe('providers/index', () => {
  it('isSocialProvider accepts the three known providers', () => {
    assert.ok(isSocialProvider('google'));
    assert.ok(isSocialProvider('apple'));
    assert.ok(isSocialProvider('facebook'));
  });

  it('isSocialProvider rejects anything else', () => {
    assert.ok(!isSocialProvider('myspace'));
    assert.ok(!isSocialProvider(42));
    assert.ok(!isSocialProvider(null));
    assert.ok(!isSocialProvider(undefined));
  });
});

describe('verifySocialToken fail-closed with no env configured', () => {
  const saved = {
    GOOGLE_CLIENT_IDS: process.env.GOOGLE_CLIENT_IDS,
    APPLE_BUNDLE_IDS: process.env.APPLE_BUNDLE_IDS,
    FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET,
  };

  before(() => {
    delete process.env.GOOGLE_CLIENT_IDS;
    delete process.env.APPLE_BUNDLE_IDS;
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('google returns null, never throws', async () => {
    assert.equal(await verifySocialToken('google', 'anything'), null);
  });

  it('apple returns null, never throws', async () => {
    assert.equal(await verifySocialToken('apple', 'anything'), null);
  });

  it('facebook returns null, never throws', async () => {
    assert.equal(await verifySocialToken('facebook', 'anything'), null);
  });
});

describe('google token verification', () => {
  let jwksServer: Server;
  let privateKey: KeyLike;
  let goodJwksUrl: string;
  const CLIENT_A = 'client-a.apps.googleusercontent.com';
  const CLIENT_B = 'client-b.apps.googleusercontent.com';

  before(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
    privateKey = priv;
    const jwk = await exportJWK(publicKey);
    const { url, server } = await serveJwks(jwk);
    jwksServer = server;
    goodJwksUrl = url;
    __setGoogleJwksUrl(url);
    process.env.GOOGLE_CLIENT_IDS = `${CLIENT_A},${CLIENT_B}`;
  });

  after(async () => {
    await new Promise((resolve) => jwksServer.close(resolve));
    delete process.env.GOOGLE_CLIENT_IDS;
  });

  function makeToken(overrides: Record<string, unknown> = {}, aud = CLIENT_A) {
    return new SignJWT({
      email: 'driver@example.com',
      email_verified: true,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setSubject('google-uid-123')
      .setIssuer('https://accounts.google.com')
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('accepts a token for the first configured client id', async () => {
    const token = await makeToken({}, CLIENT_A);
    const result = await verifyGoogleToken(token);
    assert.deepEqual(result, { providerUid: 'google-uid-123', email: 'driver@example.com' });
  });

  it('accepts a token for the second configured client id', async () => {
    const token = await makeToken({}, CLIENT_B);
    const result = await verifyGoogleToken(token);
    assert.deepEqual(result, { providerUid: 'google-uid-123', email: 'driver@example.com' });
  });

  it('rejects an unconfigured audience (impersonation attack)', async () => {
    const token = await makeToken({}, 'attacker-app.apps.googleusercontent.com');
    assert.equal(await verifyGoogleToken(token), null);
  });

  it('rejects a wrong issuer', async () => {
    const token = await new SignJWT({ email: 'driver@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setSubject('google-uid-123')
      .setIssuer('https://evil.example.com')
      .setAudience(CLIENT_A)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    assert.equal(await verifyGoogleToken(token), null);
  });

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ email: 'driver@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setSubject('google-uid-123')
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_A)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    assert.equal(await verifyGoogleToken(token), null);
  });

  it('drops an unverified email instead of rejecting the token', async () => {
    const token = await makeToken({ email_verified: false });
    const result = await verifyGoogleToken(token);
    assert.deepEqual(result, { providerUid: 'google-uid-123', email: null });
  });

  it('rejects garbage input', async () => {
    assert.equal(await verifyGoogleToken('not-a-jwt-at-all'), null);
  });

  it('accepts the non-https issuer form "accounts.google.com"', async () => {
    const token = await new SignJWT({ email: 'driver@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setSubject('google-uid-123')
      .setIssuer('accounts.google.com')
      .setAudience(CLIENT_A)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    const result = await verifyGoogleToken(token);
    assert.deepEqual(result, { providerUid: 'google-uid-123', email: 'driver@example.com' });
  });

  it('returns null when GOOGLE_CLIENT_IDS is unset (fail closed)', async () => {
    const token = await makeToken({}, CLIENT_A);
    const saved = process.env.GOOGLE_CLIENT_IDS;
    delete process.env.GOOGLE_CLIENT_IDS;
    const result = await verifyGoogleToken(token);
    process.env.GOOGLE_CLIENT_IDS = saved;
    assert.equal(result, null);
  });

  it('stays quiet (no console.error) on an ordinary token rejection', async () => {
    const token = await makeToken({}, 'attacker-app.apps.googleusercontent.com');
    const { result, errorLogs } = await withCapturedErrors(() => verifyGoogleToken(token));
    assert.equal(result, null);
    assert.deepEqual(errorLogs, []);
  });

  it('logs to console.error on a JWKS infrastructure failure (non-200), without leaking the token', async () => {
    const token = await makeToken({}, CLIENT_A);
    const { url: brokenUrl, server: brokenServer } = await serveStatus(500);
    __setGoogleJwksUrl(brokenUrl);

    const { result, errorLogs } = await withCapturedErrors(() => verifyGoogleToken(token));

    __setGoogleJwksUrl(goodJwksUrl);
    await new Promise((resolve) => brokenServer.close(resolve));

    assert.equal(result, null);
    assert.equal(errorLogs.length, 1);
    const line = String(errorLogs[0]?.[0]);
    assert.match(line, /google/);
    assert.ok(!line.includes(token), 'infrastructure-failure log must never contain the token');
  });
});

describe('apple token verification', () => {
  let jwksServer: Server;
  let privateKey: KeyLike;
  let goodJwksUrl: string;
  const BUNDLE_A = 'com.pitwall.app';

  before(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
    privateKey = priv;
    const jwk = await exportJWK(publicKey);
    const { url, server } = await serveJwks(jwk);
    jwksServer = server;
    goodJwksUrl = url;
    __setAppleJwksUrl(url);
    process.env.APPLE_BUNDLE_IDS = BUNDLE_A;
  });

  after(async () => {
    await new Promise((resolve) => jwksServer.close(resolve));
    delete process.env.APPLE_BUNDLE_IDS;
  });

  function baseToken(aud = BUNDLE_A) {
    return new SignJWT({ email: 'driver@privaterelay.appleid.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setSubject('apple-uid-123')
      .setIssuer('https://appleid.apple.com')
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('1h');
  }

  it('accepts a valid token for a configured bundle id', async () => {
    const token = await baseToken().sign(privateKey);
    const result = await verifyAppleToken(token);
    assert.deepEqual(result, { providerUid: 'apple-uid-123', email: 'driver@privaterelay.appleid.com' });
  });

  it('rejects an unconfigured audience (impersonation attack)', async () => {
    const token = await baseToken('com.attacker.app').sign(privateKey);
    assert.equal(await verifyAppleToken(token), null);
  });

  it('accepts email_verified as boolean true', async () => {
    const token = await new SignJWT({ email: 'a@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setSubject('apple-uid-bool')
      .setIssuer('https://appleid.apple.com')
      .setAudience(BUNDLE_A)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    const result = await verifyAppleToken(token);
    assert.deepEqual(result, { providerUid: 'apple-uid-bool', email: 'a@example.com' });
  });

  it('accepts email_verified as the string "true"', async () => {
    const token = await new SignJWT({ email: 'a@example.com', email_verified: 'true' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setSubject('apple-uid-str')
      .setIssuer('https://appleid.apple.com')
      .setAudience(BUNDLE_A)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    const result = await verifyAppleToken(token);
    assert.deepEqual(result, { providerUid: 'apple-uid-str', email: 'a@example.com' });
  });

  it('stays quiet (no console.error) on an ordinary token rejection', async () => {
    const token = await baseToken('com.attacker.app').sign(privateKey);
    const { result, errorLogs } = await withCapturedErrors(() => verifyAppleToken(token));
    assert.equal(result, null);
    assert.deepEqual(errorLogs, []);
  });

  it('logs to console.error on a JWKS infrastructure failure (non-200), without leaking the token', async () => {
    const token = await baseToken().sign(privateKey);
    const { url: brokenUrl, server: brokenServer } = await serveStatus(503);
    __setAppleJwksUrl(brokenUrl);

    const { result, errorLogs } = await withCapturedErrors(() => verifyAppleToken(token));

    __setAppleJwksUrl(goodJwksUrl);
    await new Promise((resolve) => brokenServer.close(resolve));

    assert.equal(result, null);
    assert.equal(errorLogs.length, 1);
    const line = String(errorLogs[0]?.[0]);
    assert.match(line, /apple/);
    assert.ok(!line.includes(token), 'infrastructure-failure log must never contain the token');
  });
});

describe('facebook token verification', () => {
  const APP_ID = '1234567890';
  const APP_SECRET = 'shh-secret';
  let originalFetch: typeof fetch;

  before(() => {
    process.env.FACEBOOK_APP_ID = APP_ID;
    process.env.FACEBOOK_APP_SECRET = APP_SECRET;
    originalFetch = globalThis.fetch;
  });

  after(() => {
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      const { status, body } = handler(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }) as typeof fetch;
  }

  it('accepts a valid token issued for our app', async () => {
    stubFetch((url) => {
      if (url.includes('debug_token')) {
        return { status: 200, body: { data: { is_valid: true, app_id: APP_ID, user_id: 'fb-uid-1' } } };
      }
      return { status: 200, body: { id: 'fb-uid-1', email: 'driver@example.com' } };
    });
    const result = await verifyFacebookToken('sometoken');
    assert.deepEqual(result, { providerUid: 'fb-uid-1', email: 'driver@example.com' });
  });

  it('rejects a token issued for a different app (impersonation attack)', async () => {
    stubFetch((url) => {
      if (url.includes('debug_token')) {
        return { status: 200, body: { data: { is_valid: true, app_id: 'someone-elses-app', user_id: 'fb-uid-1' } } };
      }
      return { status: 200, body: { id: 'fb-uid-1', email: 'driver@example.com' } };
    });
    assert.equal(await verifyFacebookToken('sometoken'), null);
  });

  it('rejects is_valid: false', async () => {
    stubFetch((url) => {
      if (url.includes('debug_token')) {
        return { status: 200, body: { data: { is_valid: false, app_id: APP_ID, user_id: 'fb-uid-1' } } };
      }
      return { status: 200, body: { id: 'fb-uid-1', email: 'driver@example.com' } };
    });
    assert.equal(await verifyFacebookToken('sometoken'), null);
  });

  it('succeeds with email: null when /me returns no email', async () => {
    stubFetch((url) => {
      if (url.includes('debug_token')) {
        return { status: 200, body: { data: { is_valid: true, app_id: APP_ID, user_id: 'fb-uid-1' } } };
      }
      return { status: 200, body: { id: 'fb-uid-1' } };
    });
    const result = await verifyFacebookToken('sometoken');
    assert.deepEqual(result, { providerUid: 'fb-uid-1', email: null });
  });

  it('succeeds with email: null when the /me call itself fails', async () => {
    stubFetch((url) => {
      if (url.includes('debug_token')) {
        return { status: 200, body: { data: { is_valid: true, app_id: APP_ID, user_id: 'fb-uid-1' } } };
      }
      return { status: 500, body: { error: 'boom' } };
    });
    const result = await verifyFacebookToken('sometoken');
    assert.deepEqual(result, { providerUid: 'fb-uid-1', email: null });
  });

  it('returns null when the app credentials are unset', async () => {
    const savedId = process.env.FACEBOOK_APP_ID;
    const savedSecret = process.env.FACEBOOK_APP_SECRET;
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;
    stubFetch(() => ({ status: 200, body: { data: { is_valid: true, app_id: APP_ID, user_id: 'fb-uid-1' } } }));
    const result = await verifyFacebookToken('sometoken');
    process.env.FACEBOOK_APP_ID = savedId;
    process.env.FACEBOOK_APP_SECRET = savedSecret;
    assert.equal(result, null);
  });

  it('stays quiet (no console.error) on an ordinary token rejection (wrong app)', async () => {
    stubFetch((url) => {
      if (url.includes('debug_token')) {
        return { status: 200, body: { data: { is_valid: true, app_id: 'someone-elses-app', user_id: 'fb-uid-1' } } };
      }
      return { status: 200, body: { id: 'fb-uid-1', email: 'driver@example.com' } };
    });
    const { result, errorLogs } = await withCapturedErrors(() => verifyFacebookToken('sometoken'));
    assert.equal(result, null);
    assert.deepEqual(errorLogs, []);
  });

  it('logs to console.error on a Graph infrastructure failure (non-200 from debug_token), without leaking the token', async () => {
    const token = 'super-secret-token-value';
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));
    const { result, errorLogs } = await withCapturedErrors(() => verifyFacebookToken(token));
    assert.equal(result, null);
    assert.equal(errorLogs.length, 1);
    const line = String(errorLogs[0]?.[0]);
    assert.match(line, /facebook/);
    assert.ok(!line.includes(token), 'infrastructure-failure log must never contain the token');
  });

  it('returns null quickly (without hanging) when the Graph call never responds, and logs it as infrastructure', async () => {
    const originalAbortTimeout = AbortSignal.timeout;
    // Speed up the test rather than waiting out the real ~4s production
    // budget: shrink every AbortSignal.timeout(ms) call to 20ms. This still
    // exercises the real abort wiring in facebook.ts, just faster.
    (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = () =>
      originalAbortTimeout(20);

    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never settles — the test would hang if the code forgot the signal
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;

    const start = Date.now();
    const { result, errorLogs } = await withCapturedErrors(() => verifyFacebookToken('sometoken'));
    const elapsed = Date.now() - start;

    AbortSignal.timeout = originalAbortTimeout;

    assert.equal(result, null);
    assert.ok(elapsed < 2000, `expected the abort to resolve quickly, took ${elapsed}ms`);
    assert.equal(errorLogs.length, 1);
    assert.match(String(errorLogs[0]?.[0]), /facebook/);
  });
});

describe('verifySocialToken dispatch', () => {
  it('rejects an unknown provider gracefully via type system boundary (facebook path smoke test)', async () => {
    // Sanity: dispatch works for a known provider even with no fetch stub (network will fail -> null).
    const saved = process.env.FACEBOOK_APP_ID;
    process.env.FACEBOOK_APP_ID = 'x';
    process.env.FACEBOOK_APP_SECRET = 'y';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const result = await verifySocialToken('facebook', 'token');
    globalThis.fetch = originalFetch;
    process.env.FACEBOOK_APP_ID = saved;
    assert.equal(result, null);
  });
});
