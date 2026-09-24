/**
 * Yarış muhasebesi — kazanç döngüsünün kapandığı yer.
 *
 * Buradaki testlerin çoğu "ödeme doğru mu" diye sormaz; ödemenin YALNIZCA BİR
 * KEZ yapıldığını ve yarım yazılamadığını sorar. Sebebi yeniden oynatmadır:
 * çöken bir sunucu aynı yarışı ikinci kez bitirebilir, ama RP iki kez
 * yazılmamalıdır.
 *
 * `withTransaction` YALNIZCA FIRLATMADA geri alır. Geri dönen bir "başarısız"
 * sonuç, o ana kadar yazılmış her şeyi TAAHHÜT EDER. Önceki fazda üç ayrı para
 * kaybı hatası tam bu şekildeydi, hepsi "başarılı bir harcama, karşılığında
 * hiçbir şey" biçiminde. Bu yüzden 2. test yalnızca "ikinci çağrı reddedildi"
 * demez, ikinci çağrıdan SONRAKİ toplamı da ölçer: `throw` yerine `return`
 * yazılırsa o toplam kayar ve test düşer.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER, TEAM_COUNT } from '../src/lobby/grid.ts';
import { loadLobbyEconomy, addRp } from '../src/economy/repo.ts';
import { startRaceFor } from '../src/lobby/runner.ts';
import { settleRace, AlreadySettledError } from '../src/economy/settle.ts';
import { insertSponsorship, loadTeamSponsorships } from '../src/economy/sponsorshipRepo.ts';
import { replayRace, type RaceSnapshot } from '../src/lobby/replay.ts';
import { deriveSeed } from '../src/lobby/runner.ts';
import { weatherFor, finishRace, type FinishEntry, type TacticPreset, type QualiRisk } from '@pitwall/shared/raceEngine';
import type { CompoundKey } from '@pitwall/shared/carCustomisation';
import { trackForRound } from '@pitwall/shared/tracks';
import {
  racePrize,
  streakMultiplier,
  type Sponsorship,
} from '@pitwall/shared/sponsors';
import { briefFor, briefCompliance, BRIEF_RP_EACH, type BriefItem, type WeekendChoices } from '@pitwall/shared/brief';

/**
 * A team's race-day finish, judged the same way the client judges its own
 * player car (gameStore.ts `settleRaceWeekend`): the better-placed of its
 * two drivers, or a fully-last placing if both retired. Test-only mirror of
 * the rule settle.ts must apply to every seat, not just the player's.
 */
function teamFinish(order: FinishEntry[], teamKey: string, teamCount: number): number {
  const classified = order.filter((e) => e.teamKey === teamKey && !e.dnf).map((e) => e.position);
  return classified.length ? Math.min(...classified) : teamCount * 2;
}

function baseSponsorship(overrides: Partial<Sponsorship> & Pick<Sponsorship, 'targetPosition'>): Sponsorship {
  return {
    dealId: overrides.dealId ?? `deal-${Math.random().toString(36).slice(2)}`,
    brandKey: 'axion',
    slot: 'sidepod',
    perRace: 100,
    bonus: 200,
    signedRound: 1,
    expiresRound: 99,
    streakTarget: 5,
    streak: 0,
    ...overrides,
  };
}

/**
 * Paylaşılan test veritabanı: BAŞKA ajanlar da aynı şemayı kullanıyor. Bu
 * yüzden tablo geneli `delete` YOK — yalnızca burada yaratılan kimlikler
 * izlenir ve yalnızca onlar silinir. (race-runner.test.ts ile aynı yardımcı.)
 */
const createdLobbies: string[] = [];
const createdUsers: string[] = [];
let seq = 0;

const HUMAN = SEAT_LADDER[0];
const ASSISTANT = SEAT_LADDER[1];
/** Hiç sahiplenilmemiş koltuk: yarışı AI sürer, ama ekonomisi yine de vardır. */
const AI_SEAT = SEAT_LADDER[2];

