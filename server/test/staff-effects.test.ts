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
 * ── UNSTAFFED HUMAN vs. UNSTAFFED AI ─────────────────────────────────────
 * A first version of this task gated every effect on that specific role
 * being HIRED, so an unstaffed team of any kind fell back to the engine's
 * own hardcoded defaults. That inverted the mechanic for a human team: at
 * skill 40 (an empty seat) `staffEffects` gives a WORSE brief (0.70/0.30)
 * and a WORSE pit crew (0.08 fail chance) than the engine's own hardcoded
 * "nobody hired" numbers (implicit accuracy 1 / band 0.05, 0.04 fail
 * chance) — so a human team was BETTER OFF never touching the staff
 * system, and hiring anyone below skill ~90 made the team worse. The
 * client's original design was the opposite: an empty seat is skill 40 ON
 * PURPOSE, so having no staff is meant to be bad and hiring is meant to
 * matter. The fix (this version): `staffEffects` applies to a
 * HUMAN-OWNED team's all three roles unconditionally (an absent role runs
 * on `staffEffects`'s own skill-40 default); an AI team (no owner) is
 * untouched, exactly as before this whole feature. Ownership is read via
 * `loadHumanTeamKeys` (`user_id is not null`), never `managed` — `managed`
 * flips human/assistant on a missed check-in, but the seat is still that
 * manager's own team meanwhile (see `lobbyRepo.ts`'s own doc comment).
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
/** Never claimed by `makeLobby` — stays `managed: 'ai'`, unowned. */
const AI_SEAT = SEAT_LADDER[2];

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

  it('an unstaffed AI team races exactly as before — never enters entries at all', async () => {
    const lobbyId = await makeLobby('AiUnstaffed');
    const { entries, briefParams } = await buildFrozenEntries(lobbyId, new Date());
    // AI hiç `entries`e girmez — bugünkü sözleşme: motorun kendi
    // `aiStrength`/`aiReliability` yoluyla koştuğu takımlar `entries`te HİÇ
    // görünmez. Bu görev bu invaryantı DEĞİŞTİRMEDİ; yalnızca `entries`e
    // giren (insan sahipli) takımların içeriğini değiştirdi.
    assert.equal(entries[AI_SEAT], undefined, 'AI takımı katılıma girmiş');
    assert.equal(briefParams[AI_SEAT], undefined, 'AI takımı için brifing parametresi üretilmiş');
  });

  it('an unstaffed human team gets the skill-40 effects, not the engine\'s hardcoded defaults', async () => {
    const lobbyId = await makeLobby('HumanUnstaffed');
    const { entries, briefParams } = await buildFrozenEntries(lobbyId, new Date());
    const expected = staffEffects({}); // skill-40 fallback for all three roles

    const own = entries[HUMAN];
    assert.ok(own, 'insan koltuğu katılıma girmedi');
    assert.equal(own.assistantErrorScale, expected.assistantErrorScale);
    assert.equal(own.pitSecondsSaved, expected.pitSecondsSaved);
    assert.equal(own.pitFailChance, expected.pitFailChance);
    assert.notEqual(own.pitFailChance, 0.04, 'motorun eski sabit varsayılanı hâlâ kullanılıyor');

    const params = briefParams[HUMAN];
    assert.ok(params, 'personelsiz insan takımı için brifing parametresi hiç üretilmedi');
    assert.equal(params.accuracy, expected.briefAccuracy);
    assert.equal(params.forecastBand, expected.forecastBand);
    assert.notEqual(params.accuracy, 1, 'briefFor\'ın eski örtük varsayılanı (doğruluk 1) hâlâ kullanılıyor');
  });

  it('hiring improves the team — the skill-40/no-staff inversion is gone', async () => {
    const bare = await makeLobby('InvBare');
    const staffed = await makeLobby('InvStaffed');
    await hire(staffed, HUMAN, 'strategist', 65);
    await hire(staffed, HUMAN, 'pitCrew', 65);

    const { briefParams: bareBrief } = await buildFrozenEntries(bare, new Date());
    const { briefParams: staffedBrief, entries: staffedEntries } = await buildFrozenEntries(staffed, new Date());

    // A skill-65 strategist gives a MORE accurate, NARROWER brief than an
    // unstaffed (skill-40) team — not a worse one.
    assert.ok(
      staffedBrief[HUMAN].accuracy > bareBrief[HUMAN].accuracy,
      'skill-65 stratejist personelsiz takımdan daha kötü bir brifing üretti',
    );
    assert.ok(
      staffedBrief[HUMAN].forecastBand < bareBrief[HUMAN].forecastBand,
      'skill-65 stratejist personelsiz takımdan daha geniş bir yağmur bandı üretti',
    );

    // A skill-65 pit crew fails LESS often than an unstaffed (skill-40) crew.
    const { entries: bareEntries } = await buildFrozenEntries(bare, new Date());
    assert.ok(
      staffedEntries[HUMAN].pitFailChance! < bareEntries[HUMAN].pitFailChance!,
      'skill-65 pit şefi personelsiz takımdan daha sık hata yaptı',
    );
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

    // No strategist at lights-out — frozen brief is the skill-40 default
    // (`staffEffects({})`), not the engine's own implicit accuracy-1 default.
    const expectedDefault = staffEffects({});
    assert.equal(snapshot.briefParams?.[HUMAN]?.accuracy, expectedDefault.briefAccuracy);
    assert.equal(snapshot.briefParams?.[HUMAN]?.forecastBand, expectedDefault.forecastBand);

    // A strategist joins AFTER lights-out but BEFORE settlement. Skill 60
    // (not 90): at skill 90 `staffEffects` happens to hit the lerp's exact
    // top (accuracy 1.0, band 0.05), which would be indistinguishable from a
    // DIFFERENT bug (ignoring the frozen params entirely and defaulting to
    // accuracy 1) and would hide a settlement-time regeneration bug behind a
    // numeric coincidence.
    await hire(lobbyId, HUMAN, 'strategist', 60);

    const track = trackForRound(1);
    const weather = weatherFor(track, seed);
    const entry = snapshot.entries[HUMAN];
    // The FROZEN params (skill-40 default), never the skill-60 strategist
    // hired after lights-out.
    const items = briefFor(track, weather, entry.setup, expectedDefault.briefAccuracy, 0, expectedDefault.forecastBand);
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

    // Koltuk boşaldıktan sonra takım İNSAN SAHİPLİ olmaya devam eder —
    // `staffEffects`in KENDİ skill-40 varsayılanına döner, `undefined`e değil.
    const expectedDefault = staffEffects({});
    const { entries } = await buildFrozenEntries(lobbyId, new Date());
    assert.equal(entries[HUMAN].pitSecondsSaved, expectedDefault.pitSecondsSaved, 'süresi dolmuş pit şefi hâlâ eski etkisini sürdürüyor');
    assert.equal(entries[HUMAN].pitFailChance, expectedDefault.pitFailChance, 'süresi dolmuş pit şefi hâlâ eski etkisini sürdürüyor');
  });
});
