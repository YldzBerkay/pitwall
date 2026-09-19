import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('test runner', () => {
  it('runs TypeScript test files', () => {
    assert.equal(1 + 1, 2);
  });
});