async function makeLobby(label = 'Settle'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter', provider: 'google', providerUid: `g-${label}-${++seq}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(owner.id);
  const lobby = await createLobby(owner.id, {
    region: 'EU', visibility: 'private', aiDifficulty: 'normal',
    rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
  });
  createdLobbies.push(lobby.id);
  await claimSeat(lobby.id, HUMAN, 'human', `${label}-h-${seq}`);
  await claimSeat(lobby.id, ASSISTANT, 'assistant', `${label}-a-${seq}`);
  return lobby.id;
}

async function claimSeat(lobbyId: string, teamKey: string, managed: 'human' | 'assistant', tag: string) {
  const user = await createUserWithIdentity({
    base: 'Racer', provider: 'google', providerUid: `g-${tag}-${Date.now()}`, emailHash: null,
  });
  createdUsers.push(user.id);
  await query(
    `update lobby_seats set user_id = $3, managed = $4, joined_at = now()
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, user.id, managed],
  );
}

/** Lobideki her takımın RP'si, takım anahtarına göre. */
async function balances(lobbyId: string): Promise<Map<string, number>> {
  const rows = await loadLobbyEconomy(lobbyId);
  return new Map(rows.map((r) => [r.teamKey, r.rp]));
}

const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

/** Işıkları söndürür; tarif yazılır, yarış muhasebeye hazır olur. */
async function raceReady(label: string): Promise<{ lobbyId: string; seed: number; snapshot: RaceSnapshot }> {
  const lobbyId = await makeLobby(label);
  const { seed, snapshot } = await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
  return { lobbyId, seed, snapshot };
}

/**
 * Predicts the settlement race's own outcome the exact same (pure,
 * deterministic) way `settle.ts` does — no decisions were ever posted for
 * these fixtures, so replaying with an empty log matches production.
 */
function predictRace(seed: number, snapshot: RaceSnapshot) {
  const state = replayRace({ seed, round: 1, snapshot, decisions: [] });
  return finishRace(state);
}

/**
 * What settle.ts should pay a team in briefing RP: the true (accuracy-1)
 * brief for the frozen recipe, judged against that team's own frozen
 * weekend choices. Zero for a team with no entry (AI-run seat — no choices
 * were ever made for it to be judged against).
 */
function briefBonusFor(seed: number, snapshot: RaceSnapshot, teamKey: string): number {
  const entry = snapshot.entries[teamKey];
  if (!entry) return 0;
  const track = trackForRound(1);
  const weather = weatherFor(track, seed);
  const items = briefFor(track, weather, entry.setup);
  const choices: WeekendChoices = {
    raceCompound: entry.setup.compound,
    tactics: entry.tactics,
    risk: snapshot.risks[teamKey] ?? 'safe',
    bias: entry.setup.bias ?? 0,
  };
  return briefCompliance(items, choices) * BRIEF_RP_EACH;
}

/** Directly writes a seat's weekend choices — the fields `weekendChoices.ts` accepts. */
async function setWeekendChoices(
  lobbyId: string, teamKey: string,
  choices: { compound: CompoundKey; bias: number; tactics: TacticPreset; qualiRisk: QualiRisk },
): Promise<void> {
  await query(
    `update lobby_seats set compound = $3, bias = $4, tactics = $5, quali_risk = $6
     where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, choices.compound, choices.bias, choices.tactics, choices.qualiRisk],
  );
}

/**
 * Brute-forces the weekend-choice combination that scores highest (and
 * lowest) against a brief — independent of `briefBonusFor` above, so the
 * dedicated briefing test does not just re-assert its own mirror of
 * settle.ts but proves payment tracks the ACTUAL best/worst compliance.
 */
