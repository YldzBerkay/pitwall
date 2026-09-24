/**
 * THE CLIENT MUST COMPUTE NO RACE OF ITS OWN.
 *
 * The server owns the race: it freezes a recipe at lights-out, ticks it, and
 * broadcasts every lap to the lobby's room (`server/src/lobby/runner.ts`,
 * `server/src/lobby/live.ts`). Because the engine is deterministic, replaying
 * that recipe is bit-identical to the live race — which is what makes
 * "everyone sees the same race" a structural property rather than a hope. A
 * client that computes its own laps destroys that property.
 *
 * ── WHAT THIS FILE PROVES ─────────────────────────────────────────────────
 * It proves the PIT PATH (a pit call reaches the server's decision log
 * carrying the driver the player chose, and while disconnected it is REFUSED
 * rather than queued), AND — since the local engine's removal — the five
 * standing guards against that engine growing back:
 *
 *   1. importing `gameStore.ts` starts no interval, and the module contains
 *      no `setInterval` at all: there is exactly one race clock in this
 *      system and it is the server's (`server/src/lobby/runner.ts`).
 *   2. no module-level race clock survives anywhere under `mobile/src`.
 *   3. no file under `mobile/src` CALLS `advanceLap` / `startRace` /
 *      `simulateQualifying` / `finishRace`. Type-only imports are fine —
 *      `LiveRacePanel.tsx` still narrows against `RaceState`.
 *   4. in a lobby, which panel `RaceWeekScreen` shows is decided by the
 *      SERVER's phase (`displayPhase` -> `displayWeekPanel`), never by a
 *      local weekend phase.
 *   5. `weekend.race` is written by no local code path — the field is gone
 *      from `Weekend` entirely, so the only race any screen can draw is the
 *      one `displayRace` hands it off the socket.
 *
 * ── WHAT THE OLD VERSION OF THIS DOC CLAIMED, AND WHY IT NO LONGER HOLDS ──
 * It said `SerialisedRace` omitted `weather`/`neutralised`, so socket frames
 * could not feed a `RaceState`. That is stale: `serialise()` sends both
 * (see `lib/api/raceSocket.ts`'s `SerialisedRace`, which mirrors it field
 * for field). It also said `simulateQualifying` had no server counterpart —
 * it does now, published in the `state` frame and read by
 * `displayQualifying`. And `finishRace`'s missing `standings` stopped
 * mattering when the local settlement went with the engine: the server
 * settles and persists the per-seat breakdown, and the client READS it
 * (`settlementDisplay.ts`).
 *
 * Most of these are TEXT SCANS on purpose: "this function is called" is a
 * property of the SOURCE, not of one execution path, and most modules under
 * `src` import React Native and cannot be resolved under plain Node
 * (`tsx --test`). Scan 1's first half is the exception — `gameStore.ts`
 * itself DOES import cleanly (see `legacy-league-gone.test.ts`), so the "no
 * interval on import" half is a real runtime observation, not a scan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, '..', 'src');
const gameStorePath = path.join(srcRoot, 'store/gameStore.ts');
const raceWeekScreenPath = path.join(srcRoot, 'features/raceweek/RaceWeekScreen.tsx');

/** Every `.ts`/`.tsx` file under `mobile/src`, as [relative path, code-only source]. */
function sourceFiles(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push([path.relative(srcRoot, full), codeOnly(readFileSync(full, 'utf8'))]);
    }
  };
  walk(srcRoot);
  return out;
}

/** Source with comments and string/template literals blanked out, so a scan
 * sees CODE only — a function named in one of this repo's many doc comments
 * is not a call, and neither is one inside a Turkish UI string. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** The body of `queuePit`'s IMPLEMENTATION (not its interface declaration). */
function queuePitImpl(): string {
  const code = codeOnly(readFileSync(gameStorePath, 'utf8'));
  const start = code.indexOf('queuePit: (driverIdx, decision)');
  assert.notEqual(start, -1, 'gameStore.ts must still implement queuePit');
  const rest = code.slice(start);
  const end = rest.indexOf('\n  },');
  return end === -1 ? rest : rest.slice(0, end);
}

