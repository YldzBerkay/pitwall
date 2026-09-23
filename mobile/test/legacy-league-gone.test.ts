import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(here, '..');

test('leagueSlice.ts no longer exists', () => {
  const p = path.join(mobileRoot, 'src/store/slices/leagueSlice.ts');
  assert.equal(existsSync(p), false, `${p} should have been deleted`);
});

/** Walks `src` and `app`, returning every `.ts`/`.tsx` file's path + text. */
function collectSourceFiles(): { file: string; text: string }[] {
  const roots = ['src', 'app'].map((d) => path.join(mobileRoot, d)).filter(existsSync);
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push({ file: full, text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}

test('no dead league endpoint is referenced outside /race/-prefixed paths', () => {
  const deadPatterns: { label: string; regex: RegExp }[] = [
    { label: "'/join'", regex: /(['"`])\/join\1/g },
    { label: "'/weekend'", regex: /(['"`])\/weekend\1/g },
    { label: "'/checkin'", regex: /(['"`])\/checkin\1/g },
    { label: "'/pit'", regex: /(['"`])\/pit\1/g },
  ];

  const files = collectSourceFiles();
  const offenders: string[] = [];

  for (const { file, text } of files) {
    for (const { label, regex } of deadPatterns) {
      if (regex.test(text)) offenders.push(`${file}: ${label}`);
    }
  }

  // The legitimate real endpoints all live under `/race/...` (e.g.
  // `/race/checkin`, `/race/weekend-choices`, `/race/pit`) and are not
  // matched by the bare-quoted patterns above, so any hit here is a dead
  // legacy league endpoint creeping back in.
  assert.deepEqual(offenders, []);
});

test('gameStore still constructs without leagueSlice', async () => {
  // Mocks for React Native / Expo modules gameStore.ts transitively imports,
  // so this can run under plain Node (see mobile/test's other slice tests
  // for the same pattern).
  const mod = await import('../src/store/gameStore');
  assert.ok(mod.useGameStore, 'useGameStore should be exported');
  const state = mod.useGameStore.getState();
  assert.ok(state, 'store should construct a state object');
  assert.equal((state as unknown as Record<string, unknown>).league, undefined, 'league slice state should be gone');
});
