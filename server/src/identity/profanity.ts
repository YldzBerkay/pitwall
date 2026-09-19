/**
 * Blocked substrings for custom nickname bases.
 *
 * Two families:
 *   - impersonation: names that would let a player pose as staff or the brand
 *   - profanity: coarse roots in TR and EN
 *
 * Matching is done on a normalised form (lowercased, diacritics stripped,
 * common digit substitutions folded) so `4dmin` and `ADM1N` are caught too.
 * This is a seed list; extend it as reports come in.
 *
 * `BLOCKED_ROOTS` is matched as a substring, which is right for roots long
 * enough to be unambiguous. Very short abbreviations are NOT safe as
 * substrings: e.g. the Turkish abbreviation `amk` is also a substring of the
 * pooled, entirely clean name `SlipstreamKing` ("stre-AMK-ing"). Those go in
 * `BLOCKED_EXACT` instead, which only matches when the whole normalised base
 * equals the root — catching someone who names themselves exactly `amk` or
 * `4mk` without flagging unrelated words that merely contain the letters.
 */
const BLOCKED_ROOTS = [
  // impersonation / reserved
  'admin', 'moderator', 'support', 'destek', 'yetkili', 'official', 'resmi',
  'pitwall', 'anthropic', 'system', 'sistem', 'staff', 'root', 'null',
  // profanity roots — TR
  'orospu', 'pic', 'sikt', 'yarrak', 'gotver', 'ananı',
  // profanity roots — EN
  'fuck', 'shit', 'bitch', 'cunt', 'nigg', 'rape', 'nazi', 'hitler',
] as const;

/** Short/ambiguous roots: only blocked as a whole-name match, never as a substring. */
const BLOCKED_EXACT = [
  'amk',
] as const;

const DIGIT_FOLD: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's',
};

/** Lowercase, strip diacritics, fold leetspeak digits, drop underscores. */
export function normaliseForModeration(input: string): string {
  const folded = input
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[_\s]/g, '');
  let out = '';
  for (const ch of folded) out += DIGIT_FOLD[ch] ?? ch;
  return out;
}

export function isBlocked(input: string): boolean {
  const normalised = normaliseForModeration(input);
  if (BLOCKED_EXACT.some((root) => normalised === normaliseForModeration(root))) return true;
  return BLOCKED_ROOTS.some((root) => normalised.includes(normaliseForModeration(root)));
}