test('queuePit routes to raceSlice.callPit and carries driverIdx', () => {
  assert.match(
    queuePitImpl(),
    /callPit\s*\(\s*driverIdx/,
    'a pit call must reach the server through raceSlice.callPit, carrying the driver the player chose',
  );
});

test('queuePit writes no local echo once a lobby seat exists', () => {
  const impl = queuePitImpl();
  const gate = impl.indexOf('race.lobbyId');
  const call = impl.indexOf('callPit');
  const pending = impl.indexOf('pending');
  assert.notEqual(gate, -1, 'queuePit must branch on race.lobbyId — the online path is the server`s log');
  assert.ok(gate < call, 'the lobby gate must come before the server call');
  assert.ok(
    pending === -1 || call < pending,
    'the online branch must return before touching the local pending list: a local echo is a ' +
      'second, unauthoritative answer to "did my call land?"',
  );
});

test('a pit call while disconnected is refused, and nothing is sent', async () => {
  const { create } = await import('zustand');
  const { createRaceSlice } = await import('@/store/slices/raceSlice');

  let requestsSent = 0;
  const store = create<Record<string, any>>()((set: any, get: any) => ({
    auth: { baseUrl: 'http://example.invalid', token: 'tok' },
    ...createRaceSlice(set, get, {
      pitApi: async () => {
        requestsSent += 1;
        return { ok: true, data: { ok: true, teamKey: 't', driverIdx: 0, compound: 'SOFT', lap: 3 } } as any;
      },
    }),
  }));

  // `status` is 'idle' — the socket was never connected.
  const outcome = await store.getState().callPit(0, 'SOFT');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'disconnected');
  assert.equal(requestsSent, 0, 'no request may leave the device while disconnected');
  // And nothing may be held for later: by the time a queued call flushed, its
  // target lap would have run and the player would have believed it landed.
  assert.equal(store.getState().race.lastPitOutcome.ok, false);
});

/**
 * ── THERE IS NO LOCAL PAYOUT LEFT TO REACH ────────────────────────────────
 *
 * This scan used to assert something weaker, because something weaker was
 * all that was available: `LiveRacePanel`'s flag button ran the local
 * `settleRaceWeekend()`, so the test pinned the button's visibility to the
 * LOBBY SEAT (`online`) rather than to socket liveness (`leagueLive`) — a
 * lobby-seated player whose socket merely dropped used to get the button
 * back and could pay themselves local RP for a race the server had already
 * settled (`server/src/economy/settle.ts`).
 *
 * The local settlement is gone with the local engine, so the gate is not
 * needed: there is no second payout to gate. This scan is the stronger form
 * of the same rule — no settlement, at any visibility, under any condition.
 */
test('LiveRacePanel offers no local payout, gated or otherwise', () => {
  const panel = codeOnly(
    readFileSync(path.join(srcRoot, 'features/raceweek/LiveRacePanel.tsx'), 'utf8'),
  );
  for (const banned of ['settleRaceWeekend', 'settleRace', 'racePrize', 'finishSprint', 'briefCompliance']) {
    assert.equal(
      new RegExp(`\\b${banned}\\b`).test(panel),
      false,
      `LiveRacePanel must not reference ${banned}: the server settles the race on its own clock and ` +
        'persists the breakdown; this screen reads, it never pays',
    );
  }
});

// ── 1. NO RACE CLOCK IN THE STORE ──────────────────────────────────────────
//
// The race advances on the server's clock, broadcast per lobby. A client
// interval that ticks a lap is a SECOND clock — it drifts, and the moment it
// does, this device is watching a different race from everyone else in the
// lobby. The store used to hold exactly such a clock (a module-level
// `raceClock` restarted by `startRaceSession`/`startSprintSession`, calling
// `advanceRaceLap` every `RACE_TICK_MS`); this is what keeps it gone.

test('1a. importing gameStore starts no interval', async () => {
  const realSetInterval = globalThis.setInterval;
  let intervalsCreated = 0;
  (globalThis as { setInterval: typeof setInterval }).setInterval = ((
    ...args: Parameters<typeof setInterval>
  ) => {
    intervalsCreated += 1;
    return realSetInterval(...args);
  }) as typeof setInterval;

  try {
    const mod = await import('@/store/gameStore');
    // Touch the store so a lazily-created one would have been created by now.
    assert.ok(mod.useGameStore.getState());
    assert.equal(intervalsCreated, 0, 'importing gameStore must create no interval — the race clock is the server`s');
  } finally {
    (globalThis as { setInterval: typeof setInterval }).setInterval = realSetInterval;
  }
});

