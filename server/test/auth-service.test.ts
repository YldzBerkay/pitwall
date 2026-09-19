import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { verifySession } from '../src/auth/jwt.ts';
import { hashEmail } from '../src/auth/emailHash.ts';
import type { VerifiedIdentity, SocialProvider } from '../src/auth/providers/index.ts';
import {
  authenticateSocial,
  registerWithPassword,
  loginWithPassword,
  AuthError,
  type SocialDeps,
} from '../src/auth/service.ts';

/** A stub verifier backed by a plain map — never touches the network. */
function stubVerify(table: Record<string, VerifiedIdentity | null>): SocialDeps {
  return {
    verify: async (_provider: SocialProvider, token: string) =>
      Object.prototype.hasOwnProperty.call(table, token) ? table[token] : null,
  };
}

describe('auth service', () => {
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

  describe('authenticateSocial', () => {
    it('creates a new account on first social sign-in and the token verifies to that user', async () => {
      const deps = stubVerify({ 'tok-1': { providerUid: 'g-1', email: null } });
      const result = await authenticateSocial({ provider: 'google', token: 'tok-1' }, deps);
      assert.equal(result.isNew, true);
      assert.equal(await verifySession(result.token), result.user.id);
    });

    it('returns the SAME account on a second sign-in with the same provider uid', async () => {
      const deps = stubVerify({ 'tok-1': { providerUid: 'g-1', email: null } });
      const first = await authenticateSocial({ provider: 'google', token: 'tok-1' }, deps);
      const second = await authenticateSocial({ provider: 'google', token: 'tok-1' }, deps);
      assert.equal(second.user.id, first.user.id);
      assert.equal(second.isNew, false);
    });

    it('links a second provider that shares a verified email onto the same account', async () => {
      const deps = stubVerify({
        'g-tok': { providerUid: 'g-2', email: 'shared@example.com' },
        'fb-tok': { providerUid: 'fb-2', email: 'shared@example.com' },
      });
      const first = await authenticateSocial({ provider: 'google', token: 'g-tok' }, deps);
      const second = await authenticateSocial({ provider: 'facebook', token: 'fb-tok' }, deps);
      assert.equal(second.user.id, first.user.id);
      assert.equal(second.isNew, false);
    });

    it('does NOT link when the email is absent — two different accounts', async () => {
      const deps = stubVerify({
        'g-tok': { providerUid: 'g-3', email: null },
        'fb-tok': { providerUid: 'fb-3', email: null },
      });
      const first = await authenticateSocial({ provider: 'google', token: 'g-tok' }, deps);
      const second = await authenticateSocial({ provider: 'facebook', token: 'fb-tok' }, deps);
      assert.notEqual(second.user.id, first.user.id);
      assert.equal(second.isNew, true);
    });

    it('picks a pooled nickname when none is supplied', async () => {
      const deps = stubVerify({ 'tok-1': { providerUid: 'g-4', email: null } });
      const result = await authenticateSocial({ provider: 'google', token: 'tok-1' }, deps);
      assert.ok(result.user.nicknameBase.length > 0);
    });

    it('rejects an invalid provider token', async () => {
      const deps = stubVerify({});
      await assert.rejects(
        () => authenticateSocial({ provider: 'google', token: 'bad-tok' }, deps),
        (err: unknown) => err instanceof AuthError && err.code === 'invalid_token',
      );
    });

    it('rejects an invalid provider name', async () => {
      const deps = stubVerify({});
      await assert.rejects(
        () => authenticateSocial({ provider: 'myspace', token: 'tok-1' }, deps),
        (err: unknown) => err instanceof AuthError && err.code === 'invalid_provider',
      );
    });

    it('rejects a blocked nickname base', async () => {
      const deps = stubVerify({ 'tok-1': { providerUid: 'g-5', email: null } });
      await assert.rejects(
        () =>
          authenticateSocial(
            { provider: 'google', token: 'tok-1', nicknameBase: 'adminuser' },
            deps,
          ),
        (err: unknown) => err instanceof AuthError && err.code === 'nickname_blocked',
      );
    });

    it('rejects an unknown country code', async () => {
      const deps = stubVerify({ 'tok-1': { providerUid: 'g-6', email: null } });
      await assert.rejects(
        () =>
          authenticateSocial(
            { provider: 'google', token: 'tok-1', countryCode: 'ZZZ' },
            deps,
          ),
        (err: unknown) => err instanceof AuthError && err.code === 'invalid_country',
      );
    });

    it('rejects an unknown region', async () => {
      const deps = stubVerify({ 'tok-1': { providerUid: 'g-7', email: null } });
      await assert.rejects(
        () =>
          authenticateSocial({ provider: 'google', token: 'tok-1', region: 'MOON' }, deps),
        (err: unknown) => err instanceof AuthError && err.code === 'invalid_region',
      );
    });

    it('never stores the raw email address, only its pepper hash', async () => {
      const deps = stubVerify({ 'tok-1': { providerUid: 'g-8', email: 'PLAIN@Example.com' } });
      await authenticateSocial({ provider: 'google', token: 'tok-1' }, deps);
      const res = await query<Record<string, unknown>>(
        `select * from auth_identities where provider = 'google' and provider_uid = 'g-8'`,
      );
      const row = res.rows[0];
      assert.ok(row);
      for (const value of Object.values(row)) {
        if (typeof value === 'string') {
          assert.ok(!value.toLowerCase().includes('plain@example.com'), 'raw email leaked into a column');
        }
      }
      assert.equal(row.email_hash, hashEmail('PLAIN@Example.com'));
    });
  });

  describe('password auth', () => {
    it('registers then logs in with a password', async () => {
      const reg = await registerWithPassword({ email: 'pw@example.com', password: 'correcthorse' });
      assert.equal(reg.isNew, true);
      const login = await loginWithPassword({ email: 'pw@example.com', password: 'correcthorse' });
      assert.equal(login.user.id, reg.user.id);
      assert.equal(login.isNew, false);
    });

    it('treats the email case-insensitively on login', async () => {
      const reg = await registerWithPassword({ email: 'CaseTest@Example.com', password: 'correcthorse' });
      const login = await loginWithPassword({ email: 'casetest@example.com', password: 'correcthorse' });
      assert.equal(login.user.id, reg.user.id);
    });

    it('rejects duplicate registration with the same email', async () => {
      await registerWithPassword({ email: 'dup@example.com', password: 'correcthorse' });
      await assert.rejects(
        () => registerWithPassword({ email: 'dup@example.com', password: 'correcthorse' }),
        (err: unknown) => err instanceof AuthError && err.code === 'email_taken',
      );
    });

    it('rejects wrong password and unknown account both as invalid_credentials', async () => {
      await registerWithPassword({ email: 'known@example.com', password: 'correcthorse' });
      await assert.rejects(
        () => loginWithPassword({ email: 'known@example.com', password: 'wrongpassword' }),
        (err: unknown) => err instanceof AuthError && err.code === 'invalid_credentials',
      );
      await assert.rejects(
        () => loginWithPassword({ email: 'nobody@example.com', password: 'whatever12' }),
        (err: unknown) => err instanceof AuthError && err.code === 'invalid_credentials',
      );
    });

    it('rejects a malformed email on registration', async () => {
      await assert.rejects(
        () => registerWithPassword({ email: 'not-an-email', password: 'correcthorse' }),
        (err: unknown) => err instanceof AuthError && err.code === 'invalid_email',
      );
    });

    it('rejects a too-short password on registration', async () => {
      await assert.rejects(
        () => registerWithPassword({ email: 'short@example.com', password: 'a1' }),
        (err: unknown) => err instanceof AuthError && err.code === 'password_too_short',
      );
    });

    it('never stores the raw email address for a password account', async () => {
      await registerWithPassword({ email: 'Secret@Example.com', password: 'correcthorse' });
      const res = await query<Record<string, unknown>>(
        `select * from auth_identities where provider = 'password'`,
      );
      const row = res.rows[0];
      assert.ok(row);
      for (const value of Object.values(row)) {
        if (typeof value === 'string') {
          assert.ok(!value.toLowerCase().includes('secret@example.com'), 'raw email leaked into a column');
        }
      }
      assert.equal(row.email_hash, hashEmail('Secret@Example.com'));
    });

    it('links a password login onto an existing social account sharing the same verified email', async () => {
      const deps = stubVerify({ 'tok-1': { providerUid: 'g-link', email: 'link@example.com' } });
      const social = await authenticateSocial({ provider: 'google', token: 'tok-1' }, deps);
      const registered = await registerWithPassword({ email: 'link@example.com', password: 'correcthorse' });
      assert.equal(registered.user.id, social.user.id);
      assert.equal(registered.isNew, false);
    });

    it('two concurrent registrations for the same email: exactly one succeeds, the other gets email_taken (not a raw DB error)', async () => {
      const results = await Promise.allSettled([
        registerWithPassword({ email: 'race@example.com', password: 'correcthorse' }),
        registerWithPassword({ email: 'race@example.com', password: 'correcthorse' }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1, 'exactly one registration should have won the race');
      assert.equal(rejected.length, 1, 'exactly one registration should have lost the race');
      const [loser] = rejected as PromiseRejectedResult[];
      assert.ok(loser.reason instanceof AuthError, 'the loser must surface an AuthError, not a raw pg error');
      assert.equal((loser.reason as AuthError).code, 'email_taken');

      const rows = await query('select count(*)::int as c from users');
      assert.equal(rows.rows[0].c, 1, 'exactly one user row must exist after the race');
    });
  });

  describe('concurrent social sign-in race', () => {
    it('two concurrent identical social sign-ins resolve to the same account without a raw DB error', async () => {
      const identity: VerifiedIdentity = { providerUid: 'race-social-uid', email: null };
      const deps = stubVerify({ tok: identity });
      const results = await Promise.allSettled([
        authenticateSocial({ provider: 'google', token: 'tok' }, deps),
        authenticateSocial({ provider: 'google', token: 'tok' }, deps),
      ]);
      for (const r of results) {
        assert.equal(r.status, 'fulfilled', 'a concurrent duplicate sign-in must not surface a raw DB error');
      }
      const ids = (results as PromiseFulfilledResult<Awaited<ReturnType<typeof authenticateSocial>>>[]).map(
        (r) => r.value.user.id,
      );
      assert.equal(ids[0], ids[1], 'both racing calls must resolve to the SAME account');
    });
  });
});
