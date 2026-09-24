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
 * ── WHAT THIS FILE PROVES TODAY, AND WHAT IT DOES NOT ─────────────────────
 * It proves the PIT PATH: a pit call reaches the server's decision log
 * carrying the driver the player chose, and while disconnected it is REFUSED
 * rather than queued.
 *
 * It does NOT yet guard "no local race engine at all". That removal is
 * blocked on the server, not on this store:
 *   - `weekend.race` is a full `RaceState`; the socket's `SerialisedRace`
 *     (`server/src/lobby/live.ts`'s `serialise()`) deliberately omits
 *     `weather`, `standings`, `neutralised`, `entries`. `settleRaceWeekend`
 *     and `finishSprint` call `finishRace(w.race)`, which reads
 *     `state.weather` and `state.standings` — so socket frames cannot feed
 *     `weekend.race` without either a server change or fabricating those
 *     fields locally, and fabricating them is exactly the second, divergent
 *     race this whole design exists to prevent.
 *   - `simulateQualifying` has NO server counterpart at all: the server runs
 *     no qualifying session and exposes no grid endpoint. `weekend.qualifying`
 *     is also a hard precondition of `settleRaceWeekend` (it throws without
 *     it) and supplies `playerGrid` to the achievements scorer.
 * Both therefore land in the Stage 2 economy/settlement migration, not here.
 * When that lands, the scans for "no `setInterval` in gameStore" and "no
 * `advanceLap`/`startRace`/`simulateQualifying` call under src" belong in
 * this file — they are the permanent guard against the local engine creeping
 * back, and they are cheap.
 *
 * These are TEXT SCANS on purpose: a module importing React Native or Expo
 * cannot be resolved under plain Node (`tsx --test`), so `gameStore.ts` can
 * never be imported here — and "this function is called" is a property of the
 * SOURCE, not of one execution path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const gameStorePath = path.join(here, '..', 'src/store/gameStore.ts');

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
 * ── THE LOCAL PAYOUT IS UNREACHABLE FROM A LOBBY SEAT ─────────────────────
 *
 * The full "no local race engine" scans named in the module doc above still
 * cannot be written (see this task's report: `weekend.phase` has no
 * server-driven source, so deleting the local engine would make the server's
 * own live race unreachable in the UI). This scan guards the one part that
 * CAN be closed today, and it closes a real money bug rather than a
 * stylistic one.
 *
 * `LiveRacePanel`'s flag button runs `settleRaceWeekend()` — the local
 * payout. The server settles a lobby race on its own clock whether or not
 * this device is connected (`server/src/economy/settle.ts`), so the button
 * must be hidden for anyone holding a LOBBY SEAT, not merely for anyone
 * whose socket happens to be up. It used to be gated on `leagueLive`
 * (`race.status === 'connected'`): a lobby-seated player who lost the socket
 * before the flag got the button back and could pay themselves local RP for
 * a race the server had already paid. The gate is `online`
 * (`Boolean(race.lobbyId)`) — the same signal `displayRace` and `queuePit`
 * key off.
 */
test('the local settlement button is gated on a lobby SEAT, not on socket liveness', () => {
  const panel = codeOnly(
    readFileSync(path.join(here, '..', 'src/features/raceweek/LiveRacePanel.tsx'), 'utf8'),
  );
  const flagBranch = /race\.finished\s*&&\s*(\w+)\s*\?/.exec(panel);
  assert.notEqual(flagBranch, null, 'LiveRacePanel must still branch on the finished race');
  assert.equal(
    flagBranch![1],
    'online',
    'the "server wrote it" branch must key off the lobby seat (`online`), not the socket status ' +
      '(`leagueLive`) — a dropped socket does not un-pay a race the server already settled',
  );
});
