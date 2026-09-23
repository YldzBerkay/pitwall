/**
 * Yarış muhasebesi — kazanç döngüsünün kapandığı yer.
 *
 * Bir yarış koşuldu; bu modül onun karşılığını LOBİDEKİ HER TAKIMA yazar ve
 * şampiyona tablosunu aynı işlemde üretir.
 *
 * ── NEDEN YENİDEN OYNATMADAN OKUNUYOR ────────────────────────────────────
 * Sonuç çağırandan alınmaz, tariften (tohum + snapshot + karar günlüğü)
 * yeniden üretilir. Sebebi muhasebenin tam da çöken bir sunucu senaryosu için
 * var olması: belleğindeki `RaceState` ile ödeme yapan bir süreç, çökme
 * sonrası devralan sürece ödeyecek hiçbir şey bırakmazdı. Tarif tek gerçek
 * kaynak olduğu için ödeme de oradan çıkar; hangi süreç öderse ödesin aynı
 * sonucu okur (bkz. `replay.ts`).
 *
 * ── NEDEN `markSettled` "zaten ödendi" DEDİĞİNDE FIRLATIYORUZ ────────────
 * `withTransaction` YALNIZCA FIRLATMADA geri alır. Geri dönen bir "başarısız"
 * sonuç, o ana kadar yazılmış her şeyi TAAHHÜT EDER. Önceki fazda üç ayrı para
 * kaybı hatası tam bu şekildeydi ve hepsi aynı biçimdeydi: "başarılı bir
 * harcama, karşılığında hiçbir şey". Burada `return` yazmak tersini yapardı —
 * hiçbir şey karşılığında başarılı bir ödeme. Bu yüzden ikinci muhasebe bir
 * DEĞER değil, bir İSTİSNA döndürür: `AlreadySettledError`. Çağıran onu
 * yakalayıp yutabilir (normal bir durumdur), ama işlem çoktan geri alınmıştır.
 *
 * ── NEDEN CLAIM YOK ──────────────────────────────────────────────────────
 * Yarış kazancı claim İSTEMEZ. Claim mekaniği fabrika/antrenman işlerine
 * aittir: orada oyuncu bir işi BAŞLATIR ve bittiğinde teslim alır, yani claim
 * o işin son adımıdır. Yarış öyle değil — yarış oyuncu uygulamayı açmasa da
 * koşar ve biter. Kazancı claim'e bağlamak, uygulamayı açmayan oyuncuyu
 * cezalandırır ve ligin ekonomisini oyuncuların çevrimiçi alışkanlığına
 * bağlar (Faz 3a-2 spec §8, Faz 3a-1 spec §5.3). Bunu "tutarlılık" adına
 * claim'li hale getirmek mekaniğin sınırını siler; sınır kasıtlıdır.
 *
 * ── NEDEN AI KOLTUKLARI DA ÖDENİR ────────────────────────────────────────
 * Yarış motoru her takımın aracını `lobby_economy`den okur. Ödenmeyen bir AI
 * takımı hiç geliştirme yapamaz, bir sezon boyunca geriler ve ızgara çürür —
 * yani insan oyuncunun rakipsiz kalması. Ödeme koltuğun kime ait olduğuna
 * DEĞİL, lobide bir ekonomi satırı olup olmadığına bakar.
 *
 * `now` her zaman çağırandan gelir; bu modül saati asla kendisi okumaz
 * (server/README.md).
 */
import type { PoolClient } from 'pg';
import { finishRace } from '@pitwall/shared/raceEngine';
import { racePrize } from '@pitwall/shared/sponsors';
import type { TeamStanding } from '@pitwall/shared/teams';
import { withTransaction } from '../db/pool.ts';
import { loadDecisions, loadRun, markSettled } from '../lobby/raceRepo.ts';
import { replayRace } from '../lobby/replay.ts';
import { addRp, loadLobbyEconomy } from './repo.ts';

export interface SettleRaceInput {
  lobbyId: string;
  seasonNo: number;
  roundNo: number;
  now: Date;
}

/** Bir takımın bu yarıştan aldığı. */
export interface SeatPayout {
  teamKey: string;
  /** Yarıştan SONRAKİ şampiyona sırası — ödülün okunduğu yer. */
  position: number;
  rp: number;
}

export interface RaceSettlement {
  /** Yarış işlendikten sonraki şampiyona tablosu. */
  standings: TeamStanding[];
  payouts: SeatPayout[];
}

/**
 * "Bu yarış zaten ödendi."
 *
 * Bir HATA değil, beklenen bir sondur: çöken bir sunucu aynı yarışı ikinci kez
 * bitirebilir. Yine de istisna olarak atılır, çünkü işlemin GERİ ALINMASI
 * gerekir — yukarıdaki `withTransaction` notuna bakın.
 */
export class AlreadySettledError extends Error {
  constructor(readonly lobbyId: string, readonly seasonNo: number, readonly roundNo: number) {
    super(`race already settled: ${lobbyId} s${seasonNo}r${roundNo}`);
    this.name = 'AlreadySettledError';
  }
}

/**
 * Ödemenin tek kapısı.
 *
 * Testin araya girip yarım bir muhasebe üretebilmesi için enjekte edilebilir:
 * "bir şey ortada patlarsa hiç RP yazılmaz" iddiası ancak gerçekten ortada bir
 * şey patlatılarak kanıtlanabilir. Üretimde varsayılan her zaman `addRp`tir.
 */
export interface SettleDeps {
  addRp: (client: PoolClient, lobbyId: string, teamKey: string, amount: number) => Promise<void>;
}

