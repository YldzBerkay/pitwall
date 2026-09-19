/**
 * Nickname rules — pure, database-free. Spec §2.2.
 *
 * A nickname is `base#tag`. Uniqueness lives on the PAIR, so TurboKral#0417
 * and TurboKral#8823 can both exist. Tags are random, never sequential: a
 * sequential tag would leak signup counts and account age.
 */
import { randomInt } from 'node:crypto';
import { NICKNAME_POOL } from './nicknamePool.ts';
import { isBlocked } from './profanity.ts';

export { NICKNAME_POOL };

export const BASE_MIN_LENGTH = 3;
export const BASE_MAX_LENGTH = 16;
export const DEFAULT_TAG_WIDTH = 4;

/** Letters (any script), digits and underscore. No spaces, no punctuation. */
const BASE_CHARS = /^[\p{L}\p{N}_]+$/u;

export type BaseValidation = 'ok' | 'too_short' | 'too_long' | 'invalid_chars' | 'blocked';

export function validateBase(base: string): BaseValidation {
  const length = [...base].length;
  if (length < BASE_MIN_LENGTH) return 'too_short';
  if (length > BASE_MAX_LENGTH) return 'too_long';
  if (!BASE_CHARS.test(base)) return 'invalid_chars';
  if (isBlocked(base)) return 'blocked';
  return 'ok';
}

/** Highest tag value for a given width: 9999 at width 4, 99999 at width 5. */
export function tagCeiling(width: number): number {
  return 10 ** width - 1;
}

/** A random tag in [1, ceiling], zero-padded to `width`. Never all zeroes. */
export function randomTag(width: number = DEFAULT_TAG_WIDTH): string {
  return String(randomInt(1, tagCeiling(width) + 1)).padStart(width, '0');
}

/** `count` distinct pooled base names. `rng` is injectable for tests. */
export function suggestBases(count: number, rng: () => number = Math.random): string[] {
  const remaining = [...NICKNAME_POOL];
  const picked: string[] = [];
  while (picked.length < count && remaining.length > 0) {
    const index = Math.min(remaining.length - 1, Math.floor(rng() * remaining.length));
    picked.push(remaining.splice(index, 1)[0]);
  }
  return picked;
}

export function formatNickname(base: string, tag: string): string {
  return `${base}#${tag}`;
}
