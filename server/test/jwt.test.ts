import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, SESSION_TTL_SECONDS } from '../src/auth/jwt.ts';
import { hashEmail, isPlausibleEmail } from '../src/auth/emailHash.ts';

describe('session jwt', () => {
  before(() => {
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-32b';
  });

  it('round-trips a user id', async () => {
    const token = await signSession('11111111-2222-3333-4444-555555555555');
    assert.equal(await verifySession(token), '11111111-2222-3333-4444-555555555555');
  });

  it('returns null for a tampered token', async () => {
    const token = await signSession('11111111-2222-3333-4444-555555555555');
    const tampered = `${token.slice(0, -2)}xy`;
    assert.equal(await verifySession(tampered), null);
  });

  it('returns null for garbage instead of throwing', async () => {
    assert.equal(await verifySession('not.a.jwt'), null);
    assert.equal(await verifySession(''), null);
  });

  it('returns null for a token signed with a different secret', async () => {
    const token = await signSession('11111111-2222-3333-4444-555555555555');
    process.env.SESSION_SECRET = 'a-completely-different-secret-value';
    const result = await verifySession(token);
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-32b';
    assert.equal(result, null);
  });

  it('expires in 30 days', () => {
    assert.equal(SESSION_TTL_SECONDS, 30 * 24 * 60 * 60);
  });

  it('refuses to sign when SESSION_SECRET is absent', async () => {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    await assert.rejects(() => signSession('x'), /SESSION_SECRET/);
    process.env.SESSION_SECRET = saved;
  });

  it('throws (not swallows) when SESSION_SECRET is absent at verify time', async () => {
    const saved = process.env.SESSION_SECRET;
    const token = await signSession('11111111-2222-3333-4444-555555555555');
    delete process.env.SESSION_SECRET;
    await assert.rejects(() => verifySession(token), /SESSION_SECRET/);
    process.env.SESSION_SECRET = saved;
  });

  it('carries no PII in the payload beyond sub/iss/aud/iat/exp', async () => {
    const token = await signSession('11111111-2222-3333-4444-555555555555');
    const payloadB64 = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'sub']);
  });
});

describe('hashEmail', () => {
  before(() => { process.env.EMAIL_HASH_PEPPER = 'test-pepper'; });

  it('is case- and whitespace-insensitive', () => {
    assert.equal(hashEmail('  Berkay@Example.COM '), hashEmail('berkay@example.com'));
  });

  it('produces different hashes for different addresses', () => {
    assert.notEqual(hashEmail('a@example.com'), hashEmail('b@example.com'));
  });

  it('is peppered — the hash changes with the pepper', () => {
    const a = hashEmail('berkay@example.com');
    process.env.EMAIL_HASH_PEPPER = 'different-pepper';
    const b = hashEmail('berkay@example.com');
    process.env.EMAIL_HASH_PEPPER = 'test-pepper';
    assert.notEqual(a, b);
  });

  it('does not contain the plaintext address', () => {
    assert.ok(!hashEmail('berkay@example.com').includes('berkay'));
  });
});

describe('isPlausibleEmail', () => {
  it('accepts valid addresses', () => {
    assert.ok(isPlausibleEmail('berkay@example.com'));
    assert.ok(isPlausibleEmail('a.b+c@sub.example.co.uk'));
  });

  it('rejects missing @', () => {
    assert.ok(!isPlausibleEmail('berkayexample.com'));
  });

  it('rejects missing dot in domain', () => {
    assert.ok(!isPlausibleEmail('berkay@examplecom'));
  });

  it('rejects addresses containing spaces', () => {
    assert.ok(!isPlausibleEmail('ber kay@example.com'));
    assert.ok(!isPlausibleEmail('berkay@ example.com'));
  });

  it('rejects an over-254-character address', () => {
    const local = 'a'.repeat(250);
    assert.ok(!isPlausibleEmail(`${local}@example.com`));
  });

  it('rejects the empty string', () => {
    assert.ok(!isPlausibleEmail(''));
  });
});
