/**
 * THE CLIENT MUST NEVER COMPUTE THE ECONOMY.
 *
 * `DevelopmentScreen.tsx` was migrated onto the server-backed economy
 * (`economyApiSlice.ts` / `factoryDisplay.ts`'s `displayFactory`): starting,
 * claiming and skipping a car upgrade all go through `economyApi`, and the
 * numbers it shows (`rp`, `carStats`, the job in flight) are the server's.
 *
 * `ManagerHomeScreen.tsx` (the Home tab) was never migrated. It drove the
 * exact same car-upgrade actions through `gameStore.ts`'s OWN local
 * `startUpgrade`/`collectUpgrade`/`buildCostFor`/`buildTimeFor`, spending a
 * LOCAL `rp` that never reached the server and used a cost/duration formula
 * that (before `61a505a`) had already drifted from the server's. Two
 * screens, two live economies, changing the same car stats under different
 * rules. This file is the permanent guard against that happening again.
 *
 * ── SCOPE, STATED PLAINLY ──────────────────────────────────────────────────
 * This is NOT a guard that "no file under mobile/src ever mutates `rp` or
 * `gold`" in the fully general sense the phrase suggests — that would also
 * indict code this task was explicitly told not to touch:
 *   - `gameStore.ts`'s `settleRaceWeekend` credits local `rp` from the local
 *     race engine's prize/sponsor payout (out of scope: "Do NOT move
 *     settlement to the server — the next task").
 *   - `signSponsor`/`releaseSponsor` (sponsorship signing bonus/penalty),
 *     `economySlice.ts` (rewarded-ad gold, gold packs, gold->RP conversion)
 *     and `staffSlice.ts`/`driverSlice.ts`/`espionageSlice.ts` (wages,
 *     training, agent costs) are separate local systems with no server
 *     counterpart at all today, and removing/moving them is out of scope
 *     for this task too.
 * A blanket "no rp/gold mutation anywhere" scan would either have to ignore
 * all of the above (making it worthless) or fail on code this task was told
 * to leave alone. Scoped honestly, the actual bug — and the actual fix — is
 * about SCREENS: no screen may compute or spend the CAR-UPGRADE economy
 * locally once a server-backed equivalent exists. That is what these tests
 * check, and it is a precise, permanent guard on exactly the drift this
 * task closes: `startUpgrade`, `collectUpgrade`, `buildCostFor`,
 * `buildTimeFor`, `upgradeDepartment`, `skipBuild`/`skipBuildCost` — the
 * local car/factory economy `gameStore.ts` still defines internally (kept,
 * because `settleRaceWeekend` still references `buildCostFor` in a refund
 * branch — touching that is the settlement work this task explicitly
 * defers) — must never again be called from a screen.
 *
 * These are TEXT SCANS on purpose: a `.tsx` screen imports React Native and
 * cannot be resolved under plain Node (`tsx --test`), so "this function is
 * called" has to be a property of the SOURCE, exactly as
 * `no-local-race.test.ts` and `legacy-league-gone.test.ts` already do it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(here, '..');

/** Source with comments and string/template literals blanked out, so a scan
 * sees CODE only — a function named in a doc comment or a Turkish UI string
 * is not a call. Identical helper to `no-local-race.test.ts`'s. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

interface ScreenFile {
  file: string;
  code: string;
}

/** Every screen (`.tsx`) under `src/features` and `app` — the places a
 * player-facing tab lives. `gameStore.ts`/its slices are deliberately
 * excluded: they still DEFINE the local upgrade functions (see the scope
 * note above); what must never happen again is a SCREEN calling them. */
function collectScreens(): ScreenFile[] {
  const roots = ['src/features', 'app'].map((d) => path.join(mobileRoot, d)).filter(existsSync);
  const out: ScreenFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === 'node_modules') continue;
        walk(full);
      } else if (/\.tsx$/.test(entry)) {
        out.push({ file: full, code: codeOnly(readFileSync(full, 'utf8')) });
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}

const LOCAL_UPGRADE_FNS = [
  'startUpgrade',
  'collectUpgrade',
  'buildCostFor',
  'buildTimeFor',
  'upgradeDepartment',
  'skipBuild',
  'skipBuildCost',
];

/** True when `name(` appears in `code` as a call NOT immediately reached
 * through `economyApi.` — i.e. the local `gameStore.ts` action, not the
 * server-backed `economyApiSlice.ts` one of the same name. */
function callsLocalFn(code: string, name: string): boolean {
  const re = new RegExp(`(?<!economyApi\\.)\\b${name}\\s*\\(`, 'g');
  return re.test(code);
}

/** Also catches the `useGameStore((s) => s.startUpgrade)` selector form,
 * which reads the local action out even before it is ever called. */
function selectsLocalFn(code: string, name: string): boolean {
  return new RegExp(`\\bs\\.${name}\\b`).test(code);
}

test('1. no screen calls or selects gameStore.ts\'s local car-upgrade economy', () => {
  const screens = collectScreens();
  assert.ok(screens.length > 0, 'expected to find at least one screen under src/features or app');
  const offenders: string[] = [];
  for (const { file, code } of screens) {
    for (const fn of LOCAL_UPGRADE_FNS) {
      if (callsLocalFn(code, fn) || selectsLocalFn(code, fn)) {
        offenders.push(`${path.relative(mobileRoot, file)}: ${fn}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `local upgrade economy leaking into screens:\n${offenders.join('\n')}`);
});

test('2. the Home tab\'s economy state comes from economyApi (displayFactory), not local gameStore fields', () => {
  const homeFile = path.join(mobileRoot, 'src/features/manager/ManagerHomeScreen.tsx');
  assert.ok(existsSync(homeFile), 'ManagerHomeScreen.tsx should still exist');
  const code = codeOnly(readFileSync(homeFile, 'utf8'));
  assert.match(
    code,
    /displayFactory\s*\(/,
    'ManagerHomeScreen.tsx must derive its car/factory view from displayFactory (factoryDisplay.ts), the same selector DevelopmentScreen.tsx uses',
  );
});

test('3. starting an upgrade anywhere in the app calls the server (economyApi.startUpgrade), never a local equivalent', () => {
  const screens = collectScreens();
  const offenders: string[] = [];
  for (const { file, code } of screens) {
    if (callsLocalFn(code, 'startUpgrade')) offenders.push(path.relative(mobileRoot, file));
  }
  assert.deepEqual(offenders, [], `screens calling startUpgrade outside economyApi:\n${offenders.join('\n')}`);
  // And the server path must actually be reachable from Development (the
  // only screen with a start-upgrade control) so this isn't vacuous.
  const devFile = path.join(mobileRoot, 'src/features/development/DevelopmentScreen.tsx');
  const devCode = codeOnly(readFileSync(devFile, 'utf8'));
  assert.match(devCode, /economyApi\.startUpgrade\s*\(/, 'DevelopmentScreen.tsx must still call economyApi.startUpgrade');
});

test('4. with no lobby, the Home tab says so rather than showing local numbers', () => {
  const homeFile = path.join(mobileRoot, 'src/features/manager/ManagerHomeScreen.tsx');
  // `codeOnly` blanks string literals (needed for the other scans, which
  // only care about identifiers/calls) — but the thing being asserted here
  // IS a string literal (`display.kind === 'no-lobby'`), so this checks the
  // raw source instead.
  const raw = readFileSync(homeFile, 'utf8');
  assert.match(
    raw,
    /['"]no-lobby['"]/,
    'ManagerHomeScreen.tsx must branch on displayFactory\'s "no-lobby" kind instead of falling back to local carStats/rp/build',
  );
});