test('1b. gameStore.ts contains no setInterval at all', () => {
  const code = codeOnly(readFileSync(gameStorePath, 'utf8'));
  assert.equal(
    /\bsetInterval\s*\(/.test(code),
    false,
    'gameStore.ts must contain no setInterval: an action that starts one is invisible to 1a, ' +
      'and there is exactly one race clock in this system — the server`s',
  );
});

// ── 2. NO MODULE-LEVEL RACE CLOCK ANYWHERE UNDER src ───────────────────────
//
// Screens legitimately run intervals (a 1-second "now" for a countdown, a
// tip rotator). What may never come back is a clock that lives at MODULE
// scope — outside any component or hook, so it keeps running for the life of
// the process — or any timer whose callback advances a race.

test('2. no module-level clock, and no timer that advances a race, under src', () => {
  const offenders: string[] = [];
  const raceish = /advanceLap|advanceRaceLap|raceClock|RACE_TICK|nextLap/;
  for (const [file, code] of sourceFiles()) {
    for (const line of code.split('\n')) {
      if (!/\bset(Interval|Timeout)\s*\(/.test(line)) continue;
      // Module scope: the statement starts hard against the left margin.
      if (/^(const|let|var|\s{0,1})[^\s]/.test(line) && !/^\s/.test(line)) {
        offenders.push(`${file}: module-level timer — ${line.trim()}`);
      }
      if (raceish.test(line)) offenders.push(`${file}: timer advances a race — ${line.trim()}`);
    }
    if (/\braceClock\b/.test(code)) offenders.push(`${file}: a module-level race clock identifier survives`);
  }
  assert.deepEqual(offenders, []);
});

// ── 3. THE ENGINE'S RACE FUNCTIONS ARE NEVER CALLED ────────────────────────
//
// `@pitwall/shared/raceEngine` still exists and the SERVER still runs it —
// that is the point: one engine, one race. The client may import its TYPES
// (`LiveRacePanel.tsx` narrows against `RaceState`) but may never execute a
// lap, a start, a qualifying session or a classification of its own.

const BANNED_CALLS = ['advanceLap', 'startRace', 'simulateQualifying', 'finishRace'] as const;

test('3. no file under src calls advanceLap / startRace / simulateQualifying / finishRace', () => {
  const offenders: string[] = [];
  for (const [file, code] of sourceFiles()) {
    for (const name of BANNED_CALLS) {
      // `name(` only — so `import type { RaceState }` and a mention like
      // `startRaceSession(` are both untouched.
      if (new RegExp(`\\b${name}\\s*\\(`).test(code)) offenders.push(`${file}: calls ${name}()`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('3b. importing the engine for its TYPES is still allowed', () => {
  const panel = codeOnly(readFileSync(path.join(srcRoot, 'features/raceweek/LiveRacePanel.tsx'), 'utf8'));
  assert.match(
    panel,
    /import type \{[^}]*RaceState[^}]*\}/,
    'scan 3 must not have been satisfied by banning the engine`s types too — a type import executes nothing',
  );
});

// ── 4. IN A LOBBY, THE PANEL COMES FROM THE SERVER'S PHASE ─────────────────
//
// The local `WeekendPhase` had eight values because the local engine ran the
// weekend session by session. The server has five, and qualifying is not
// something the player runs — it happens at lights-out. There is no faithful
// 1:1 mapping, so there is no mapping: `displayWeekPanel` answers "which
// panel" directly from the server's own phase.

test('4a. displayWeekPanel maps every server phase to a panel', async () => {
  const { displayWeekPanel } = await import('@/store/slices/raceSlice');
  const ready = (phase: 'open' | 'checkin' | 'live' | 'result' | 'finished') =>
    displayWeekPanel({ kind: 'ready', phase, seasonNo: 1, roundNo: 1 });

  assert.equal(ready('open'), 'choices', 'open: the weekend-choice UI — bias, tyre, risk, tactics');
  assert.equal(ready('checkin'), 'checkin', 'checkin: the check-in call, choices still editable');
  assert.equal(ready('live'), 'live', 'live: the live race panel, including the server`s qualifying result');
  assert.equal(ready('result'), 'result');
  assert.equal(ready('finished'), 'season-over');
  assert.equal(displayWeekPanel({ kind: 'loading' }), 'loading', 'seated but no frame yet is a distinct answer, not a guess');
  assert.equal(displayWeekPanel({ kind: 'no-lobby' }), 'no-lobby');
});

test('4b. RaceWeekScreen picks its panel from the server phase, with no local fallback', () => {
  const screen = codeOnly(readFileSync(raceWeekScreenPath, 'utf8'));
  assert.match(screen, /displayWeekPanel\s*\(/, 'the panel choice must go through displayWeekPanel');
  assert.match(screen, /displayPhase\s*\(/, 'which is fed by the server`s phase');
  assert.equal(
    /weekend\s*\.\s*phase|WeekendPhase|localPhase/.test(screen),
    false,
    'RaceWeekScreen must not consult a local weekend phase at all — a fallback to it in a lobby ' +
      'is how the screen ends up showing a weekend the server is not running',
  );
});

// ── 5. NOTHING LOCAL WRITES weekend.race ───────────────────────────────────
//
// The strongest form of "written only by socket frames" available: the field
// does not exist. `Weekend` is now a bag of CHOICES (bias, tyre, risk,
// tactics) — the things the player sends to the server before lights-out —
// and carries no race, no lap, no result and no settlement.

test('5. `Weekend` holds no race state, and nothing under src writes weekend.race', () => {
  const code = codeOnly(readFileSync(gameStorePath, 'utf8'));
  const start = code.indexOf('export interface Weekend');
  assert.notEqual(start, -1, 'gameStore.ts must still declare the Weekend interface');
  const body = code.slice(start, code.indexOf('}', start));
  for (const field of ['race', 'prevRace', 'pending', 'prompt', 'result', 'settlement', 'qualifying']) {
    assert.equal(
      new RegExp(`(^|\\n)\\s*${field}\\??\\s*:`).test(body),
      false,
      `Weekend.${field} must be gone — a local race image is a second, divergent race`,
    );
  }

  const offenders = sourceFiles()
    .filter(([, c]) => /weekend\s*\.\s*(race|prevRace|prompt|pending|settlement)\b/.test(c))
    .map(([file]) => file);
  assert.deepEqual(offenders, []);
});
