/**
 * Guards the follow-up to the earlier `playerTeam`-only leftover in
 * `finishRace`/`simulateQualifying` (see `shared/src/raceEngine.ts`
 * `RaceResult.playerFinish` and `QualifyingResult.playerGrid`): the server
 * used to carry its OWN copy of those formulas, generalised to an arbitrary
 * `teamKey`, in `server/src/economy/weekendAchievements.ts`
 * (`teamPlayerFinish`/`teamGridSlots`). That is exactly the shape of drift
 * this project already paid for once with the upgrade formulas (see
 * `upgrade-formula.test.ts`) — a second definition the balance/behaviour
 * gate never sees.
 *
 * The fix: `shared/src/raceEngine.ts` now exports `teamPlayerFinish`/
 * `teamGridSlots` itself, `finishRace`/`simulateQualifying` call them for
 * their own `playerTeam`-scoped fields, and the server only imports them.
 *
 * This file pins three things:
 *  1) the shared helpers compute the right thing for an arbitrary team,
 *  2) `finishRace`/`simulateQualifying` output is byte-identical to a golden
 *     capture taken before this refactor (the constraint that matters most:
 *     replaying a recipe must match the live race exactly),
 *  3) no second definition of these helpers exists under `server/src`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { trackForRound } from '@pitwall/shared/tracks';
import { freshStandings } from '@pitwall/shared/season';
import {
  simulateQualifying, simulateRace, startRace, finishRace, fullGrid,
  teamPlayerFinish, teamGridSlots,
  type Entries, type QualiRisk, type RaceInput, type RaceResult,
} from '@pitwall/shared/raceEngine';

const ROUND = 8;
const SEED = 4242;

const TEAM_KEYS = [
  'aurelia', 'silberpfad', 'bravado', 'northgate', 'ravensworth', 'bosphorus',
  'ridgeline', 'castellan', 'verano', 'falkirk', 'orenda',
] as const;

const setup = (motor: number, aero: number, grip: number) =>
  ({ motor, aero, grip, compound: 'MEDIUM' as const, bias: 0 });

function buildEntries(): { entries: Entries; risks: Record<string, QualiRisk> } {
  const entries: Entries = {};
  const risks: Record<string, QualiRisk> = {};
  TEAM_KEYS.forEach((key, i) => {
    entries[key] = {
      setup: setup(60 + i, 70 - i, 55 + ((i * 3) % 20)),
      reliability: 0.25 + (i % 4) * 0.05,
      tactics: i % 3 === 0 ? 'aggressive' : i % 3 === 1 ? 'balanced' : 'conservative',
      managed: i % 2 === 0 ? 'human' : 'assistant',
      pitSecondsSaved: (i % 3) * 0.2,
      pitFailChance: 0.02,
    };
    risks[key] = i % 2 === 0 ? 'aggressive' : 'safe';
  });
  return { entries, risks };
}

/** Reproduces the exact fixture used to capture `race-team-finish-golden.json`. */
function runFixtureRace() {
  const track = trackForRound(ROUND);
  const { entries, risks } = buildEntries();
  const standings = freshStandings();

  const qualifying = simulateQualifying({ track, entries, wet: false, risks, round: ROUND, seed: SEED });
  const grid = qualifying.grid.map((e) => ({ teamKey: e.teamKey, driverIdx: e.driverIdx }));

  const raceInput: RaceInput = {
    standings, track, entries,
    weather: { forecast: 0, wetAtStart: false },
    grid: grid as RaceInput['grid'],
    round: ROUND,
    seed: SEED,
  };
  const race = simulateRace(raceInput, track);
  return { qualifying, race };
}

