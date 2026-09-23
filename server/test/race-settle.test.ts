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
import { query, closePool } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { createLobby } from '../src/lobby/lobbyRepo.ts';
import { SEAT_LADDER, TEAM_COUNT } from '../src/lobby/grid.ts';
import { loadLobbyEconomy, addRp } from '../src/economy/repo.ts';
import { startRaceFor } from '../src/lobby/runner.ts';
import { settleRace, AlreadySettledError } from '../src/economy/settle.ts';
import { racePrize } from '@pitwall/shared/sponsors';

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
async function raceReady(label: string): Promise<string> {
  const lobbyId = await makeLobby(label);
  await startRaceFor({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
  return lobbyId;
}

describe('race settlement — the earning loop', () => {
  before(async () => { await runMigrations(); });
  after(async () => {
    for (const id of createdLobbies) await query('delete from lobbies where id = $1', [id]);
    for (const id of createdUsers) await query('delete from users where id = $1', [id]);
    await closePool();
  });

  it('credits rp to every seat in the lobby', async () => {
    const lobbyId = await raceReady('Pay');
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
    const lobbyId = await raceReady('Twice');
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
    const lobbyId = await raceReady('Table');
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
    const lobbyId = await raceReady('Ai');
    const before = await balances(lobbyId);
    await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });
    const after = await balances(lobbyId);
    assert.ok(
      after.get(AI_SEAT)! > before.get(AI_SEAT)!,
      'AI koltuğu ödenmedi — bir sezon sonunda ızgara çürür',
    );
  });

  it('writes no rp at all when settlement fails mid-way', async () => {
    const lobbyId = await raceReady('Fail');
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
    const lobbyId = await raceReady('Ladder');
    const settlement = await settleRace({ lobbyId, seasonNo: 1, roundNo: 1, now: new Date() });

    const best = settlement.standings[0];
    const worst = settlement.standings[settlement.standings.length - 1];
    assert.ok(best.points > worst.points, 'yarış tabloyu hiç ayırmamış');

    const payoutOf = (teamKey: string) => settlement.payouts.find((p) => p.teamKey === teamKey)!.rp;
    assert.ok(
      payoutOf(best.teamKey) > payoutOf(worst.teamKey),
      'daha iyi biten daha az kazandı',
    );
    // Sayılar uydurulmadı: mevcut `racePrize` merdiveni okunuyor.
    assert.equal(payoutOf(best.teamKey), racePrize(1, TEAM_COUNT));
    assert.equal(payoutOf(worst.teamKey), racePrize(TEAM_COUNT, TEAM_COUNT));
  });
});
