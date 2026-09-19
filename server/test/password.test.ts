import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validatePassword } from '../src/auth/password.ts';

describe('validatePassword', () => {
  it('accepts a password of at least 8 characters', () => {
    assert.equal(validatePassword('correct-horse'), 'ok');
  });

  it('rejects anything shorter than 8 characters', () => {
    assert.equal(validatePassword('short7!'), 'too_short');
  });

  it('rejects anything longer than 200 characters', () => {
    assert.equal(validatePassword('a'.repeat(201)), 'too_long');
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct-horse-battery');
    assert.equal(await verifyPassword('correct-horse-battery', stored), true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct-horse-battery');
    assert.equal(await verifyPassword('wrong-horse-battery', stored), false);
  });

  it('salts — the same password hashes differently every time', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    assert.notEqual(a, b);
  });

  it('emits the documented encoding', async () => {
    const stored = await hashPassword('correct-horse-battery');
    assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('returns false for a malformed stored value instead of throwing', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
    assert.equal(await verifyPassword('anything', 'scrypt$1$2$3'), false);
  });

  it('returns false quickly for an out-of-range or invalid N, instead of hanging', async () => {
    const salt = Buffer.from('0123456789abcdef').toString('base64');
    const key = Buffer.from('0123456789abcdef').toString('base64');
    // N is not a power of two greater than 1
    assert.equal(await verifyPassword('anything', `scrypt$3$8$1$${salt}$${key}`), false);
    // N is absurdly large — must be rejected up front, not passed to scrypt
    assert.equal(await verifyPassword('anything', `scrypt$1073741824$8$1$${salt}$${key}`), false);
  });
});
