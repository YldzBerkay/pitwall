import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NICKNAME_POOL,
  validateBase,
  randomTag,
  suggestBases,
  formatNickname,
} from '../src/identity/nickname.ts';

describe('nickname pool', () => {
  it('holds exactly 30 distinct base names', () => {
    assert.equal(NICKNAME_POOL.length, 30);
    assert.equal(new Set(NICKNAME_POOL).size, 30);
  });

  it('every pooled name passes its own validator', () => {
    for (const base of NICKNAME_POOL) {
      assert.equal(validateBase(base), 'ok', `pooled name rejected: ${base}`);
    }
  });
});

describe('validateBase', () => {
  it('accepts non-Latin scripts and Turkish letters', () => {
    assert.equal(validateBase('ApexAvcısı'), 'ok');
    assert.equal(validateBase('ゴースト'), 'ok');
    assert.equal(validateBase('Şahin_07'), 'ok');
  });

  it('rejects names shorter than 3 characters', () => {
    assert.equal(validateBase('ab'), 'too_short');
  });

  it('rejects names longer than 16 characters', () => {
    assert.equal(validateBase('a'.repeat(17)), 'too_long');
  });

  it('rejects spaces, hashes and punctuation', () => {
    assert.equal(validateBase('Turbo Kral'), 'invalid_chars');
    assert.equal(validateBase('Turbo#01'), 'invalid_chars');
    assert.equal(validateBase('Turbo-Kral'), 'invalid_chars');
  });

  it('rejects blocked words regardless of case or digit substitution', () => {
    assert.equal(validateBase('adminPanel'), 'blocked');
    assert.equal(validateBase('PitWallOfficial'), 'blocked');
    assert.equal(validateBase('4dmin'), 'blocked');
  });
});

describe('randomTag', () => {
  it('produces a zero-padded tag of the requested width', () => {
    for (let i = 0; i < 200; i += 1) {
      const tag = randomTag(4);
      assert.match(tag, /^[0-9]{4}$/);
      assert.ok(Number(tag) >= 1 && Number(tag) <= 9999, `out of range: ${tag}`);
    }
  });

  it('never produces the all-zero tag', () => {
    for (let i = 0; i < 500; i += 1) assert.notEqual(randomTag(4), '0000');
  });

  it('supports a widened tag space', () => {
    const tag = randomTag(5);
    assert.match(tag, /^[0-9]{5}$/);
    assert.ok(Number(tag) >= 1 && Number(tag) <= 99999);
  });
});

describe('suggestBases', () => {
  it('returns the requested number of distinct pooled names', () => {
    const picks = suggestBases(4);
    assert.equal(picks.length, 4);
    assert.equal(new Set(picks).size, 4);
    for (const p of picks) assert.ok(NICKNAME_POOL.includes(p));
  });

  it('is deterministic when given a seeded rng', () => {
    const rng = () => 0.5;
    assert.deepEqual(suggestBases(3, rng), suggestBases(3, rng));
  });
});

describe('formatNickname', () => {
  it('joins base and tag with a hash', () => {
    assert.equal(formatNickname('TurboKral', '0417'), 'TurboKral#0417');
  });
});
