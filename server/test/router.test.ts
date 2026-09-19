import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';

let server: Server;
let base: string;

describe('Router', () => {
  before(async () => {
    const router = new Router();
    router.get('/ping', async () => ({ status: 200, body: { pong: true } }));
    router.post('/echo', async (ctx) => ({ status: 200, body: { got: ctx.body } }));
    router.get('/boom', async () => { throw new Error('kaboom'); });
    router.get('/auth/social', async () => ({ status: 200, body: {} }));
    router.get('/unicode', async () => ({
      status: 200,
      body: { text: 'Türkiye ığşçöü 日本語のテスト' },
    }));
    router.get('/circular', async () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      return { status: 200, body: obj };
    });

    server = createServer(async (req, res) => {
      if (await router.handle(req, res)) return;
      res.writeHead(404).end('fell through');
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('routes a GET and returns JSON', async () => {
    const res = await fetch(`${base}/ping`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), { pong: true });
  });

  it('parses a JSON body on POST', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    assert.deepEqual(await res.json(), { got: { a: 1 } });
  });

  it('answers a malformed JSON body with 400, not a crash', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { error: string }).error, 'invalid_json');
  });

  it('turns an unexpected throw into a 500 without leaking the message', async () => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'internal_error');
    assert.ok(!JSON.stringify(body).includes('kaboom'), 'internal message leaked to client');
  });

  it('answers CORS preflight', async () => {
    const res = await fetch(`${base}/echo`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(res.headers.get('access-control-allow-headers')?.includes('authorization'));
  });

  it('returns false for an unregistered route so the caller can fall through', async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'fell through');
  });

  it('rejects a body larger than the limit', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(200_000) }),
    });
    assert.equal(res.status, 413);
  });

  it('does not treat a path as a suffix match of another registered path', async () => {
    // /auth/social is registered; /social must NOT be seen as "handled"
    // just because the route key ends with " /social".
    const res = await fetch(`${base}/social`, { method: 'OPTIONS' });
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'fell through');
  });

  it('sets content-length correctly for multi-byte UTF-8 bodies', async () => {
    const res = await fetch(`${base}/unicode`);
    assert.equal(res.status, 200);
    const json = await res.json() as { text: string };
    assert.equal(json.text, 'Türkiye ığşçöü 日本語のテスト');
  });

  it('turns a JSON.stringify failure (circular body) into a safe response, not a crash', async () => {
    const res = await fetch(`${base}/circular`);
    assert.equal(res.status, 500);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'internal_error');
  });
});
