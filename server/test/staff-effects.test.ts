/**
 * Hired staff actually change the game — Faz 3b-2 Stage D.
 *
 * `staffEffects` (`@pitwall/shared/staff`) has produced seven numbers since
 * `ab611ff`, but until this task nothing server-side ever read them: hiring
 * a mechanic changed no number anywhere. These tests prove each of the
 * seven effects reaches its real production path, that race-entry effects
 * freeze at lights-out (a post-race hire cannot retroactively change a
 * replay), that the brief a player is judged against at settlement is the
 * SAME brief they could see before the race (not one regenerated from
 * whoever happens to be on the roster at settlement time), and that
 * `contractRounds` ticks exactly once per settled race.
 *
 * Every id this suite creates is tracked and only those are torn down —
 * other suites share this database (house rule, see `race-settle.test.ts`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER } from '../src/lobby/grid.ts';
import { buildFrozenEntries, startRaceFor, deriveSeed } from '../src/lobby/runner.ts';
import { replayRace, qualifyingForRecipe, type RaceSnapshot } from '../src/lobby/replay.ts';
import { settleRace, AlreadySettledError } from '../src/economy/settle.ts';
import { startJob, claimJob } from '../src/economy/jobs.ts';
import { loadTeamEconomy } from '../src/economy/repo.ts';
import { hireStaffSeat, loadStaffSeat } from '../src/staff/repo.ts';
import { staffEffects, wageFor, type StaffMember, type StaffRole } from '@pitwall/shared/staff';
import { weatherFor, finishRace } from '@pitwall/shared/raceEngine';
import { trackForRound } from '@pitwall/shared/tracks';
import { briefFor, briefCompliance, BRIEF_RP_EACH, type WeekendChoices } from '@pitwall/shared/brief';

const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const HUMAN = SEAT_LADDER[0];

async function makeLobby(label: string): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'CrewChief', provider: 'google', providerUid: `g-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(owner.id);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbies.push(lobby.id);
  await query(
    `update lobby_seats set user_id = $2, managed = 'human', joined_at = now() where lobby_id = $1 and team_key = $3`,
    [lobby.id, owner.id, HUMAN],
  );
  return lobby.id;
}

/** Hires a staff member directly (bypasses the market/RP flow — this suite
 *  is testing the EFFECT, not the hiring transaction, which `staff-market.
 *  test.ts` already covers). */
