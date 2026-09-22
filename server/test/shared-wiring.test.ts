import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SHARED_PROBE } from '@pitwall/shared';

describe('shared package wiring', () => {
  it('is importable from the server by package name', () => {
    assert.equal(SHARED_PROBE, 'shared-package-reachable');
  });
});