function bestAndWorstChoices(items: BriefItem[]): {
  best: WeekendChoices; bestScore: number; worst: WeekendChoices; worstScore: number;
} {
  const compounds: CompoundKey[] = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];
  const tacticsOpts: TacticPreset[] = ['conservative', 'balanced', 'aggressive'];
  const riskOpts: QualiRisk[] = ['safe', 'aggressive'];
  const biasOpts = [-1, 0, 1];
  let best: WeekendChoices | undefined;
  let bestScore = -1;
  let worst: WeekendChoices | undefined;
  let worstScore = Infinity;
  for (const raceCompound of compounds) {
    for (const tactics of tacticsOpts) {
      for (const risk of riskOpts) {
        for (const bias of biasOpts) {
          const choices: WeekendChoices = { raceCompound, tactics, risk, bias };
          const score = briefCompliance(items, choices);
          if (score > bestScore) { bestScore = score; best = choices; }
          if (score < worstScore) { worstScore = score; worst = choices; }
        }
      }
    }
  }
  return { best: best!, bestScore, worst: worst!, worstScore };
}

describe('race settlement — the earning loop', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('credits rp to every seat in the lobby', async () => {
    const { lobbyId } = await raceReady('Pay');
    const before = await balances(lobbyId);
    assert.equal(before.size, TEAM_COUNT, 'lobi 11 ekonomi satırıyla doğmalı');

    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const after = await balances(lobbyId);

    assert.equal(settlement.payouts.length, TEAM_COUNT);
    for (const [teamKey, rp] of before) {
      assert.ok(after.get(teamKey)! > rp, `${teamKey} ödenmedi`);
    }
    // Ödenen toplam, döndürülen dökümle birebir uyuşmalı.
    const paid = settlement.payouts.reduce((a, p) => a + p.rp, 0);
    assert.equal(total(after) - total(before), paid);
  });

  it('settling the same race twice credits rp exactly once', async () => {
    const { lobbyId } = await raceReady('Twice');
    await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const afterFirst = await balances(lobbyId);

    await assert.rejects(
      () => settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() }),
      AlreadySettledError,
      'ikinci muhasebe sessizce geçmemeli',
    );

    const afterSecond = await balances(lobbyId);
    // ASIL İDDİA: reddedilmiş olması yetmez, HİÇBİR RP yazılmamış olmalı.
    assert.equal(total(afterSecond), total(afterFirst), 'ikinci muhasebe RP yazdı');
    for (const [teamKey, rp] of afterFirst) {
      assert.equal(afterSecond.get(teamKey), rp, `${teamKey} iki kez ödendi`);
    }
  });

  it('updates the championship table in the same settlement', async () => {
    const { lobbyId } = await raceReady('Table');
    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    assert.equal(settlement.standings.length, TEAM_COUNT);
    const points = settlement.standings.reduce((a, s) => a + s.points, 0);
    assert.ok(points > 0, 'tablo hiç puan almamış — yarış işlenmemiş');
    // Sıralama tutarlı: 1..11, puana göre azalan.
    settlement.standings.forEach((s, i) => assert.equal(s.position, i + 1));
    for (let i = 1; i < settlement.standings.length; i += 1) {
      assert.ok(settlement.standings[i - 1].points >= settlement.standings[i].points);
    }
    // Ödeme dökümü tabloyla aynı sıralamayı okur.
    for (const p of settlement.payouts) {
      const row = settlement.standings.find((s) => s.teamKey === p.teamKey)!;
      assert.equal(p.position, row.position, `${p.teamKey} için sıralama ayrıştı`);
    }
  });

  it('pays an AI-run team too', async () => {
    const { lobbyId } = await raceReady('Ai');
    const before = await balances(lobbyId);
    await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const after = await balances(lobbyId);
    assert.ok(
      after.get(AI_SEAT)! > before.get(AI_SEAT)!,
      'AI koltuğu ödenmedi — bir sezon sonunda ızgara çürür',
    );
  });

  it('writes no rp at all when settlement fails mid-way', async () => {
    const { lobbyId } = await raceReady('Fail');
    const before = await balances(lobbyId);

    let credits = 0;
    await assert.rejects(
      () => settleRace(
        { lobbyId, seasonNo: 1, roundNo: 1, now: new Date() },
        {
          // İlk alacaklandırmadan SONRA patlat: kısmi yazma geri alınmalı.
          addRp: async (client, l, t, amount) => {
            credits += 1;
            if (credits > 1) throw new Error('boom');
            await addRp(client, l, t, amount);
          },
        },
      ),
      /boom/,
    );

    const after = await balances(lobbyId);
    for (const [teamKey, rp] of before) {
      assert.equal(after.get(teamKey), rp, `${teamKey} yarım muhasebeden RP aldı`);
    }
    // Muhasebe kaydı da geri alınmalı, yoksa yarış bir daha ASLA ödenemez.
    const settled = await query(
      'select 1 from race_settlements where lobby_id = $1 and season_no = 1 and round_no = 1',
      [lobbyId],
    );
    assert.equal(settled.rowCount, 0, 'ödeme yapılmadan muhasebe kaydı kaldı');
  });

  it('a better finishing position earns more than a worse one', async () => {
    const { lobbyId, seed, snapshot } = await raceReady('Ladder');
    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    const best = settlement.standings[0];
    const worst = settlement.standings[settlement.standings.length - 1];
    assert.ok(best.points > worst.points, 'yarış tabloyu hiç ayırmamış');

    const payoutOf = (teamKey: string) => settlement.payouts.find((p) => p.teamKey === teamKey)!.rp;
    // Sayılar uydurulmadı: mevcut `racePrize` merdiveni + (varsa) brifing
    // bonusu okunuyor — bu lobide hiç sponsorluk yok, yani üçüncü gelir kolu
    // yok. Ladder koltuklarından biri insan/asistan koltuğuysa (SEAT_LADDER[0]
    // en güçlü araç olduğu için genelde `best` odur) brifing bonusu da hesaba
    // katılmalı, yoksa bu tam eşitlik testi yeni ödeme koluyla çelişirdi.
    assert.equal(payoutOf(best.teamKey), racePrize(1, TEAM_COUNT) + briefBonusFor(seed, snapshot, best.teamKey));
    assert.equal(
      payoutOf(worst.teamKey),
      racePrize(TEAM_COUNT, TEAM_COUNT) + briefBonusFor(seed, snapshot, worst.teamKey),
    );
    assert.ok(
      payoutOf(best.teamKey) > payoutOf(worst.teamKey),
      'daha iyi biten daha az kazandı',
    );
  });

  /**
   * `sponsorships_target_check` (007_sponsorships.sql) pins target_position
   * to 1..12 — the same ceiling `generateOffers` itself never exceeds. So a
   * "guaranteed miss" needs a real, worse-finishing team rather than an
   * out-of-range target: the team with the worst LEAD-CAR finish this race
   * (mirrors `teamFinish`, computed for every seat).
   */
  function worstFinisher(race: ReturnType<typeof predictRace>): { teamKey: string; finish: number } {
    let worstTeam = race.standings[0].teamKey;
    let worstFinish = -1;
    for (const s of race.standings) {
      const f = teamFinish(race.order, s.teamKey, TEAM_COUNT);
      if (f > worstFinish) { worstFinish = f; worstTeam = s.teamKey; }
    }
    return { teamKey: worstTeam, finish: worstFinish };
  }

  it('pays a signed sponsorship its per-race income', async () => {
    const { lobbyId, seed, snapshot } = await raceReady('SponsorIncome');
    const race = predictRace(seed, snapshot);
    // The worst-placed team, with a target one better than its own finish,
    // guarantees the bonus is NOT paid — isolating perRace by itself.
    const { teamKey, finish } = worstFinisher(race);
    const missTarget = Math.max(1, Math.min(12, finish - 1));
    const position = race.standings.find((s) => s.teamKey === teamKey)!.position;

    await withTransaction((client) => insertSponsorship(
      client, lobbyId, teamKey,
      baseSponsorship({ targetPosition: missTarget, perRace: 137, bonus: 500, dealId: 'income-deal' }),
    ));

    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const payout = settlement.payouts.find((p) => p.teamKey === teamKey)!.rp;
    const expected = racePrize(position, TEAM_COUNT) + 137 + briefBonusFor(seed, snapshot, teamKey);
    assert.equal(payout, expected, 'sponsor perRace geliri ödenmedi');
  });

  it('advances a met streak and persists it', async () => {
    const { lobbyId, seed, snapshot } = await raceReady('StreakUp');
    const race = predictRace(seed, snapshot);
    // The race winner (lead car, position 1) is guaranteed to meet ANY
    // valid target — isolates the "hit" branch with zero luck involved.
    const winnerTeam = race.order[0].teamKey;
    const position = race.standings.find((s) => s.teamKey === winnerTeam)!.position;

    await withTransaction((client) => insertSponsorship(
      client, lobbyId, winnerTeam,
      baseSponsorship({
        targetPosition: 1, // garanti tutturulur — kazanan takım
        perRace: 50, bonus: 300, streakTarget: 5, streak: 2, dealId: 'streak-up-deal',
      }),
    ));

    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    const running = await loadTeamSponsorships(lobbyId, winnerTeam);
    const deal = running.find((s) => s.dealId === 'streak-up-deal')!;
    assert.equal(deal.streak, 3, 'seri ilerlemedi/kalıcı olmadı');

    const payout = settlement.payouts.find((p) => p.teamKey === winnerTeam)!.rp;
    const bonus = Math.round(300 * streakMultiplier(3, 5));
    const expected = racePrize(position, TEAM_COUNT) + 50 + bonus + briefBonusFor(seed, snapshot, winnerTeam);
    assert.equal(payout, expected, 'seri bonusu doğru ödenmedi');
  });

  it('breaks a missed streak and persists the reset', async () => {
    const { lobbyId, seed, snapshot } = await raceReady('StreakDown');
    const race = predictRace(seed, snapshot);
    // The worst-placed team with a target one better than its own finish is
    // guaranteed to miss — isolates the "reset" branch with zero luck.
    const { teamKey, finish } = worstFinisher(race);
    const missedTarget = Math.max(1, Math.min(12, finish - 1));
    const position = race.standings.find((s) => s.teamKey === teamKey)!.position;

    await withTransaction((client) => insertSponsorship(
      client, lobbyId, teamKey,
      baseSponsorship({
        targetPosition: missedTarget,
        perRace: 60, bonus: 400, streakTarget: 5, streak: 3, dealId: 'streak-down-deal',
      }),
    ));

    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    const running = await loadTeamSponsorships(lobbyId, teamKey);
    const deal = running.find((s) => s.dealId === 'streak-down-deal')!;
    assert.equal(deal.streak, 0, 'kaçırılan seri sıfırlanıp kalıcı olmadı');

    const payout = settlement.payouts.find((p) => p.teamKey === teamKey)!.rp;
    const expected = racePrize(position, TEAM_COUNT) + 60 + briefBonusFor(seed, snapshot, teamKey);
    assert.equal(payout, expected, 'kaçırılan hedefte bonus yine de ödenmiş');
  });

  it('pays the briefing bonus according to the manager\'s actual weekend choices', async () => {
    // İki bağımsız lobi: biri brifingin ÖNERDİĞİ her şeyi seçer, öbürü hiçbirini.
    const goodLobby = await makeLobby('BriefGood');
    const badLobby = await makeLobby('BriefBad');

    const goodSeed = deriveSeed(goodLobby, 1, 1);
    const goodTrack = trackForRound(1);
    const goodWeather = weatherFor(goodTrack, goodSeed);
    const dummySetup = { motor: 50, aero: 50, grip: 50, compound: 'MEDIUM' as CompoundKey };
    const goodItems = briefFor(goodTrack, goodWeather, dummySetup);
    const { best, bestScore } = bestAndWorstChoices(goodItems);
    await setWeekendChoices(goodLobby, HUMAN, {
      compound: best.raceCompound, bias: best.bias, tactics: best.tactics, qualiRisk: best.risk,
    });

    const badSeed = deriveSeed(badLobby, 1, 1);
    const badTrack = trackForRound(1);
    const badWeather = weatherFor(badTrack, badSeed);
    const badItems = briefFor(badTrack, badWeather, dummySetup);
    const { worst, worstScore } = bestAndWorstChoices(badItems);
    await setWeekendChoices(badLobby, HUMAN, {
      compound: worst.raceCompound, bias: worst.bias, tactics: worst.tactics, qualiRisk: worst.risk,
    });

    const { snapshot: goodSnapshot } = await startRaceFor({ lobbyId: goodLobby, seasonNo: 1, roundNo: 1, now: new Date() });
    const { snapshot: badSnapshot } = await startRaceFor({ lobbyId: badLobby, seasonNo: 1, roundNo: 1, now: new Date() });

    const goodRace = predictRace(goodSeed, goodSnapshot);
    const goodPos = goodRace.standings.find((s) => s.teamKey === HUMAN)!.position;
    const badRace = predictRace(badSeed, badSnapshot);
    const badPos = badRace.standings.find((s) => s.teamKey === HUMAN)!.position;

    const goodSettlement = await settleRace({ lobbyId: goodLobby, seasonNo: 1, roundNo: 1, now: new Date() });
    const badSettlement = await settleRace({ lobbyId: badLobby, seasonNo: 1, roundNo: 1, now: new Date() });

    const goodPayout = goodSettlement.payouts.find((p) => p.teamKey === HUMAN)!.rp;
    const badPayout = badSettlement.payouts.find((p) => p.teamKey === HUMAN)!.rp;

    assert.equal(goodPayout, racePrize(goodPos, TEAM_COUNT) + bestScore * BRIEF_RP_EACH, 'iyi seçimler doğru ödenmedi');
    assert.equal(badPayout, racePrize(badPos, TEAM_COUNT) + worstScore * BRIEF_RP_EACH, 'kötü seçimler doğru ödenmedi');
    assert.ok(bestScore >= worstScore, 'en iyi kombinasyon en kötüden düşük puan aldı');
  });

  it('leaves a sponsorless team unaffected by the sponsor/brief payout paths', async () => {
    const { lobbyId, seed, snapshot } = await raceReady('NoSponsor');
    const race = predictRace(seed, snapshot);
    const position = race.standings.find((s) => s.teamKey === AI_SEAT)!.position;

    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const payout = settlement.payouts.find((p) => p.teamKey === AI_SEAT)!.rp;

    // AI koltuğu ne sponsorluk imzalayabilir ne de hafta sonu seçimi yapar —
    // ödemesi salt yarış ödülü olmalı.
    assert.equal(payout, racePrize(position, TEAM_COUNT));
  });

  it('writes no sponsor income or streak change when settlement fails mid-way', async () => {
    const { lobbyId } = await raceReady('SponsorFail');

    await withTransaction((client) => insertSponsorship(
      client, lobbyId, HUMAN,
      baseSponsorship({ targetPosition: TEAM_COUNT, perRace: 90, bonus: 300, streak: 1, dealId: 'fail-deal' }),
    ));

    const before = await balances(lobbyId);
    const beforeStreak = (await loadTeamSponsorships(lobbyId, HUMAN)).find((s) => s.dealId === 'fail-deal')!.streak;

    let credits = 0;
    await assert.rejects(
      () => settleRace(
        { lobbyId, seasonNo: 1, roundNo: 1, now: new Date() },
        {
          addRp: async (client, l, t, amount) => {
            credits += 1;
            if (credits > 1) throw new Error('boom');
            await addRp(client, l, t, amount);
          },
        },
      ),
      /boom/,
    );

    const after = await balances(lobbyId);
    for (const [teamKey, rp] of before) {
      assert.equal(after.get(teamKey), rp, `${teamKey} yarım muhasebeden RP aldı`);
    }
    const afterStreak = (await loadTeamSponsorships(lobbyId, HUMAN)).find((s) => s.dealId === 'fail-deal')!.streak;
    assert.equal(afterStreak, beforeStreak, 'yarım muhasebe seriyi de yazdı');
  });
});