async function hire(lobbyId: string, teamKey: string, role: StaffRole, skill: number, contractRounds = 8): Promise<StaffMember> {
  const member: StaffMember = {
    id: `test-${role}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Kişi', role, skill, wage: wageFor(skill), contractRounds,
  };
  await withTransaction((client) => hireStaffSeat(client, lobbyId, teamKey, member));
  return member;
}

describe('staff effects — hiring actually changes the game', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('unstaffed team: race-entry fields are absent, same as today', async () => {
    const lobbyId = await makeLobby('Unstaffed');
    const { entries } = await buildFrozenEntries(lobbyId, new Date());
    const own = entries[HUMAN];
    assert.ok(own, 'insan koltuğu katılıma girmedi');
    assert.equal(own.assistantErrorScale, undefined, 'stratejist yokken assistantErrorScale ayarlanmış');
    assert.equal(own.pitSecondsSaved, undefined, 'pit şefi yokken pitSecondsSaved ayarlanmış');
    assert.equal(own.pitFailChance, undefined, 'pit şefi yokken pitFailChance ayarlanmış');
  });

  it('mechanic: reliabilityBonus raises frozen reliability, staffed vs unstaffed', async () => {
    const bare = await makeLobby('MechBare');
    const staffed = await makeLobby('MechStaffed');
    const elite = await hire(staffed, HUMAN, 'mechanic', 90);

    const bareEntries = (await buildFrozenEntries(bare, new Date())).entries;
    const staffedEntries = (await buildFrozenEntries(staffed, new Date())).entries;

    const expectedBonus = staffEffects({ mechanic: elite }).reliabilityBonus;
    assert.ok(expectedBonus > 0, 'test kurulumu: elit mekanik sıfır bonus üretiyor');
    assert.ok(
      staffedEntries[HUMAN].reliability > bareEntries[HUMAN].reliability,
      'elit mekanik güvenilirliği artırmadı',
    );
    assert.equal(
      Math.round(staffedEntries[HUMAN].reliability * 1e9),
      Math.round(Math.min(1, bareEntries[HUMAN].reliability + expectedBonus) * 1e9),
      'güvenilirlik bugünkü motor terimiyle TOPLANMIYOR',
    );
  });

  it('mechanic: upgradeBonus raises upgrade gain at claim time', async () => {
    const bare = await makeLobby('UpgBare');
    const staffed = await makeLobby('UpgStaffed');
    const elite = await hire(staffed, HUMAN, 'mechanic', 90);
    const expectedBonus = staffEffects({ mechanic: elite }).upgradeBonus;
    assert.ok(expectedBonus > 0);

    async function claimedGain(lobbyId: string): Promise<number> {
      const now = new Date();
      const started = await startJob({ lobbyId, teamKey: HUMAN, kind: 'upgrade', payload: { stat: 'motor' }, now });
      assert.ok(started.ok, JSON.stringify(started));
      const claimed = await claimJob({ lobbyId, teamKey: HUMAN, jobId: started.jobId, now: started.endsAt });
      assert.ok(claimed.ok, JSON.stringify(claimed));
      return claimed.applied['gain'] as number;
    }

    const bareGain = await claimedGain(bare);
    const staffedGain = await claimedGain(staffed);
    assert.ok(staffedGain > bareGain, 'elit mekanik yükseltme kazancını artırmadı');
    assert.equal(Math.round((staffedGain - bareGain) * 1e6), Math.round(expectedBonus * 1e6));
  });

  it('strategist: assistantErrorScale reaches the frozen entry for an assistant-run seat', async () => {
    const staffed = await makeLobby('AssistStaffed');
    await query(`update lobby_seats set managed = 'assistant' where lobby_id = $1 and team_key = $2`, [staffed, HUMAN]);
    const elite = await hire(staffed, HUMAN, 'strategist', 90);
    const expected = staffEffects({ strategist: elite }).assistantErrorScale;

    const { entries } = await buildFrozenEntries(staffed, new Date());
    assert.equal(entries[HUMAN].assistantErrorScale, expected, 'assistantErrorScale dondurulan katılıma girmedi');
    assert.ok(expected < 1, 'test kurulumu: elit stratejist skalayı düşürmüyor');
  });

  it('pit crew: pitSecondsSaved and pitFailChance reach the frozen entry', async () => {
    const staffed = await makeLobby('PitStaffed');
    const elite = await hire(staffed, HUMAN, 'pitCrew', 90);
    const expected = staffEffects({ pitCrew: elite });

    const { entries } = await buildFrozenEntries(staffed, new Date());
    assert.equal(entries[HUMAN].pitSecondsSaved, expected.pitSecondsSaved);
    assert.equal(entries[HUMAN].pitFailChance, expected.pitFailChance);
  });

  it('strategist: briefAccuracy/forecastBand reach the frozen recipe, not settlement time', async () => {
    const staffed = await makeLobby('BriefStaffed');
    const elite = await hire(staffed, HUMAN, 'strategist', 90);
    const expected = staffEffects({ strategist: elite });

    const { snapshot } = await startRaceFor({ lobbyId: staffed, seasonNo: 1, roundNo: 1, now: new Date() });
    const params = snapshot.briefParams?.[HUMAN];
    assert.ok(params, 'brifing parametreleri tarife hiç girmedi');
    assert.equal(params.accuracy, expected.briefAccuracy);
    assert.equal(params.forecastBand, expected.forecastBand);
  });

  it('a staff member hired AFTER lights-out does not change that race\'s replay', async () => {
    const lobbyId = await makeLobby('PostHire');
    const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    const before = finishRace(replayRace({ seed, round: 1, snapshot, decisions: [] }));

    await hire(lobbyId, HUMAN, 'pitCrew', 90);
    await hire(lobbyId, HUMAN, 'mechanic', 90);
    await hire(lobbyId, HUMAN, 'strategist', 90);

    // replayRace only ever reads the SNAPSHOT (`run.snapshot`), never the
    // live `lobby_staff` table — hiring after the fact must not move a
    // single result.
    const after = finishRace(replayRace({ seed, round: 1, snapshot, decisions: [] }));
    assert.deepEqual(after.order, before.order, 'ışıklar söndükten sonraki bir imza yarışı geriye dönük değiştirdi');
  });

  it('settlement judges the brief frozen at lights-out, not the roster at settlement time', async () => {
    const lobbyId = await makeLobby('BriefFrozenSettle');
    const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    // No strategist at lights-out — frozen brief is the plain (accuracy 1) one.
    assert.equal(snapshot.briefParams?.[HUMAN], undefined);

    // A strategist joins AFTER lights-out but BEFORE settlement. Skill 60
    // (not 90): at skill 90 `staffEffects` happens to hit the lerp's exact
    // top (accuracy 1.0, band 0.05), which is byte-identical to the
    // no-strategist default and would hide a settlement-time regeneration
    // bug behind a numeric coincidence.
    await hire(lobbyId, HUMAN, 'strategist', 60);

    const track = trackForRound(1);
    const weather = weatherFor(track, seed);
    const entry = snapshot.entries[HUMAN];
    const items = briefFor(track, weather, entry.setup); // frozen params: none
    const choices: WeekendChoices = {
      raceCompound: entry.setup.compound, tactics: entry.tactics,
      risk: snapshot.risks[HUMAN] ?? 'safe', bias: entry.setup.bias ?? 0,
    };
    const expectedBonus = briefCompliance(items, choices) * BRIEF_RP_EACH;

    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const payout = settlement.payouts.find((p) => p.teamKey === HUMAN)!;
    assert.equal(payout.briefBonus, expectedBonus, 'brifing bonusu ışıklar sönerken donan brifingi DEĞİL, sonradan gelen stratejisti yargıladı');
  });

  it('a staff contract ticks exactly once per settled race; settling twice ticks once', async () => {
    const lobbyId = await makeLobby('ContractTick');
    const member = await hire(lobbyId, HUMAN, 'mechanic', 60, 5);
    await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const afterFirst = await loadStaffSeat(lobbyId, HUMAN, 'mechanic');
    assert.equal(afterFirst?.member.contractRounds, member.contractRounds - 1, 'sözleşme bir tur inmedi');

    await assert.rejects(
      () => settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() }),
      AlreadySettledError,
    );
    const afterSecond = await loadStaffSeat(lobbyId, HUMAN, 'mechanic');
    assert.equal(afterSecond?.member.contractRounds, afterFirst?.member.contractRounds, 'ikinci muhasebe sözleşmeyi ikinci kez indirdi');
  });

  it('an expired contract releases the seat back to the default', async () => {
    const lobbyId = await makeLobby('ContractExpire');
    await hire(lobbyId, HUMAN, 'pitCrew', 90, 1);
    await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    const seat = await loadStaffSeat(lobbyId, HUMAN, 'pitCrew');
    assert.equal(seat, null, 'süresi dolan sözleşme koltukta kaldı');

    const { entries } = await buildFrozenEntries(lobbyId, new Date());
    assert.equal(entries[HUMAN].pitSecondsSaved, undefined, 'süresi dolmuş pit şefi hâlâ etkisini sürdürüyor');
    assert.equal(entries[HUMAN].pitFailChance, undefined, 'süresi dolmuş pit şefi hâlâ etkisini sürdürüyor');
  });
});
