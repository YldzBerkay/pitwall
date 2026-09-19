import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NICKNAME_POOL,
  validateBase,
  randomTag,
  suggestBases,
  formatNickname,
} from '../src/identity/nickname.ts';
import { isBlocked, normaliseForModeration } from '../src/identity/profanity.ts';

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
    for (const p of picks) assert.ok((NICKNAME_POOL as readonly string[]).includes(p));
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

describe('normaliseForModeration — Turkish dotless-i bug (Finding 1)', () => {
  it('folds tr-TR dotless ı (from ASCII I) to i', () => {
    assert.equal(normaliseForModeration('ADMIN'), 'admin');
    assert.equal(normaliseForModeration('Admin'), 'admin');
    assert.equal(normaliseForModeration('AdMiN'), 'admin');
    assert.equal(normaliseForModeration('OFFICIAL'), 'official');
  });

  it('folds a literal dotless ı typed directly to i', () => {
    assert.equal(normaliseForModeration('Offıcial'), 'official');
  });

  it('still folds the digit-substitution and lowercase forms the same way', () => {
    assert.equal(normaliseForModeration('ADM1N'), 'admin');
    assert.equal(normaliseForModeration('4dmin'), 'admin');
    assert.equal(normaliseForModeration('admin'), 'admin');
  });

  it('folds tr-TR dotted İ (from ASCII capital I with a dot) to i as well', () => {
    assert.equal(normaliseForModeration('PİTWALL'), 'pitwall');
  });

  it('blocks the previously-bypassing all-caps and mixed-case forms', () => {
    assert.equal(isBlocked('ADMIN'), true);
    assert.equal(isBlocked('AdMiN'), true);
    assert.equal(isBlocked('OFFICIAL'), true);
    assert.equal(isBlocked('Offıcial'), true);
    assert.equal(isBlocked('ADM1N'), true);
    assert.equal(isBlocked('4dmin'), true);
  });
});

describe('isBlocked — short-root tokenisation (Finding 2)', () => {
  it('blocks short roots glued to another word via CamelCase/digit/underscore boundaries', () => {
    assert.equal(isBlocked('TurboAmk'), true);
    assert.equal(isBlocked('Amk_123'), true);
    assert.equal(isBlocked('amk'), true);
    assert.equal(isBlocked('AMK'), true);
  });

  it('does not reject innocent words that merely contain an ambiguous short root as a substring', () => {
    assert.equal(isBlocked('epic'), false);
    assert.equal(isBlocked('picture'), false);
    assert.equal(isBlocked('tropical'), false);
    assert.equal(isBlocked('rootbeer'), false);
    assert.equal(isBlocked('uprooted'), false);
    assert.equal(isBlocked('nullable'), false);
    assert.equal(isBlocked('annulled'), false);
    assert.equal(isBlocked('grape'), false);
    assert.equal(isBlocked('drape'), false);
    assert.equal(isBlocked('rapeseed'), false);
    assert.equal(isBlocked('nazionale'), false);
  });

  it('still allows the collision that started this: SlipstreamKing', () => {
    assert.equal(isBlocked('SlipstreamKing'), false);
  });

  it('still catches the unambiguous slur tier as a plain substring (not tokenised)', () => {
    assert.equal(isBlocked('swiggnigg'), true);
  });
});

describe('isBlocked — pool names never trip moderation', () => {
  it('lets every pooled base name through', () => {
    for (const base of NICKNAME_POOL) {
      assert.equal(isBlocked(base), false, `pooled name blocked: ${base}`);
    }
  });
});