const defaultDeps: SettleDeps = { addRp };

/**
 * Yarışı muhasebeleştirir: tabloyu üretir ve her koltuğa RP yazar.
 *
 * TEK İŞLEM: `markSettled` ile bütün alacaklandırmalar aynı transaction'da.
 * Ortada herhangi bir şey patlarsa muhasebe kaydı da RP de geri alınır, yani
 * yarış hâlâ ödenmemiş sayılır ve yeniden denenebilir. Ayrı işlemlerde
 * olsalardı iki kötü sondan biri kesin olurdu: ya ödemesiz bir muhasebe kaydı
 * (yarış BİR DAHA ASLA ödenemez) ya da kayıtsız bir ödeme (her yeniden
 * oynatmada tekrar ödenir).
 *
 * `AlreadySettledError` fırlatır: bu yarış daha önce ödendi.
 *
 * `client` VERİLİRSE (Faz 3a-2 süpürme döngüsü): yazmalar ÇAĞIRANIN
 * işleminde yapılır, burada yeni bir `withTransaction` AÇILMAZ. Bunun
 * nedeni `runner.ts`teki bayrak anı — koşu satırının `finished_at`ı ve lobi
 * evresinin `result`e geçmesi, ödemeyle AYNI taahhütte olmalı. İkisi ayrı
 * işlemlerde olsaydı arada çöken bir süreç "bitmiş ama hiç ödenmemiş" bir
 * yarış bırakırdı — bu görevin asıl düzelttiği hata. `client` verilmediğinde
 * (testler, doğrudan çağrılar) davranış öncekiyle birebir aynı: fonksiyon
 * kendi işlemini açar ve kapatır.
 */
export async function settleRace(
  input: SettleRaceInput,
  deps: SettleDeps = defaultDeps,
  client?: PoolClient,
): Promise<RaceSettlement> {
  const { lobbyId, seasonNo, roundNo, now } = input;

  const run = await loadRun(lobbyId, seasonNo, roundNo);
  if (!run) {
    throw new Error(`settleRace: no race run for ${lobbyId} s${seasonNo}r${roundNo}`);
  }
  const decisions = await loadDecisions(lobbyId, seasonNo, roundNo);
  // `uptoLap` verilmiyor: muhasebe her zaman BAYRAĞA kadar oynatır. Yarı
  // yolda bir yarışın sonucu diye bir şey yoktur.
  const state = replayRace({ seed: run.seed, round: roundNo, snapshot: run.snapshot, decisions });
  if (!state.finished) {
    throw new Error(`settleRace: race did not reach the flag for ${lobbyId} s${seasonNo}r${roundNo}`);
  }
  const result = finishRace(state);

  // Tablo AYRI SAKLANMAZ; yarışın kendisi gibi tariften türetilir (bkz.
  // runner.ts `standingsBeforeRound`). Burada üretilen tablo, bir sonraki
  // turun tarifine giren tablonun aynısıdır — iki yol da aynı yeniden
  // oynatmadan çıktığı için ayrışamazlar.
  const standings = result.standings;
  const positionOf = new Map(standings.map((s) => [s.teamKey, s.position]));

  const economies = await loadLobbyEconomy(lobbyId);

  // Yazma gövdesi bir kapanışta: `client` ÇAĞIRANDAN geldiyse onun üzerinde
  // çalışır ve `withTransaction`ı hiç görmez (commit/rollback çağıranın
  // işidir — bkz. `runner.ts` `flag()`); verilmediyse eskisi gibi kendi
  // işlemini kendisi açar. İki yol da AYNI gövdeyi çalıştırır, yani "kim
  // taahhüt eder" dışında davranışları ayrışamaz.
  const writePayouts = async (c: import('pg').PoolClient): Promise<RaceSettlement> => {
    // ÖNCE KAPI: ödeme yazmalarıyla AYNI işlemde ve yazmalardan önce.
    if (!(await markSettled(c, lobbyId, seasonNo, roundNo, now))) {
      // FIRLAT, DÖNME. Dönmek buraya kadar yazılanları taahhüt ederdi; burada
      // henüz bir şey yazılmamış olsa bile kural aynı kalmalı, çünkü bu satırın
      // altına ileride bir yazma eklenmesi yeterdi.
      throw new AlreadySettledError(lobbyId, seasonNo, roundNo);
    }

    const payouts: SeatPayout[] = [];
    for (const econ of economies) {
      // Ekonomi satırı olan ama tabloda olmayan bir takım olamaz (tablo 11
      // takımın hepsini taşır); yine de sessiz bir `undefined` yerine sahanın
      // sonunu varsayıyoruz — ödül merdiveninin en ucuzu.
      const position = positionOf.get(econ.teamKey) ?? standings.length;
      // Sayı UYDURULMAZ: yarış günü ödülü `shared/src/sponsors.ts` `racePrize`
      // merdiveninden okunur ve o da `ECONOMY_SCALE`e bağlıdır — ekonominin tek
      // knob'u. Sponsor ücreti ve brifing bonusu BİLEREK yok: sözleşmeler de
      // hafta sonu seçimleri de henüz sunucuda saklanmıyor (Faz 3c), ve
      // olmayan veriden ödeme uydurmak ekonomi kapısını sessizce kaydırırdı.
      const rp = racePrize(position, standings.length);
      await deps.addRp(c, lobbyId, econ.teamKey, rp);
      payouts.push({ teamKey: econ.teamKey, position, rp });
    }

    return { standings, payouts };
  };

  return client ? writePayouts(client) : withTransaction(writePayouts);
}
