/**
 * Hafta sonu DÖNÜŞÜ — `result`ten bir sonraki hafta sonuna.
 *
 * NEDEN AYRI BİR MODÜL:
 * `runner.ts`in `flag()`i lobiyi `result`e taşır ve orada BİLEREK bırakır
 * (bkz. onun docblock'u): damga + evre + muhasebe TEK işlemde olmalı, ve o
 * işlem "bu yarış bitti" sorusuna cevap verir, "bir sonraki hafta sonu ne
 * zaman" sorusuna değil. `result` de `acquireDueLobbies`in taradığı
 * evrelerden biri DEĞİL (`lease.ts` `DUE_PHASES`) — orada bırakılan bir lobiyi
 * kira mekanizması bir daha asla devralmaz. Birinin onu ittirmesi gerekir; bu
 * modül o ittirmedir. `sweep.ts` her bayrak görüşünden sonra bunu çağırır.
 *
 * NEDEN TAKVİMİ BURASI TÜRETMİYOR, `schedule.ts`İ ÇAĞIRIYOR:
 * "Bir sonraki yarış ne zaman" sorusunun TEK cevabı `nextRaceAt`tir
 * (`createLobby` da aynı fonksiyonu çağırır). İkinci bir hesap icat etmek —
 * "bir gün sonra" gibi — bölgenin yerel saatinden ve DST'den bağımsız,
 * `createLobby`nin verdiğinden ayrışabilecek bir zamanlama doğururdu.
 *
 * NEDEN TABLO SIFIRLAMASI İÇİN AYRI BİR YAZMA YOK:
 * Lobinin kendi puan tablosu diye ayrı bir SÜTUN/tablo yok; `runner.ts`teki
 * `standingsBeforeRound` onu her seferinde TARİFTEN türetiyor ve döngüsü
 * `seasonNo`ya göre taranıyor (`loadRun(lobbyId, seasonNo, r)`). Yani sezonu
 * artırıp turu 1'e döndürmek TEK BAŞINA yeterli: yeni sezonun 1. turundan
 * önce o sezonda hiç koşu yoktur, döngü hiç dönmez ve tarif `freshStandings()`e
 * düşer. Burada standings'i ayrıca "sıfırlayan" bir yazma eklemek, aynı
 * gerçeğin iki kopyasını (biri türetilen, biri saklanan) yaratıp ayrışmaya
 * açardı — `runner.ts`in kendi ilkesiyle çelişirdi.
 *
 * NEDEN KIŞ RESETİ BURADA VE SADECE SEZON GEÇİŞİNDE:
 * `shared/src/season.ts` `regressCar` ve `shared/src/factory.ts`
 * `factoryEffects` zaten var ve tam bu iş için yazılmışlar (mobile'daki
 * tek-oyunculu sürüm `gameStore.ts`te aynı ikiliyi sezon sınırında çağırıyor).
 * Icat edilen tek bir sayı yok: taban `CAR_BASELINE`, taşınan pay `CARRY_OVER`
 * ve fabrika tabanı hepsi `shared`te. Araç her turda değil, YALNIZCA sezon
 * döndüğünde geriler — sezon içi ilerleme haftalık yarışlardan gelir, kışın
 * geriye çektiği de budur.
 *
 * NEDEN KORUMA UPDATE'İN KENDİ `where`'İNDE:
 * Bu depodaki her yerleşik sözleşme aynı: önce `select` edip sonra karar
 * vermek kontrol-sonra-davran yarışıdır (server/README.md). İki süreç aynı
 * biten yarışı görüp ikisi de dönüştürseydi lobi iki tur birden atlardı. Karar
 * UPDATE'in kendi `where`'inde (`phase = 'result' and season_no = $x and
 * round_no = $y`) verilir; kazanan `rowCount = 1` görür, kaybeden `0` — tıpkı
 * `phase.ts`/`lease.ts`/`raceRepo.ts`teki `advanceLastLap` gibi.
 *
 * NEDEN İKİ YAZMA (EVRE + EKONOMİ) TEK İŞLEMDE:
 * Evre geçişi taahhüt edilip kış reseti arada çökerse, lobi bir sonraki
 * sezonda ama araçlar hâlâ geçen sezonun statlarıyla kalırdı — ve evre artık
 * `result` olmadığı için bu fonksiyon BİR DAHA ASLA o resetı denemez (kendi
 * koruması bunu engeller). `runner.ts`teki `flag()`in aynı dersi: üç yazmayı
 * (damga, evre, muhasebe) tek taahhüde alması. Burada da evre + kış resetini
 * tek taahhüde alıyoruz.
 *
 * `now` her zaman çağırandan gelir; bu modül saati asla kendisi okumaz
 * (server/README.md §"now sadece route'ta örneklenir").
 */