describe('shared/ owns the team-scoped finish/grid formulas', () => {
  it('1) teamPlayerFinish/teamGridSlots compute the right thing for an arbitrary (non-player) team', () => {
    const { race, qualifying } = runFixtureRace();
    const otherTeam = 'ridgeline'; // not playerTeam.key ('bosphorus')

    // Hand-computed expectation, independent of the shared helper's own code path.
    const positions = race.order.filter((e) => e.teamKey === otherTeam && !e.dnf).map((e) => e.position);
    const expectedFinish = positions.length ? Math.min(...positions) : 0;
    assert.equal(teamPlayerFinish(race.order, otherTeam), expectedFinish);

    const idx0 = qualifying.grid.findIndex((e) => e.teamKey === otherTeam && e.driverIdx === 0) + 1;
    const idx1 = qualifying.grid.findIndex((e) => e.teamKey === otherTeam && e.driverIdx === 1) + 1;
    assert.deepEqual(teamGridSlots(qualifying.grid, otherTeam), [idx0, idx1]);

    // Sanity: a team with no cars at all classifies as 0 / [0, 0].
    assert.equal(teamPlayerFinish(race.order, 'no_such_team'), 0);
    assert.deepEqual(teamGridSlots(qualifying.grid, 'no_such_team'), [0, 0]);
  });

  it('2) finishRace/simulateQualifying stay byte-identical to the pre-refactor golden capture', async () => {
    const goldenPath = fileURLToPath(new URL('./fixtures/race-team-finish-golden.json', import.meta.url));
    const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as {
      qualifying: unknown; race: unknown;
    };
    const { qualifying, race } = runFixtureRace();
    // Round-trip through JSON so we compare exactly what was captured
    // (structurally), not live objects that merely look equal.
    assert.deepEqual(JSON.parse(JSON.stringify(qualifying)), golden.qualifying);
    assert.deepEqual(JSON.parse(JSON.stringify(race)), golden.race);

    // Also pin the player-team fields specifically, since those are the
    // ones the refactor touches directly.
    const goldenRace = golden.race as RaceResult;
    assert.equal(race.playerFinish, goldenRace.playerFinish);
    assert.deepEqual(race.playerFinishes, goldenRace.playerFinishes);
    const goldenQualifying = golden.qualifying as { playerGrid: [number, number] };
    assert.deepEqual(qualifying.playerGrid, goldenQualifying.playerGrid);
  });

  it('2b) finishRace stays byte-identical when the player team itself DNFs both cars (the classified.length === 0 branch)', async () => {
    // The main golden race above never has the player team retire, so a
    // change to just that branch would slip past it. This fixture forces
    // both of bosphorus's (playerTeam) cars to DNF, pinning `playerFinish`'s
    // documented "0 when both retired" contract against a pre-refactor
    // capture.
    const goldenPath = fileURLToPath(new URL('./fixtures/race-team-finish-dnf-golden.json', import.meta.url));
    const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as RaceResult;

    const ROUND = 3;
    const SEED = 777;
    const track = trackForRound(ROUND);
    const teamKeys = [
      'aurelia', 'silberpfad', 'bravado', 'northgate', 'ravensworth', 'bosphorus',
      'ridgeline', 'castellan', 'verano', 'falkirk', 'orenda',
    ] as const;
    const entries: Entries = {};
    teamKeys.forEach((key, i) => {
      entries[key] = {
        setup: { motor: 60 + i, aero: 70 - i, grip: 55 + ((i * 3) % 20), compound: 'MEDIUM', bias: 0 },
        reliability: 0.3,
        tactics: 'balanced',
        managed: 'assistant',
      };
    });
    const raceInput: RaceInput = {
      standings: freshStandings(), track, entries,
      weather: { forecast: 0, wetAtStart: false },
      grid: fullGrid({}, entries),
      round: ROUND,
      seed: SEED,
    };
    const state = startRace(raceInput);
    for (const car of state.cars) {
      if (car.teamKey === 'bosphorus') { car.dnf = true; car.dnfLap = 12; }
    }
    state.finished = true;
    const race = finishRace(state);

    assert.deepEqual(JSON.parse(JSON.stringify(race)), golden);
    assert.equal(race.playerFinish, 0);
    assert.deepEqual(race.playerFinishes, [0, 0]);
  });

  it('3) no second definition of teamPlayerFinish/teamGridSlots exists in server/src', async () => {
    const SRC = fileURLToPath(new URL('../src/', import.meta.url));
    const offenders: string[] = [];

    async function scan(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const text = await readFile(full, 'utf8');
        for (const [i, line] of text.split('\n').entries()) {
          // The private re-derivation this test guards against declared its
          // own function of these exact names. A legitimate file only ever
          // imports them from shared/.
          if (/\bfunction\s+teamPlayerFinish\s*\(/.test(line) || /\bfunction\s+teamGridSlots\s*\(/.test(line)) {
            offenders.push(`${full}:${i + 1}: reintroduces a private teamPlayerFinish/teamGridSlots definition — ${line.trim()}`);
          }
        }
      }
    }
    await scan(SRC);
    assert.deepEqual(offenders, [], `server/src has a second finish/grid formula definition: ${offenders.join(', ')}`);

    // Positive half: the achievements module must actually import them from shared/.
    const achievementsSrc = await readFile(join(SRC, 'economy', 'weekendAchievements.ts'), 'utf8');
    assert.match(achievementsSrc, /from ['"]@pitwall\/shared\/raceEngine['"]/,
      'weekendAchievements.ts must import the finish/grid formulas from shared/');
    assert.match(achievementsSrc, /\bteamPlayerFinish\b/);
    assert.match(achievementsSrc, /\bteamGridSlots\b/);
  });
});
