import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { seedTeamEconomy, loadTeamEconomy } from '../src/economy/repo.ts';
import { startJob } from '../src/economy/jobs.ts';
import { bumpAdsWatched, bumpGoldConverted, grantGold } from '../src/gold/repo.ts';
import { buildSlotState, SlotStateError } from '../src/economy/state.ts';
import { ADS_PER_DAY, GOLD_TO_RP_DAILY_CAP } from '@pitwall/shared/economy';

let seq = 0;

/** The smallest lobby + team economy a test needs. Every call gets its own
 *  unique name_base/name_seq and providerUid, so a half-finished run from
 *  one test never poisons another. */
async function makeLobbyWithTeam(teamKey = 'bosphorus'): Promise<{ lobbyId: string; userId: string }> {
  const n = ++seq;
  const owner = await createUserWithIdentity({
    base: 'PitCrew', provider: 'google', providerUid: `g-state-${n}`, emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`StateLobby #${n}`, 'StateLobby', n, owner.id],
  );
  const lobbyId = res.rows[0].id;
  await withTransaction((c) => seedTeamEconomy(c, lobbyId, teamKey));
  return { lobbyId, userId: owner.id };
}

describe('slot state', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from pending_jobs');
    await query('delete from lobby_economy');
    await query('delete from daily_caps');
    await query('delete from gold_grants');
    await query('delete from lobbies');
    await query('delete from users');
  });
  after(async () => { await closePool(); });

  it('serverNow really is the server clock, not whatever the caller supplied', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    const before = new Date();
    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date('2099-01-01T00:00:00Z') });
    const after = new Date();

    const serverNow = new Date(state.serverNow);
    assert.ok(
      serverNow.getTime() >= before.getTime() && serverNow.getTime() <= after.getTime(),
      `serverNow (${state.serverNow}) must fall between ${before.toISOString()} and ${after.toISOString()} — ` +
      'a caller-supplied instant (2099) must never come back untouched',
    );
  });

  it('returns rp, gold, car, factory, upgrade counters and teamValue together in one object', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date() });

    const economy = await loadTeamEconomy(lobbyId, 'bosphorus');
    assert.ok(economy);
    assert.equal(state.rp, economy!.rp);
    assert.deepEqual(state.car, economy!.car);
    assert.deepEqual(state.factory, economy!.factoryLevels);
    assert.deepEqual(state.upgradesDone, economy!.upgradesDone);
    assert.equal(typeof state.gold, 'number');
    assert.equal(typeof state.teamValue, 'number');
    assert.ok(state.teamValue > 0);
    assert.equal(state.lobbyId, lobbyId);
    assert.equal(state.teamKey, 'bosphorus');
  });

  it('lists open jobs with ready computed from the passed now, and skipCostGold falling to 0 once ready', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    const startedAt = new Date('2026-01-01T00:00:00Z');
    const started = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'training', payload: {}, now: startedAt });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const before = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date(started.endsAt.getTime() - 1000) });
    assert.equal(before.jobs.length, 1);
    assert.equal(before.jobs[0].jobId, started.jobId);
    assert.equal(before.jobs[0].ready, false);
    assert.ok(before.jobs[0].skipCostGold > 0);
    assert.equal(before.jobs[0].endsAt, started.endsAt.toISOString());

    const after = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date(started.endsAt.getTime() + 1000) });
    assert.equal(after.jobs[0].ready, true);
    assert.equal(after.jobs[0].skipCostGold, 0);
  });

  it('reports daily caps as what is left, shrinking as usage grows', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    const now = new Date('2026-02-01T12:00:00Z');

    const fresh = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now });
    assert.equal(fresh.caps.adsLeft, ADS_PER_DAY);
    assert.equal(fresh.caps.convertibleLeft, GOLD_TO_RP_DAILY_CAP);

    await bumpAdsWatched(userId, now, 3);
    await bumpGoldConverted(userId, now, 2);

    const used = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now });
    assert.equal(used.caps.adsLeft, ADS_PER_DAY - 3);
    assert.equal(used.caps.convertibleLeft, GOLD_TO_RP_DAILY_CAP - 2);
  });

  it('floors caps at zero even if usage somehow exceeds the daily limit', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    const now = new Date('2026-02-01T12:00:00Z');
    await bumpAdsWatched(userId, now, ADS_PER_DAY + 5);
    await bumpGoldConverted(userId, now, GOLD_TO_RP_DAILY_CAP + 5);

    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now });
    assert.equal(state.caps.adsLeft, 0);
    assert.equal(state.caps.convertibleLeft, 0);
  });

  it('reflects the account gold balance', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    await grantGold({ userId, source: 'ad', externalId: 'ext-1', gold: 42 });
    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date() });
    assert.equal(state.gold, 42);
  });

  it('leaks nothing sensitive — no email-shaped value, no password/token/secret key', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'spy', payload: {}, now: new Date() });
    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date() });

    const serialised = JSON.stringify(state);
    assert.doesNotMatch(serialised, /[^\s"]+@[^\s"]+\.[^\s"]+/, 'must not contain an email-shaped value');

    const lowerKeys = JSON.stringify(state, (key) => key).toLowerCase();
    for (const forbidden of ['password', 'token', 'secret']) {
      assert.ok(!lowerKeys.includes(forbidden), `serialised state must not contain a "${forbidden}" key`);
    }
  });

  it('a slot with no economy row is a handleable error, not a half-built object', async () => {
    const { lobbyId, userId } = await makeLobbyWithTeam();
    // 'aurelia' was never seeded for this lobby.
    await assert.rejects(
      () => buildSlotState({ lobbyId, teamKey: 'aurelia', userId, now: new Date() }),
      (err: unknown) => err instanceof SlotStateError && err.reason === 'no_economy',
    );
  });
});
