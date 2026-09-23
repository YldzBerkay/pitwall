/**
 * Faz 3a-2'den önceki TEK global lig artık yok: `server/src/league.ts` ve
 * onu servis eden eski uçlar (`/join`, `/weekend`, `/checkin`, `/pit`,
 * `/state`, WS `/live`) silindi çünkü bir istemciye kendi lobisininkinden
 * BAŞKA bir yarış verirlerdi. Bu test gerçek `src/index.ts` sunucusunu
 * ayağa kaldırıp şunu doğrular: eski uçlar 404, yeni `/race/...` ailesi ve
 * ilgisiz bir uç (`/onboarding/bootstrap`) hâlâ ayakta.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

process.env.SESSION_SECRET ??= 'a'.repeat(32);
process.env.EMAIL_HASH_PEPPER ??= 'test-pepper-value';
process.env.PORT ??= '8799';

const base = `http://127.0.0.1:${process.env.PORT}`;
const wsBase = `ws://127.0.0.1:${process.env.PORT}`;

async function waitForServer(url: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server never came up at ${url}`);
}

describe('legacy single-league surface is gone', () => {
  before(async () => {
    // `src/index.ts` kendi kendini ayağa kaldıran bir modül: import etmek
    // migrasyonları çalıştırıp gerçek sunucuyu dinlemeye başlatır — tıpkı
    // `npx tsx src/index.ts` gibi, ama aynı süreç içinde.
    await import('../src/index.ts');
    await waitForServer(`${base}/onboarding/bootstrap`);
  });

  it('legacy GET /state returns 404', async () => {
    const res = await fetch(`${base}/state`);
    assert.equal(res.status, 404);
  });

  it('legacy POST /join, /weekend, /checkin, /pit all return 404', async () => {
    for (const path of ['/join', '/weekend', '/checkin', '/pit']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 404, `${path} should be gone`);
    }
  });

  it('the new /race/checkin and /race/pit are still routed', async () => {
    for (const path of ['/race/checkin', '/race/pit']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      // 401 (no session) is fine — the point is they are ROUTED, not 404.
      assert.notEqual(res.status, 404, `${path} should still be routed`);
    }
  });

  it('a WebSocket to the legacy /live path no longer connects', async () => {
    const ws = new WebSocket(`${wsBase}/live`);
    const refused = await new Promise<boolean>((resolve) => {
      ws.once('open', () => resolve(false));
      ws.once('close', () => resolve(true));
      ws.once('error', () => resolve(true));
    });
    assert.ok(refused, 'the legacy /live upgrade should be refused, not opened');
  });

  it('/race/live still accepts a subscription', async () => {
    const ws = new WebSocket(`${wsBase}/race/live`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const reply = new Promise<any>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(String(raw))));
    });
    ws.send(JSON.stringify({ type: 'subscribe', lobbyId: 'does-not-exist', token: 'bad' }));
    const msg = await reply;
    assert.ok(msg.type, 'the socket should still get a structured reply, not be dropped');
    ws.close();
  });

  it('an unrelated route still answers 200', async () => {
    const res = await fetch(`${base}/onboarding/bootstrap`);
    assert.equal(res.status, 200);
  });
});