import { factoryEffects } from '@pitwall/shared/factory';
import { regressCar, SEASON_ROUNDS } from '@pitwall/shared/season';
import { withTransaction } from '../db/pool.ts';
import { bumpCarStat, loadLobbyEconomy, type CarStats } from '../economy/repo.ts';
import { loadLobby } from './lobbyRepo.ts';
import { nextRaceAt } from './schedule.ts';

/** Bir dönüşün gerçekten olup olmadığını ve nereye vardığını bildirir. */
export interface RolloverOutcome {
  /** `false`: bu lobi zaten dönmüştü (ya da hiç `result`te değildi) — çağıranın yapacak bir şeyi yok. */
  rolled: boolean;
  seasonNo: number;
  roundNo: number;
  /** Bu dönüşte sezon da arttıysa `true` — kış resetinin uygulandığı işaret. */
  seasonRolled: boolean;
}

const CAR_FIELDS: (keyof CarStats)[] = ['motor', 'aero', 'grip'];

/**
 * Bitmiş bir turu bir sonrakine dönüştürür.
 *
 * `seasonNo`/`roundNo` biten turun kimliğidir — çağıran (`sweep.ts`) onu
 * koşucudan zaten biliyor, burada YENİDEN OKUNMAZ: `flag()`in kendi kuralı
 * gibi, dönüşün hangi turu ittirdiği çağıranın elindeki gerçeğe bağlı olmalı,
 * aradaki bir okumaya değil.
 *
 * `false` döndüğü iki durum ayrışmaz (ikisi de "çağıranın yapacak bir şeyi
 * yok" demek): lobi hâlâ `result`te değilse (henüz bitmemiş, ya da zaten
 * dönmüş) UPDATE'in `where`i hiç eşleşmez.
 */
export async function rolloverRace(
  lobbyId: string, seasonNo: number, roundNo: number, now: Date,
): Promise<RolloverOutcome> {
  // Bölge lobiyle birlikte doğar ve BİR DAHA DEĞİŞMEZ (`createLobby`);
  // burada okunması bir yarışa girmez, yalnızca `nextRaceAt`in girdisidir.
  const lobby = await loadLobby(lobbyId);
  if (!lobby) return { rolled: false, seasonNo, roundNo, seasonRolled: false };

  let nextRound = roundNo + 1;
  let nextSeason = seasonNo;
  const seasonRolled = nextRound > SEASON_ROUNDS;
  if (seasonRolled) {
    nextRound = 1;
    nextSeason = seasonNo + 1;
  }
  const nextAt = nextRaceAt(lobby.region, now);

  const rolled = await withTransaction(async (client) => {
    // KORUMA BURADA: `select` ile önceden bakmıyoruz, kararı bu UPDATE'in
    // `where`i veriyor. Kaybeden `rowCount = 0` görür ve hiçbir şey yapmaz.
    const res = await client.query(
      `update lobbies
          set phase = 'open', season_no = $2, round_no = $3, next_race_at = $4,
              race_owner = null, race_lease_until = null
        where id = $1 and phase = 'result' and season_no = $5 and round_no = $6`,
      [lobbyId, nextSeason, nextRound, nextAt, seasonNo, roundNo],
    );
    if (res.rowCount !== 1) return false;

    if (seasonRolled) {
      // KIŞ RESETİ: yalnızca bu çağıran gerçekten dönüştürdüyse (yukarıdaki
      // UPDATE'i KAZANDIYSA) çalışır — aksi halde iki süreç aynı resetı iki
      // kez uygulardı. Fabrika seviyelerine DOKUNULMAZ (taşınan tek şey
      // odur); yalnızca araç, `shared/src/season.ts`in TEK formülüyle,
      // `shared/src/factory.ts`in TEK fabrika tabanına doğru geriler.
      const economies = await loadLobbyEconomy(lobbyId);
      for (const econ of economies) {
        const floor = factoryEffects(econ.factoryLevels).winterFloorBonus;
        for (const field of CAR_FIELDS) {
          const regressed = regressCar(econ.car[field], floor);
          const delta = regressed - econ.car[field];
          // Delta sıfırsa yazmaya gerek yok — hem gereksiz bir UPDATE hem de
          // `updated_at`i boş yere ilerletmemek için.
          if (delta !== 0) await bumpCarStat(client, lobbyId, econ.teamKey, field, delta);
        }
      }
    }

    return true;
  });

  return { rolled, seasonNo: nextSeason, roundNo: nextRound, seasonRolled: rolled && seasonRolled };
}
