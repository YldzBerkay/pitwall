import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerAuthRoutes } from '../src/auth/routes.ts';
import { registerIdentityRoutes } from '../src/identity/routes.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';

let server: Server;
let base: string;

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, body, text };
}

describe('identity http', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.EMAIL_HASH_PEPPER = 'test-pepper-value';
    await runMigrations();

    const router = new Router();
    registerAuthRoutes(router);
    registerIdentityRoutes(router);

    server = createServer(async (req, res) => {
      if (await router.handle(req, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  beforeEach(async () => {
    await query('delete from users');
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await closePool();
  });

  describe('GET /onboarding/bootstrap', () => {
    it('suggests a region for a public IPv4 address', async () => {
      const { status, body } = await json('/onboarding/bootstrap', {
        headers: { 'x-forwarded-for': '8.8.8.8' },
      });
      assert.equal(status, 200);
      assert.equal(body.suggestedNicknames.length, 4);
      for (const s of body.suggestedNicknames) {
        assert.match(s.tag, /^[0-9]{4}$/);
        assert.ok(typeof s.base === 'string' && s.base.length > 0);
      }
      assert.equal(body.suggestedRegion, 'NA');
      assert.equal(body.regions.length, 7);
      assert.ok(body.countries.length >= 200);
    });

    it('returns null suggestedRegion for a private address', async () => {
      const { status, body } = await json('/onboarding/bootstrap', {
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
      assert.equal(status, 200);
      assert.equal(body.suggestedRegion, null);
    });
  });

  describe('POST /auth/password/register', () => {
    it('registers and returns 201 with a public profile carrying no email', async () => {
      const { status, body, text } = await json('/auth/password/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'racer@example.com',
          password: 'correct horse battery staple',
          nicknameBase: 'TurboKral',
          countryCode: 'TR',
        }),
      });
      assert.equal(status, 201);
      assert.ok(typeof body.token === 'string' && body.token.length > 0);
      assert.match(body.user.nickname, /^TurboKral#[0-9]{4}$/);
      assert.equal(body.user.country, 'TR');
      assert.ok(!text.includes('racer@example.com'), 'plaintext email leaked into response body');
    });

    it('rejects a blocked nickname base with 400', async () => {
      const { status, body } = await json('/auth/password/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'blocked@example.com',
          password: 'correct horse battery staple',
          nicknameBase: 'adminPanel',
        }),
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'nickname_blocked');
    });
  });

  describe('POST /auth/password/login', () => {
    it('rejects a wrong password with 401', async () => {
      await json('/auth/password/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'wrongpw@example.com', password: 'correct horse battery staple' }),
      });
      const { status, body } = await json('/auth/password/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'wrongpw@example.com', password: 'nope nope nope nope' }),
      });
      assert.equal(status, 401);
      assert.equal(body.error, 'invalid_credentials');
    });
  });

  describe('POST /auth/social', () => {
    it('rejects an unknown provider with 400', async () => {
      const { status, body } = await json('/auth/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'myspace', token: 'whatever' }),
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'invalid_provider');
    });
  });

  describe('GET /me', () => {
    it('is unauthorized with no bearer token', async () => {
      const { status, body } = await json('/me');
      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    });

    it('is unauthorized with a garbage bearer token', async () => {
      const { status, body } = await json('/me', { headers: { authorization: 'Bearer garbage' } });
      assert.equal(status, 401);
      assert.equal(body.error, 'unauthorized');
    });

    it('returns the profile for a valid session', async () => {
      const reg = await json('/auth/password/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'meuser@example.com', password: 'correct horse battery staple', nicknameBase: 'DriftKing' }),
      });
      const { status, body } = await json('/me', { headers: { authorization: `Bearer ${reg.body.token}` } });
      assert.equal(status, 200);
      assert.match(body.nickname, /^DriftKing#[0-9]{4}$/);
      assert.equal(body.gold, 0);
      assert.equal(body.rankPoints, 0);
    });
  });

  describe('PATCH /me', () => {
    it('updates country and region', async () => {
      const reg = await json('/auth/password/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'patchme@example.com', password: 'correct horse battery staple' }),
      });
      const token = reg.body.token;
      const { status, body } = await json('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ countryCode: 'DE', region: 'EU' }),
      });
      assert.equal(status, 200);
      assert.equal(body.country, 'DE');
      assert.equal(body.region, 'EU');
    });

    it('rejects an invalid country code with 400', async () => {
      const reg = await json('/auth/password/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'badcountry@example.com', password: 'correct horse battery staple' }),
      });
      const { status, body } = await json('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.body.token}` },
        body: JSON.stringify({ countryCode: 'XX' }),
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'invalid_country');
    });

    it('rejects an invalid region with 400', async () => {
      const reg = await json('/auth/password/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'badregion@example.com', password: 'correct horse battery staple' }),
      });
      const { status, body } = await json('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.body.token}` },
        body: JSON.stringify({ region: 'MARS' }),
      });
      assert.equal(status, 400);
      assert.equal(body.error, 'invalid_region');
    });
  });
});
