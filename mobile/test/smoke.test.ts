/// <reference types="node" />
/**
 * Smoke test for the `tsx --test` runner itself.
 *
 * The triple-slash reference above is load-bearing: `mobile/tsconfig.json`
 * (extending `expo/tsconfig.base`) sets no explicit `types` array, and under
 * this project's TypeScript/tsconfig combination that means `@types/node`
 * (present in node_modules) is NOT auto-included, so bare `node:test` /
 * `node:assert` specifiers fail to resolve under `tsc --noEmit` without it.
 * Confirmed by reproducing the failure in isolation before adding this line.
 * We didn't touch `tsconfig.json` to fix this project-wide, per the task's
 * scope — this keeps the fix local to the one file that needs it.
 *
 * This proves two things the rest of the mobile test suite will depend on:
 *
 * 1. `@pitwall/shared` resolves — imports real constants from
 *    `shared/src/economy.ts` (via the `/economy` subpath, matching every
 *    existing import in `mobile/src`; the bare `@pitwall/shared` barrel
 *    re-exports with explicit `.ts` extensions that fail `tsc` under this
 *    tsconfig, which is why nothing in `src` imports the barrel either) and
 *    asserts on their values.
 * 2. The `@/*` -> `./src/*` alias resolves — imports the `request()` HTTP
 *    helper from `@/lib/api/identity`, the actual client this phase needs to
 *    test. `lib/api/identity.ts` is plain TypeScript: it only touches
 *    `fetch`/`AbortController` (both global under Node) and a type-only
 *    import from `@pitwall/shared/regions`. It never imports `react`,
 *    `react-native`, or `expo`, so it resolves and runs under Node with no
 *    RN/Expo shims — the boundary this test runner accepts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { ECONOMY_SCALE, GOLD_TO_RP } from '@pitwall/shared/economy';
import { request } from '@/lib/api/identity';

test('@pitwall/shared resolves and exposes the economy constants', () => {
  assert.equal(ECONOMY_SCALE, 1.5);
  assert.equal(GOLD_TO_RP, 50);
});

test('@/ alias resolves a React-Native-free client module, and request() round-trips real JSON over HTTP', async () => {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await request<{ path: string; ok: boolean }>(baseUrl, '/ping', { method: 'GET' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.path, '/ping');
      assert.equal(result.data.ok, true);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err: Error | undefined) => (err ? reject(err) : resolve())));
  }
});
