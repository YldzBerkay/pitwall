/**
 * The one random number generator the game is allowed to use.
 *
 * Everything that involves chance — sponsor offers, the championship table,
 * qualifying, the race itself — draws from a seeded mulberry32 so that the same
 * seed and the same inputs always give the same result. Unseeded, ambient
 * randomness is banned in the data layer on purpose: with it, a player could
 * leave the screen and come back to re-roll a bad weekend.
 *
 * Seed convention: `round * prime + secondInput * prime`, see each caller.
 */
/**
 * A string -> uint32 hash, purely so an id (a lobby id, a team key, a driver
 * id) can feed a seed alongside the numeric fields `rng` already takes. Not a
 * hash anyone needs to reverse or keep stable across versions — only stable
 * WITHIN one run of whatever it seeds.
 *
 * Shared rather than reimplemented per caller (`espionage.ts`'s `missionSeed`
 * had its own private copy first): the whole point of a seed helper is that
 * every caller salts the SAME way, so an audit can trust it once.
 */
export function strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A roughly bell-shaped draw in [-1, 1]: the mean of three uniforms, so the
 * middle is common and the tails are rare. Race noise reads better this way
 * than a flat uniform, where a 1-in-20 upset happens as often as a 1-in-2 one.
 */
export const bell = (random: () => number): number =>
  ((random() + random() + random()) / 3 - 0.5) * 2;
