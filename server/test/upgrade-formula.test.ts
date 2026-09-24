/**
 * Guards the balance fix in `server/src/economy/jobs.ts`: the server's
 * upgrade cost/duration/gain must come from `@pitwall/shared/carCustomisation`
 * — the same formulas `mobile`'s `npm run econ` gate validates — not from a
 * private re-derivation. See the design note at the top of `jobs.ts` and
 * `shared/src/carCustomisation.ts` (`upgradeCostFor`, `upgradeDurationMs`,
 * `UPGRADE_GAIN`) for the numbers this test pins.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { seedTeamEconomy, loadTeamEconomy, setFactoryLevel, addRp } from '../src/economy/repo.ts';
import { startJob, claimJob } from '../src/economy/jobs.ts';
import { upgradeCostFor, upgradeDurationMs, UPGRADE_GAIN, UPGRADE_MAX_MS } from '@pitwall/shared/carCustomisation';
import { factoryEffects } from '@pitwall/shared/factory';

let seq = 0;

async function makeLobbyWithTeam(teamKey = 'bosphorus'): Promise<{ lobbyId: string; userId: string }> {
  const n = ++seq;
  const owner = await createUserWithIdentity({
    base: 'PitCrew', provider: 'google', providerUid: `g-upgformula-${n}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`UpgFormula #${n}`, 'UpgFormula', n, owner.id],
  );
  const lobbyId = res.rows[0].id;
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, teamKey));
  return { lobbyId, userId: owner.id };
}

describe('server upgrade formula matches shared/', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from pending_jobs');
    await query('delete from lobby_economy');
    await query('delete from lobbies');
    await query('delete from users');
  });
  after(async () => { await closePool(); });

  it('1) cost with no factory bonus equals shared upgradeCostFor for n = 0, 1, 4, 9', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    // Repeat the same stat enough times to walk through n = 0..9, checking
    // the ones the brief calls out. No factory levels are set, so
    // costScale === 1 and the server's charge must equal the bare formula.
    for (let n = 0; n <= 9; n++) {
      const now = new Date(Date.UTC(2026, 0, 1 + n));
      // Late-ladder upgrades (n=9 costs 28833 RP) outrun the starting
      // balance; top up generously before each start so the test measures
      // the formula, not the funding.
      await withTransaction((c) => addRp(c, lobbyId, 'bosphorus', 100_000));
      const before = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
      const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'motor' }, now });
      assert.equal(started.ok, true, `start failed at n=${n}`);
      if (!started.ok) return;
      if (n === 0 || n === 1 || n === 4 || n === 9) {
        assert.equal(started.rpCost, upgradeCostFor(n), `n=${n} cost mismatch`);
        const after = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
        assert.equal(before - after, upgradeCostFor(n), `n=${n} rp did not move by shared cost`);
      }
      // Claim immediately (well past ends_at) so the next iteration's
      // `timesDone` advances by exactly one.
      const claimNow = new Date(started.endsAt.getTime() + 1000);
      const claimed = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now: claimNow });
      assert.equal(claimed.ok, true, `claim failed at n=${n}`);
    }
  });

  it('2) duration with no factory bonus equals shared upgradeDurationMs, including the 22h cap at high n', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    await withTransaction((c) => addRp(c, lobbyId, 'bosphorus', 100_000));
    for (const n of [0, 1, 4, 9]) {
      // Fast-forward upgradesDone to n by bumping it directly rather than
      // looping claims (duration doesn't depend on prior claims, only on
      // upgrades_done, so this is equivalent and much faster).
      await query(
        `update lobby_economy set upgrades_done = jsonb_set(upgrades_done, '{motor}', to_jsonb($3::int), true)
         where lobby_id = $1 and team_key = $2`,
        [lobbyId, 'bosphorus', n],
      );
      const now = new Date(Date.UTC(2026, 1, 1));
      const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'motor' }, now });
      assert.equal(started.ok, true, `start failed at n=${n}`);
      if (!started.ok) return;
      const expectedMs = upgradeDurationMs(n);
      const actualMs = started.endsAt.getTime() - now.getTime();
      assert.equal(actualMs, expectedMs, `n=${n} duration mismatch`);
      if (n === 9) {
        assert.equal(expectedMs, UPGRADE_MAX_MS, 'n=9 should already be at the 22h cap in shared/');
      }
      // Undo the start so the next iteration begins from a clean slate.
      await query('delete from pending_jobs where lobby_id = $1', [lobbyId]);
    }
  });

  it('3) a completed upgrade grants shared base gain plus the factory bonus', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    await withTransaction((c) => setFactoryLevel(c, lobbyId, 'bosphorus', 'wind_tunnel', 3));
    const effects = factoryEffects({ wind_tunnel: 3 });
    const before = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.motor;

    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'motor' }, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const claimNow = new Date(started.endsAt.getTime() + 1000);
    const claimed = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: started.jobId, now: claimNow });
    assert.equal(claimed.ok, true);

    const after = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.motor;
    const expectedGain = UPGRADE_GAIN + effects.upgradeGainBonus;
    // The gain round-trips through Postgres numeric/JSON, which can perturb
    // the last float digit; compare with a tight tolerance rather than
    // exact equality.
    assert.ok(Math.abs((after - before) - expectedGain) < 1e-6,
      `expected shared UPGRADE_GAIN (${UPGRADE_GAIN}) + wind tunnel bonus (${effects.upgradeGainBonus}), got ${after - before}`);
  });

  it('4) factory scales still apply to cost and time', async () => {
    const { lobbyId } = await makeLobbyWithTeam();
    await withTransaction((c) => setFactoryLevel(c, lobbyId, 'bosphorus', 'manufacturing', 2));
    const effects = factoryEffects({ manufacturing: 2 });
    assert.ok(effects.upgradeCostScale < 1, 'manufacturing should discount cost');
    assert.ok(effects.upgradeTimeScale < 1, 'manufacturing should discount time');

    const now = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { stat: 'motor' }, now });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    assert.equal(started.rpCost, Math.round(upgradeCostFor(0) * effects.upgradeCostScale));
    const durationMs = started.endsAt.getTime() - now.getTime();
    assert.equal(durationMs, Math.round(upgradeDurationMs(0) * effects.upgradeTimeScale));
  });

  it('5) no second definition of the upgrade formulas exists in server/src', async () => {
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
          // The private formula this test guards against used its own
          // growth constants (1.25 for cost, 0.15 for duration) and its own
          // base gain of 1 — numbers that only ever show up again if
          // someone reintroduces a private re-derivation instead of
          // importing shared/'s `upgradeCostFor`/`upgradeDurationMs`/
          // `UPGRADE_GAIN`. A plain literal search is deliberately blunt:
          // the point is to catch the shape of the old bug, not to police
          // every number in the file.
          if (/1\.25\s*\*\*|\*\*\s*1\.25/.test(line)) {
            offenders.push(`${full}:${i + 1}: reintroduces the old 1.25 cost exponent — ${line.trim()}`);
          }
          if (/timesDone\s*\*\s*0\.15|0\.15\s*\*\s*timesDone/.test(line)) {
            offenders.push(`${full}:${i + 1}: reintroduces the old 0.15 duration growth — ${line.trim()}`);
          }
          if (/UPGRADE_BASE_GAIN\s*=\s*1\b/.test(line)) {
            offenders.push(`${full}:${i + 1}: reintroduces the old base gain of 1 — ${line.trim()}`);
          }
        }
      }
    }
    await scan(SRC);
    assert.deepEqual(offenders, [], `server/src has a second upgrade-formula definition: ${offenders.join(', ')}`);

    // Positive half of the guard: the composing wrapper must actually route
    // through shared/'s formulas, not just avoid the banned literals above.
    const jobsSrc = await readFile(join(SRC, 'economy', 'jobs.ts'), 'utf8');
    assert.match(jobsSrc, /from ['"]@pitwall\/shared\/carCustomisation['"]/,
      'server/src/economy/jobs.ts must import the upgrade formulas from shared/');
    assert.match(jobsSrc, /\bupgradeCostFor\b/, 'jobs.ts must use shared upgradeCostFor');
    assert.match(jobsSrc, /\bUPGRADE_GAIN\b/, 'jobs.ts must use shared UPGRADE_GAIN');
  });
});
