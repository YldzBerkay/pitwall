import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { teamValue } from '../src/economy/value.ts';

const base = {
  rp: 1000,
  car: { motor: 70, aero: 70, grip: 70 },
  factoryLevels: {} as Record<string, number>,
};

describe('team value', () => {
  it('is positive for a fresh team', () => {
    assert.ok(teamValue(base) > 0);
  });

  it('grows with the car', () => {
    assert.ok(teamValue({ ...base, car: { motor: 90, aero: 90, grip: 90 } }) > teamValue(base));
  });

  it('grows with factory investment', () => {
    assert.ok(teamValue({ ...base, factoryLevels: { wind_tunnel: 3, engine_lab: 2 } }) > teamValue(base));
  });

  it('values a higher factory level more than a lower one', () => {
    const l1 = teamValue({ ...base, factoryLevels: { wind_tunnel: 1 } });
    const l3 = teamValue({ ...base, factoryLevels: { wind_tunnel: 3 } });
    assert.ok(l3 > l1, 'level 3 must be worth more than level 1');
  });

  it('counts banked rp', () => {
    assert.ok(teamValue({ ...base, rp: 50_000 }) > teamValue(base));
  });

  it('ignores an unknown department rather than throwing', () => {
    assert.equal(
      teamValue({ ...base, factoryLevels: { not_a_department: 4 } }),
      teamValue(base),
      'an unknown code must not add value',
    );
  });

  it('treats a missing or zero level as no investment', () => {
    assert.equal(teamValue({ ...base, factoryLevels: { wind_tunnel: 0 } }), teamValue(base));
  });

  it('does not go negative or explode on a below-baseline car', () => {
    const v = teamValue({ ...base, car: { motor: 10, aero: 10, grip: 10 } });
    assert.ok(v >= 0, 'value must never be negative');
    assert.ok(v <= teamValue(base), 'a worse car must not be worth more');
  });

  it('is a whole number — it is shown to the player as money', () => {
    assert.equal(Number.isInteger(teamValue(base)), true);
    assert.equal(Number.isInteger(teamValue({ ...base, factoryLevels: { wind_tunnel: 5 } })), true);
    assert.equal(Number.isInteger(teamValue({ ...base, car: { motor: 71.5, aero: 70, grip: 70 } })), true);
  });

  it('is deterministic and does not mutate its input', () => {
    const input = { rp: 1000, car: { motor: 70, aero: 70, grip: 70 }, factoryLevels: { wind_tunnel: 2 } };
    const snapshot = JSON.stringify(input);
    const first = teamValue(input);
    assert.equal(teamValue(input), first);
    assert.equal(JSON.stringify(input), snapshot, 'teamValue mutated its argument');
  });
});
