import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMY_SCALE, GOLD_TO_RP, skipCostGold } from '@pitwall/shared/economy';
import { factoryEffects, DEPARTMENT_MAX_LEVEL } from '@pitwall/shared/factory';
import { teams } from '@pitwall/shared/teams';

describe('shared package wiring', () => {
  it('exposes the economy constants the server prices things with', () => {
    assert.equal(ECONOMY_SCALE, 1.5);
    assert.equal(GOLD_TO_RP, 50);
  });

  it('exposes pure helpers that do not read the clock', () => {
    // Biten iş bedava, 1 dakika kalan iş bir saatlik ücret.
    assert.equal(skipCostGold(0), 0);
    assert.equal(skipCostGold(60_000), 5);
  });

  it('exposes the factory effect table', () => {
    assert.equal(DEPARTMENT_MAX_LEVEL, 5);
    assert.equal(factoryEffects({}).upgradeCostScale, 1);
  });

  it('exposes the grid', () => {
    assert.equal(teams.length, 11);
  });
});
